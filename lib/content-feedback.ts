import { z } from "zod";
import {
  CONTENT_FEEDBACK_REASONS,
  type ContentFeedbackRating,
  type ContentFeedbackReason,
} from "@/lib/content-feedback-catalog";

export {
  CONTENT_FEEDBACK_REASONS,
  NEGATIVE_FEEDBACK_REASONS,
  POSITIVE_FEEDBACK_REASONS,
  type ContentFeedbackRating,
  type ContentFeedbackReason,
} from "@/lib/content-feedback-catalog";

export const CONTENT_FEEDBACK_BODY_SNAPSHOT_MAX = 5_000;
export const CONTENT_FEEDBACK_NOTE_MAX = 500;
export const CONTENT_FEEDBACK_REASONS_MAX = 4;
export const CONTENT_FEEDBACK_INJECTED_MAX = 8;
export const CONTENT_FEEDBACK_EXCERPT_MAX = 500;
export const CONTENT_FEEDBACK_INJECTED_CHARS_MAX = 4_000;

export type ContentFeedback = {
  id: string;
  workspace_id: string;
  chat_id: string | null;
  artifact_id: string | null;
  draft_id: string | null;
  rating: ContentFeedbackRating;
  reasons: ContentFeedbackReason[];
  note: string | null;
  body_snapshot: string;
  /** Sibling artifact id in a two-draft comparison (Phase B), if any. */
  competed_against: string | null;
  created_at: string;
};

const reasonSchema = z.enum(CONTENT_FEEDBACK_REASONS);

export function normalizeFeedbackBody(raw: string): string {
  return raw.trim().slice(0, CONTENT_FEEDBACK_BODY_SNAPSHOT_MAX);
}

export function normalizeFeedbackNote(raw: string | null | undefined): string | null {
  const note = (raw ?? "").replace(/\s+/g, " ").trim();
  return note ? note.slice(0, CONTENT_FEEDBACK_NOTE_MAX) : null;
}

function normalizeFeedbackExcerpt(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CONTENT_FEEDBACK_EXCERPT_MAX);
}

function uniqueReasons(reasons: ContentFeedbackReason[]): ContentFeedbackReason[] {
  return Array.from(new Set(reasons)).slice(0, CONTENT_FEEDBACK_REASONS_MAX);
}

export const contentFeedbackInputSchema = z
  .object({
    rating: z.enum(["up", "down"]),
    reasons: z.array(reasonSchema).default([]).transform(uniqueReasons),
    note: z.string().max(CONTENT_FEEDBACK_NOTE_MAX * 3).optional().nullable(),
    bodySnapshot: z
      .string()
      .min(1, "Content is required")
      .max(CONTENT_FEEDBACK_BODY_SNAPSHOT_MAX * 3)
      .transform(normalizeFeedbackBody)
      .refine((value) => value.length > 0, "Content is required"),
    chatId: z.string().uuid().optional().nullable(),
    artifactId: z.string().trim().min(1).max(120).optional().nullable(),
    draftId: z.string().uuid().optional().nullable(),
    competedAgainst: z.string().trim().min(1).max(120).optional().nullable(),
  })
  .transform((input) => ({
    rating: input.rating,
    reasons: input.reasons,
    note: normalizeFeedbackNote(input.note),
    body_snapshot: input.bodySnapshot,
    chat_id: input.chatId ?? null,
    artifact_id: input.artifactId ?? null,
    draft_id: input.draftId ?? null,
    competed_against: input.competedAgainst ?? null,
  }));

export type ContentFeedbackInput = z.infer<typeof contentFeedbackInputSchema>;

export function renderFeedbackMemoryBlock(
  feedback: ReadonlyArray<
    Pick<ContentFeedback, "rating" | "reasons" | "note" | "body_snapshot">
  > | null | undefined,
): string {
  if (!feedback || feedback.length === 0) return "";

  const positive: string[] = [];
  const negative: string[] = [];
  let chars = 0;
  const add = (rating: ContentFeedbackRating, line: string) => {
    if (chars + line.length + 3 > CONTENT_FEEDBACK_INJECTED_CHARS_MAX) {
      return false;
    }
    if (rating === "up") positive.push(line);
    else negative.push(line);
    chars += line.length + 3;
    return true;
  };

  for (const item of feedback.slice(0, CONTENT_FEEDBACK_INJECTED_MAX)) {
    const reasons = Array.isArray(item.reasons)
      ? item.reasons.filter((r): r is ContentFeedbackReason =>
          CONTENT_FEEDBACK_REASONS.includes(r as ContentFeedbackReason),
        )
      : [];
    const reasonText = reasons.length ? reasons.join(", ") : "General feedback";
    const note = normalizeFeedbackNote(item.note);
    const excerpt = normalizeFeedbackExcerpt(item.body_snapshot);
    if (!excerpt) continue;
    const line = [
      reasonText,
      note ? `note: ${note}` : "",
      `example: "${excerpt}"`,
    ]
      .filter(Boolean)
      .join(" | ");
    if (!add(item.rating, line)) break;
  }

  if (positive.length === 0 && negative.length === 0) return "";

  return [
    "The user has given recent taste feedback on generated drafts in this workspace.",
    "Treat this as soft guidance, below the user's current request and below hard",
    "writing preferences. Use it to adjust voice, hooks, structure, CTA style, and",
    "format choices. Do not copy examples verbatim.",
    "",
    ...(positive.length
      ? ["Do more of:", ...positive.map((line) => `- ${line}`), ""]
      : []),
    ...(negative.length
      ? ["Avoid:", ...negative.map((line) => `- ${line}`)]
      : []),
  ]
    .join("\n")
    .trim();
}
