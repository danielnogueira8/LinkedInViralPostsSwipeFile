export const POSITIVE_FEEDBACK_REASONS = [
  "Great hook",
  "Right voice",
  "Good structure",
  "Good CTA",
  "More like this",
] as const;

export const NEGATIVE_FEEDBACK_REASONS = [
  "Too generic",
  "Wrong voice",
  "Bad hook",
  "Too long",
  "Too salesy",
  "Bad format",
  "Don't use this phrase",
] as const;

export const CONTENT_FEEDBACK_REASONS = [
  ...POSITIVE_FEEDBACK_REASONS,
  ...NEGATIVE_FEEDBACK_REASONS,
] as const;

export type ContentFeedbackRating = "up" | "down";
export type ContentFeedbackReason = (typeof CONTENT_FEEDBACK_REASONS)[number];
