import { z } from "zod";
import {
  composerStarterIdSchema,
  type ComposerStarterId,
} from "@/lib/composer-task-context";
import {
  explorationLaneSchema,
  type ExplorationLane,
} from "@/lib/content-learning/contracts";

export const draftKey = (id: string | null) =>
  `swipein:chat-draft:${id ?? "__new__"}`;

export type ComposerDraft = {
  text: string;
  starterId: ComposerStarterId | null;
  explorationLane: ExplorationLane | "auto";
};

const storedComposerDraftSchema = z
  .object({
    version: z.literal(1),
    text: z.string(),
    starterId: composerStarterIdSchema.nullable(),
    explorationLane: explorationLaneSchema.or(z.literal("auto")).optional(),
  })
  .strict();

const EMPTY_COMPOSER_DRAFT: ComposerDraft = {
  text: "",
  starterId: null,
  explorationLane: "auto",
};

function serializeComposerDraft(draft: ComposerDraft): string {
  return JSON.stringify({ version: 1, ...draft });
}

/**
 * Read the complete per-chat composer draft. Plain strings from older builds
 * remain valid and are migrated the next time the draft is written.
 */
export function readComposerDraft(id: string | null): ComposerDraft {
  try {
    const raw = localStorage.getItem(draftKey(id));
    if (raw === null) return EMPTY_COMPOSER_DRAFT;
    try {
      const parsed = storedComposerDraftSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        return {
          text: parsed.data.text,
          starterId: parsed.data.starterId,
          explorationLane: parsed.data.explorationLane ?? "auto",
        };
      }
    } catch {
      // Legacy entries are plain text, not JSON.
    }
    return { text: raw, starterId: null, explorationLane: "auto" };
  } catch {
    return EMPTY_COMPOSER_DRAFT;
  }
}

/** Persist prompt copy and selected starter together behind one boundary. */
export function writeComposerDraft(
  id: string | null,
  draft: ComposerDraft,
): void {
  try {
    if (
      draft.text.trim() ||
      draft.starterId !== null ||
      draft.explorationLane !== "auto"
    ) {
      localStorage.setItem(draftKey(id), serializeComposerDraft(draft));
    } else {
      localStorage.removeItem(draftKey(id));
    }
  } catch {
    // Draft persistence is best-effort; storage can be disabled by the browser.
  }
}

/**
 * Transfer the compose-ahead slot only after the destination write succeeds.
 * This keeps an eager new-chat race from losing either text or starter intent.
 */
export function moveComposerDraft(
  fromId: string | null,
  toId: string,
  textOverride?: string,
): void {
  try {
    const source = readComposerDraft(fromId);
    const moved = {
      ...source,
      ...(textOverride === undefined ? {} : { text: textOverride }),
    };
    if (
      moved.text.trim() ||
      moved.starterId !== null ||
      moved.explorationLane !== "auto"
    ) {
      localStorage.setItem(draftKey(toId), serializeComposerDraft(moved));
    } else {
      localStorage.removeItem(draftKey(toId));
    }
    localStorage.removeItem(draftKey(fromId));
  } catch {
    // Leave the source intact when the destination cannot be written.
  }
}

/** Consume workflow metadata after send while leaving prompt restoration safe. */
export function clearComposerStarter(id: string | null): void {
  const draft = readComposerDraft(id);
  writeComposerDraft(id, { ...draft, starterId: null });
}

export function writeComposerExplorationLane(
  id: string | null,
  explorationLane: ComposerDraft["explorationLane"],
): void {
  const draft = readComposerDraft(id);
  writeComposerDraft(id, { ...draft, explorationLane });
}

export function consumeComposerExplorationLane(
  turnChatId: string,
  activeChatId: string | null,
): ComposerDraft["explorationLane"] | null {
  writeComposerExplorationLane(turnChatId, "auto");
  return turnChatId === activeChatId ? "auto" : null;
}

export function readDraft(id: string | null): string {
  return readComposerDraft(id).text;
}

export function writeDraft(id: string | null, text: string): void {
  const existing = readComposerDraft(id);
  writeComposerDraft(id, {
    text,
    starterId: text.trim() ? existing.starterId : null,
    explorationLane: existing.explorationLane,
  });
}
