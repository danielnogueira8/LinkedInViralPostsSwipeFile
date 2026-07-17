// ---------------------------------------------------------------------------
// Decision pre-pass — the "should I ask a clarifying question?" gate.
//
// GLM-5.2 is a capable WRITER but an unreliable DECIDER: the recurring
// instability (asking when it shouldn't / not asking when it should, missing an
// exact count, treating "draft 5" as idea-5) all lives in the plan/decide layer,
// not the writing layer. So before the GLM loop runs, we make ONE short,
// structured judgment call on a stronger model (Claude Sonnet 5 via
// OpenRouter) that does exactly one thing: decide whether the request is
// ambiguous enough to ask the user first, and if so, propose the question +
// options. The decision is a forced-tool-call (schema-validated structured
// output), and run.ts validates it again before surfacing — the model fills a
// form, our code decides what to do with it.
//
// Design rules that keep this STABLE (the whole point):
//   • FAIL OPEN. Any error/timeout/missing-key/malformed-output → return a
//     "don't ask, proceed" verdict so the turn falls through to GLM EXACTLY as
//     it does today. The decision layer can only ADD an ask; it can never break
//     a turn. A new provider dependency must not become a new outage surface.
//   • Thin context. We send the recent conversation + a focused decision prompt,
//     NOT the 14K-token agent SYSTEM_PROMPT. Keeps the call cheap (~a fraction
//     of a cent) and fast.
//   • Env-gated + tunable model, so it's a one-flag rollback and the model can
//     be swapped (e.g. to Haiku) without a code change.
// ---------------------------------------------------------------------------

import {
  CHAT_MODEL,
  completeChat,
  logOpenRouterUsage,
  estimateTokens,
  UsagePersistenceError,
  type ChatMessage,
  type ToolDef,
} from "@/lib/openrouter";
import {
  coworkAdapterHealth,
  type AdapterHealthRegistry,
} from "@/lib/agent/adapter-health";
import {
  runCoworkAdapterAttempt,
  providerModelAttribution,
} from "@/lib/agent/cowork-adapter-attempt";
import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";
import { supabaseAdmin } from "@/lib/supabase";
import { trackedAccountIds } from "@/lib/supabase-scoped";

// Defaults to the one app-wide chat model (OPENROUTER_CHAT_MODEL) so every
// text-LLM call uses the SAME model unless pinned via OPENROUTER_DECISION_MODEL.
// NOTE: the decision pre-pass does judgment/instruction-following work — the
// weakest area of a cheaper model. Historically this ran on Sonnet for exactly
// that reason. Now that a single OPENROUTER_CHAT_MODEL drives everything, keep
// that model strong (or pin OPENROUTER_DECISION_MODEL to a strong judge) for
// this layer to add value.
export const DECISION_MODEL =
  process.env.OPENROUTER_DECISION_MODEL || CHAT_MODEL;

// Feature flag. ON by default now — the Sonnet decision pre-pass is the primary
// defense against GLM's ambiguity misjudgments (wrong guesses on vague asks,
// flaky ask/proceed calls), so it should run for every chat. Set
// AGENT_DECISION_LAYER=0 to disable (a one-flag kill-switch: the turn then falls
// through to GLM's own judgment, exactly as before this layer existed). Any
// other value (or unset) → enabled. The DETERMINISTIC floor in decideTurn runs
// regardless of this flag, so the most dangerous silent-failure signals (an
// unfilled [placeholder]) are still caught even when the LLM layer is off.
export function decisionLayerEnabled(): boolean {
  return process.env.AGENT_DECISION_LAYER !== "0";
}

// How long we'll wait on the decision call before giving up and proceeding to
// GLM. The pre-pass is latency we add BEFORE the main generation, so we cap it
// tightly — a slow decision call must not stall the whole turn.
const DECISION_TIMEOUT_MS = Number(
  process.env.AGENT_DECISION_TIMEOUT_MS || 6000,
);

// Only the last few turns matter for "is THIS request ambiguous" — and trimming
// keeps the call cheap and on-point. We cap both the count and per-message size.
const MAX_DECISION_TURNS = 6;
const MAX_MESSAGE_CHARS = 2000;
// Cap on niches injected into the decision prompt — enough to ground the
// options, not enough to bloat the call.
const MAX_CONTEXT_NICHES = 12;

// Fetch the workspace's REAL tracked niches so the decision model can only
// offer options that actually exist (it was inventing niches the workspace
// doesn't track). Mirrors the list_niches tool query, scoped to this workspace.
// Returns [] on any failure / empty workspace — the decision still runs, just
// without niche grounding (the prompt then tells it to proceed rather than
// invent options). Never throws.
export async function workspaceNiches(workspaceId: string): Promise<string[]> {
  if (!workspaceId) return [];
  try {
    const accountIds = await trackedAccountIds(workspaceId);
    if (accountIds.length === 0) return [];
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("workspace_accounts")
      .select("niche, accounts!inner(niche, archived_at)")
      .eq("workspace_id", workspaceId)
      .is("accounts.archived_at", null);
    if (error) return [];
    const counts = new Map<string, number>();
    for (const row of (data ?? []) as Array<{
      niche: string | null;
      accounts: { niche: string | null } | { niche: string | null }[];
    }>) {
      const acc = Array.isArray(row.accounts) ? row.accounts[0] : row.accounts;
      const n = (row.niche ?? acc?.niche ?? "").trim();
      if (!n) continue;
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_CONTEXT_NICHES)
      .map(([niche]) => niche);
  } catch {
    return [];
  }
}

// Did the assistant's most recent turn already end on a clarifying question?
// If so, the user's current message is the ANSWER — we must NOT ask again
// (the "two questions in a row" bug). We can't see the live ask-event from
// history, so we approximate: the last assistant message is a short, single
// question (ends with "?", no long body) immediately before the new user turn.
// Pure + exported for unit tests.
export function justAskedQuestion(history: ChatMessage[]): boolean {
  // Find the last assistant message (skip the trailing user message we're
  // deciding on, and any tool messages).
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user") continue; // the current/just-prior user turns
    if (m.role !== "assistant") continue;
    // Persisted tool state is authoritative. A real AskCard is declared by an
    // ask_user call; when structured calls are present, never reinterpret the
    // assistant's prose (including an ordinary trailing question) as an ask.
    // Rows from before ask tool-call persistence have no tool_calls property,
    // so those alone retain the conservative prose fallback below.
    if (m.persisted_tool_state || m.tool_calls !== undefined) {
      return (m.tool_calls ?? []).some(
        (call) => call.function.name === "ask_user",
      );
    }
    const text = typeof m.content === "string" ? m.content : "";
    const t = text.trim();
    if (!t) return false;
    // A clarifying question is short and ends on a question mark. A normal
    // assistant reply (a draft, a multi-paragraph answer) is long and doesn't.
    return t.length <= 400 && t.endsWith("?");
  }
  return false;
}

export type DecisionVerdict = {
  // True only when the request is ambiguous/consequential enough that asking
  // gives the user real control AND a wrong guess would waste a generation.
  shouldAsk: boolean;
  // Present when shouldAsk: the single clarifying question + 2-6 options. These
  // are fed through run.ts's buildAskQuestion (same validation as ask_user), so
  // shape mismatches degrade to "don't ask" rather than a broken card.
  question?: string;
  options?: string[];
  // The label of an "I'm satisfied / proceed however you think" escape option,
  // so picking it closes the card with no further model turn (mirrors ask_user).
  doneOption?: string;
  // One short line of why — for logs/debugging, never shown to the user.
  reasoning?: string;
  // Deterministic safety refusal. This is reserved for high-confidence abuse
  // only; ordinary contrarian, edgy, or competitor-comparison content proceeds.
  refuse?: boolean;
  refusalMessage?: string;
};

const PROCEED: DecisionVerdict = { shouldAsk: false };

// ---------------------------------------------------------------------------
// DETERMINISTIC AMBIGUITY FLOOR — runs BEFORE (and independent of) the LLM
// decision call, on EVERY turn, even when the decision layer is disabled or its
// network call fails. It catches the ambiguity signals that don't need judgment
// at all — a request that literally can't be fulfilled as written — so this
// class of "silent wrong guess" never depends on a model.
//
// Deliberately CONSERVATIVE: only fires on signals that are unambiguously
// ambiguous, so it can't over-ask. Everything subtler is left to the LLM
// decision (or to proceeding). Pure + exported for unit tests.
// ---------------------------------------------------------------------------

// The most recent user message's text (mirrors run.ts's latestUserText).
export function latestUserMessage(history: ChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((b) => (b.type === "text" ? b.text : "")).join(" ");
    }
    return "";
  }
  return "";
}

// A conservative [square-bracket] placeholder token: a short run of
// letters/spaces/hyphens/slashes in single brackets ([topic], [person],
// [company name], [your niche]). Mirrors the client's PLACEHOLDER_RE so the
// server floor and the composer nudge agree on what counts. Does NOT match
// bracketed prose with sentence punctuation, so "[see the docs]." is safe.
const PLACEHOLDER_RE = /\[[A-Za-z][A-Za-z /-]*\]/g;
export function findUnfilledPlaceholders(text: string): string[] {
  return text.match(PLACEHOLDER_RE) ?? [];
}

// The user explicitly handed the choice back ("you pick", "your call", "use your
// best judgment", "pick something that fits", "surprise me"). When present, an
// unfilled placeholder is NOT a blocker — the user told us to choose — so the
// floor must NOT ask. Superset of the composer's own "you pick" detection.
const YOU_PICK_RE =
  /\b(you\s+(pick|choose|decide)|your\s+(call|choice)|use\s+your\s+(best\s+)?(judge?ment|discretion)|pick\s+(something|one|a\s+\w+|whatever)|whatever\s+(fits|you\s+(think|want))|surprise\s+me|up\s+to\s+you|dealer'?s\s+choice|just\s+(do\s+it|go|proceed))\b/i;

const BARE_CONTENT_REQUEST_RE =
  /^(?:please\s+)?(?:help\s+me\s+)?(?:write|draft|create|make|generate)(?:\s+me)?\s+(?:a|an|one)?\s*(?:linkedin\s+)?(?:post|hook|piece\s+of\s+content|content)(?:\s+please)?[.!?]*$/i;

function missingTopicAsk(text: string): DecisionVerdict {
  if (!BARE_CONTENT_REQUEST_RE.test(text.trim())) return PROCEED;
  return {
    shouldAsk: true,
    question: "What should the post be about?",
    options: ["I'll share the topic", "You pick one that fits my voice"],
    doneOption: "You pick one that fits my voice",
    reasoning: "deterministic floor: content request has no topic",
  };
}

const FULL_CONTENT_ACTION_RE =
  /\b(write|draft|create|generate|make|produce|prepare|give me|build)\b/i;
const CONTENT_UNIT_RE =
  /\b(posts?|hooks?|ideas?|angles?|captions?|linkedin posts?|content|pieces of content|content pieces)\b/i;
const YEAR_OF_CONTENT_RE =
  /\b(?:a|one|1)\s+(?:full\s+)?year\s+of\s+(?:content|posts?|linkedin posts?)\b/i;
const EVERY_CREATOR_POST_RE =
  /\b(?:every|all)\s+(?:post|posts|piece|pieces)\s+(?:from|by)\s+(?:this|that|a|the)?\s*(?:creator|account|person|profile|author)\b/i;

function requestedContentCount(text: string): number | null {
  const numeric = text.match(
    /\b(?:write|draft|create|generate|make|produce|prepare|give me|build)\s+(?:me\s+)?(\d{1,4})\s+(?:full\s+)?(?:posts?|hooks?|ideas?|angles?|captions?|linkedin posts?|pieces of content|content pieces)\b/i,
  );
  if (numeric) return Number(numeric[1]);

  const wordCounts: Record<string, number> = {
    ten: 10,
    twenty: 20,
    thirty: 30,
    fifty: 50,
    hundred: 100,
  };
  const word = text.match(
    /\b(?:write|draft|create|generate|make|produce|prepare|give me|build)\s+(?:me\s+)?(?:a\s+)?(ten|twenty|thirty|fifty|hundred)\s+(?:full\s+)?(?:posts?|hooks?|ideas?|angles?|captions?|linkedin posts?|pieces of content|content pieces)\b/i,
  );
  if (!word) return null;
  return wordCounts[word[1].toLowerCase()] ?? null;
}

export function deterministicScopeAsk(text: string): DecisionVerdict {
  const t = text.trim();
  if (!t) return PROCEED;
  const asksForContent = FULL_CONTENT_ACTION_RE.test(t) && CONTENT_UNIT_RE.test(t);
  const count = requestedContentCount(t);
  const excessiveCount = count !== null && count >= 10;
  const hugeScope =
    (asksForContent && YEAR_OF_CONTENT_RE.test(t)) || EVERY_CREATOR_POST_RE.test(t);

  if (!excessiveCount && !hugeScope) return PROCEED;

  return {
    shouldAsk: true,
    question: "That is a large content run. How should I scope it first?",
    options: [
      "Start with 3 finished posts",
      "Outline the full batch first",
      "Use your best judgment",
    ],
    doneOption: "Use your best judgment",
    reasoning: excessiveCount
      ? `deterministic scope clamp: requested ${count} content items`
      : "deterministic scope clamp: unbounded content request",
  };
}

const REFUSAL_MESSAGE =
  "I can't help with malware, credential theft, hate or harassment, or explicit wrongdoing. I can help rewrite the request into a legitimate LinkedIn post or safer positioning.";

const MALWARE_RE =
  /\b(?:malware|ransomware|keylogger|botnet|trojan|stealer|backdoor|exploit kit|phishing kit)\b|\b(?:write|build|create|code|generate)\b[\s\S]{0,80}\b(?:virus|worm|credential stealer|password stealer)\b/i;
const CREDENTIAL_THEFT_RE =
  /\b(?:steal|harvest|phish|exfiltrate|dump|scrape)\b[\s\S]{0,80}\b(?:passwords?|credentials?|api keys?|tokens?|cookies?|session keys?|private keys?)\b/i;
const HATE_HARASSMENT_RE =
  /\b(?:write|draft|create|generate|make)\b[\s\S]{0,120}\b(?:harass|doxx|threaten|dehumaniz(?:e|ing)|target)\b[\s\S]{0,120}\b(?:a\s+)?(?:protected class|race|religion|ethnicity|gender|sexual orientation|disabled people|immigrants?)\b/i;
const WRONGDOING_RE =
  /\b(?:help me|show me how to|write instructions to|give me steps to|create a plan to)\b[\s\S]{0,100}\b(?:evade taxes|commit fraud|launder money|forge documents|bypass kyc|bypass sanctions|insider trad(?:e|ing))\b/i;

export function deterministicRefusal(text: string): DecisionVerdict {
  const t = text.trim();
  if (!t) return PROCEED;
  if (
    MALWARE_RE.test(t) ||
    CREDENTIAL_THEFT_RE.test(t) ||
    HATE_HARASSMENT_RE.test(t) ||
    WRONGDOING_RE.test(t)
  ) {
    return {
      shouldAsk: false,
      refuse: true,
      refusalMessage: REFUSAL_MESSAGE,
      reasoning: "deterministic refusal: high-confidence abuse",
    };
  }
  return PROCEED;
}

// Build the "fill in the missing piece" ask from an unfilled placeholder. Names
// the placeholder so the question is concrete ("What topic should this be
// about?"). doneOption lets the user hand it back ("You pick — fits my voice").
function placeholderAsk(token: string): DecisionVerdict {
  // Strip the brackets + tidy for a human label ("[topic]" → "topic").
  const label = token.replace(/^\[|\]$/g, "").trim().toLowerCase();
  const noun = label || "this";
  return {
    shouldAsk: true,
    question: `You left "${token}" unfilled. What should ${noun === "this" ? "this post be about" : `the ${noun} be`}?`,
    options: [
      `Let me tell you the ${noun}`,
      `You pick a ${noun} that fits my voice and niche`,
    ],
    doneOption: `You pick a ${noun} that fits my voice and niche`,
    reasoning: `deterministic floor: unfilled placeholder ${token}`,
  };
}

// The always-on deterministic ambiguity check. Returns an ask verdict for a
// signal that needs no judgment, or PROCEED (so the caller falls through to the
// LLM decision). Currently: an unfilled [placeholder] with no "you pick" escape.
// (The "which draft?" / bare-number cases are handled precisely in run.ts's
// ask_user path via userNamedASpecificItem + the system prompt, so they're not
// duplicated here — this floor covers the silent-draft-about-[topic] class.)
export function deterministicAsk(history: ChatMessage[]): DecisionVerdict {
  const msg = latestUserMessage(history).trim();
  if (!msg) return PROCEED;
  // Don't stack a second question on an answer to the previous one.
  if (justAskedQuestion(history)) return PROCEED;
  const refusal = deterministicRefusal(msg);
  if (refusal.refuse) return refusal;
  const scopeAsk = deterministicScopeAsk(msg);
  if (scopeAsk.shouldAsk) return scopeAsk;
  // The user handed the choice back → their unfilled bracket is intentional.
  if (YOU_PICK_RE.test(msg)) return PROCEED;
  const topicAsk = missingTopicAsk(msg);
  if (topicAsk.shouldAsk) return topicAsk;
  const placeholders = findUnfilledPlaceholders(msg);
  if (placeholders.length > 0) return placeholderAsk(placeholders[0]);
  return PROCEED;
}

const DECISION_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "decide",
    description:
      "Record your decision about whether to ask the user a clarifying question before the assistant proceeds.",
    parameters: {
      type: "object",
      properties: {
        shouldAsk: {
          type: "boolean",
          description:
            "True ONLY if the request is genuinely ambiguous or has a consequential open choice where two reasonable interpretations would produce noticeably different output AND guessing wrong wastes the user's time. False for clear requests, trivial choices, or anything you can proceed on with a sensible default.",
        },
        question: {
          type: "string",
          description:
            "If shouldAsk: one short clarifying question (one sentence). Omit otherwise.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "If shouldAsk: 2-6 concrete, mutually-distinct answer options in the user's own words. Make the LAST option a let-me-decide escape (e.g. 'Use your best judgment'). Omit otherwise.",
        },
        doneOption: {
          type: "string",
          description:
            "If one option means 'just proceed / use your best judgment', repeat its EXACT label here so picking it needs no further work. Omit otherwise.",
        },
        reasoning: {
          type: "string",
          description: "One short line: why ask, or why proceed.",
        },
      },
      required: ["shouldAsk"],
    },
  },
};

// The decision system prompt, grounded in this workspace's real context. The
// niche list keeps it from inventing options the workspace doesn't track, and
// the just-asked flag enforces "never ask twice in a row".
// The workspace-INDEPENDENT HEAD instructions — byte-identical on every call,
// and the bulk of the prompt (~90%). Split out from the variable grounding so
// the call site can send it as a cacheable content block: this pass fires on
// ~every chat turn, so the cache-read discount (10x on Sonnet 5) on a warm
// turn is the single highest-frequency saving in the app. The prompt's exact
// ORDER is preserved: head → variable grounding → tail (see buildDecisionSystem).
export const DECISION_SYSTEM_HEAD = [
  "You are a routing gate for a LinkedIn-ghostwriting assistant. You do NOT write anything.",
  "Your ONLY job: decide whether the assistant should ask the user ONE clarifying question before it proceeds, or just proceed.",
  "",
  "Ask when (and only when) BOTH are true:",
  "  1) The request is genuinely ambiguous or has a consequential open choice — two reasonable readings would produce noticeably different output. Classic cases: a bare number/reference against a list the assistant just produced ('draft 5' = idea #5 OR all 5?); 'rewrite it'/'refine it' when more than one draft is in play (which one?); an unclear whose-voice/which-source; or a MISSING ESSENTIAL the output can't be built without.",
  "  2) Guessing wrong would waste a real generation (so it's worth one quick question).",
  "",
  "MISSING TOPIC is the most important ask. If the user asks for a post/hook/content but gives NO subject to write about (e.g. just 'write me a post', 'draft something', 'make me a hook') and hasn't said to pick one for them, ASK what it should be about — do NOT let the assistant invent a random topic. Offer 'Let me tell you the topic' + 'You pick one that fits my voice'. (If they DID give a topic, even a rough one, proceed.)",
  "",
  "Do NOT ask when: the request is clear; the topic/subject is present (even loosely); the choice is trivial or has an obvious sensible default; the user already said 'just do it' / 'your call' / 'use your best judgment' / 'pick something that fits'; or you'd merely be confirming something you can infer. Default to PROCEEDING when a topic exists — over-asking is its own failure.",
  "",
  "CRITICAL — you have LIMITED context. The assistant itself can look things up (the user's voice profile, the tracked viral posts, the niches, brand details) BY CALLING TOOLS. So NEVER ask the user for a fact the assistant could fetch itself — that's not a clarifying question, it's a job the assistant should just do. Only ask about genuine USER INTENT that no lookup can resolve (which of these, how many, what angle, whose voice).",
  "",
  "NEVER ask which NICHE to pull from, or offer niche options. Everything the assistant produces is adapted to the USER'S OWN voice and niche, so the original niche of a source post is irrelevant — when the user wants ideas / trending posts / inspiration, the assistant should pull the top-performing posts across ALL tracked niches and adapt them to the user. 'Which niche?' is never a valid clarifying question; PROCEED instead.",
  "",
  "Your options MUST be real and answerable. NEVER invent specifics (niches, account names, topics) you can't see in the context below or the conversation. If you can't form concrete, grounded options, PROCEED instead of asking.",
].join("\n");

// The stable TAIL — also byte-identical every call. It sits AFTER the variable
// grounding in the assembled prompt (order preserved), so it rides in the
// uncached suffix, not the cached prefix. It's ~2 lines, so its lost cache
// discount is negligible; keeping order identical is worth more than caching it.
const DECISION_SYSTEM_TAIL = [
  "If you ask: give 2-6 concrete options in the user's own words, and make the LAST option a let-me-decide escape, passed as doneOption too.",
  "Record your decision via the `decide` tool. Be decisive.",
].join("\n");

// The per-turn VARIABLE grounding — niches, justAsked, applied skills — WITH
// the stable tail appended so the assembled order is head → grounding → tail,
// identical to before this split. This whole string is the UNCACHED suffix
// after the head's cache breakpoint.
export function buildDecisionSystemVariable(opts: {
  niches: string[];
  justAsked: boolean;
  // Slugs of the custom skills the user invoked this turn (via /name or the
  // ⚡ picker). The decide layer doesn't NEED the skill bodies (those land in
  // the writing agent's system message), but it does need to know skills are
  // present so it never asks "which skill?" or "what guidance?" — the user
  // already answered that by picking it.
  customSkillNames?: string[];
}): string {
  const lines: string[] = [];

  if (opts.niches.length > 0) {
    // The niche list is GROUNDING ONLY — it stops the model inventing a niche
    // it can't see when it mentions one. It is NOT a menu to offer: per the
    // rule above, "which niche?" is never a valid question, because output is
    // always adapted to the user's own voice/niche.
    lines.push(
      `Workspace context — for reference only, this workspace tracks these niches: ${opts.niches.join(", ")}. Do NOT offer these as a pick-one question; use them only so you never reference a niche that doesn't exist.`,
    );
  } else {
    lines.push(
      "Workspace context — no specific tracked niches are available to you here. Do NOT ask the user to pick a niche or offer niche options; proceed and let the assistant look up what it needs.",
    );
  }

  if (opts.justAsked) {
    lines.push(
      "IMPORTANT — the assistant ALREADY asked the user a clarifying question on the previous turn, and the current user message is their ANSWER. Do NOT ask again — PROCEED (shouldAsk:false). Never ask two questions in a row.",
    );
  }

  if (opts.customSkillNames && opts.customSkillNames.length > 0) {
    const list = opts.customSkillNames.map((n) => `/${n}`).join(", ");
    lines.push(
      `IMPORTANT — the user has ALREADY applied custom skill(s) for this turn: ${list}. The skill body is in the writing assistant's context (you don't see it). NEVER ask "which skill should I use?" or "what guidance?" — the user already picked. Phrases like "use that skill" / "with the skill" / "apply our skill" refer to the applied skill(s); PROCEED.`,
    );
  }

  lines.push(DECISION_SYSTEM_TAIL);
  return lines.join("\n\n");
}

// The whole system prompt as ONE string (head + variable-with-tail). Produces
// exactly the same text the pre-split buildDecisionSystem did. Kept for the
// off-path caller (deterministic-floor branch) and tests; the live call path
// sends head + variable as two blocks so the head caches (see completeChat).
export function buildDecisionSystem(opts: {
  niches: string[];
  justAsked: boolean;
  customSkillNames?: string[];
}): string {
  return `${DECISION_SYSTEM_HEAD}\n\n${buildDecisionSystemVariable(opts)}`;
}

// Trim history to the recent, size-capped turns the decision actually needs.
function decisionContext(history: ChatMessage[]): ChatMessage[] {
  return history
    .slice(-MAX_DECISION_TURNS)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .map((b) => (b.type === "text" ? b.text : ""))
                .join(" ")
            : "";
      return {
        role: m.role,
        content: text.slice(0, MAX_MESSAGE_CHARS),
      } as ChatMessage;
    })
    .filter((m) => typeof m.content === "string" && m.content.trim().length > 0);
}

// Validate the model's raw tool args into a DecisionVerdict. Defensive: any
// shape that isn't a clean "ask" collapses to PROCEED, so a malformed decision
// can never surface a broken card.
export function parseDecision(
  toolArgs: Record<string, unknown> | null,
): DecisionVerdict {
  if (!toolArgs || typeof toolArgs !== "object") return PROCEED;
  if (toolArgs.shouldAsk !== true) return PROCEED;
  const question =
    typeof toolArgs.question === "string" ? toolArgs.question.trim() : "";
  const options = Array.isArray(toolArgs.options)
    ? toolArgs.options.filter((o): o is string => typeof o === "string")
    : [];
  // An "ask" with no usable question or fewer than 2 options is not actionable —
  // proceed rather than surface a half-built card (run.ts validates again too).
  if (!question || options.length < 2) return PROCEED;
  const doneOption =
    typeof toolArgs.doneOption === "string" ? toolArgs.doneOption.trim() : undefined;
  const reasoning =
    typeof toolArgs.reasoning === "string" ? toolArgs.reasoning.trim() : undefined;
  return {
    shouldAsk: true,
    question,
    options,
    ...(doneOption ? { doneOption } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

// The decision pre-pass. Disabled, provider, content, and timeout failures fall
// through to PROCEED. An authoritative usage-ledger failure propagates so a
// paid call can never continue as uncharged work.
export async function decideTurn(
  history: ChatMessage[],
  opts: {
    workspaceId: string;
    signal?: AbortSignal;
    // Slugs of skills the user invoked this turn — see buildDecisionSystem.
    customSkillNames?: string[];
    telemetry?: CoworkTurnTelemetry;
    adapterHealth?: AdapterHealthRegistry;
    // The turn's intent is PROVABLY complete: the user attached an explicit model
    // SOURCE through the UI (they clicked "model this post" on a specific
    // post/template). The attached source fixes BOTH the structural reference and
    // the subject matter, so the turn can't be missing a topic and there's no open
    // intent question for the LLM pass to catch — the Sonnet decide call is pure
    // cost. Deliberately NARROW: a bare format/style chip does NOT supply a topic,
    // so those still run the pass (a "write an Identity-belief post" with no
    // subject must still get the missing-topic ask). See the short-circuit below
    // (it runs AFTER the deterministic ask floors, so a huge-scope, refusal, or
    // unfilled-[placeholder] request layered on the source still asks).
    intentFullySpecified?: boolean;
  } = { workspaceId: "" },
): Promise<DecisionVerdict> {
  // DETERMINISTIC FLOOR FIRST — always, even when the LLM layer is off or its
  // call would fail. A signal that needs no judgment (an unfilled [placeholder])
  // is caught here for free, so ambiguity handling never depends on a network
  // call succeeding. Only when the floor says "proceed" do we consult the model.
  const floor = deterministicAsk(history);
  // The floor returns a non-PROCEED verdict for BOTH an ask (shouldAsk) AND a
  // refusal (refuse, with shouldAsk:false) — honor either before short-circuiting.
  if (floor.shouldAsk || floor.refuse) return floor;

  // PROVABLY-COMPLETE SHORT-CIRCUIT (cost). When the user attached an explicit
  // model source, the "should I ask a clarifying question?" answer is
  // deterministically NO — the attached source fixes both the reference and the
  // subject, so nothing an intent question could resolve is open. Skip the Sonnet
  // decide call. Safe because it sits AFTER deterministicAsk: a still-ambiguous
  // FREE-TEXT overlay on top of the source — a huge-scope run ("make 50 of
  // these"), a refusal, or an unfilled [placeholder] — is already caught by the
  // floor above and asks/refuses as before.
  if (opts.intentFullySpecified) return PROCEED;

  if (!decisionLayerEnabled()) return PROCEED;
  if (!process.env.OPENROUTER_API_KEY) return PROCEED;
  const context = decisionContext(history);
  if (context.length === 0) return PROCEED;

  // Never ask two questions in a row: if the assistant already asked on the
  // previous turn, the current user message is the ANSWER — proceed without even
  // spending a decision call. This is the deterministic half of the "two
  // questions in a row" fix (the prompt also reinforces it as a backstop).
  if (justAskedQuestion(history)) return PROCEED;

  // Ground the decision in the workspace's REAL niches so it can't invent
  // options the workspace doesn't track. Cheap + cached; [] on any failure.
  const niches = await workspaceNiches(opts.workspaceId);
  // Two-block system message so the stable HEAD caches: the head is
  // byte-identical every call (a cache breakpoint sits on it), the small
  // variable grounding rides uncached after it. On a warm turn the head reads
  // at the cache rate (10x cheaper on Sonnet 5). Order is preserved vs. the
  // single-string form: head → variable-with-tail. (Gemini honors only the
  // LAST breakpoint; there's exactly one, on the head, so both providers cache
  // the head correctly.)
  const variable = buildDecisionSystemVariable({
    niches,
    justAsked: false,
    customSkillNames: opts.customSkillNames,
  });

  try {
    const attempt = await runCoworkAdapterAttempt({
      registry: opts.adapterHealth ?? coworkAdapterHealth,
      adapterKey: `cowork_legacy_decision:${DECISION_MODEL}`,
      signal: opts.signal,
      call: () =>
        completeChat({
          model: DECISION_MODEL,
          maxTokens: 300,
          timeoutMs: DECISION_TIMEOUT_MS,
          tools: [DECISION_TOOL],
          forceTool: "decide",
          messages: [
            {
              role: "system",
              content: [
                {
                  type: "text",
                  text: DECISION_SYSTEM_HEAD,
                  cache_control: { type: "ephemeral" },
                },
                { type: "text", text: variable },
              ],
            },
            ...context,
          ],
          signal: opts.signal,
        }),
      validate: (response) => {
        const toolArgs = response.toolArgs;
        if (!toolArgs || typeof toolArgs.shouldAsk !== "boolean") {
          throw new Error("Decision response was missing its required schema.");
        }
        if (
          toolArgs.shouldAsk === true &&
          (typeof toolArgs.question !== "string" ||
            !Array.isArray(toolArgs.options) ||
            toolArgs.options.filter((option) => typeof option === "string")
              .length < 2)
        ) {
          throw new Error("Decision response contained an invalid question.");
        }
        return parseDecision(toolArgs);
      },
      persistUsage: (response) => {
        if (!opts.workspaceId) return Promise.resolve();
        const attribution = providerModelAttribution(DECISION_MODEL, response.model);
        return logOpenRouterUsage(
          "decide",
          attribution.model,
          response.usage,
          opts.workspaceId,
          attribution.metadata,
        );
      },
      usage: (response) => response.usage,
      responseModel: (response) => response.model,
      telemetry: opts.telemetry,
      stage: "legacy_decision_prepass",
      attempt: 1,
      model: DECISION_MODEL,
      rejectedReasonCode: "invalid_decision_response",
    });
    return attempt.value;
  } catch (error) {
    if (
      error instanceof UsagePersistenceError ||
      (error instanceof Error && error.name === "UsagePersistenceError")
    ) {
      throw error;
    }
    // Provider/content failures fail open to the deterministic main route.
    return PROCEED;
  }
}

// Rough token footprint of a decision call, for the cost note in tests/docs.
export function decisionPromptTokens(history: ChatMessage[]): number {
  const ctx = decisionContext(history)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
  const system = buildDecisionSystem({ niches: [], justAsked: false });
  return estimateTokens(system) + estimateTokens(ctx);
}
