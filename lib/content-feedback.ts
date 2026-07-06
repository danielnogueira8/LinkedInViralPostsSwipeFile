import { z } from "zod";
import {
  CONTENT_FEEDBACK_REASONS,
  type ContentFeedbackRating,
  type ContentFeedbackReason,
} from "@/lib/content-feedback-catalog";

export const CONTENT_FEEDBACK_BODY_SNAPSHOT_MAX = 5_000;
export const CONTENT_FEEDBACK_NOTE_MAX = 500;
export const CONTENT_FEEDBACK_REASONS_MAX = 4;
export { CONTENT_FEEDBACK_REASONS };
export type { ContentFeedbackRating, ContentFeedbackReason };

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
  })
  .transform((input) => ({
    rating: input.rating,
    reasons: input.reasons,
    note: normalizeFeedbackNote(input.note),
    body_snapshot: input.bodySnapshot,
    chat_id: input.chatId ?? null,
    artifact_id: input.artifactId ?? null,
    draft_id: input.draftId ?? null,
  }));

export type ContentFeedbackInput = z.infer<typeof contentFeedbackInputSchema>;
