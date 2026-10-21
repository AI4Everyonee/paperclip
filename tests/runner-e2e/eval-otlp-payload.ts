import { createRequire } from "node:module";

const require = createRequire(new URL("../../server/package.json", import.meta.url));
const protobuf = require("protobufjs") as typeof import("../../server/node_modules/protobufjs/index.js");
const root = protobuf.parse(`syntax = "proto3";
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; ArrayValue array_value = 5; KeyValueList kvlist_value = 6; bytes bytes_value = 7; } }
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message Resource { repeated KeyValue attributes = 1; }
message Scope { repeated KeyValue attributes = 3; }
message Event { repeated KeyValue attributes = 3; }
message Link { repeated KeyValue attributes = 4; }
message Span { repeated KeyValue attributes = 9; repeated Event events = 11; repeated Link links = 13; }
message ScopeSpans { Scope scope = 1; repeated Span spans = 2; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
message Traces { repeated ResourceSpans resource_spans = 1; }
message LogRecord { AnyValue body = 5; repeated KeyValue attributes = 6; }
message ScopeLogs { Scope scope = 1; repeated LogRecord log_records = 2; }
message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; }
message Logs { repeated ResourceLogs resource_logs = 1; }
message PartialSuccess { int64 rejected = 1; }
message Response { PartialSuccess partial_success = 1; }
`).root.resolveAll();

export type EvalOtlpSignal = "traces" | "logs";
export const isEvalProjectId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function validateEvalOtlpParent(value: string, projectId: string): string {
  if (!isEvalProjectId(projectId)) throw new Error("invalid_otlp_project");
  if (value === `project_id:${projectId}`) return value;
  if (value.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("invalid_otlp_parent");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || !bytes.subarray(0, 3).equals(Buffer.from([4, 2, 0]))) throw new Error("invalid_otlp_parent");
  const data = JSON.parse(bytes.subarray(3).toString("utf8"));
  if (!data || Array.isArray(data) || Object.keys(data).sort().join(",") !== "object_id,root_span_id,row_id,span_id"
    || data.object_id !== projectId || data.row_id !== data.span_id
    || !/^[0-9a-f]{16}$/.test(data.span_id) || /^0+$/.test(data.span_id)
    || !/^[0-9a-f]{32}$/.test(data.root_span_id) || /^0+$/.test(data.root_span_id)) throw new Error("invalid_otlp_parent");
  return value;
}

function validateWire(body: Buffer, type: import("../../server/node_modules/protobufjs/index.js").Type) {
  const reader = protobuf.Reader.create(body);
  let fields = 0;
  const inspect = (message: typeof type, end: number, depth: number): void => {
    if (depth > 64) throw new Error("otlp_structure_limit");
    const seen = new Set<number | string>();
    while (reader.pos < end) {
      if (++fields > 200_000) throw new Error("otlp_structure_limit");
      const tag = reader.uint32(), id = tag >>> 3, wire = tag & 7, field = message.fieldsById[id];
      if (!id || ![0, 1, 2, 5].includes(wire)) throw new Error("invalid_otlp_wire");
      if (field) {
        if (!field.repeated && seen.has(id) || field.partOf && seen.has(field.partOf.name)) throw new Error("ambiguous_otlp_wire");
        seen.add(id); if (field.partOf) seen.add(field.partOf.name);
        const nested = field.resolvedType instanceof protobuf.Type ? field.resolvedType : undefined;
        const expected = nested || ["string", "bytes"].includes(field.type) ? 2 : field.type === "double" ? 1 : 0;
        if (wire !== expected) throw new Error("invalid_otlp_wire");
        if (nested) {
          const length = reader.uint32(), next = reader.pos + length;
          if (next > end) throw new Error("invalid_otlp_wire");
          inspect(nested, next, depth + 1);
        } else reader.skipType(wire);
      } else reader.skipType(wire);
      if (reader.pos > end) throw new Error("invalid_otlp_wire");
    }
  };
  inspect(type, body.length, 0);
}

export function validateEvalOtlpPayload(body: Buffer, contentType: string, signal: EvalOtlpSignal, projectId: string): Buffer {
  const type = root.lookupType(signal === "traces" ? "Traces" : "Logs");
  if (contentType !== "application/json") validateWire(body, type);
  const decoded: unknown = contentType === "application/json" ? JSON.parse(body.toString("utf8")) : type.decode(body).toJSON();
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid_otlp_payload");
  let visited = 0;
  const inspect = (value: unknown, depth: number): void => {
    if (++visited > 200_000 || depth > 64) throw new Error("otlp_structure_limit");
    if (Array.isArray(value)) { value.forEach(item => inspect(item, depth + 1)); return; }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (row.key === "braintrust.parent") {
      const parent = row.value as { stringValue?: unknown; string_value?: unknown } | undefined;
      if (!parent || Object.keys(parent).length !== 1) throw new Error("invalid_otlp_parent");
      const text = parent.stringValue ?? parent.string_value;
      if (typeof text !== "string") throw new Error("invalid_otlp_parent");
      validateEvalOtlpParent(text, projectId);
    }
    if (Object.hasOwn(row, "braintrust.parent")) {
      if (typeof row["braintrust.parent"] !== "string") throw new Error("invalid_otlp_parent");
      validateEvalOtlpParent(row["braintrust.parent"], projectId);
    }
    Object.values(row).forEach(item => inspect(item, depth + 1));
  };
  inspect(decoded, 0);
  return contentType === "application/json" ? Buffer.from(JSON.stringify(decoded)) : body;
}

export function evalOtlpRejected(body: Buffer, contentType: string, signal: EvalOtlpSignal): number {
  if (!body.length) return 0;
  const decoded = contentType === "application/json" ? JSON.parse(body.toString("utf8"))
    : root.lookupType("Response").decode(body).toJSON();
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid_otlp_response");
  const partial = decoded.partialSuccess;
  if (partial !== undefined && (!partial || typeof partial !== "object" || Array.isArray(partial))) throw new Error("invalid_otlp_response");
  const rejected = partial?.[signal === "traces" ? "rejectedSpans" : "rejectedLogRecords"] ?? partial?.rejected ?? 0;
  if (!/^[0-9]+$/.test(String(rejected)) || !Number.isSafeInteger(Number(rejected))) throw new Error("invalid_otlp_response");
  return Number(rejected);
}

export function evalOtlpResponse(rejected: number, contentType: string, signal: EvalOtlpSignal): Buffer {
  if (contentType === "application/json") return Buffer.from(JSON.stringify(rejected
    ? { partialSuccess: { [signal === "traces" ? "rejectedSpans" : "rejectedLogRecords"]: String(rejected) } } : {}));
  const type = root.lookupType("Response");
  return Buffer.from(type.encode(type.fromObject(rejected ? { partialSuccess: { rejected: String(rejected) } } : {})).finish());
}
