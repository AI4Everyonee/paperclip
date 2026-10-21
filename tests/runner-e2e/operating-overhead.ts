import { usdToUnits } from "../../packages/shared/src/money.js";

export const EVAL_OVERHEAD_COMPONENTS = ["ci_compute", "artifact_storage", "observability", "shared_subscription"] as const;
export interface EvalOperatingOverhead {
  version: 1;
  reference: string;
  runner: "github-hosted" | "aws-fleet";
  verifiedAt: string;
  expiresAt: string;
  components: Array<{ component: typeof EVAL_OVERHEAD_COMPONENTS[number]; maxUsd: string; reference: string }>;
}

const object = (value: unknown, allowed: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Invalid operating overhead fields");
};
const reference = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,511}$/.test(value);

export function validateOperatingOverhead(value: EvalOperatingOverhead, totalUsd: string): bigint {
  object(value, ["version", "reference", "runner", "verifiedAt", "expiresAt", "components"]);
  if (value.version !== 1 || !reference(value.reference) || !["github-hosted", "aws-fleet"].includes(value.runner)
      || typeof value.verifiedAt !== "string" || typeof value.expiresAt !== "string"
      || !Number.isFinite(Date.parse(value.verifiedAt)) || !Number.isFinite(Date.parse(value.expiresAt))
      || Date.parse(value.expiresAt) <= Date.parse(value.verifiedAt)
      || Date.parse(value.expiresAt) - Date.parse(value.verifiedAt) > 31 * 86_400_000
      || !Array.isArray(value.components) || value.components.length !== EVAL_OVERHEAD_COMPONENTS.length) {
    throw new Error("Incomplete operating overhead allowance");
  }
  const seen = new Set<string>();
  let reserved = 0n;
  for (const component of value.components) {
    object(component, ["component", "maxUsd", "reference"]);
    if (!EVAL_OVERHEAD_COMPONENTS.includes(component.component) || seen.has(component.component)
        || !reference(component.reference) || typeof component.maxUsd !== "string"
        || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(component.maxUsd)) throw new Error("Invalid operating overhead component");
    seen.add(component.component);
    reserved += usdToUnits(component.maxUsd);
  }
  if (reserved >= usdToUnits(totalUsd)) throw new Error("Operating overhead leaves no model allowance");
  return reserved;
}

export function scheduledOperatingOverhead(raw: string | undefined, runner: string | undefined, totalUsd: string, now: number): EvalOperatingOverhead {
  if (!raw || raw.length > 16_384) throw new Error("Missing reviewed operating overhead allowance");
  let value: EvalOperatingOverhead;
  try { value = JSON.parse(raw); } catch { throw new Error("Invalid operating overhead JSON"); }
  validateOperatingOverhead(value, totalUsd);
  const expected = runner === "ubuntu-latest" ? "github-hosted"
    : runner === "runs-on/fleet=paperclip-public-pr-x64/env=public-ci" ? "aws-fleet" : undefined;
  if (!expected || value.runner !== expected) throw new Error("Operating overhead runner does not match the selected runner");
  if (!Number.isFinite(now) || now < Date.parse(value.verifiedAt) || now + 4 * 3_600_000 >= Date.parse(value.expiresAt)) {
    throw new Error("Operating overhead allowance needs review before paid admission");
  }
  return value;
}
