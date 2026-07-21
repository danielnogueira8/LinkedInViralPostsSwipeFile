import { z } from "zod";
import { postMediaAttachmentsSchema } from "@/lib/post-media";

export const createDraftSchema = z
  .object({
    // Body may be empty when the user is capturing a named idea to fill later.
    body: z.string().trim().max(20_000).default(""),
    title: z.string().trim().max(200).optional(),
    kind: z.enum(["post", "hook", "lead_magnet"]).optional(),
    // The lead-magnet resource to give away, chosen in the create form when the
    // user sets the kind to "lead_magnet". Only meaningful for that kind; the
    // server resolves the id to a title + public_slug and stamps meta.lead_magnet
    // so the board's "Giveaway" row and the comment-to-DM automation can read it.
    lead_magnet_id: z.string().uuid().nullable().optional(),
    status: z.enum(["idea", "drafting", "ready", "posted"]).optional(),
    plan_to_post_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
      .nullable()
      .optional(),
    media_attachments: postMediaAttachmentsSchema.optional(),
  })
  .refine(
    (value) =>
      (value.body?.trim().length ?? 0) > 0 ||
      (value.title?.trim().length ?? 0) > 0,
    {
      message: "Give the post a name or some content.",
      path: ["title"],
    },
  );
