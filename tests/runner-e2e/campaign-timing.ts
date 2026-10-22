import { buildCampaignAccounting } from "./attempt-accounting.js";
import { durationLabel } from "./report-format.js";
import type { RunnerE2ECampaignAccounting, RunnerE2EResult } from "./types.js";

export const campaignTimingScope = "Attempt durations include setup and cleanup captured inside each attempt. The observed window spans the earliest retained start to the latest retained finish, including gaps and overlap. Neither measure is CI queue/setup time or provider-billed runtime.";

export function summarizeCampaignTiming(
  results: readonly RunnerE2EResult[],
  retained?: RunnerE2ECampaignAccounting,
) {
  const accounting = retained ?? buildCampaignAccounting({ results });
  const attempts = accounting.attempts;
  const subtotal = attempts.reduce((total, attempt) => total + attempt.durationMs, 0);
  const subtotalMs = Number.isFinite(subtotal) ? subtotal : null;
  const starts = attempts.map(attempt => Date.parse(attempt.startedAt));
  const finishes = attempts.map(attempt => Date.parse(attempt.finishedAt));
  const validWindows = attempts.length > 0 && starts.every((start, index) =>
    Number.isFinite(start) && Number.isFinite(finishes[index]) && finishes[index]! >= start);
  const observedWindowMs = validWindows ? Math.max(...finishes) - Math.min(...starts) : null;
  const complete = attempts.length > 0 && accounting.missingAttempts === 0 && subtotalMs !== null;
  return {
    retainedAttempts: attempts.length,
    missingAttempts: accounting.missingAttempts,
    subtotalMs,
    totalMs: complete ? subtotalMs : null,
    observedWindowMs,
  };
}

export function campaignAttemptTimeLabel(timing: ReturnType<typeof summarizeCampaignTiming>) {
  if (timing.totalMs !== null) return durationLabel(timing.totalMs);
  return timing.retainedAttempts > 0 && timing.subtotalMs !== null
    ? `Unknown (${durationLabel(timing.subtotalMs)} retained subtotal)`
    : "Unknown";
}

export function campaignTimingText(timing: ReturnType<typeof summarizeCampaignTiming>) {
  return [
    `Summed attempt time: ${campaignAttemptTimeLabel(timing)}; ${timing.retainedAttempts} retained attempts; ${timing.missingAttempts} missing attempts.`,
    `Observed attempt window: ${durationLabel(timing.observedWindowMs)}.`,
    campaignTimingScope,
  ];
}
