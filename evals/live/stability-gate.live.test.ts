import { describe, test, expect, vi } from "vitest";
import {
  shouldRunLiveEvals,
  runLiveAgent,
  visibleDeliverable,
  judge,
  repeatEval,
  stabilityRuns,
  stabilityThreshold,
  type ToolFixtures,
  type Verdict,
} from "./harness";
import { decideTurn } from "@/lib/agent/decide";
import type { ChatMessage } from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// STABILITY GATE (Tier 3, opt-in). The behaviors that have actually misbehaved,
// run N times each, scored by PASS RATE — not a single green check. Stability is
// the metric: a case that's 6/10 reliable "passes once" but breaks in prod, so
// we gate on passRate >= STABILITY_THRESHOLD across STABILITY_RUNS runs.
//
// Run: npm run test:evals:live  (needs RUN_LIVE_EVALS=1 + OPENROUTER_API_KEY —
// the judge also runs through OpenRouter, no separate key). Tune with
// STABILITY_RUNS / STABILITY_THRESHOLD. Skipped cleanly from the default
// hermetic suite.
//
// Two families of cases:
//   • DELIVERY cases — run the full agent and judge the deliverable (exact
//     count, voice, formatting). These exercise the chat model directly.
//   • DECISION cases — exercise the Sonnet decision pre-pass (ask vs proceed) in
//     isolation, since that's the layer the instability lived in. They assert a
//     deterministic verdict (shouldAsk true/false), so they need no judge.
// ---------------------------------------------------------------------------

const fixtures: { current: ToolFixtures } = { current: {} };
vi.mock("@/lib/agent/tools", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/agent/tools")>();
  return { ...orig, runTool: async (name: string) => fixtures.current[name] ?? { ok: true } };
});
vi.mock("@/lib/openrouter", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/openrouter")>();
  return { ...orig, logOpenRouterUsage: async () => undefined };
});

const gate = shouldRunLiveEvals();
const maybe = gate.run ? describe : describe.skip;
if (!gate.run) console.log(`[stability gate] skipped — ${gate.reason}`);

const VOICE = {
  ok: true,
  voice: {
    summary: "Punchy founder voice; one-line paragraphs, blank lines between, no fluff.",
    tone: ["direct", "concrete"],
    exemplars: ["Most cold outreach is dead.\n\nHere's what replaced it.\n\nStop guessing."],
  },
};

const RUNS = stabilityRuns();
const THRESHOLD = stabilityThreshold();

// A reusable assertion: a stability result must clear the threshold, and the
// failures are surfaced so a sub-threshold run is diagnosable.
function expectStable(label: string, r: { passRate: number; passes: number; runs: number; failures: string[] }) {
  console.log(
    `STABILITY [${label}] ${r.passes}/${r.runs} = ${(r.passRate * 100).toFixed(0)}% (need ${(THRESHOLD * 100).toFixed(0)}%)` +
      (r.failures.length ? `\n  fails:\n   - ${r.failures.join("\n   - ")}` : ""),
  );
  expect(r.passRate, `${label}: ${r.passes}/${r.runs} below ${THRESHOLD}`).toBeGreaterThanOrEqual(THRESHOLD);
}

// ---- DELIVERY cases (full agent + judge) ----------------------------------

maybe("stability — delivery", () => {
  test(
    `exact count: "give me 5 hooks" produces exactly 5 (×${RUNS})`,
    async () => {
      fixtures.current = { get_voice: VOICE };
      const r = await repeatEval(RUNS, async (): Promise<Verdict> => {
        const run = await runLiveAgent("Give me 5 hook ideas about cold outreach, in my voice.");
        return judge({
          userMessage: "Give me 5 hook ideas",
          deliverable: visibleDeliverable(run),
          rule: "The reply must contain EXACTLY 5 distinct hook ideas — not 4, not 6. Count them.",
        });
      });
      expectStable("exact-count-5-hooks", r);
    },
    1000 * 60 * 10,
  );

  test(
    `formatting: a drafted post has blank-line paragraph breaks (×${RUNS})`,
    async () => {
      fixtures.current = { get_voice: VOICE };
      const r = await repeatEval(RUNS, async (): Promise<Verdict> => {
        const run = await runLiveAgent("Write me one LinkedIn post in my voice about why distribution beats a perfect offer.");
        return judge({
          userMessage: "Write one post",
          deliverable: visibleDeliverable(run),
          rule: "The post body must be broken into SHORT paragraphs separated by blank lines (not one dense wall of text).",
        });
      });
      expectStable("post-paragraph-formatting", r);
    },
    1000 * 60 * 10,
  );
});

// ---- DECISION cases (Sonnet pre-pass in isolation) ------------------------

maybe("stability — decision pre-pass (ask vs proceed)", () => {
  // These exercise the decision layer specifically, so turn it on for this block.
  process.env.AGENT_DECISION_LAYER = "1";

  const decisionCase = (
    label: string,
    history: ChatMessage[],
    want: "ask" | "proceed",
  ) =>
    test(
      `${label} → should ${want} (×${RUNS})`,
      async () => {
        const r = await repeatEval(RUNS, async (): Promise<Verdict> => {
          const v = await decideTurn(history, { workspaceId: "live-eval-workspace" });
          const got = v.shouldAsk ? "ask" : "proceed";
          return {
            pass: got === want,
            reason: `got ${got} (q=${JSON.stringify(v.question)})`,
          };
        });
        expectStable(`decision:${label}`, r);
      },
      1000 * 60 * 5,
    );

  decisionCase(
    "ambiguous 'draft 5' against a list",
    [
      { role: "user", content: "give me 5 post ideas about cold outreach" },
      { role: "assistant", content: "1. A\n2. B\n3. C\n4. D\n5. E" },
      { role: "user", content: "draft 5" },
    ],
    "ask",
  );

  decisionCase(
    // A SPECIFIC angle + concrete claim — not a broad topic. (A broad "write
    // about distribution" is legitimately ask-able about the angle, so it's a
    // poor "must-proceed" assertion; this leaves no reasonable open choice.)
    "clear, fully-specified request",
    [
      {
        role: "user",
        content:
          "Write me one short LinkedIn post in my voice arguing that founders should spend their first 90 days building an audience BEFORE building the product. One concrete example, end with a question.",
      },
    ],
    "proceed",
  );

  decisionCase(
    "explicit just-do-it",
    [
      { role: "user", content: "give me 5 ideas" },
      { role: "assistant", content: "1. A\n2. B\n3. C\n4. D\n5. E" },
      { role: "user", content: "draft them all, your call on the order" },
    ],
    "proceed",
  );
});
