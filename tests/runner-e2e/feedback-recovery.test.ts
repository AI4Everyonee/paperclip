import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { recoverInterruptedFeedback, readRecoveredFeedback } from "./feedback-recovery.js";
import { mustPreserveRecoveryState } from "./cleanup-verification.js";
import { isHistoricalBundlePathAllowed } from "./history-publish.js";
import type { RunnerApi } from "./api.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = { campaignId: "campaign", attemptId: "attempt", executionId: "execution" };
const companyId = "88c1939b-2d9f-4bb3-8ebc-8a7a85efeeac";
const api = (get: (url: string) => unknown): Pick<RunnerApi, "get"> => ({ async get<T>(url: string) { return get(url) as T; } });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "eval-feedback-recovery-")); roots.push(root);
  await mkdir(path.join(root, "snapshots"));
  await writeFile(path.join(root, "snapshots/fixtures.json"), JSON.stringify({ executionId: identity.executionId, companyId }));
  return root;
}

it("retains saved feedback after worker loss while active-run coverage stays partial", async () => {
  const root = await fixture();
  const entry = { id: "saved", kind: "complaint", runId: "run", body: "Synthetic lost-worker complaint. private-canary-value" };
  await recoverInterruptedFeedback({ identity, caseDirectory: root, deadlineAt: Date.now() + 5000,
    secrets: ["private-canary-value"], api: api(url => {
      if (url.includes("agent-commentary?")) return { items: [entry], total: 1 };
      if (url.endsWith("agent-commentary/saved")) return entry;
      if (url.endsWith("heartbeat-runs?limit=1000")) return [{ id: "run" }];
      if (url.endsWith("heartbeat-runs/run")) return { id: "run", runtimeMode: "native", status: "running" };
      return [];
    }),
  });
  const summary = await readRecoveredFeedback(root, identity);
  expect(summary).toMatchObject({ collection: "partial", invocationCollection: "partial", complaints: 1, bodiesCollected: 1 });
  expect(summary?.review).toHaveLength(1);
  const saved = await readFile(path.join(root, "snapshots/agent-feedback-recovered.json"), "utf8");
  expect(saved).toContain("Synthetic lost-worker complaint.");
  expect(saved).not.toContain("private-canary-value");
  expect(isHistoricalBundlePathAllowed("evidence/case/attempt-1/snapshots/agent-feedback-recovered.json")).toBe(false);
  expect(isHistoricalBundlePathAllowed("evidence/case/attempt-1/snapshots/feedback-recovery.json")).toBe(false);
  await writeFile(path.join(root, "snapshots/agent-feedback.json"), saved);
  await recoverInterruptedFeedback({ identity, caseDirectory: root, deadlineAt: Date.now() + 5000, secrets: [],
    api: api(() => { throw new Error("controller stopped after the worker checkpoint"); }),
  });
  expect(await readRecoveredFeedback(root, identity)).toMatchObject({ complaints: 1, bodiesCollected: 1, collection: "partial" });
  expect(await readFile(path.join(root, "snapshots/agent-feedback-recovered.json"), "utf8")).toContain("Synthetic lost-worker complaint.");
  expect(await readRecoveredFeedback(root, { ...identity, attemptId: "different" })).toBeUndefined();
  const receiptPath = path.join(root, "snapshots/feedback-recovery.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.summary.collection = "complete";
  await writeFile(receiptPath, JSON.stringify(receipt));
  expect(await readRecoveredFeedback(root, identity)).toBeUndefined();
});

it("preserves completed attempt evidence without making another API request", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "result.json"), "retained original");
  let calls = 0;
  await recoverInterruptedFeedback({ identity, caseDirectory: root, deadlineAt: Date.now() + 5000, secrets: [],
    api: api(() => { calls++; throw new Error("must not read"); }),
  });
  expect(calls).toBe(0);
  expect(await readFile(path.join(root, "result.json"), "utf8")).toBe("retained original");
  expect(await readRecoveredFeedback(root, identity)).toBeUndefined();
});

it("reports unavailable recovery without fabricating an empty successful collection", async () => {
  const root = await fixture();
  await recoverInterruptedFeedback({ identity, caseDirectory: root, deadlineAt: Date.now() + 5000, secrets: [],
    api: api(() => { throw new Error("controller unavailable"); }),
  });
  expect(await readRecoveredFeedback(root, identity)).toMatchObject({ collection: "unavailable", invocationCollection: "unavailable" });
  expect(mustPreserveRecoveryState({ processCleanupFailed: false, results: [{ cleanup: "passed", synthetic: true }] })).toBe(true);
  expect(mustPreserveRecoveryState({ processCleanupFailed: false, results: [{ cleanup: "passed", synthetic: false }] })).toBe(false);
});
