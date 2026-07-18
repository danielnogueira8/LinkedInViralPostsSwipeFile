import { z } from "zod";
import {
  composerStarterIdSchema,
  type ComposerStarterId,
} from "@/lib/composer-task-context";

export const draftKey = (id: string | null) =>
  `swipein:chat-draft:${id ?? "__new__"}`;

export type ComposerDraft = {
  text: string;
  starterId: ComposerStarterId | null;
};

const storedComposerDraftSchema = z
  .object({
    version: z.literal(1),
    text: z.string(),
    starterId: composerStarterIdSchema.nullable(),
  })
  .strict();

const EMPTY_COMPOSER_DRAFT: ComposerDraft = { text: "", starterId: null };

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
        };
      }
    } catch {
      // Legacy entries are plain text, not JSON.
    }
    return { text: raw, starterId: null };
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
    if (draft.text.trim()) {
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
    if (moved.text.trim()) {
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

export function readDraft(id: string | null): string {
  return readComposerDraft(id).text;
}

export function writeDraft(id: string | null, text: string): void {
  const existing = readComposerDraft(id);
  writeComposerDraft(id, {
    text,
    starterId: text.trim() ? existing.starterId : null,
  });
}
