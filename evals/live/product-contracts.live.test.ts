import { describe, expect, test, vi } from "vitest";
import { CHAT_MODEL } from "@/lib/openrouter";
import { findBannedWords } from "@/evals/anti-slop-detectors";
import {
  runLiveAgent,
  shouldRunLiveEvals,
  visibleDeliverable,
  type LiveRunResult,
  type ToolFixtures,
} from "./harness";
import {
  contractPassed,
  conservativeInputTokenBound,
  liveSpendCeiling,
  LiveSpendBudget,
  runLiveContract,
  safeReportLine,
  type LiveContract,
} from "./contract-runner";

const state = vi.hoisted(() => ({
  fixtures: {} as ToolFixtures,
  providerCostUsd: 0,
  sawProviderCost: false,
  projectedWorstCaseUsd: 0,
  sawLeadMagnetContext: false,
}));

vi.mock("@/lib/agent/tools", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/agent/tools")>();
  return {
    ...original,
    runTool: async (name: string) => state.fixtures[name] ?? { ok: true },
  };
});

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/openrouter")>();
  return {
    ...original,
    logOpenRouterUsage: async () => undefined,
    streamChat: async function* (...args: Parameters<typeof original.streamChat>) {
      const options = args[0];
      const actualModel = options.model ?? original.CHAT_MODEL;
      if (actualModel !== "z-ai/glm-5.2") {
        throw new Error("live contracts require pinned model z-ai/glm-5.2");
      }
      const inputTokensUpperBound = conservativeInputTokenBound({
        messages: options.messages,
        tools: options.tools ?? [],
      });
      if (JSON.stringify(options.messages).includes("E2E_LEAD_MAGNET_TYPE")) {
        state.sawLeadMagnetContext = true;
      }
      const requestWorstCase =
        original.openRouterCost(
          "z-ai/glm-5.2",
          inputTokensUpperBound,
          options.maxTokens ?? 1024,
        ) * 3;
      // Fail closed only when a SINGLE request's worst case exceeds the
      // per-request reservation bound. A production turn issues several model
      // calls (decision, orchestrator round(s), writer), so summing every call
      // in a turn against a per-request bound would wrongly reject a normal
      // multi-round turn before any model is even hit. The cumulative spend
      // across the whole suite is separately enforced by LiveSpendBudget
      // ($LIVE_EVAL_SPEND_CEILING_USD). We still accumulate for observability.
      state.projectedWorstCaseUsd += requestWorstCase;
      // Fail closed only when a SINGLE request's projected worst case exceeds
      // the per-request bound. Two things matter here:
      //  1. The check is per-request, not a running sum. A production turn
      //     issues several model calls (decision, orchestrator round(s),
      //     writer), so summing them against a single-request bound would
      //     wrongly reject a normal multi-round turn before any model is hit.
      //  2. The bound is $0.25, sized to the real v2 prompt. Under
      //     RUN_LIVE_EVALS the agent clamps output to 1024 tokens, but the v2
      //     system prompt + tool schemas + fixtures serialize to ~58KB, whose
      //     byte-length input bound alone yields ~$0.17 worst case (×3). The
      //     old $0.125 bound was sized for the smaller pre-v2 prompt and now
      //     rejects every turn.
      // This is a conservative pre-flight guard, NOT the spend cap. Actual
      // GLM-5.2 cost per turn is ~$0.01-0.03; the real ceiling is enforced by
      // LiveSpendBudget ($LIVE_EVAL_SPEND_CEILING_USD) via the per-repetition
      // estimatedCostPerRunUsd reservation below, which stays at $0.125 so the
      // suite still fits the $2 default budget.
      if (requestWorstCase > 0.25) {
        throw new Error("live contract prompt exceeds the pre-reserved worst-case bound");
      }
      for await (const chunk of original.streamChat(...args)) {
        if (typeof chunk.usage?.cost === "number") {
          state.providerCostUsd += chunk.usage.cost;
          state.sawProviderCost = true;
        }
        yield chunk;
      }
    },
  };
});

const gate = shouldRunLiveEvals();
const maybe = gate.run ? describe : describe.skip;
const repetitions = Math.max(2, Math.floor(Number(process.env.LIVE_EVAL_REPETITIONS ?? "2")));
const budget = new LiveSpendBudget(liveSpendCeiling());

const VOICE = {
  ok: true,
  voice: {
    summary: "Direct, concrete founder voice. Short paragraphs. No emoji or motivational filler.",
    tone: ["direct", "specific"],
    exemplars: ["We deleted seven onboarding emails.\n\nActivation rose 17%.\n\nLess guidance. Faster value."],
  },
};
const SOURCE = {
  id: "fixed-source-1",
  text: "Orbit Ledger reduced onboarding time by 37% using a two-step activation checklist.",
  post_url: "https://linkedin.com/feed/update/fixed-source-1",
  post_type: "regular",
  accounts: { name: "Orbit Ledger", niche: "SaaS" },
};
const TOP_POSTS = { ok: true, count: 1, posts: [SOURCE] };

type ProductCase = {
  id: string;
  rule: string;
  prompt: string;
  fixtures: ToolFixtures;
  agentOpts?: { leadMagnetBlock?: string };
  check: (run: LiveRunResult) => boolean;
};

const cases: ProductCase[] = [
  {
    id: "tool-selection-top-posts",
    rule: "Cowork selects get_top_from_batch for tracked-account winners.",
    prompt: "Find the top-performing post from my tracked accounts this week and explain the winning angle.",
    fixtures: { get_top_from_batch: TOP_POSTS },
    check: (run) => run.toolCalls.some((call) => call.name === "get_top_from_batch"),
  },
  {
    id: "prompt-adherence-no-clarification",
    rule: "A fully specified request proceeds without asking a clarification question.",
    prompt: "Write one 100-word LinkedIn post for B2B founders arguing that distribution beats polish. End with a statement. Your call on the angle; do not ask questions.",
    fixtures: { get_voice: VOICE },
    check: (run) =>
      run.done &&
      run.artifacts.some((artifact) => artifact.kind === "post") &&
      !run.toolCalls.some((call) => call.name === "ask_user") &&
      !run.finalText.trim().endsWith("?"),
  },
  {
    id: "source-fidelity-fixed-claim",
    rule: "A modeled post preserves the fixed source company, result, and mechanism.",
    prompt: `Model this source faithfully without inventing facts:\n${SOURCE.text}`,
    fixtures: { get_voice: VOICE },
    check: (run) => {
      const output = visibleDeliverable(run);
      return /Orbit Ledger/i.test(output) && /37%/.test(output) && /two-step activation checklist/i.test(output);
    },
  },
  {
    id: "voice-short-direct-no-emoji",
    rule: "Cowork applies the stored direct voice with short paragraphs and no emoji.",
    prompt: "Write one post in my voice about deleting unnecessary onboarding emails.",
    fixtures: { get_voice: VOICE },
    check: (run) => {
      const output = visibleDeliverable(run);
      const paragraphs = output.split(/\n\s*\n/).filter(Boolean);
      const filler = /game[- ]changer|results speak for themselves|unlock your potential|it'?s that simple/i;
      return (
        run.toolCalls.some((call) => call.name === "get_voice") &&
        paragraphs.length >= 2 &&
        paragraphs.every((paragraph) => (paragraph.match(/[.!?](?:\s|$)/g) ?? []).length <= 2) &&
        !/[\p{Extended_Pictographic}]/u.test(output) &&
        !filler.test(output)
      );
    },
  },
  {
    id: "post-type-lead-magnet",
    rule: "A lead-magnet request renders a post and preserves lead-magnet intent.",
    prompt: "Write a lead-magnet post for my resource called The 7-Step Onboarding Audit. Ask readers to comment AUDIT.",
    fixtures: { get_voice: VOICE },
    agentOpts: {
      leadMagnetBlock:
        "E2E_LEAD_MAGNET_TYPE: This turn is a lead-magnet post for The 7-Step Onboarding Audit. CTA keyword AUDIT.",
    },
    check: (run) =>
      state.sawLeadMagnetContext &&
      run.toolCalls.some((call) => call.name === "render_post") &&
      /7-Step Onboarding Audit/i.test(visibleDeliverable(run)) &&
      /comment\s+[\"']?AUDIT/i.test(visibleDeliverable(run)),
  },
  {
    id: "exact-count-five-hooks",
    rule: "Cowork returns exactly five numbered hooks when asked for five.",
    prompt: "Give me exactly 5 distinct hooks about founder-led distribution. No introduction.",
    fixtures: { get_voice: VOICE },
    check: (run) =>
      (run.finalText.match(/^\s*[1-5][.)]\s+/gm) ?? []).length === 5 &&
      !/^\s*6[.)]\s+/m.test(run.finalText),
  },
  {
    id: "lead-magnet-comment-keyword",
    rule: "The lead-magnet CTA uses the exact fixed keyword once.",
    prompt: "Write a lead-magnet post for an onboarding audit PDF. The CTA must ask readers to comment AUDIT exactly once.",
    fixtures: { get_voice: VOICE },
    check: (run) => (visibleDeliverable(run).match(/\bAUDIT\b/g) ?? []).length === 1,
  },
  {
    id: "anti-slop-banned-language",
    rule: "A shipped post passes deterministic anti-slop language checks.",
    prompt: "Write one concise post: a shorter onboarding checklist raised activation from 41% to 58%. No em dashes.",
    fixtures: { get_voice: VOICE, get_top_from_batch: TOP_POSTS },
    check: (run) => {
      const output = visibleDeliverable(run);
      return findBannedWords(output).length === 0 && !output.includes("—");
    },
  },
];

maybe("budget-capped production product contracts", () => {
  test("uses the pinned pricing basis required by the hard reservation bound", () => {
    expect(CHAT_MODEL).toBe("z-ai/glm-5.2");
  });

  for (const scenario of cases) {
    test(scenario.id, async () => {
      const contract: LiveContract = {
        id: scenario.id,
        rule: scenario.rule,
        model: CHAT_MODEL,
        parameters: { agentPrompt: "production", fixtureVersion: 1, retryAttempts: 3 },
        repetitions,
        minimumPassRate: 0.8,
        // Pinned GLM-5.2, bounded fixed fixtures, agent token/round caps, and
        // three connection attempts. Actual provider cost must also fit this
        // bound or the contract fails closed.
        estimatedCostPerRunUsd: 0.125,
      };
      const report = await runLiveContract(contract, budget, async () => {
        state.fixtures = scenario.fixtures;
        state.providerCostUsd = 0;
        state.sawProviderCost = false;
        state.projectedWorstCaseUsd = 0;
        state.sawLeadMagnetContext = false;
        const run = await runLiveAgent(scenario.prompt, [], {
          skipDecision: true,
          ...scenario.agentOpts,
        });
        if (!state.sawProviderCost) throw new Error("OpenRouter response omitted authoritative usage cost");
        return {
          pass: scenario.check(run),
          reason: "named production rule failed against fixed fixture",
          actualCostUsd: state.providerCostUsd,
        };
      });
      console.log(`LIVE_CONTRACT ${safeReportLine(report)}`);
      expect(contractPassed(report), safeReportLine(report)).toBe(true);
    }, 300_000);
  }
});
