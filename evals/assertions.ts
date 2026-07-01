import { expect } from "vitest";
import type { Artifact, AgentEvent } from "@/lib/agent/run";

// Six assertion helpers targeted at the bug classes this codebase has actually
// shipped. Each takes the EventTrace from runStubbedAgent and throws an
// expect() with a clear message on failure.
//
// Order in this file matches the audit's recommended six:
//   1. assertToolCalled       — the model used the expected tool
//   2. assertNoEmptyTurn      — the turn produced text OR an artifact OR an error
//   3. assertNoRawFence       — no ```post/```hook/```cite leaked into displayed text
//   4. assertNoInBandError    — no "tool-use limit"/empty/swallowed-error fallback
//   5. assertTurnsUnderLimit  — the loop didn't hit MAX_TOOL_ROUNDS
//   6. assertArtifactKindOk   — the produced artifact kind is what was expected

export type Trace = {
  events: AgentEvent[];
  // What streamed to the client (raw text deltas — may contain mid-stream
  // fences that the client strips on display).
  streamedText: string;
  // The persisted assistant content (server-stripped of fences) — the right
  // thing to assert against for "no raw fence" / "no canned-error text".
  finalContent: string;
  artifacts: Artifact[];
  toolCalls: { name: string; args: string }[];
  toolResults: { name: string; ok: boolean }[];
  errors: { message: string; code?: string | number; recovery?: string }[];
  done: boolean;
};

export function assertToolCalled(trace: Trace, toolName: string): void {
  const found = trace.toolCalls.some((c) => c.name === toolName);
  expect(found, `expected tool "${toolName}" to be called; got: ${trace.toolCalls.map((c) => c.name).join(", ") || "(none)"}`).toBe(true);
}

// The turn should NEVER produce zero useful output (no final content AND no
// artifact AND no error). The #295 bug was "agent went silent" — this
// assertion catches it. Checks finalContent (persisted), not streamedText.
export function assertNoEmptyTurn(trace: Trace): void {
  const hasOutput =
    trace.finalContent.trim().length > 0 ||
    trace.artifacts.length > 0 ||
    trace.errors.length > 0;
  expect(hasOutput, `expected SOME output (text, artifact, or error) — got an empty turn`).toBe(true);
}

// The PERSISTED final content must NOT contain raw ```post/```hook/```cite
// fences — they should be stripped server-side (PR #299) and/or never appear
// (render-tool path). This is the #298 bug class. Note this checks
// `finalContent`, NOT `streamedText` — fences may appear briefly mid-stream
// (they're stripped client-side on display), but they MUST be gone by `done`.
export function assertNoRawFence(trace: Trace): void {
  const fences = trace.finalContent.match(/```(post|hook|cite)\b/g);
  expect(
    fences,
    `expected no raw \`\`\`post/hook/cite fences in persisted final content; found: ${fences?.join(", ") ?? "(none)"}\nFinal content was:\n${trace.finalContent}`,
  ).toBeNull();
}

// The user-visible "tool-use limit" / canned fallback messages should NEVER
// appear in normal scenarios. If they do, the loop dead-ended instead of
// producing a real answer (the #297 bug class).
export function assertNoInBandError(trace: Trace): void {
  const badPhrases = [
    /reached my tool-use limit/i,
    /assistant hit an error/i,
  ];
  const matched = badPhrases.find((p) => p.test(trace.finalContent));
  expect(
    matched,
    `expected no "tool-use limit"/"assistant hit an error" canned text in final content; found pattern ${matched?.source}`,
  ).toBeUndefined();
}

// The loop should converge in fewer rounds than MAX_TOOL_ROUNDS. Round count
// is approximated as the number of distinct tool_start events (which fire once
// per tool call, and the loop runs ≥1 round per tool batch). Generous bound —
// MAX_TOOL_ROUNDS is 14; a healthy run uses 2-5 rounds, so the default 10-call
// proxy still catches a runaway well before the real ceiling.
export function assertTurnsUnderLimit(trace: Trace, max = 10): void {
  // tool_start events approximate rounds; the loop also makes ≥1 model call
  // per round, but we can't see those from the event stream. This is a close
  // enough proxy for catching runaway loops.
  const starts = trace.events.filter((e) => e.type === "tool_start").length;
  expect(
    starts,
    `expected fewer than ${max} tool calls; got ${starts}`,
  ).toBeLessThan(max);
}

// The expected artifact kind was produced (e.g. "post", "hook", "cite"). Use
// when the scenario sets up a script that should result in an artifact.
export function assertArtifactKindOk(
  trace: Trace,
  kind: Artifact["kind"],
  options?: { minCount?: number; nonEmptyBody?: boolean },
): void {
  const matching = trace.artifacts.filter((a) => a.kind === kind);
  const minCount = options?.minCount ?? 1;
  expect(
    matching.length,
    `expected ≥${minCount} "${kind}" artifact; got ${matching.length} (kinds: ${trace.artifacts.map((a) => a.kind).join(", ") || "(none)"})`,
  ).toBeGreaterThanOrEqual(minCount);
  if (options?.nonEmptyBody !== false && (kind === "post" || kind === "hook")) {
    for (const a of matching) {
      expect(
        a.body.trim().length,
        `expected ${kind} artifact body to be non-empty; got body: "${a.body}"`,
      ).toBeGreaterThan(0);
    }
  }
}

// Bonus helper: assert the turn ended cleanly (done event was yielded).
export function assertTurnDone(trace: Trace): void {
  expect(trace.done, "expected the turn to end with a `done` event").toBe(true);
}
