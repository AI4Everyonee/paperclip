import { describe, it, expect, vi } from "vitest";
import { FixtureRegistry } from "../fixture-registry.js";
import { parseTargetConfig, preparationPreview } from "./catalog.js";
import { journeyFixtures } from "./fixtures.js";
import { validateRetainedRunnerResult } from "../result-validation.js";
import { assertPublicCampaign } from "../history-publish.js";
import { validateJourneyCollection } from "./collection.js";
import { summarizeExecutionBilling, aggregateCampaignBilling } from "../billing.js";
import { discoverReportCatalog } from "../report-catalog.js";
import { isIncompleteFirstTaskResult } from "../case-outcome.js";
import type { RunnerE2EResult } from "../types.js";
import type { JourneyContext, TargetSession } from "./types.js";
const local = { version: 1, id: "local-qa", mode: "managed-self-hosted", journeys: ["task-properties"], executionEnvironment: "local", baseline: { features: {}, connections: [] }, limits: { durationMs: 10000, modelBudgetCents: 0, maxRuns: 0 } };
function result(): RunnerE2EResult {
  return { schema: "paperclip.runner-e2e.result/v2", suiteId: "product-journeys", suiteDefinitionHash: "test", executionId: "product-journeys.local-qa.local.task-properties", profileId: "local-qa", environmentId: "local", caseId: "task-properties", provider: null, model: null, runtimeMode: "none", status: "passed", cleanup: "passed", attempt: 1, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", durationMs: 1000,
    productJourney: { outcome: "passed", startingState: "recipe", phases: [{phase: "journey", outcome: "passed"}], checks: [{id:"assignment-persisted", passed:true},{id:"no-agent-work",passed:true}], privacy: "private", resourceDisposition: "released", deployment: { kind: "self-hosted", targetId: "local-qa", origin: "http://127.0.0.1:3100", commit: "a".repeat(40), cloudRelease: null, runtimeImage: null, configurationHash: "test" } } };
}
describe("deployment journey contracts", () => {
  it("resolves only requested prerequisites, once, and unwinds on failure", async () => {
    const calls: string[] = [];
    const registry = new FixtureRegistry().register({id:"a", async setup(){calls.push("a"); return 1;}, async teardown(){calls.push("-a");}})
      .register({id:"b",dependencies:["a"],async setup(){calls.push("b");throw new Error("setup");}})
      .register({id:"unselected",async setup(){throw new Error("unselected");}});
    await expect(registry.setupAll(["b"])).rejects.toThrow("setup");
    expect(calls).toEqual(["a","b","-a"]);
  });
  it("reuses verified onboarding without claiming recipe setup is onboarding coverage", async () => {
    const ready = { capabilities:["company","board-user","task-write"], startingState:"onboarding" } as JourneyContext;
    const prepare = vi.fn(async () => ({...ready, startingState:"recipe"}));
    const fixtures = journeyFixtures({prepare} as unknown as TargetSession);
    fixtures.provide(ready);
    expect(await fixtures.resolve(["company","board-user"])).toBe(ready);
    expect(prepare).not.toHaveBeenCalled();
    const independent = journeyFixtures({prepare} as unknown as TargetSession);
    expect((await independent.resolve(["task-write"])).startingState).toBe("recipe");
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it("rejects missing capabilities and cycles", async () => {
    const fixtures = journeyFixtures({prepare:async()=>({capabilities:[]})} as unknown as TargetSession);
    await expect(fixtures.resolve(["task-write"])).rejects.toMatchObject({outcome:"unsupported"});
    const graph = new FixtureRegistry().register({id:"a",dependencies:["b"],setup:async()=>null}).register({id:"b",dependencies:["a"],setup:async()=>null});
    await expect(graph.setupAll(["a"])).rejects.toThrow("cycle");
  });
  it("requires explicit paid limits and compatible deployment selections", () => {
    expect(preparationPreview(parseTargetConfig(local)).modelProfileId).toBeNull();
    const fresh = {...local,mode:"new-cloud",adapterModule:"/private/provider.mjs",journeys:["cloud-onboarding","task-properties"]};
    expect(()=>parseTargetConfig(fresh)).toThrow("paid_journey_requires_limits");
    expect(()=>parseTargetConfig({...fresh,limits:{...local.limits,modelBudgetCents:1000,maxRuns:1}})).not.toThrow();
    expect(()=>parseTargetConfig({...local,executionEnvironment:"daytona"})).toThrow("unsupported");
    expect(()=>parseTargetConfig({...local,journeys:["cloud-onboarding"]})).toThrow("onboarding_requires");
    expect(()=>parseTargetConfig({...local,apiKey:"secret"})).toThrow("fields");
  });
  it("preview never loads or emits private adapter configuration", () => {
    const config = parseTargetConfig({...local,mode:"existing-cloud",adapterModule:"/not-installed.mjs",adapterConfig:{operatorSecret:"never-print"}});
    expect(JSON.stringify(preparationPreview(config))).not.toContain("never-print");
  });
  it("counts shared setup once and rejects raw data in collection receipts", () => {
    const onboarding = result(); onboarding.caseId="cloud-onboarding"; onboarding.runtimeMode="native";
    onboarding.runIds=["run-1"]; onboarding.usage={runs:[{runId:"run-1",usage:{costUsd:0.5,inputTokens:10,outputTokens:10}}]};
    onboarding.productJourney!.operations={campaignId:"campaign",attemptId:"attempt",modelCostUsd:0.7,setupCostUsd:0.2,requestCount:2,feedback:{collection:"complete",complaints:0,suggestions:1},traceIds:[]};
    expect(aggregateCampaignBilling([onboarding,result()]).observedAndEstimatedCostUsd).toBeCloseTo(0.7);
    expect(()=>validateJourneyCollection({journeyId:"cloud-onboarding",runIds:["run"],usage:{runs:[{runId:"run",usage:{apiKey:"not-retainable"} as any}]}})).toThrow("invalid_collection_receipt");
    onboarding.productJourney!.operations.modelCostUsd=null;
    expect(aggregateCampaignBilling([onboarding,result()]).observedAndEstimatedCostUsd).toBeNull();
  });
  it("requires real pass evidence and forbids model work in browser-only passes", () => {
    expect(()=>validateRetainedRunnerResult(result())).not.toThrow();
    const missing = result(); missing.productJourney!.checks=[];
    expect(()=>validateRetainedRunnerResult(missing)).toThrow();
    const paid = result(); paid.runIds=["unexpected"];
    expect(()=>validateRetainedRunnerResult(paid)).toThrow();
  });
  it("keeps browser-only reporting free of invented model calls and rejects public publication", () => {
    const value=result();
    expect(summarizeExecutionBilling(value)).toMatchObject({llm:{runCount:0,reportedCostUsd:0},runtime:{agentRunDurationMs:0}});
    expect(discoverReportCatalog({expected:[value.executionId],results:[value],catalog:[]})[0]?.profile).toMatchObject({provider:null,model:null,generation:"none"});
    expect(()=>assertPublicCampaign({results:[value]})).toThrow("Private");
    value.status="failed"; value.productJourney!.outcome="blocked";
    value.productJourney!.checks=[];
    expect(summarizeExecutionBilling(value).llm.runCount).toBe(0);
    expect(isIncompleteFirstTaskResult(value)).toBe(true);
    value.productJourney!.outcome="failed";
    expect(isIncompleteFirstTaskResult(value)).toBe(false);
  });
});
