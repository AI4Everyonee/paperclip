import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
vi.mock("@playwright/test", () => ({ chromium: { launch: async () => ({ newContext: async () => ({setDefaultTimeout(){}, pages:()=>[]}), close:async()=>{} }) }, expect: {} }));
vi.mock("../dashboard-regenerate.js", () => ({ regenerateRunnerDashboard: vi.fn(async () => {}) }));
vi.mock("./task-properties.js", () => ({taskProperties: async (_context:unknown,_session:unknown,_id:unknown,evidence:any) => {evidence.checks.push({id:"assignment-persisted",passed:true},{id:"no-agent-work",passed:true});}}));
import { chromium } from "@playwright/test";
import { launchProductJourneys } from "./launch.js";
import { regenerateRunnerDashboard } from "../dashboard-regenerate.js";
const roots: string[]=[];
afterEach(async()=>{vi.restoreAllMocks(); process.exitCode=0; await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function run(options:{authFailure?:boolean;onboardingFailure?:boolean;drift?:boolean;cleanupFailure?:boolean;collectionFailure?:boolean;mini?:boolean;missingReceipt?:boolean;finalizationFailure?:boolean}={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),"journey-campaign-test-")); roots.push(root);
  const module=path.join(root,"provider.mjs");
  await writeFile(module, `import {readFile} from 'node:fs/promises';
const identity={kind:'cloud',targetId:'qa',origin:'https://qa.example.test',commit:'${"a".repeat(40)}',cloudRelease:'v1',runtimeImage:'image',configurationHash:'config'};
let onboarded=false;
const context={identity,startingState:'onboarding',capabilities:['company','board-user','task-write'],page:{async screenshot(){} }};
export const provider={version:1, async acquire(input){return {
async authenticate(){${options.authFailure ? "throw {outcome:'failed',code:'login_code_expired'};" : ""}},
async onboard(evidence){${options.onboardingFailure ? "throw {outcome:'failed',code:'onboarding_failed'};" : "evidence.checks.push(...['fresh-workspace','ui-connection-and-native-agent','first-task-complete','downloadable-artifact-verified','native-trace-verified'].map(id=>({id,passed:true})));onboarded=true;return context;"}},
async prepare(){throw Error('onboarding receipt was not reused')},
async identity(){return {...identity,commit:'${(options.drift?"b":"a").repeat(40)}'}},
async collect(){${options.collectionFailure ? "throw Error('private collection error');" : options.missingReceipt ? "return [];" : "return onboarded?[{journeyId:'cloud-onboarding',runIds:['run-1'],usage:{runs:[{runId:'run-1',usage:{costUsd:0.01}}]},operations:{campaignId:input.campaignId,attemptId:input.campaignId+':cloud-onboarding:1',modelCostUsd:0.01,setupCostUsd:0.005,requestCount:2,feedback:{collection:'complete',complaints:0,suggestions:0},traceIds:['a'.repeat(32)]}}]:[];"}}, async own(){}, async release(){${options.cleanupFailure ? "throw Error('private raw error');" : "return 'released';"}}
, async finalizeEvidence(){
const report=JSON.parse(await readFile(input.outputDir+'/normalized-results.json','utf8'));
if(report.results.some(r=>r.cleanup==='not_started'))throw Error('final evidence preceded cleanup');
${options.finalizationFailure ? "throw Error('private evidence upload diagnostic');" : ""}
}}}};`);
  const config={version:1,id:"qa",mode:"new-cloud",adapterModule:module,journeys:["cloud-onboarding","task-properties"],executionEnvironment:"daytona",baseline:{features:{},connections:[]},limits:{durationMs:60000,modelBudgetCents:1000,maxRuns:1},...(options.mini?{modelProfileId:"runner-codex-mini"}:{})};
  const file=path.join(root,"target.json"),output=path.join(root,"report"); await writeFile(file,JSON.stringify(config));
  await launchProductJourneys(["--target-config",file,"--output",output],path.resolve(import.meta.dirname,"../../.."));
  return JSON.parse(await readFile(path.join(output,"normalized-results.json"),"utf8"));
}
describe("product journey campaign boundary outcomes",()=>{
  it("retains browser startup failure and every selected dependent result", async () => {
    vi.spyOn(chromium, "launch").mockRejectedValueOnce(new Error("private startup detail"));
    const campaign = await run();
    expect(campaign.results.map((r:any)=>r.productJourney.outcome)).toEqual(["failed", "blocked"]);
    expect(JSON.stringify(campaign)).not.toContain("private startup detail");
  });
  it("preserves failed auth and reports every dependent journey blocked",async()=>{
    const campaign=await run({authFailure:true});
    expect(campaign.results.map((r:any)=>r.productJourney.outcome)).toEqual(["failed","blocked"]);
    expect(campaign.results[0].productJourney.phases[0]).toEqual({phase:"authentication",outcome:"failed",code:"login_code_expired"});
  });
  it("does not turn onboarding failure into preconfigured-state success",async()=>{
    const campaign=await run({onboardingFailure:true});
    expect(campaign.results.map((r:any)=>r.productJourney.outcome)).toEqual(["failed","blocked"]);
    expect(campaign.results[0].productJourney.phases.find((p:any)=>p.phase==="journey").outcome).toBe("failed");
  });
  it("reuses a verified onboarding context for the same shared story",async()=>{
    const campaign=await run();
    expect(campaign.results.map((r:any)=>r.status)).toEqual(["passed","passed"]);
    expect(campaign.results.map((r:any)=>r.productJourney.startingState)).toEqual(["onboarding","onboarding"]);
    expect(campaign.results[1]).toMatchObject({provider:null,model:null,runtimeMode:"none"});
  });
  it("fails deployment drift and blocks descendants",async()=>{
    const campaign=await run({drift:true});
    expect(campaign.results[0].error).toBe("deployment_changed_during_journey");
    expect(campaign.results[1].productJourney.outcome).toBe("blocked");
  });
  it("keeps cleanup failures visible without copying raw errors",async()=>{
    const campaign=await run({cleanupFailure:true});
    expect(campaign.results.every((r:any)=>r.cleanup==="failed"&&r.status==="failed")).toBe(true);
    expect(JSON.stringify(campaign)).not.toContain("private raw error");
  });
  it("preserves failed authentication and blocked dependents when finalization also fails",async()=>{
    const campaign=await run({authFailure:true,collectionFailure:true,cleanupFailure:true});
    expect(campaign.results.map((r:any)=>r.productJourney.outcome)).toEqual(["failed","blocked"]);
    expect(campaign.results.every((r:any)=>r.status==="failed"&&r.cleanup==="failed")).toBe(true);
    expect(campaign.results[1].productJourney.phases).toContainEqual({phase:"collection",outcome:"failed",code:"evidence_collection_failed"});
  });
  it("fails paid success when its provider silently omits accounting evidence",async()=>{
    const campaign=await run({missingReceipt:true});
    expect(campaign.results[0].status).toBe("failed");
    expect(campaign.results[0].error).toBe("paid_journey_receipt_missing");
    expect(campaign.results[0].productJourney.phases).toContainEqual({phase:"collection",outcome:"failed",code:"paid_journey_receipt_missing"});
  });
  it("retains an evidence-finalization failure after the cleanup report was written",async()=>{
    const campaign=await run({finalizationFailure:true});
    expect(campaign.results.every((r:any)=>r.status==="failed"&&r.cleanup==="failed")).toBe(true);
    expect(campaign.results[0].productJourney.phases).toContainEqual({phase:"cleanup",outcome:"failed",code:"evidence_finalization_failed"});
    expect(JSON.stringify(campaign)).not.toContain("private evidence upload diagnostic");
  });
  it("attempts evidence finalization even when dashboard generation fails",async()=>{
    vi.mocked(regenerateRunnerDashboard).mockRejectedValueOnce(new Error("private render diagnostic"));
    const campaign=await run();
    expect(campaign.results.every((r:any)=>r.status==="failed"&&r.cleanup==="failed")).toBe(true);
    expect(campaign.results[0].productJourney.phases).toContainEqual({phase:"cleanup",outcome:"failed",code:"report_generation_failed"});
    expect(campaign.results[0].productJourney.phases).not.toContainEqual({phase:"cleanup",outcome:"failed",code:"evidence_finalization_failed"});
    expect(JSON.stringify(campaign)).not.toContain("private render diagnostic");
  });
  it("retains an explicitly selected mini model without adding a model to the browser story",async()=>{
    const campaign=await run({mini:true});
    expect(campaign.results[0]).toMatchObject({profileId:"runner-codex-mini",model:"gpt-5.4-mini"});
    expect(campaign.expected[0]).toBe("product-journeys.qa.runner-codex-mini.daytona.cloud-onboarding");
    expect(campaign.results[1]).toMatchObject({profileId:"browser",model:null,runtimeMode:"none"});
  });
});
