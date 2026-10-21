import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { openEvalCostLedger, readEvalCostLedger } from "./cost-ledger.js";
import { EVAL_OVERHEAD_COMPONENTS, type EvalOperatingOverhead } from "./operating-overhead.js";
import { importOperatingReceipt, operatingReceiptObservation, type EvalOperatingReceipt } from "./operating-receipts.js";

const evidence = Buffer.from("fixture-only infrastructure receipt");
const overhead: EvalOperatingOverhead = { version: 1, runner: "github-hosted", reference: "fixture-allowance",
  verifiedAt: "2026-10-01T00:00:00Z", expiresAt: "2026-11-01T00:00:00Z",
  components: EVAL_OVERHEAD_COMPONENTS.map(component => ({ component, maxUsd: "1", reference: `fixture-${component}` })) };
const receipt = (fields: Partial<EvalOperatingReceipt> = {}): EvalOperatingReceipt => ({ version: 1, campaignId: "fixture",
  allowanceReference: overhead.reference, component: "artifact_storage", evidenceSha256: createHash("sha256").update(evidence).digest("hex"),
  windowStartedAt: "2026-10-01T00:00:00Z", windowEndedAt: "2026-10-02T00:00:00Z", coverage: "partial",
  source: "infrastructure", provider: "fixture", classification: "estimated", costUsd: "0.2", pricingVersion: "fixture-pricing", ...fields });
const now = Date.parse("2026-10-03T00:00:00Z");

it("binds operating observations to the campaign, allowance, evidence and closed observation window", () => {
  expect(operatingReceiptObservation(receipt(), "fixture", overhead, evidence, now)).toMatchObject({ requestId: "overhead:artifact_storage", final: false });
  for (const changed of [receipt({ campaignId: "other" }), receipt({ allowanceReference: "other" }), receipt({ evidenceSha256: "0".repeat(64) }),
    receipt({ windowEndedAt: "2026-10-04T00:00:00Z" }), receipt({ windowStartedAt: "2026-10-03T00:00:00Z" }),
    receipt({ component: "model" as never }), { ...receipt(), apiKey: "disallowed" }]) {
    expect(() => operatingReceiptObservation(changed, "fixture", overhead, evidence, now)).toThrow();
  }
  expect(() => operatingReceiptObservation(receipt(), "fixture", overhead, Buffer.from("different"), now)).toThrow();
});

it("does not upgrade missing or partial evidence to an invoice or completed receipt", () => {
  for (const changed of [receipt({ classification: "reconciled" }), receipt({ classification: "unknown" }),
    receipt({ classification: "unknown", costUsd: undefined, coverage: "complete" }), receipt({ pricingVersion: undefined }), receipt({ costUsd: "-1" })]) {
    expect(() => operatingReceiptObservation(changed, "fixture", overhead, evidence, now)).toThrow();
  }
  expect(operatingReceiptObservation(receipt({ classification: "unknown", costUsd: undefined }), "fixture", overhead, evidence, now))
    .toMatchObject({ classification: "unknown", final: false });
  expect(operatingReceiptObservation(receipt({ component: "shared_subscription", classification: "allocated", coverage: "complete" }), "fixture", overhead, evidence, now))
    .toMatchObject({ classification: "allocated", route: "subscription", final: true });
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "operating-receipts-"));
  const ledgerPath = path.join(directory, "ledger.jsonl");
  const ledger = await openEvalCostLedger(ledgerPath, { campaignId: "fixture", maxUsd: "20", deadlineAt: "2099-01-01T00:00:00Z",
    maxRequests: 10, maxConcurrent: 1, maxAttemptsPerExecution: 1, overhead });
  await ledger.close();
  return { directory, ledgerPath };
}

it("retains private source evidence, imports idempotently and keeps partial holds until invoice reconciliation", async () => {
  const { directory, ledgerPath } = await fixture();
  try {
    expect(await importOperatingReceipt(ledgerPath, receipt(), evidence)).toMatchObject({ knownUsd: "0.200000000", heldUsd: "3.800000000", unknownRequests: 4 });
    const before = await readFile(ledgerPath, "utf8");
    await importOperatingReceipt(ledgerPath, Object.fromEntries(Object.entries(receipt()).reverse()) as unknown as EvalOperatingReceipt, evidence);
    expect(await readFile(ledgerPath, "utf8")).toBe(before);
    const retained = path.join(`${ledgerPath}.overhead`, `${receipt().evidenceSha256}.evidence`);
    expect(await readFile(retained)).toEqual(evidence);
    expect((await stat(retained)).mode & 0o777).toBe(0o600);
    expect(await readdir(`${ledgerPath}.overhead`)).toHaveLength(2);
    expect(await importOperatingReceipt(ledgerPath, receipt({ source: "invoice", classification: "reconciled", costUsd: "0.3", coverage: "complete" }), evidence))
      .toMatchObject({ knownUsd: "0.300000000", heldUsd: "3.000000000", unknownRequests: 3 });
    expect(await importOperatingReceipt(ledgerPath, receipt({ source: "invoice", classification: "reconciled", costUsd: "0.4", coverage: "complete" }), evidence))
      .toMatchObject({ knownUsd: "0.400000000", heldUsd: "3.600000000", conflictingRequests: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("fails before ledger mutation when retained evidence is corrupt or another writer owns the journal", async () => {
  const { directory, ledgerPath } = await fixture();
  try {
    await importOperatingReceipt(ledgerPath, receipt(), evidence);
    const before = await readFile(ledgerPath, "utf8");
    await writeFile(path.join(`${ledgerPath}.overhead`, `${receipt().evidenceSha256}.evidence`), "corrupted");
    await expect(importOperatingReceipt(ledgerPath, receipt({ costUsd: "0.5" }), evidence)).rejects.toThrow("conflicts");
    expect(await readFile(ledgerPath, "utf8")).toBe(before);
    const loaded = await readEvalCostLedger(ledgerPath), writer = await openEvalCostLedger(ledgerPath, loaded.state.limits);
    try { await expect(importOperatingReceipt(ledgerPath, receipt(), evidence)).rejects.toThrow("writer lock"); }
    finally { await writer.close(); }
    expect(await readFile(ledgerPath, "utf8")).toBe(before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
