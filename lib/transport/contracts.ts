import { z } from "zod";
import {
  ArtifactSchema,
  AskQuestionSchema,
  PlanStepSchema,
} from "@/lib/agent/contracts";
import { CoworkTurnUsageWireSchema } from "@/lib/cowork-turn-usage";

export const ApiErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
  code: z.string().optional(),
  reason: z.string().optional(),
  retryAt: z.string().optional(),
});

export const WeeklyBatchStartResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    jobId: z.string(),
    batchId: z.string(),
    runId: z.string(),
    chatId: z.string().nullable(),
    status: z.literal("queued"),
  }),
  ApiErrorSchema,
]);

export type WeeklyBatchStartResponse = z.infer<
  typeof WeeklyBatchStartResponseSchema
>;

const BatchRunSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "running", "done", "failed"]),
  stage: z.string().nullable(),
  total: z.number(),
  attempted: z.number(),
  created: z.number(),
  error: z.string().nullable(),
}).passthrough();

export const WeeklyBatchPollResponseSchema = z.object({
  ok: z.literal(true),
  run: BatchRunSchema.nullable(),
});

export const WeeklyBatchReadinessResponseSchema = z.object({
  ok: z.literal(true),
  readiness: z.object({
    available: z.number(),
    cooldown: z.discriminatedUnion("onCooldown", [
      z.object({ onCooldown: z.literal(false) }),
      z.object({ onCooldown: z.literal(true), retryAtIso: z.string() }),
    ]),
  }).passthrough(),
  run: BatchRunSchema.nullable(),
});

export const WeeklyBatchSlotsResponseSchema = z.object({
  ok: z.literal(true),
  slots: z.array(z.object({
    id: z.string(),
    slot_index: z.number(),
    source_first_line: z.string().nullable(),
    source_url: z.string().nullable(),
    is_lead_magnet: z.boolean(),
    skill_label: z.string().nullable(),
    status: z.enum(["queued", "drafting", "filed", "skipped", "failed"]),
    draft_title: z.string().nullable(),
    error: z.string().nullable(),
  }).passthrough()),
});

const ChatSseFrameSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("text"), data: z.object({ delta: z.string() }) }),
  z.object({
    event: z.literal("tool_start"),
    data: z.object({
      id: z.string(),
      name: z.string(),
      args: z.string().optional(),
    }),
  }),
  z.object({
    event: z.literal("tool_end"),
    data: z.object({
      id: z.string(),
      name: z.string(),
      ok: z.boolean(),
      summary: z.string().optional(),
    }),
  }),
  z.object({
    event: z.enum(["plan", "plan_update"]),
    data: z.object({ steps: z.array(PlanStepSchema) }),
  }),
  z.object({ event: z.literal("ask"), data: AskQuestionSchema }),
  z.object({
    event: z.literal("preference_saved"),
    data: z.object({ id: z.string(), rule: z.string() }),
  }),
  z.object({ event: z.literal("artifact"), data: ArtifactSchema }),
  z.object({
    event: z.literal("done"),
    data: z
      .object({
        artifacts: z.array(ArtifactSchema),
        usage: CoworkTurnUsageWireSchema.optional(),
      })
      .passthrough(),
  }),
  z.object({
    event: z.literal("error"),
    data: z.object({
      message: z.string(),
      code: z.union([z.string(), z.number()]).optional(),
      recovery: z.literal("continue").optional(),
    }),
  }),
]);

export type ChatSseFrame = z.infer<typeof ChatSseFrameSchema>;

export function parseChatSseFrame(
  event: string,
  data: unknown,
): ChatSseFrame | null {
  const parsed = ChatSseFrameSchema.safeParse({ event, data });
  return parsed.success ? parsed.data : null;
}

export function encodeChatSseFrame(event: string, data: unknown): string | null {
  const frame = parseChatSseFrame(event, data);
  return frame
    ? `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`
    : null;
}
