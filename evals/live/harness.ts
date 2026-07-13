import { completeChat, type ChatMessage } from "@/lib/openrouter";
import type { AgentEvent, Artifact } from "@/lib/agent/contracts";

// ---------------------------------------------------------------------------
// Live-model prompt-eval harness (Tier 3).
//
// Unlike the stubbed suite (which mocks streamChat and asserts loop mechanics),
// this runs the REAL agent loop against the REAL chat model so we can test
// whether the model actually FOLLOWS the system prompt — date honesty, exact
// counts, voice rules, etc. To stay deterministic about DATA while exercising
// real REASONING, the TOOLS are stubbed (fixed fixtures) but the model is not.
//
// Because prompt-following is fuzzy (you can't string-match "did it imply the
// post is newer than it is"), each case is graded by an LLM judge — a separate
// model (Claude Sonnet, via OpenRouter — same billing account/key as the chat
// model under test, no separate direct Anthropic key), so a model never
// grades itself.
//
// This file is imported only by *.live.test.ts, which the runner skips unless
// RUN_LIVE_EVALS=1 and the required key is present (see shouldRunLiveEvals).
// ---------------------------------------------------------------------------

// The judge model — a claude-* model, but reached via OpenRouter using the
// SAME OPENROUTER_API_KEY as the model under test, not a separate direct
// Anthropic key. Overridable via env for a cheaper/pinned tier.
export const JUDGE_MODEL =
  process.env.OPENROUTER_JUDGE_MODEL || "anthropic/claude-sonnet-5";

// True only when explicitly opted in AND the key exists. Both the model under
// test AND the judge now run through OpenRouter, so this is the only key
// needed. Missing it → the suite skips cleanly so normal `npm run test:evals`
// is never affected.
export function shouldRunLiveEvals(): { run: boolean; reason: string } {
  if (process.env.RUN_LIVE_EVALS !== "1") {
    return { run: false, reason: "RUN_LIVE_EVALS!=1 (opt-in only)" };
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return { run: false, reason: "OPENROUTER_API_KEY not set (model under test + judge)" };
  }
  return { run: true, reason: "" };
}

// Fixed tool fixtures for one scenario: map of tool name → result the agent
// loop receives when the model calls that tool. Anything not listed returns a
// generic { ok: true }, matching the stubbed suite's behavior.
export type ToolFixtures = Record<string, Record<string, unknown>>;

export type LiveRunResult = {
  // Everything the user would SEE: the final assistant text + any artifact
  // bodies (drafts/hooks), joined so the judge sees the full deliverable.
  finalText: string;
  artifacts: Artifact[];
  toolCalls: { name: string; args: string }[];
  done: boolean;
  errored: boolean;
};

// Run the REAL agent loop against the REAL model with stubbed tools. Returns
// what the user would see, for the judge to grade.
//
// We mock at call time via vitest's vi.mock in the test file (hoisted); here we
// just import runAgent lazily and drive it. The test file is responsible for
// mocking @/lib/agent/tools (runTool → fixtures) and @/lib/openrouter's
// logOpenRouterUsage (→ no-op, so no Supabase write), while leaving streamChat
// REAL. See prompt-evals.live.test.ts.
export async function runLiveAgent(
  userMessage: string,
  history: ChatMessage[] = [],
  // Turn-mode flags forwarded to runAgent, so a live case can exercise the
  // refine path exactly as the stream route drives it (isRefine arms the
  // render-cap-of-1 + shorten-length nets).
  agentOpts: {
    isRefine?: boolean;
    skipDecision?: boolean;
    leadMagnetBlock?: string;
  } = {},
): Promise<LiveRunResult> {
  const { runAgent } = await import("@/lib/agent");

  const fullHistory: ChatMessage[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  const events: AgentEvent[] = [];
  for await (const ev of runAgent({
    history: fullHistory,
    workspaceId: "live-eval-workspace",
    // No chatId → no cancel polling / DB reads.
    ...agentOpts,
  })) {
    events.push(ev);
  }

  let finalText = "";
  const artifacts: Artifact[] = [];
  const toolCalls: { name: string; args: string }[] = [];
  let done = false;
  let errored = false;
  for (const ev of events) {
    if (ev.type === "tool_start") toolCalls.push({ name: ev.name, args: ev.args });
    else if (ev.type === "artifact") artifacts.push(ev.artifact);
    else if (ev.type === "error") errored = true;
    else if (ev.type === "done") {
      done = true;
      finalText = ev.message.content;
    }
  }
  return { finalText, artifacts, toolCalls, done, errored };
}

// The full deliverable the user sees: assistant text + every artifact body.
// The judge grades this, not just finalText, since posts/hooks live in
// artifacts (render_* tools), not the chat text.
export function visibleDeliverable(r: LiveRunResult): string {
  const parts = [r.finalText.trim()];
  for (const a of r.artifacts) {
    parts.push(`[${a.kind} card${a.title ? `: ${a.title}` : ""}]\n${a.body}`);
  }
  return parts.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// STABILITY GATE — repeat-run evaluation.
//
// A single green run proves a behavior CAN work, not that it's STABLE. The
// agent's instability is exactly the kind that passes once and breaks the next
// time (the chat model is non-deterministic on the decide/ask/count layer). So for the
// behaviors that have actually misbehaved, we run each case N times and score a
// PASS RATE — stability is "9/10", not "1 green check". A regression that drops
// a behavior from 10/10 to 6/10 is invisible to a single-run eval but caught
// here.
// ---------------------------------------------------------------------------

// How many times each stability case runs. More runs → tighter confidence but
// more tokens/time. Env-tunable so a quick local check can use fewer.
export function stabilityRuns(): number {
  const n = Number(process.env.STABILITY_RUNS || 5);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 5;
}

// The pass rate a case must clear to be considered stable (0..1). Default 0.8
// (e.g. 4/5). Env-tunable so you can ratchet it up as the agent improves.
export function stabilityThreshold(): number {
  const t = Number(process.env.STABILITY_THRESHOLD || 0.8);
  return Number.isFinite(t) && t > 0 && t <= 1 ? t : 0.8;
}

export type StabilityResult = {
  runs: number;
  passes: number;
  passRate: number;
  // One reason per FAILED run, so a flake is diagnosable from the test output.
  failures: string[];
};

// Run one async pass/fail probe N times and report the pass rate. `probe`
// returns a Verdict (typically: run the agent, judge the deliverable). Runs are
// sequential to avoid hammering the provider with a burst (and tripping rate
// limits) — stability eval favors reliability over speed.
export async function repeatEval(
  runs: number,
  probe: (attempt: number) => Promise<Verdict>,
): Promise<StabilityResult> {
  let passes = 0;
  const failures: string[] = [];
  for (let i = 0; i < runs; i++) {
    let v: Verdict;
    try {
      v = await probe(i);
    } catch (e) {
      v = { pass: false, reason: `probe threw: ${(e as Error).message}` };
    }
    if (v.pass) passes++;
    else failures.push(`run ${i + 1}: ${v.reason}`);
  }
  return { runs, passes, passRate: runs ? passes / runs : 0, failures };
}

export type Verdict = { pass: boolean; reason: string };

// LLM-as-judge: grade a deliverable against a single, concrete rule. The judge
// is Claude (independent from the chat model under test). The rubric is phrased so the
// judge returns strict JSON we can parse; we default to FAIL on any parse/SDK
// error so a flaky judge can't produce a false green.
export async function judge(opts: {
  userMessage: string;
  deliverable: string;
  rule: string;
}): Promise<Verdict> {
  const system =
    "You are a strict QA grader for an AI LinkedIn-ghostwriting assistant. " +
    "You are given the USER's request, the ASSISTANT's full visible reply, and " +
    "a single RULE. Decide ONLY whether the reply satisfies that rule — ignore " +
    "everything else (style, quality, other rules). Be literal and skeptical: " +
    "if the rule is violated even subtly, fail it. Reply with STRICT JSON only, " +
    'no prose: {"pass": true|false, "reason": "<one sentence>"}.';
  const user =
    `USER REQUEST:\n${opts.userMessage}\n\n` +
    `ASSISTANT REPLY:\n${opts.deliverable}\n\n` +
    `RULE TO CHECK:\n${opts.rule}`;

  try {
    // Routed through OpenRouter (same OPENROUTER_API_KEY as the model under
    // test), not a direct Anthropic key. Sonnet, not Opus: this grades a
    // bounded true/false + one-sentence reason, not open-ended reasoning —
    // the only real requirement (per the file header) is a model DIFFERENT
    // from the chat model under test. Zero risk: this is a CI-only judge, never a
    // production code path.
    const res = await completeChat({
      model: JUDGE_MODEL,
      maxTokens: 300,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const text = res.text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { pass: false, reason: `Judge returned no JSON: ${text.slice(0, 120)}` };
    const parsed = JSON.parse(match[0]) as { pass?: unknown; reason?: unknown };
    return {
      pass: parsed.pass === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "(no reason)",
    };
  } catch (e) {
    // Fail closed: a judge error must not pass silently.
    return { pass: false, reason: `Judge error: ${(e as Error).message}` };
  }
}
