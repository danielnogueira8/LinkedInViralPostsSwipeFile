import { supabaseAdmin } from "@/lib/supabase";
import { neutralizeMarkers, wrapUntrustedDelimited } from "@/lib/agent/untrusted";
import type { NoModelFormatId } from "@/lib/agent/no-model-format-catalog";

// ---------------------------------------------------------------------------
// No-model LinkedIn format router.
//
// The problem: a MODELED post (the user attached a "--- POST TO MODEL AFTER ---"
// envelope, a template, or a refine target) gives the writing agent a concrete
// STRUCTURAL reference — a real post whose hook, rhythm, line breaks, and CTA
// shape it can mirror. A FROM-SCRATCH post ("write a post about X") gives it
// none of that: the agent has the always-on anti-slop + structure-variety
// skills (a MENU of shapes) but must still pick the right architecture while
// also gathering voice, facts, hook, and CTA. So from-scratch drafts drift
// generic.
//
// This module is the missing DECISION layer for the no-model case ONLY. It's a
// SILENT, DETERMINISTIC (no LLM) router: given the user's message, pick a
// LinkedIn-native archetype, fetch 1-2 REAL exemplar posts from the DB by id,
// and hand the writing agent format rules + full examples to model the STRUCTURE
// of (never the facts/text). It does NOT touch the modeled / template / refine /
// weekly-batch flows — when a source post exists, that source stays the
// structural authority. See run.ts (noModelFormatBlock) + the stream route for
// the activation gate.
//
// Why deterministic (not an LLM router) for v1: no extra model call means no
// added latency/cost on the hot path, and keyword rules are predictable +
// unit-testable. A future version can upgrade to a structured-JSON LLM router
// and workspace-level format memory (see the PR notes); the format library +
// exemplar-id plumbing here are the foundation for that.
//
// Security: exemplar post bodies are scraped LinkedIn content (attacker-
// controllable — a creator can write "ignore previous instructions" in a post).
// We neutralize forged envelope markers before the text reaches the prompt, and
// the block itself tells the model the examples are DATA to study for structure,
// never instructions and never facts to copy. The exemplars are used PRIVATELY
// (fed to the model, never surfaced to the user, never cited), so they can't
// leak a specific creator's wording into a user-facing card.
// ---------------------------------------------------------------------------

export type { NoModelFormatId };

export type NoModelFormat = {
  id: NoModelFormatId;
  label: string;
  // Human-readable cues for when this shape fits — surfaced to the model so it
  // understands the archetype's intent, not just its skeleton.
  whenToUse: string[];
  // Facts the shape needs to land. The model fills what it can derive (topic,
  // audience from the voice profile) and treats the genuine unknowns (a real
  // offer, a real result) as facts to ASK for or bracket — never to invent.
  requiredContext: string[];
  // The architecture to MODEL — a shape, not a fill-in template.
  structure: string[];
  // Failure modes to steer away from for this shape specifically.
  avoid: string[];
  // Real swipe-file post ids (global tracked posts) whose full text is fetched
  // at generation time and shown to the model as structure-only exemplars.
  exemplarPostIds: string[];
};

// The archetype library. These are flexible SHAPE guidance, deliberately kept
// small (8 formats) so this stays a decision layer, not a hidden template
// engine. Exemplar ids are curated global tracked posts — the full text is
// fetched from the DB per turn (loadNoModelFormatExamples), never hardcoded
// here, so we neither bloat the source with scraped bodies nor ship stale text.
export const NO_MODEL_FORMATS: NoModelFormat[] = [
  {
    id: "lead_magnet_system_breakdown",
    label: "Lead Magnet: System Breakdown",
    whenToUse: [
      "free resource",
      "comment keyword",
      "workflow",
      "playbook",
      "system giveaway",
    ],
    requiredContext: ["resource", "audience", "outcome", "CTA keyword"],
    structure: [
      "Sharp claim or category-death hook",
      "Show the old/manual pain",
      "Introduce the system/resource",
      "Explain what it does",
      "List concrete contents or capabilities",
      "End with one clear comment/connect CTA",
    ],
    avoid: ["multiple CTAs", "fake proof", "vague resource names"],
    exemplarPostIds: [
      "71837d68-6a8f-47a0-a116-09390a6674c7",
      "e72ce410-2000-4861-871d-440cf20d161e",
      "02bf8c6f-c21e-49db-9e25-bba275c6cdea",
    ],
  },
  {
    id: "lead_magnet_resource_inventory",
    label: "Lead Magnet: Resource Inventory",
    whenToUse: [
      "bundle",
      "library",
      "template pack",
      "agent pack",
      "resource list",
    ],
    requiredContext: ["resource name", "what is inside", "CTA keyword"],
    structure: [
      "Name the resource clearly",
      "State who it helps",
      "List what is inside",
      "Explain purpose in one plain paragraph",
      "End with comment/like/repost CTA if requested",
    ],
    avoid: ["generic 'ultimate guide' with no specifics"],
    exemplarPostIds: [
      "b9956d47-5e5b-4b0d-9dde-fe6cee537d35",
      "1e84438b-2c8f-4eba-9a3c-e77e60489ce0",
      "26514f8f-a82a-42fc-a57c-54daa0bca030",
    ],
  },
  {
    id: "personal_authority_story",
    label: "Personal Authority Story",
    whenToUse: [
      "personal update",
      "lesson from life",
      "founder story",
      "return after absence",
    ],
    requiredContext: ["real event", "lesson or emotional point"],
    structure: [
      "Personal hook",
      "Explain the context",
      "Add lived details",
      "Connect back to work/audience",
      "End with a human question or quiet close",
    ],
    avoid: ["invented anecdotes", "forced business lesson"],
    exemplarPostIds: ["bd1e5bb2-2c2c-42a8-a5c1-929ff90040cb"],
  },
  {
    id: "identity_belief_letter",
    label: "Identity / Belief Letter",
    whenToUse: [
      "audience belief",
      "encouragement",
      "identity friction",
      "values post",
    ],
    requiredContext: ["specific audience", "belief or tension"],
    structure: [
      "Direct address to the audience",
      "Name repeated lived tensions",
      "Make the conviction turn",
      "Give the reader a belief to keep",
      "Close with a memorable signoff",
    ],
    avoid: ["generic motivation", "fake struggle"],
    exemplarPostIds: ["1137166b-a11b-4a1d-baec-5070674d4f1b"],
  },
  {
    id: "explainer_framework_breakdown",
    label: "Explainer / Framework Breakdown",
    whenToUse: [
      "explain a concept",
      "framework",
      "levels",
      "analogy",
      "technical education",
    ],
    requiredContext: ["concept", "reader problem"],
    structure: [
      "Simple hook naming the complexity",
      "Use an analogy or organizing frame",
      "Break into numbered sections",
      "Each section explains what it is and why it matters",
      "End with implication or diagnostic question",
    ],
    avoid: ["too many terms without payoff"],
    exemplarPostIds: [
      "6949e6dc-93c4-4727-86be-e232071ef5d4",
      "c3e35927-2522-4036-bd59-8e8f844e2226",
      "99e171b9-2a55-4f52-bee8-857727a2c624",
    ],
  },
  {
    id: "tactical_listicle",
    label: "Tactical Listicle",
    whenToUse: ["tips", "mistakes", "lessons", "steps", "checklist"],
    requiredContext: ["topic", "audience"],
    structure: [
      "Promise the list",
      "Use numbered items with the short heading on the numbered line",
      "If an item has explanation, add a blank line after the heading before the body",
      "Each item earns itself with explanation",
      "Do not force exactly three points",
      "End with the most important takeaway",
    ],
    avoid: [
      "bare one-line bullets",
      "split numbered headings",
      "flattened heading-plus-body paragraphs",
    ],
    exemplarPostIds: [
      "dd0717c2-ad8d-4e4c-901a-80c9d3f85174",
      "841aaa1c-710d-400b-bcf8-9542e8871288",
    ],
  },
  {
    id: "event_announcement",
    label: "Event / Announcement",
    whenToUse: [
      "launch",
      "event",
      "live session",
      "coming to",
      "announcement",
    ],
    requiredContext: ["event", "why now", "what audience gets"],
    structure: [
      "Announce the event",
      "Explain why it matters now",
      "Tell people what they will get",
      "Invite questions, attendance, or recommendations",
      "Keep the CTA social and light",
    ],
    avoid: ["corporate event copy"],
    exemplarPostIds: [
      "32e84c11-f2ff-4689-9757-f9f4b97222c5",
      "d57a37d8-60dc-4f7e-995e-9892e944c995",
    ],
  },
  {
    id: "offer_proof_giveaway",
    label: "Offer / Proof / Giveaway Hybrid",
    whenToUse: ["case study", "proof", "free guide", "specific result"],
    requiredContext: ["proof point or honest placeholder", "resource", "CTA"],
    structure: [
      "Lead with proof or concrete change",
      "Explain what changed",
      "List what the reader gets",
      "Tie back to the audience pain",
      "End with comment CTA",
    ],
    avoid: ["made-up metrics", "fake clients", "unsupported results"],
    exemplarPostIds: [
      "0be822f0-9036-45c2-8087-5e5dddd585b1",
      "5d9c2217-5cda-4d29-a76f-59cebdf83fcb",
      "979e5b4e-1f5d-4f85-98d8-2b8f823bd7cb",
    ],
  },
  {
    id: "contrarian_take",
    label: "Contrarian Take",
    whenToUse: [
      "challenge common advice",
      "a clear accepted belief exists",
      "point-of-view / authority",
      "unpopular opinion",
    ],
    requiredContext: ["topic", "the common belief being challenged"],
    structure: [
      "Name the common belief plainly (the thing everyone accepts)",
      "Reverse it: state why it's wrong or incomplete",
      "Give the specific reason / mechanism it fails",
      "Show what actually works instead, concretely",
      "Land on the practical implication (soft question or no CTA)",
    ],
    avoid: [
      "strawman arguments",
      "manufactured 'hot take' phrasing",
      "fake proof",
    ],
    // Real exemplars (hand-picked, DB-verified): belief → reversal → mechanism.
    // Luis Rodrigues "Most people think Agentic AI is just ChatGPT + tools.
    // They're wrong."; Luis "AI gives wrong answers because it's not smart
    // enough. Usually it's the opposite."; Emilia Moller "Common misconception:
    // SEO = rankings. It isn't." (a different niche, same shape).
    exemplarPostIds: [
      "c7fd70ae-7aef-4a1d-bfdb-7fabb75cb2c7",
      "ad525afa-edcd-43c7-8254-2d7aac01c076",
      "f4dcf577-b9fd-4d93-b97f-bc13276d85bf",
    ],
  },
  {
    id: "mistake_breakdown",
    label: "Mistake Breakdown",
    whenToUse: [
      "the ask is about a mistake or avoidable failure",
      "audience needs a tactical correction",
      "a common wrong default exists",
    ],
    requiredContext: ["audience", "the mistake / wrong default"],
    structure: [
      "Name the mistake in plain language",
      "Why smart people make it (make it forgivable, not dumb)",
      "What it costs — the concrete consequence",
      "What to do instead — the better behavior",
      "One concrete example or a save-worthy close",
    ],
    avoid: [
      "condescension",
      "inventing a personal war story",
      "a generic 'avoid these 5 things' list with no reasoning",
    ],
    // Real exemplars: Luis "Most people open Claude Code and start typing.
    // That's the mistake… I lost a few days to this." (mistake → cost → fix);
    // Luis "Everyone wants to be AI-first. Nobody wants to fix the data."
    // (mistake of omission).
    exemplarPostIds: [
      "0b3faff3-bbec-4e88-8737-5b7a81ecf495",
      "9dae2d9b-ff37-43cc-8ee5-334f6bcac91a",
    ],
  },
  {
    id: "before_after_transformation",
    label: "Before / After Transformation",
    whenToUse: [
      "there is a real messy starting state and a real change",
      "a journey / turnaround the user actually lived",
      "case-study-adjacent without needing fabricated metrics",
    ],
    requiredContext: ["the starting state", "the change", "the result"],
    structure: [
      "Open in the messy 'before' — the specific starting state",
      "The turning point — the specific change that was made",
      "What shifted as a result, honestly qualified",
      "The concrete 'after' (real numbers or details, never invented)",
      "The takeaway for the reader — what's transferable",
    ],
    avoid: [
      "invented metrics",
      "fake before/after numbers",
      "a rags-to-riches arc that didn't happen",
    ],
    // Real exemplars: Lara Acosta "In 2023, I felt burnt out… messy… 1-person
    // team" → the systems that changed it; Chris Donelly "We took Searchable
    // from 0 → $85M in 5 months… I made countless mistakes… became my system."
    exemplarPostIds: [
      "ac19f60a-8f70-4339-aed0-c6340fb1280b",
      "e337e66b-0813-4c0a-9489-aadc526d7a08",
    ],
  },
];

const FORMATS_BY_ID = new Map<NoModelFormatId, NoModelFormat>(
  NO_MODEL_FORMATS.map((f) => [f.id, f]),
);

function byId(id: NoModelFormatId): NoModelFormat {
  const f = FORMATS_BY_ID.get(id);
  // The router only ever passes ids from NoModelFormatId, so this can't miss in
  // practice; throw loudly if the library and the union ever drift apart.
  if (!f) throw new Error(`unknown no-model format id: ${id}`);
  return f;
}

export function getNoModelFormatById(id: NoModelFormatId): NoModelFormat {
  return byId(id);
}

export function selectNoModelFormatForTurn(
  userText: string,
  forcedId?: NoModelFormatId,
): NoModelFormat {
  return forcedId ? byId(forcedId) : selectNoModelFormat(userText);
}

// Deterministic keyword router. Returns the archetype whose intent best matches
// the user's message. Order matters: the most explicit intents (lead magnet,
// story, belief) are checked before the broad fallbacks so a message that trips
// several buckets lands in the strongest one. The fallback (a from-scratch post
// with no strong signal) is the explainer shape — a single-concept breakdown is
// the safest neutral default, and the structure-variety skill still nudges the
// model to vary from its recent posts. Pure + exported for tests.
export function selectNoModelFormat(userText: string): NoModelFormat {
  const t = userText.toLowerCase();

  // A resource BUNDLE/library/pack is a lead-magnet whether or not the words
  // "lead magnet" appear — route it to the inventory shape directly. Checked
  // before the general lead-magnet block so a "system playbook giveaway" still
  // wins the system-breakdown shape below.
  if (/\bbundle\b|\blibrary\b|template pack|resource pack|\bagent pack\b/.test(t)) {
    return byId("lead_magnet_resource_inventory");
  }

  if (
    /lead magnet|giveaway|free resource|comment|dm me|send it|playbook|guide/.test(
      t,
    )
  ) {
    if (/system|workflow|agent|automation|playbook/.test(t)) {
      return byId("lead_magnet_system_breakdown");
    }
    return byId("lead_magnet_resource_inventory");
  }

  // Contrarian take: the message challenges an accepted belief. Checked HIGH so
  // "most people think X" / "unpopular opinion" wins over the broad
  // explainer/listicle rules below (which would otherwise swallow it).
  if (
    /contrarian|unpopular opinion|hot take|most people (think|believe|assume)|everyone (says|thinks|believes)|conventional wisdom|common misconception|\bmyth\b|you'?ve been told|stop (doing|telling)/.test(
      t,
    )
  ) {
    return byId("contrarian_take");
  }

  // A PERSONAL story ("when I", "the time I", "I learned") stays a story even
  // when it involves a mistake — so this is checked BEFORE mistake_breakdown,
  // which is the impersonal, tactical-correction shape.
  if (/story|lesson|happened|when i|the time i|i almost|i learned|personal/.test(t)) {
    return byId("personal_authority_story");
  }

  // Mistake breakdown: the ask is ABOUT a mistake / avoidable failure (impersonal
  // — a personal one was caught above). Checked before the listicle rule so
  // "the mistakes founders make with X" isn't flattened into a bare tips list.
  if (/mistake|mistakes|getting .* wrong|the wrong way|avoid(able)? (mistake|failure)|why .* (fail|struggle)/.test(t)) {
    return byId("mistake_breakdown");
  }

  // Before/after transformation: an explicit turnaround / journey with a real
  // start and end. Checked before the listicle/explainer fallback (a "went from
  // X to Y" story isn't a listicle).
  if (/before (and|\/|&) after|before\/after|transformation|turnaround|went from|used to .* now|\d+\s?(x|%)\b.*(result|growth|increase)/.test(t)) {
    return byId("before_after_transformation");
  }

  if (/belief|for founders|if you're|small|identity|people like us/.test(t)) {
    return byId("identity_belief_letter");
  }
  if (/framework|explain|break down|levels|what is|how .* works/.test(t)) {
    return byId("explainer_framework_breakdown");
  }
  if (/list|tips|steps|lessons|checklist|things/.test(t)) {
    return byId("tactical_listicle");
  }
  if (/launch|event|webinar|live|coming to|announcement/.test(t)) {
    return byId("event_announcement");
  }
  if (/case study|result|proof|booked|saved|increased|decreased/.test(t)) {
    return byId("offer_proof_giveaway");
  }

  return byId("explainer_framework_breakdown");
}

// A resolved exemplar — the full post text plus light engagement context, used
// privately as a structure-only reference for the model.
export type NoModelExample = {
  id: string;
  author: string | null;
  niche: string | null;
  text: string;
  engagement: {
    reactions: number | null;
    comments: number | null;
    reposts: number | null;
    viral_score: number | null;
  };
};

type ExampleRow = {
  id: string;
  text: string | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  viral_score: number | null;
  accounts:
    | { name?: string | null; niche?: string | null }
    | { name?: string | null; niche?: string | null }[]
    | null;
};

// Fetch the full text of a format's exemplar posts from the DB. The exemplars
// are curated GLOBAL tracked posts, so this looks them up by id WITHOUT the
// per-workspace account filter used for user-facing cites — every workspace
// should see the same reference architecture. The workspaceId arg is kept for a
// future version that scopes exemplars per workspace; unused today.
//
// Never throws: a DB blip or a since-deleted exemplar just yields fewer (or no)
// examples, and the caller degrades to format-rules-only. Post bodies are run
// through neutralizeMarkers so a forged envelope marker in scraped text can't
// break out of the example block.
export async function loadNoModelFormatExamples(
  format: NoModelFormat,
  // Reserved for future per-workspace exemplar scoping — see note above.
  _workspaceId: string,
  limit = 2,
): Promise<NoModelExample[]> {
  try {
    const ids = format.exemplarPostIds.slice(0, limit);
    if (ids.length === 0) return [];
    const { data, error } = await supabaseAdmin()
      .from("posts")
      .select(
        "id, text, reactions, comments, reposts, viral_score, accounts!inner(name, niche)",
      )
      .in("id", ids);
    if (error || !data) return [];
    const byIdMap = new Map<string, NoModelExample>();
    for (const raw of data as ExampleRow[]) {
      if (typeof raw.text !== "string" || !raw.text.trim()) continue;
      const acc = Array.isArray(raw.accounts) ? raw.accounts[0] : raw.accounts;
      byIdMap.set(raw.id, {
        id: raw.id,
        author: acc?.name ?? null,
        niche: acc?.niche ?? null,
        text: neutralizeMarkers(raw.text),
        engagement: {
          reactions: raw.reactions,
          comments: raw.comments,
          reposts: raw.reposts,
          viral_score: raw.viral_score,
        },
      });
    }
    // Preserve the curated exemplar order (the DB may return rows in any order),
    // and drop ids that didn't resolve.
    return ids
      .map((id) => byIdMap.get(id))
      .filter((e): e is NoModelExample => !!e);
  } catch {
    return [];
  }
}

// Render the format guidance + full exemplars into ONE system block for the
// writing agent. Kept SEPARATE from the global writing/structure skills (those
// stay broad and cached); this block is the exact architecture for THIS turn and
// varies per turn (different examples), so it's injected uncached (see run.ts).
//
// The framing is explicit on the two failure modes: (1) study STRUCTURE only,
// never copy facts/wording/CTAs/names/metrics; (2) don't invent facts — ask or
// bracket the genuine unknowns. Voice profile still outranks this shape.
export function renderNoModelFormatBlock(
  format: NoModelFormat,
  examples: NoModelExample[],
): string {
  const whenToUse = format.whenToUse.map((x) => `- ${x}`).join("\n");
  const structure = format.structure
    .map((x, i) => `${i + 1}. ${x}`)
    .join("\n");
  const avoid = format.avoid.map((x) => `- ${x}`).join("\n");

  const exampleBlocks = examples
    .map((e, i) => {
      const reactions = e.engagement.reactions ?? 0;
      const comments = e.engagement.comments ?? 0;
      const wrapped = wrapUntrustedDelimited({
        label: "EXAMPLE POST START",
        endLabel: "EXAMPLE POST END",
        text: e.text,
      });
      return `Example ${i + 1}
Author: ${e.author ?? "Unknown"}
Engagement: ${reactions} reactions, ${comments} comments
${wrapped}`;
    })
    .join("\n\n");

  // When no exemplar resolved (DB blip / deleted post), the block still gives
  // the model the format rules — it just omits the examples section rather than
  // printing an empty "study these" header with nothing under it.
  const examplesSection = examples.length
    ? `Real LinkedIn examples to study for STRUCTURE ONLY.
Do not copy wording, facts, claims, CTAs, names, metrics, or offers.
Borrow only the architecture, rhythm, line breaks, hook mechanics, proof placement, and CTA shape.

${exampleBlocks}`
    : "";

  const missingContext = `If the selected format requires a real fact the user has not provided, do not invent it.
If the missing fact is essential (a real offer, a real result/metric, a client, a CTA keyword for a lead magnet), ask ONE concise ask_user question.
If the user clearly wants speed, use a bracketed token like [YOUR RESULT] or write around the missing fact without pretending it exists.
Ask only for facts that would be dangerous or low-quality to invent — do not ask for everything.`;

  return `The user asked for a NEW LinkedIn post with no source post, template, or refine target.

Internal no-model LinkedIn format selected: ${format.label}

Use this format silently. Do NOT tell the user which format was selected or that a format was selected.

When to use:
${whenToUse}

Structure to model:
${structure}

Avoid:
${avoid}

${examplesSection}

${missingContext}

Priority: the user's voice profile (get_voice) outranks this structure — match their voice first, and use this shape only to give the post a proven architecture. Do not use a source-post modeling shape (none was provided). Render exactly one complete post with render_post unless the user asked for several.`.replace(
    /\n{3,}/g,
    "\n\n",
  );
}

// Detect whether the current turn is a genuine FROM-SCRATCH post request — the
// only case the router activates for. Two gates:
//   (1) No model/template/refine source. hasModelSource is true when the stream
//       route resolved a modelSourceId for THIS turn (a "Model this post",
//       template-fill, or refine). We ALSO defensively check the raw envelope
//       markers in case they ever reach the text directly.
//   (2) The message reads like a request to WRITE a post — not "give me hooks",
//       "analyze this", "find posts", or a board command (save/schedule/move).
// Pure + exported for tests.
const POST_REQUEST_RE =
  /\b(write|draft|create|make|turn this into|post about|linkedin post)\b/i;
const ENVELOPE_RE =
  /--- POST TO MODEL AFTER ---|--- TEMPLATE TO FILL ---|--- POST TO REFINE ---/;
// Deliverables that are NOT a full from-scratch post, or board/search commands.
// If the message is really about one of these, the router stays out of the way
// even when a "write"/"make" verb is present ("make these hooks punchier").
const NON_POST_INTENT_RE =
  /\b(hooks?|openers?|analyze|analyse|teardown|find posts?|search|save|schedule|move|mark)\b/i;

export function isNoModelPostRequest(
  userText: string,
  hasModelSource: boolean,
): boolean {
  if (hasModelSource) return false;
  if (ENVELOPE_RE.test(userText)) return false;
  if (!POST_REQUEST_RE.test(userText)) return false;
  // A hook/analysis/board command that happens to include a write verb is not a
  // from-scratch post — let the normal flow handle it.
  if (NON_POST_INTENT_RE.test(userText)) return false;
  return true;
}
