import { expect } from "@playwright/test";
import { JourneyError, type JourneyContext, type JourneyEvidence, type TargetSession } from "./types.js";

export async function taskProperties(context: JourneyContext, session: TargetSession, campaignId: string, evidence: JourneyEvidence) {
  for (const capability of ["company", "board-user", "task-write"]) {
    if (!context.capabilities.includes(capability)) throw new JourneyError("unsupported", `missing_${capability}`);
  }
  const { api, page, company, user } = context;
  const name = `Journey QA ${campaignId}`;
  await session.own({ kind: "issue", name });
  const issue = await api.post<{ id: string; identifier: string }>(`/api/companies/${company.id}/issues`, {
    title: name, description: "Disposable task-property verification", status: "backlog",
  });
  await session.own({ kind: "issue", name, id: issue.id });
  // The declared starting point is the task list. Navigation to the task is a user action.
  await page.goto(`${api.origin}/${company.issuePrefix}/issues`);
  await page.getByRole("link").filter({ hasText: name }).first().click();
  const properties = page.getByRole("button", { name: /^(Show properties|Properties)$/ }).first();
  if (await properties.isVisible()) await properties.click();
  const assignee = page.locator("[data-property-row]").filter({ has: page.locator('[data-property-label="Assignee"]') });
  await assignee.locator("[data-property-value]").getByRole("button").first().click();
  await page.getByRole("button", { name: "Assign to me", exact: true }).click();
  await expect.poll(async () => (await api.get<{ assigneeUserId: string }>(`/api/issues/${issue.id}`)).assigneeUserId).toBe(user.id);
  await page.reload();
  await expect(assignee.locator("[data-property-value]")).toContainText("You");
  const persisted = await api.get<{ assigneeUserId: string; assigneeAgentId: string | null; status: string }>(`/api/issues/${issue.id}`);
  if (persisted.assigneeUserId !== user.id || persisted.assigneeAgentId !== null || persisted.status !== "backlog") throw new JourneyError("failed", "assignment_persistence_mismatch");
  const runs = await api.get<unknown[]>(`/api/issues/${issue.id}/runs`);
  if (runs.length) throw new JourneyError("failed", "browser_only_journey_started_agent_work");
  evidence.checks.push({ id: "assignment-persisted", passed: true }, { id: "no-agent-work", passed: true });
}
