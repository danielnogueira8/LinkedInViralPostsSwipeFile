import { z } from "zod";
import type { ChatMessage } from "@/lib/openrouter";
import {
  postMediaAttachmentsSchema,
  type PostMediaAttachment,
} from "@/lib/post-media";

export const PlanStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(["pending", "active", "done"]),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;

export const AskQuestionSchema = z
  .object({
    question: z.string().min(1),
    options: z.array(z.string().min(1)).min(2),
    allowOther: z.boolean(),
    multiSelect: z.boolean().optional(),
    doneOption: z.string().min(1).optional(),
  })
  .superRefine((question, ctx) => {
    if (question.doneOption && !question.options.includes(question.doneOption)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "doneOption must match one of the question options",
        path: ["doneOption"],
      });
    }
  });

export type AskQuestion = z.infer<typeof AskQuestionSchema>;

export type Artifact = {
  id: string;
  kind: "post" | "hook" | "cite";
  title: string;
  body: string;
  media_attachments?: PostMediaAttachment[];
  meta?: Record<string, unknown>;
};

const DraftArtifactSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["post", "hook"]),
    title: z.string(),
    body: z.string().trim().min(1, "draft body must be non-empty"),
    media_attachments: postMediaAttachmentsSchema.optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const CiteArtifactSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("cite"),
    title: z.string(),
    body: z.literal(""),
    media_attachments: postMediaAttachmentsSchema.optional(),
    meta: z.object({ postId: z.string().uuid() }).passthrough(),
  })
  .passthrough();

export const ArtifactSchema: z.ZodType<Artifact> = z.discriminatedUnion("kind", [
  DraftArtifactSchema,
  CiteArtifactSchema,
]);

const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    cache_control: z.object({ type: z.literal("ephemeral") }).optional(),
  }),
  z.object({
    type: z.literal("file"),
    file: z.object({ filename: z.string(), file_data: z.string() }),
  }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({ url: z.string() }),
  }),
]);

const FileAnnotationSchema = z.object({
  type: z.literal("file"),
  file: z.object({
    hash: z.string(),
    name: z.string().optional(),
    content: z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({
          type: z.literal("image_url"),
          image_url: z.object({ url: z.string() }),
        }),
      ]),
    ),
  }),
});

const ChatMessageSchema: z.ZodType<ChatMessage> = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(ContentBlockSchema), z.null()]),
    tool_calls: z.array(ToolCallSchema).optional(),
    tool_call_id: z.string().optional(),
    persisted_tool_state: z.literal(true).optional(),
    annotations: z.array(FileAnnotationSchema).optional(),
  })
  .superRefine((message, ctx) => {
    if (message.role === "tool" && !message.tool_call_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tool messages must identify the tool call they answer",
        path: ["tool_call_id"],
      });
    }
  });

export const AssistantTurnSchema = z.object({
  content: z.string(),
  tool_calls: z.array(ToolCallSchema).nullable(),
  artifacts: z.array(ArtifactSchema),
  toolMessages: z.array(ChatMessageSchema),
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export type AssistantTurn = z.infer<typeof AssistantTurnSchema>;

export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), delta: z.string() }),
  z.object({
    type: z.literal("tool_start"),
    id: z.string(),
    name: z.string(),
    args: z.string(),
  }),
  z.object({
    type: z.literal("tool_end"),
    id: z.string(),
    name: z.string(),
    ok: z.boolean(),
    summary: z.string().optional(),
  }),
  z.object({ type: z.literal("plan"), steps: z.array(PlanStepSchema) }),
  z.object({ type: z.literal("plan_update"), steps: z.array(PlanStepSchema) }),
  z.object({ type: z.literal("ask"), ask: AskQuestionSchema }),
  z.object({
    type: z.literal("preference_saved"),
    id: z.string(),
    rule: z.string(),
  }),
  z.object({ type: z.literal("artifact"), artifact: ArtifactSchema }),
  z.object({ type: z.literal("done"), message: AssistantTurnSchema }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
    code: z.union([z.string(), z.number()]).optional(),
    recovery: z.literal("continue").optional(),
  }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
