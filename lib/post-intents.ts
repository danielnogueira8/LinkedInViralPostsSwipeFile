// Contextual AI actions a user can launch from a post card. Each intent stashes
// the post via /api/model-source (so the full, server-resolved text rides into
// the chat safely) and opens the chat at /dashboard?model=<id>&intent=<key>,
// where the chat prefills the matching instruction in the composer.
//
// Shared between the post card (renders the action menu) and the chat workspace
// (turns ?intent=<key> back into the prefilled prompt) so the two never drift.
//
// "model" is the original behavior — write an original post after this one,
// matching its structure. The others are analysis/derivation where the post is
// the subject rather than a structural template.

export type PostIntentKey =
  | "model"
  | "refine"
  | "breakdown"
  | "variations"
  | "why"
  | "fill_template";

export type PostIntent = {
  key: PostIntentKey;
  // Menu label shown on the card.
  label: string;
  // Lucide icon name — resolved to a component at the call site so this module
  // stays free of React/icon imports.
  icon: "message-square" | "scan-text" | "copy-plus" | "lightbulb";
  // The composer prompt. The post text itself is woven in server-side via the
  // modeling envelope, so the prompt refers to "the attached post".
  prompt: string;
  // True when the prompt contains a [placeholder] the user should fill before
  // sending (the composer selects that span on prefill).
  hasPlaceholder?: boolean;
};

export const POST_INTENTS: Record<PostIntentKey, PostIntent> = {
  model: {
    key: "model",
    label: "Model this post",
    icon: "message-square",
    // Predefined + ready to send: no [placeholder] to fill, so "Model in Chat"
    // works in one click. The agent models the attached post's structure/hook
    // in the user's voice on a topic that fits them (it loads the voice profile
    // first). The user can still steer the topic in a follow-up message.
    prompt:
      "Model an original post in my voice after the attached post. Keep its structure and hook style, but make the content mine — pick a topic that fits my voice and niche. If you need direction on the topic, ask me in one short line.",
  },
  refine: {
    key: "refine",
    label: "Refine this post",
    icon: "message-square",
    // The attached post is the user's OWN draft (source: 'draft'). Refine it in
    // place rather than modeling a new one after it. Has a [placeholder] so the
    // user can say what to change before sending; the composer selects that span.
    prompt:
      "Refine the attached post: [tell me what to change]. Keep it in my voice, return the full improved version.",
    hasPlaceholder: true,
  },
  breakdown: {
    key: "breakdown",
    label: "Break down the hook",
    icon: "scan-text",
    prompt:
      "Break down the hook of the attached post. What pattern is it using, why does it stop the scroll, and how could I reuse that hook structure for my own content? Keep it tight and practical.",
  },
  variations: {
    key: "variations",
    label: "Draft 3 variations in my voice",
    icon: "copy-plus",
    prompt:
      "Using the attached post as a structural reference, draft 3 original variations in my voice on a topic that fits me. Keep its structure and hook style, but make each one original and distinct.",
  },
  why: {
    key: "why",
    label: "Why did this work?",
    icon: "lightbulb",
    prompt:
      "Analyze the attached post: why did it perform? Walk through the hook, structure, and what makes it resonate — then give me 2–3 takeaways I can apply to my own posts. Don't rewrite it.",
  },
  // The attached source is a TEMPLATE (source: 'template'): a fill-in-the-blank
  // skeleton, not a real post. The agent fills its {placeholders} in the user's
  // voice on a topic that fits them, keeping the structure. Has a [placeholder]
  // so the user can name the topic before sending; the composer selects it.
  fill_template: {
    key: "fill_template",
    label: "Model in Chat",
    icon: "message-square",
    prompt:
      "Fill in the attached template in my voice about [topic]. Keep the structure and hook style. Fill the placeholders you can from my topic and voice; for anything that needs a specific fact about my business you don't have (my offer, a real result, a client), ask me first instead of making it up.",
    hasPlaceholder: true,
  },
};

// Validate an arbitrary string as an intent key, defaulting to "model" (the
// original behavior) so a stale/garbled ?intent= never breaks the handoff.
export function resolveIntent(key: string | null | undefined): PostIntent {
  if (key && key in POST_INTENTS) return POST_INTENTS[key as PostIntentKey];
  return POST_INTENTS.model;
}
