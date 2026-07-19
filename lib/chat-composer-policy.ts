import type { AskQuestion } from "@/lib/agent/contracts";
import { isLeadMagnetNoModelFormat, type NoModelFormatId } from "@/lib/agent/no-model-format-catalog";
import { isTerminalAskAnswer } from "@/lib/chat-ask";
import type { Message } from "@/lib/chat-hydration";

// ---------------------------------------------------------------------------
// Starter-prompt placeholders. A starter like "Write a post about [topic]" ships
// a [bracketed] span the user is meant to fill. If they send it unfilled, the
// agent would guess (or, worse, draft about the literal "[topic]"). These helpers
// detect + strip the placeholders so the composer can nudge the user, and so a
// deliberate second send can be turned into a clean "you pick" instruction.
//
// The pattern is deliberately CONSERVATIVE — a placeholder is a short token of
// letters/spaces/hyphens/slashes inside single brackets (e.g. [topic], [person],
// [company name], [your niche]). It does NOT match natural bracketed prose with
// sentence punctuation ("[see the docs].") so we don't false-positive on a user
// who legitimately typed brackets.
// Exported so components/chat-rich-text.tsx can highlight the same unfilled
// spans inside a rendered draft body — one detection rule for both the
// composer nudge and the draft-card render, so they can't drift apart.
// ---------------------------------------------------------------------------
export const PLACEHOLDER_RE = /\[[A-Za-z][A-Za-z /-]*\]/g;

export function firstPlaceholderRange(text: string): [number, number] | null {
  PLACEHOLDER_RE.lastIndex = 0;
  const match = PLACEHOLDER_RE.exec(text);
  PLACEHOLDER_RE.lastIndex = 0;
  return match ? [match.index, match.index + match[0].length] : null;
}
const CLIENT_POST_REQUEST_RE =
  /\b(write|draft|create|make|model|turn this into|post about|linkedin post)\b/i;
const CLIENT_NON_POST_INTENT_RE =
  /\b(hooks?|openers?|analyze|analyse|teardown|find posts?|search|save|schedule|move|mark)\b/i;
const CLIENT_LEAD_MAGNET_INTENT_RE =
  /\b(lead[-\s]?magnet|giveaway|free resource|freebie|playbook|checklist|worksheet|comment .*send|comment .*dm|dm .*link)\b/i;
const CLIENT_EXPLICIT_REGULAR_POST_RE = /\bregular\s+post\b/i;

export function clientShouldApplyPostFormat(text: string, hasModelSource: boolean): boolean {
  if (hasModelSource) return false;
  if (!CLIENT_POST_REQUEST_RE.test(text)) return false;
  return !CLIENT_NON_POST_INTENT_RE.test(text);
}

export function clientShouldApplyLeadMagnet(
  text: string,
  hasModelSource: boolean,
  postFormatId: NoModelFormatId | null | undefined,
  hasSelectedLeadMagnet = false,
  modelSourcePostType: "regular" | "lead_magnet" | null = null,
): boolean {
  // A selected lead magnet is a RESOURCE HINT — which giveaway to use IF the
  // turn is a lead-magnet post — NOT a switch that forces every "write a post
  // about X" into a giveaway post. So merely having one selected no longer
  // turns a plain post request into a lead-magnet post: the message must show
  // explicit lead-magnet intent (CLIENT_LEAD_MAGNET_INTENT_RE), OR the user
  // must have explicitly picked the "Lead magnet post" FORMAT. This kills the
  // misuse where a leftover / accidental picker selection hijacked a regular
  // post. (The picker still helps: when the turn IS a lead-magnet post, the
  // selected resource is the one used.)
  if (postFormatId) return isLeadMagnetNoModelFormat(postFormatId);
  if (CLIENT_EXPLICIT_REGULAR_POST_RE.test(text)) return false;
  if (hasModelSource) {
    if (hasSelectedLeadMagnet) return true;
    // Modeling a classified lead-magnet source means preserving its giveaway
    // post type unless the user explicitly asks for a regular post above.
    if (modelSourcePostType === "lead_magnet") return true;
    return CLIENT_LEAD_MAGNET_INTENT_RE.test(text);
  }
  return CLIENT_LEAD_MAGNET_INTENT_RE.test(text);
}

export function leadMagnetPickerDisabledForSource(
  modelSourcePostType: "regular" | "lead_magnet" | null | undefined,
): boolean {
  void modelSourcePostType;
  return false;
}

export function suggestedLeadMagnetPromptForPost(
  userText: string,
  source: { postText: string; postType: "regular" | "lead_magnet" | null } | null,
): string {
  const cleanUserText = userText.replace(/\s+/g, " ").trim();
  const sourceText = source?.postText.replace(/\s+/g, " ").trim() ?? "";
  const parts: string[] = [];
  if (cleanUserText) {
    parts.push(`Create a practical lead magnet that supports this post request: ${cleanUserText}`);
  } else {
    parts.push("Create a practical lead magnet for this LinkedIn giveaway post.");
  }
  if (sourceText) {
    parts.push(`Use this modeled source angle for context, but make the resource original: ${sourceText.slice(0, 650)}`);
  }
  if (source?.postType === "lead_magnet") {
    parts.push("The modeled source is a lead-magnet/giveaway post, so the resource should be concrete enough to give away when someone comments.");
  }
  return parts.join("\n\n").slice(0, 1200);
}

// All placeholder tokens still present in the text (e.g. ["[topic]"]). Empty when
// none — the common case, so callers can early-out cheaply.
export function findPlaceholders(text: string): string[] {
  return text.match(PLACEHOLDER_RE) ?? [];
}

// Remove every placeholder token and tidy the surrounding whitespace/punctuation
// the removal leaves behind ("about [topic]." → "about."- then "about ." → fixed),
// so the stripped sentence still reads cleanly. Used on a deliberate second send
// (the user chose to proceed without filling) before appending the "you pick" note.
export function stripPlaceholders(text: string): string {
  return text
    .replace(PLACEHOLDER_RE, "")
    // Collapse a now-doubled space, and a dangling space before punctuation.
    .replace(/ {2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

export function looksLikeComposerRefine(message: string): boolean {
  const t = message.toLowerCase().trim();
  if (!t) return false;
  // Explicit "make a new / another / different" requests are NOT refines.
  // These take priority over the refine signal — if both fire, treat as new.
  if (
    /\b(another|new draft|fresh draft|different draft|other draft|alternative|variation|version 2|v2|a second|one more|give me \d+|draft \d+ more)\b/.test(
      t,
    )
  ) {
    return false;
  }
  // Refine signals — verbs + adjectives users naturally type when iterating
  // on the same draft. Anchored on word boundaries so substrings inside
  // unrelated words don't trip.
  return /\b(refine|tighten|shorten|lengthen|punchier|simpler|stronger|sharper|crisper|tweak|polish|improve|edit (this|the|it)|rewrite (this|the|it)|change (the|this)|update (this|the|it)|fix (this|the|it)|make it|make this|make the)\b/.test(
    t,
  );
}

// Ask-card answers need a slightly different heuristic from raw composer sends.
// In the composer, "make a variation" usually means "create another card", so
// looksLikeComposerRefine deliberately rejects it. But after the assistant asks
// "Anything else on this one?", the same wording is an edit to the current card:
// keep one draft and push the result into version history.
export function askAnswerShouldRefineLatestDraft(
  ask: Pick<AskQuestion, "question" | "options">,
  answer: string,
): boolean {
  const context = `${ask.question} ${ask.options.join(" ")}`.toLowerCase();
  const text = answer.toLowerCase().trim();
  if (!text) return false;
  const isPostDraftFollowUp =
    /\b(anything else|on this one|this one|this draft|the draft|change|edit|refine|tighten|shorter|hook|cta|list|listicle|variation)\b/.test(
      context,
    );
  if (!isPostDraftFollowUp) return false;
  if (isTerminalAskAnswer(text)) {
    return false;
  }
  return /\b(refine|tighten|shorten|shorter|lengthen|punchier|simpler|stronger|sharper|crisper|tweak|polish|improve|edit|rewrite|change|update|fix|make it|make this|make the|turn it into|turn this into|add|remove|cut|listicle|list-format|list format|numbered|variation|format|structure|hook|opener|cta|call to action)\b/.test(
    text,
  );
}

/**
 * Completion reconciliation must use the persisted user-row identity, never
 * prompt text. Text is not a turn identity: a repeated prompt can already have
 * an older assistant response in canonical history while the current request
 * is still waiting to be claimed.
 */
export function assistantAfterPersistedUserMessage(
  messages: Message[],
  userMsg: Message,
): Message | undefined {
  const userIdx = messages.findIndex(
    (message) =>
      message.role === "user" &&
      (message.id === userMsg.id ||
        Boolean(
          message.clientTurnId &&
            userMsg.clientTurnId &&
            message.clientTurnId === userMsg.clientTurnId,
        )),
  );
  if (userIdx < 0) return undefined;
  const afterUser = messages.slice(userIdx + 1);
  const nextUserIdx = afterUser.findIndex((message) => message.role === "user");
  return afterUser
    .slice(0, nextUserIdx >= 0 ? nextUserIdx : undefined)
    .find((message) => message.role === "assistant");
}

export function hasAssistantAfterPersistedUserMessage(
  messages: Message[],
  userMsg: Message,
): boolean {
  return Boolean(assistantAfterPersistedUserMessage(messages, userMsg));
}
