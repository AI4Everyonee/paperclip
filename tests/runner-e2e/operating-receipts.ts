import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openEvalCostLedger, readEvalCostLedger, validEvalLedgerId, type EvalCostObservation } from "./cost-ledger.js";
import { EVAL_OVERHEAD_COMPONENTS, type EvalOperatingOverhead } from "./operating-overhead.js";
import { collectGitHubOperatingUsage } from "./github-operating-usage.js";

export interface EvalOperatingReceipt {
  version: 1;
  campaignId: string;
  allowanceReference: string;
  component: typeof EVAL_OVERHEAD_COMPONENTS[number];
  evidenceSha256: string;
  windowStartedAt: string;
  windowEndedAt: string;
  coverage: "complete" | "partial";
  source: "infrastructure" | "invoice";
  provider: string;
  classification: EvalCostObservation["classification"];
  costUsd?: string;
  pricingVersion?: string;
}
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const canonical = (receipt: EvalOperatingReceipt) => Object.fromEntries(Object.entries(receipt).sort(([left], [right]) => left.localeCompare(right)));

export function operatingReceiptObservation(receipt: EvalOperatingReceipt, campaignId: string, overhead: EvalOperatingOverhead,
  evidence: Buffer, now = Date.now()): EvalCostObservation {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || Object.keys(receipt).some(key => ![
    "version", "campaignId", "allowanceReference", "component", "evidenceSha256", "windowStartedAt", "windowEndedAt",
    "coverage", "source", "provider", "classification", "costUsd", "pricingVersion",
  ].includes(key))) throw new Error("Invalid operating receipt fields");
  if (receipt.version !== 1 || receipt.campaignId !== campaignId || receipt.allowanceReference !== overhead.reference
      || !EVAL_OVERHEAD_COMPONENTS.includes(receipt.component) || !validEvalLedgerId(receipt.provider)
      || !["infrastructure", "invoice"].includes(receipt.source) || !["complete", "partial"].includes(receipt.coverage)
      || receipt.evidenceSha256 !== hash(evidence) || !/^[a-f0-9]{64}$/.test(receipt.evidenceSha256)
      || !Number.isFinite(now) || typeof receipt.windowStartedAt !== "string" || typeof receipt.windowEndedAt !== "string"
      || !Number.isFinite(Date.parse(receipt.windowStartedAt)) || !Number.isFinite(Date.parse(receipt.windowEndedAt))
      || Date.parse(receipt.windowStartedAt) > Date.parse(receipt.windowEndedAt) || Date.parse(receipt.windowEndedAt) > now) {
    throw new Error("Operating receipt scope, evidence or window mismatch");
  }
  if (!["reported", "estimated", "allocated", "reconciled", "unknown"].includes(receipt.classification)
      || receipt.classification === "reconciled" && receipt.source !== "invoice"
      || receipt.classification === "unknown" && (receipt.costUsd !== undefined || receipt.coverage === "complete")
      || receipt.classification !== "unknown" && (typeof receipt.costUsd !== "string" || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(receipt.costUsd))
      || ["estimated", "allocated"].includes(receipt.classification) && !validEvalLedgerId(receipt.pricingVersion)
      || receipt.pricingVersion !== undefined && !validEvalLedgerId(receipt.pricingVersion)) throw new Error("Invalid operating cost classification or provenance");
  return { observationId: `operating-receipt:${hash(JSON.stringify(canonical(receipt)))}`, requestId: `overhead:${receipt.component}`,
    source: receipt.source, provider: receipt.provider, currency: "USD",
    route: receipt.component === "shared_subscription" ? "subscription" : "infrastructure",
    classification: receipt.classification, ...(receipt.costUsd === undefined ? {} : { costUsd: receipt.costUsd }),
    ...(receipt.pricingVersion === undefined ? {} : { pricingVersion: receipt.pricingVersion }), final: receipt.coverage === "complete" };
}

async function retain(file: string, bytes: Buffer) {
  let handle;
  try { handle = await open(file, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await readFile(file)).equals(bytes)) throw new Error("Retained operating evidence conflicts");
    return;
  }
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export async function importOperatingReceipt(ledgerPath: string, receipt: EvalOperatingReceipt, evidence: Buffer) {
  if (evidence.length < 1 || evidence.length > 8 * 1024 * 1024) throw new Error("Operating evidence must be between one byte and 8 MiB");
  const loaded = await readEvalCostLedger(ledgerPath);
  if (!loaded.state.limits.overhead) throw new Error("Campaign has no declared operating overhead");
  const observation = operatingReceiptObservation(receipt, loaded.state.limits.campaignId, loaded.state.limits.overhead, evidence);
  const ledger = await openEvalCostLedger(ledgerPath, loaded.state.limits);
  try {
    const directory = `${ledgerPath}.overhead`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await retain(path.join(directory, `${receipt.evidenceSha256}.evidence`), evidence);
    await retain(path.join(directory, `${observation.observationId.split(":")[1]}.receipt.json`), Buffer.from(`${JSON.stringify(canonical(receipt), null, 2)}\n`));
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    if (!(await readEvalCostLedger(ledgerPath)).state.observations.has(observation.observationId)) await ledger.observe(observation);
    return ledger.snapshot();
  } finally { await ledger.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, first, second, third, ...rest] = process.argv.slice(2);
  if (command === "github" && first && second && !third) {
    const usage = await collectGitHubOperatingUsage(first);
    await retain(path.resolve(second), Buffer.from(`${JSON.stringify(usage, null, 2)}\n`));
    console.log(JSON.stringify({ source: usage.workflowUrl, summedJobSeconds: usage.summedJobSeconds,
      retainedArtifactBytes: usage.artifacts.retainedBytes, billing: "unknown", output: path.resolve(second) }));
  } else if (command === "import" && first && second && third && !rest.length) {
    const receipt = JSON.parse(await readFile(second, "utf8")) as EvalOperatingReceipt;
    const result = await importOperatingReceipt(path.resolve(first), receipt, await readFile(third));
    console.log(JSON.stringify({ campaignId: result.campaignId, knownUsd: result.knownUsd, heldUsd: result.heldUsd,
      committedUsd: result.committedUsd, unknownRequests: result.unknownRequests, conflictingRequests: result.conflictingRequests }));
  } else throw new Error("Usage: operating-receipts.ts github <run-id> <private-output> | import <ledger> <receipt> <evidence>");
}
