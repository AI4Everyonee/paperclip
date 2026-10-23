import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { runnerSuites } from "../catalog.js";
import { productJourneys, parseTargetConfig, preparationPreview } from "./catalog.js";
import { journeyFixtures } from "./fixtures.js";
import { taskProperties } from "./task-properties.js";
import { JourneyError, type JourneyContext, type JourneyEvidence, type JourneyOutcome, type TargetProvider, type TargetSession } from "./types.js";
import type { RunnerE2EResult } from "../types.js";
import { regenerateRunnerDashboard } from "../dashboard-regenerate.js";
import { resolveRunnerE2ESource } from "../source.js";
import { validateRetainedRunnerResult } from "../result-validation.js";
import { validateJourneyCollection } from "./collection.js";

export function journeyFailure(error: unknown): { outcome: Exclude<JourneyOutcome, "passed">; code: string } {
  if (error instanceof JourneyError) return error;
  const candidate = error as { outcome?: string; code?: string } | null;
  if (candidate && ["failed", "blocked", "unsupported"].includes(candidate.outcome ?? "") && /^[a-z][a-z0-9_-]{0,100}$/.test(candidate.code ?? "")) {
    return { outcome: candidate.outcome as Exclude<JourneyOutcome, "passed">, code: candidate.code! };
  }
  // Browser errors may contain keys, codes, URLs and form values. Never retain them.
  return { outcome: "failed", code: "journey_operation_failed" };
}

export async function launchProductJourneys(args: string[], repositoryRoot: string) {
  args = args.filter(arg => arg !== "--");
  if (args.includes("--list") && !args.includes("--target-config")) { console.log(JSON.stringify(productJourneys, null, 2)); return; }
  const allowed = new Set(["--target-config", "--output", "--preview", "--list", "--suite"]);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (!allowed.has(flag)) throw new Error("unknown_product_journey_option");
    if (!["--preview", "--list"].includes(flag)) {
      const value = args[++i]; if (!value || value.startsWith("--") || values.has(flag)) throw new Error("invalid_product_journey_option");
      values.set(flag, value);
    }
  }
  const file = values.get("--target-config");
  if (!file) throw new Error("target_config_required");
  const config = parseTargetConfig(JSON.parse(await readFile(file, "utf8")));
  if (args.includes("--preview") || args.includes("--list")) { console.log(JSON.stringify(preparationPreview(config), null, 2)); return; }
  const campaignId = `journey-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const outputDir = path.resolve(values.get("--output") ?? path.join(repositoryRoot, "tests/runner-e2e/results", campaignId));
  // A campaign directory is exclusive; attempts are never overwritten.
  await mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  const deadlineAt = Date.now() + config.limits.durationMs;
  const controller = new AbortController();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const abort = () => { controller.abort(); for (const page of context?.pages() ?? []) void page.close().catch(() => {}); };
  let session: TargetSession | undefined;
  let ready: JourneyContext | undefined;
  let fixtures: ReturnType<typeof journeyFixtures> | undefined;
  let prerequisiteFailure: ReturnType<typeof journeyFailure> | undefined;
  const results: RunnerE2EResult[] = [];
  let sha: string | null = null;
  try { sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* Packaged harnesses may not include Git metadata. */ }
  const source = resolveRunnerE2ESource({ sha, ref: null, workflowRunUrl: null });
  const definitionHash = createHash("sha256").update(JSON.stringify(productJourneys));
  for (const name of ["catalog.ts", "task-properties.ts", "cloud-onboarding.ts", "onboarding-first-task.ts", "fixtures.ts", "launch.ts", "types.ts", "collection.ts", "local-target.ts"]) definitionHash.update(await readFile(path.join(import.meta.dirname, name)));
  const suiteDefinitionHash = definitionHash.digest("hex");
  const expected = config.journeys.map(id => `product-journeys.${config.id}.${id === "cloud-onboarding" ? config.modelProfileId : "browser"}.${config.executionEnvironment}.${id}`);
  let reportPersisted = false;
  const failFinalization = (code: string) => {
    for (const result of results) {
      result.status = "failed"; result.cleanup = "failed"; result.failureClass = "cleanup_failure";
      result.error ??= code;
      if (result.productJourney!.outcome === "passed") result.productJourney!.outcome = "failed";
      result.productJourney!.resourceDisposition = "cleanup-failed";
      if (!result.productJourney!.phases.some(phase => phase.phase === "cleanup" && phase.code === code)) {
        result.productJourney!.phases.push({ phase: "cleanup", outcome: "failed", code });
      }
    }
  };
  const persist = async () => {
    try {
      await writeFile(path.join(outputDir, "normalized-results.tmp"), JSON.stringify({ schema: "paperclip.runner-e2e.campaign/v2", campaignId, generatedAt: new Date().toISOString(), expected, source, results }, null, 2), { mode: 0o600 });
      await rename(path.join(outputDir, "normalized-results.tmp"), path.join(outputDir, "normalized-results.json"));
      reportPersisted = true;
    } catch {
      reportPersisted = false;
      failFinalization("evidence_persistence_failed");
      throw new JourneyError("failed", "evidence_persistence_failed");
    }
  };
  const persistSafely = async () => { try { await persist(); return true; } catch { return false; } };
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  const timer = setTimeout(abort, config.limits.durationMs);
  try {
    try {
      browser = await chromium.launch({ headless: !config.headed, ...(process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE } : {}) });
      context = await browser.newContext();
      context.setDefaultTimeout(30_000);
      if (controller.signal.aborted) throw new JourneyError("blocked", "campaign_deadline_or_interruption");
      const loaded = config.mode === "managed-self-hosted" ? await import("./local-target.js") : await import(pathToFileURL(path.resolve(config.adapterModule!)).href);
      const provider = loaded.provider as TargetProvider;
      if (provider?.version !== 1 || typeof provider.acquire !== "function") throw new JourneyError("blocked", "unsupported_target_provider_contract");
      session = await provider.acquire({ config, campaignId, deadlineAt, browser: context, signal: controller.signal, repositoryRoot, outputDir, harness: { revision: source.sha, definitionHash: suiteDefinitionHash } });
      await session.authenticate();
      fixtures = journeyFixtures(session);
    } catch (error) { prerequisiteFailure = journeyFailure(error); }
    for (const [index, id] of config.journeys.entries()) {
      const startedAt = new Date().toISOString();
      const evidence: JourneyEvidence = { targetId: config.id, outcome: "blocked", startingState: ready?.startingState ?? "recipe", phases: [], checks: [], resourceDisposition: "cleanup-failed", privacy: "private", campaignId, attemptId: `${campaignId}:${id}:1` };
      const profile = id === "cloud-onboarding" ? runnerSuites.flatMap(suite => suite.profiles).find(p => p.id === config.modelProfileId) : undefined;
      const result: RunnerE2EResult = {
        schema: "paperclip.runner-e2e.result/v2", executionId: expected[index]!, suiteId: "product-journeys", suiteDefinitionHash,
        source, attempt: 1, status: "failed", profileId: profile?.id ?? "browser", environmentId: config.executionEnvironment, caseId: id,
        provider: profile?.provider ?? null, model: profile?.model ?? null, runtimeMode: profile?.generation ?? "none", startedAt, finishedAt: startedAt, durationMs: 0, cleanup: "not_started", productJourney: evidence,
      };
      results.push(result);
      let phase: JourneyEvidence["phases"][number]["phase"] = "authentication";
      try {
        if (prerequisiteFailure) {
          if (index === 0) throw new JourneyError(prerequisiteFailure.outcome, prerequisiteFailure.code);
          throw new JourneyError("blocked", "prerequisite_journey_failed");
        }
        if (controller.signal.aborted) throw new JourneyError("blocked", "campaign_deadline_or_interruption");
        evidence.phases.push({ phase: "authentication", outcome: "passed" });
        await persist();
        phase = id === "cloud-onboarding" ? "journey" : "setup";
        if (id === "cloud-onboarding") {
          if (!session!.onboard) throw new JourneyError("unsupported", "target_has_no_onboarding");
          ready = await session!.onboard(evidence);
          fixtures!.provide(ready);
        } else {
          ready = await fixtures!.resolve(productJourneys.find(j => j.id === id)!.requires);
          evidence.phases.push({ phase: "setup", outcome: "passed" });
          evidence.deployment = ready.identity;
          evidence.startingState = ready.startingState;
          await persist();
          phase = "journey";
          await taskProperties(ready, session!, campaignId, evidence);
        }
        evidence.deployment = ready.identity;
        evidence.startingState = ready.startingState;
        if (JSON.stringify(await session!.identity()) !== JSON.stringify(ready.identity)) throw new JourneyError("failed", "deployment_changed_during_journey");
        evidence.outcome = "passed";
        evidence.phases.push({ phase: "journey", outcome: "passed" });
        result.status = "passed";
        const evidenceDir = path.join(outputDir, "evidence", result.executionId, "attempt-1");
        await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
        await ready.page.screenshot({ path: path.join(evidenceDir, `${id}.png`) });
        result.screenshots = [{ id, label: productJourneys.find(j => j.id === id)!.label, file: `${id}.png` }];
      } catch (error) {
        const failure = journeyFailure(error);
        evidence.outcome = failure.outcome;
        evidence.phases.push({ phase, ...failure });
        result.status = "failed";
        result.error = failure.code;
        result.failureClass = failure.outcome === "failed" ? "candidate_failure" : "permanent_infrastructure";
        if (id === "cloud-onboarding" || !ready) prerequisiteFailure = failure;
      }
      result.finishedAt = new Date().toISOString(); result.durationMs = Date.parse(result.finishedAt) - Date.parse(startedAt);
      if (!await persistSafely()) prerequisiteFailure ??= { outcome: "failed", code: "evidence_persistence_failed" };
    }
  } finally {
    clearTimeout(timer);
    try {
      const collected = await session?.collect() ?? [];
      const seen = new Set<string>();
      for (const receipt of collected) {
        validateJourneyCollection(receipt);
        const result = results.find(r => r.caseId === receipt.journeyId);
        if (!result || seen.has(receipt.journeyId) || receipt.operations && (receipt.operations.campaignId !== campaignId || receipt.operations.attemptId !== result.productJourney!.attemptId)) throw new JourneyError("failed", "foreign_or_duplicate_operations_receipt");
        seen.add(receipt.journeyId);
        // Validate the normalized boundary before retaining any adapter output.
        const candidate = { ...result, status: "failed", runIds: receipt.runIds, usage: receipt.usage, productJourney: { ...result.productJourney!, operations: receipt.operations } };
        validateRetainedRunnerResult(candidate);
        result.runIds = receipt.runIds;
        result.usage = receipt.usage;
        if (receipt.operations) result.productJourney!.operations = receipt.operations;
      }
      for (const result of results) {
        if (result.caseId === "cloud-onboarding" && result.status === "passed" && (!seen.has(result.caseId) || !result.runIds?.length || !result.productJourney?.operations || !result.productJourney.operations.traceIds.length)) throw new JourneyError("failed", "paid_journey_receipt_missing");
      }
      for (const result of results) result.productJourney!.phases.push({ phase: "collection", outcome: "passed" });
    } catch (error) {
      const failure = journeyFailure(error);
      for (const result of results) { result.status = "failed"; if (result.productJourney!.outcome === "passed") { result.productJourney!.outcome = "failed"; result.error = failure.code; } result.productJourney!.phases.push({ phase: "collection", outcome: "failed", code: failure.code === "paid_journey_receipt_missing" ? failure.code : "evidence_collection_failed" }); }
    }
    // A private provider checkpoints the measured evidence before deleting resources.
    await persistSafely();
    try {
      const disposition = await session?.release(results.every(r => r.status === "passed") ? "passed" : "failed") ?? "released";
      for (const result of results) { if (result.cleanup !== "failed") result.cleanup = "passed"; result.productJourney!.resourceDisposition = disposition; result.productJourney!.phases.push({ phase: "cleanup", outcome: "passed" }); }
    } catch {
      for (const result of results) { result.status = "failed"; result.cleanup = "failed"; if (result.productJourney!.outcome === "passed") result.productJourney!.outcome = "failed"; result.failureClass = "cleanup_failure"; result.productJourney!.phases.push({ phase: "cleanup", outcome: "failed", code: "target_cleanup_failed" }); }
    }
    try { await browser?.close(); } catch {
      for (const result of results) { result.status = "failed"; result.cleanup = "failed"; if (result.productJourney!.outcome === "passed") result.productJourney!.outcome = "failed"; result.productJourney!.resourceDisposition = "cleanup-failed"; result.productJourney!.phases.push({ phase: "cleanup", outcome: "failed", code: "browser_cleanup_failed" }); }
    }
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
    await persistSafely();
  }
  // If the final write failed, make one bounded attempt to retain that failure itself.
  if (!reportPersisted) await persistSafely();
  if (reportPersisted) {
    try { await regenerateRunnerDashboard({ bundle: outputDir, historyFile: null }); }
    catch { failFinalization("report_generation_failed"); await persistSafely(); }
  }
  try { if (reportPersisted) await session?.finalizeEvidence?.(); }
  catch {
    failFinalization("evidence_finalization_failed");
    await persistSafely();
    if (reportPersisted) {
      try { await regenerateRunnerDashboard({ bundle: outputDir, historyFile: null }); } catch { /* Durable provider checkpoint and cleanup failure remain recoverable. */ }
      try { await session?.checkpointEvidence?.(); } catch { /* Keep the provider's pending manifest and exclusive leases for recovery. */ }
    }
  }
  if (!reportPersisted) console.error("evidence_persistence_failed");
  console.log(`Product journeys: ${results.filter(r => r.status === "passed").length}/${results.length} passed; ${reportPersisted ? `private report ${outputDir}/dashboard.html` : "evidence pending recovery"}`);
  if (!reportPersisted || results.some(r => r.status !== "passed")) process.exitCode = 1;
}
