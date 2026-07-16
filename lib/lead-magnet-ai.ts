import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BACKGROUND_MODEL,
  completeChat,
  logOpenRouterUsage,
  type ToolDef,
} from "@/lib/openrouter";
import {
  LEAD_MAGNET_AI_MONTHLY_LIMIT,
  LEAD_MAGNET_BODY_MAX,
  LEAD_MAGNET_COLS,
  LEAD_MAGNET_RESOURCE_TYPES,
  coerceLeadMagnet,
  makePublicSlug,
  normalizeLeadMagnetMetadata,
  type LeadMagnet,
} from "@/lib/lead-magnets";
import {
  renderLeadMagnetCreatorContext,
  renderLeadMagnetQualityRequirements,
  renderLeadMagnetStructureRequirements,
  assessGeneratedLeadMagnetMarkdown,
  prepareGeneratedLeadMagnetMarkdown,
} from "@/lib/lead-magnet-generation";
import { MONTHLY_BUDGET_USD } from "@/lib/agent/rate-limit";
import {
  claimWorkspaceCost,
  releaseWorkspaceCost,
} from "@/lib/workspace-cost-claims";
import {
  coworkAdapterHealth,
  type AdapterHealthRegistry,
} from "@/lib/agent/adapter-health";
import { runCoworkAdapterAttempt } from "@/lib/agent/cowork-adapter-attempt";
import type { CoworkTurnTelemetry } from "@/lib/agent/cowork-telemetry";

export const LEAD_MAGNET_GENERATION_COST_RESERVE_USD = 0.05;

export class LeadMagnetCostCapError extends Error {
  constructor() {
    super("Monthly AI budget reached.");
    this.name = "LeadMagnetCostCapError";
  }
}

const EMIT_LEAD_MAGNET_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "emit_lead_magnet",
    description: "Return the generated lead magnet as a markdown document.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "selection_summary",
        "deliverables",
        "resource_type",
        "estimated_minutes",
        "markdown_body",
      ],
      properties: {
        title: {
          type: "string",
          description: "Clear, specific resource title. Maximum 90 characters.",
        },
        selection_summary: {
          type: "string",
          description:
            "One concise sentence describing who this lead magnet is for and what problem it solves. Used later to choose the right giveaway without reading the full document.",
        },
        deliverables: {
          type: "array",
          items: { type: "string" },
          description:
            "3-6 concrete named assets included in the resource, e.g. a hook scorecard or launch checklist. Never return raw fill-in fields, bracket placeholders, or ordinary body bullets.",
        },
        resource_type: {
          type: "string",
          enum: [...LEAD_MAGNET_RESOURCE_TYPES],
          description: "The single resource format that best matches the job to be done.",
        },
        estimated_minutes: {
          type: "number",
          minimum: 1,
          maximum: 180,
          description: "A realistic estimate for the reader to apply the quick implementation plan.",
        },
        markdown_body: {
          type: "string",
          description:
            "The full lead magnet as markdown. Use Notion-like headings, lists, examples, and practical sections.",
        },
      },
    },
  },
};

export async function generateLeadMagnetResource(opts: {
  sb: SupabaseClient;
  workspaceId: string;
  userId: string;
  prompt: string;
  ctaUrl?: string | null;
  ctaLabel?: string | null;
  signal?: AbortSignal;
  adapterHealth?: AdapterHealthRegistry;
  telemetry?: CoworkTurnTelemetry;
  cancellationReason?: () => "cancelled" | "deadline";
}): Promise<{ leadMagnet: LeadMagnet; used: number; limit: number }> {
  opts.signal?.throwIfAborted();
  const claim = await claimLeadMagnetGeneration(opts.sb, opts.workspaceId, opts.userId);
  if (!claim) {
    throw new Error(
      `You've used all ${LEAD_MAGNET_AI_MONTHLY_LIMIT} AI lead magnets for this month.`,
    );
  }
  if (opts.signal?.aborted) {
    await settleLeadMagnetClaim(opts.sb, claim.claimId, "released");
    opts.signal.throwIfAborted();
  }

  const costOperationKey = `lead-magnet:${claim.claimId}`;
  let costClaimed = false;
  let completed = false;
  try {
    costClaimed = Boolean(
      await claimWorkspaceCost({
        workspaceId: opts.workspaceId,
        operationKey: costOperationKey,
        estimatedCostUsd: LEAD_MAGNET_GENERATION_COST_RESERVE_USD,
        budgetUsd: MONTHLY_BUDGET_USD,
        ttlSeconds: 900,
      }),
    );
    opts.signal?.throwIfAborted();
  } catch (error) {
    await settleLeadMagnetClaim(opts.sb, claim.claimId, "released");
    if (costClaimed) {
      await releaseWorkspaceCost({
        workspaceId: opts.workspaceId,
        operationKey: costOperationKey,
      });
    }
    throw error;
  }
  if (!costClaimed) {
    await settleLeadMagnetClaim(opts.sb, claim.claimId, "released");
    throw new LeadMagnetCostCapError();
  }

  try {
    const result = await generateClaimedLeadMagnet(opts);
    await settleLeadMagnetClaim(opts.sb, claim.claimId, "completed");
    completed = true;
    return {
      ...result,
      used: claim.usedBefore + 1,
      limit: LEAD_MAGNET_AI_MONTHLY_LIMIT,
    };
  } catch (error) {
    await settleLeadMagnetClaim(opts.sb, claim.claimId, "released");
    throw error;
  } finally {
    try {
      await releaseWorkspaceCost({
        workspaceId: opts.workspaceId,
        operationKey: costOperationKey,
      });
    } catch (releaseError) {
      console.error(
        completed
          ? "Failed to release completed lead magnet cost claim"
          : "Failed to release failed lead magnet cost claim",
        releaseError,
      );
      if (!completed) throw releaseError;
    }
  }
}

async function settleLeadMagnetClaim(
  sb: SupabaseClient,
  claimId: string,
  status: "completed" | "released",
): Promise<void> {
  const { data, error } = await sb
    .from("lead_magnet_generation_claims")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", claimId)
    .eq("status", "reserved")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Lead magnet generation claim ${claimId} was lost.`);
}

export async function claimLeadMagnetGeneration(
  sb: SupabaseClient,
  workspaceId: string,
  userId: string,
): Promise<{ claimId: string; usedBefore: number } | null> {
  const { data: claims, error: claimError } = await sb.rpc(
    "claim_lead_magnet_generation",
    {
      p_workspace_id: workspaceId,
      p_user_id: userId,
      p_limit: LEAD_MAGNET_AI_MONTHLY_LIMIT,
    },
  );
  if (claimError) throw claimError;
  const claim = Array.isArray(claims) ? claims[0] : null;
  if (!claim?.claim_id) return null;
  return { claimId: String(claim.claim_id), usedBefore: Number(claim.used_before ?? 0) };
}

// Extract a usable (title, markdown) pair from a lead-magnet completion,
// tolerant of the model dropping the structured tool args. Some models
// (notably gpt-5.6-luna on the fuller prod prompt) emit the markdown as reply
// TEXT instead of `toolArgs.markdown_body`, or omit the title from the tool
// call — the forced tool_choice guarantees a call is MADE, not that every field
// lands. When the tool arg is missing we fall back to `response.text` (body)
// and to the markdown's first `# ` heading (title), which is exactly what the
// downstream persist path already trusts. Exported so validation and the
// generator agree on one salvage definition.
export function salvageLeadMagnetContent(
  response: Awaited<ReturnType<typeof completeChat>>,
): { title: string; markdown: string } {
  const argTitle =
    typeof response.toolArgs?.title === "string"
      ? response.toolArgs.title.trim()
      : "";
  const markdown =
    typeof response.toolArgs?.markdown_body === "string" &&
    response.toolArgs.markdown_body.trim().length > 0
      ? response.toolArgs.markdown_body.trim()
      : (response.text ?? "").trim();
  // Title fallback: first markdown H1, else the first non-empty line (trimmed of
  // leading #), so a text-only response still yields a title.
  let title = argTitle;
  if (!title && markdown) {
    const h1 = markdown.match(/^\s*#\s+(.+?)\s*$/m);
    if (h1) {
      title = h1[1].trim();
    } else {
      const firstLine = markdown.split("\n").find((l) => l.trim().length > 0);
      if (firstLine) title = firstLine.replace(/^#+\s*/, "").trim().slice(0, 90);
    }
  }
  return { title, markdown };
}

export function validateLeadMagnetAdapterResponse(
  response: Awaited<ReturnType<typeof completeChat>>,
): Awaited<ReturnType<typeof completeChat>> {
  // Accept a response with a usable body in EITHER the structured tool arg OR
  // the reply text (salvage). Only reject when neither yields a real guide —
  // that's the true "the model gave us nothing" failure, not "the model put the
  // markdown in the wrong field". The old check read only toolArgs and threw
  // even when response.text held a complete guide, which surfaced as a 500
  // ("Adapter response validation failed") on models that answer in text.
  const { title, markdown } = salvageLeadMagnetContent(response);
  if (!title || markdown.length < 80) {
    throw new Error(
      "Lead magnet response was missing its required structured title or markdown body.",
    );
  }
  return response;
}

async function generateClaimedLeadMagnet(opts: {
  sb: SupabaseClient;
  workspaceId: string;
  userId: string;
  prompt: string;
  ctaUrl?: string | null;
  ctaLabel?: string | null;
  signal?: AbortSignal;
  adapterHealth?: AdapterHealthRegistry;
  telemetry?: CoworkTurnTelemetry;
  cancellationReason?: () => "cancelled" | "deadline";
}): Promise<{ leadMagnet: LeadMagnet }> {
  opts.signal?.throwIfAborted();
  const { data: voice, error: voiceError } = await opts.sb
    .from("voice_profiles")
    .select("display_name, avatar_url, headline, summary")
    .eq("workspace_id", opts.workspaceId)
    .maybeSingle();
  if (voiceError) throw voiceError;
  opts.signal?.throwIfAborted();

  const creatorContext = renderLeadMagnetCreatorContext({
    displayName: (voice?.display_name as string | null) ?? null,
    avatarUrl: (voice?.avatar_url as string | null) ?? null,
    headline: (voice?.headline as string | null) ?? null,
    summary: (voice?.summary as string | null) ?? null,
  });
  const structureRequirements = renderLeadMagnetStructureRequirements({
    url: opts.ctaUrl,
    label: opts.ctaLabel,
  });
  const qualityRequirements = renderLeadMagnetQualityRequirements();

  const messages = [
    {
      role: "system" as const,
      content:
        "You create concise, useful markdown lead magnets for LinkedIn creators. Return only structured tool output. The resource must feel like expert working material, not generic educational prose. Build instructions and usable assets, not a long article. Do not invent personal case studies, names, credentials, companies, years of experience, client counts, or metrics. Make the resource practical enough that someone would be happy to receive it after replying to a LinkedIn post.",
    },
    {
      role: "user" as const,
      content: [
        `Create a lead magnet about:\n${opts.prompt}`,
        creatorContext,
        structureRequirements,
        qualityRequirements,
        [
          "Requirements:",
          "- Markdown only.",
          "- Create one complete full guide. Do not switch to a different resource format.",
          "- Follow the opening and guide structure exactly.",
          "- If the request is broad, narrow the guide to the most useful practical outcome supported by the supplied context.",
          "- Make every promised deliverable available in the guide itself.",
          `- Keep it under ${LEAD_MAGNET_BODY_MAX} characters.`,
        ].join("\n"),
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
  const runRepair = async (previous?: {
    title: string;
    markdown: string;
    issues: string[];
  }) =>
    runCoworkAdapterAttempt({
      registry: opts.adapterHealth ?? coworkAdapterHealth,
      adapterKey: `cowork_setup_lead_magnet:${BACKGROUND_MODEL}`,
      signal: opts.signal,
      call: () =>
        completeChat({
          model: BACKGROUND_MODEL,
          maxTokens: 3500,
          tools: [EMIT_LEAD_MAGNET_TOOL],
          forceTool: "emit_lead_magnet",
          signal: opts.signal,
          messages: [
            ...messages,
            ...(previous
              ? [
                  {
                    role: "assistant" as const,
                    content: JSON.stringify({
                      title: previous.title,
                      markdown_body: previous.markdown,
                    }),
                  },
                ]
              : []),
            {
              role: "user" as const,
              content: previous
                ? [
                    "Repair the guide and return the complete corrected version.",
                    "Fix every issue below without changing the requested topic or inventing evidence:",
                    ...previous.issues.map((issue) => `- ${issue}`),
                  ].join("\n")
                : "The prior response was missing the required structured title or complete markdown guide. Return one complete corrected guide now.",
            },
          ],
        }),
      validate: validateLeadMagnetAdapterResponse,
      persistUsage: (response) =>
        logOpenRouterUsage(
          "lead_magnet_generate_repair",
          BACKGROUND_MODEL,
          response.usage,
          opts.workspaceId,
          { user_id: opts.userId },
        ),
      usage: (response) => response.usage,
      telemetry: opts.telemetry,
      stage: "setup_lead_magnet_repair",
      attempt: 2,
      model: BACKGROUND_MODEL,
      fallbackReason: previous ? "quality_rejected" : "primary_rejected",
      rejectedReasonCode: "invalid_lead_magnet_repair",
      cancellationReason: opts.cancellationReason,
    });

  let res: Awaited<ReturnType<typeof completeChat>>;
  let repairUsed = false;
  try {
    const primary = await runCoworkAdapterAttempt({
      registry: opts.adapterHealth ?? coworkAdapterHealth,
      adapterKey: `cowork_setup_lead_magnet:${BACKGROUND_MODEL}`,
      signal: opts.signal,
      call: () =>
        completeChat({
          model: BACKGROUND_MODEL,
          maxTokens: 3500,
          tools: [EMIT_LEAD_MAGNET_TOOL],
          forceTool: "emit_lead_magnet",
          signal: opts.signal,
          messages,
        }),
      validate: validateLeadMagnetAdapterResponse,
      persistUsage: (response) =>
        logOpenRouterUsage(
          "lead_magnet_generate",
          BACKGROUND_MODEL,
          response.usage,
          opts.workspaceId,
          { user_id: opts.userId },
        ),
      usage: (response) => response.usage,
      telemetry: opts.telemetry,
      stage: "setup_lead_magnet_primary",
      attempt: 1,
      model: BACKGROUND_MODEL,
      rejectedReasonCode: "invalid_lead_magnet_response",
      cancellationReason: opts.cancellationReason,
    });
    res = primary.response;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "InvalidAdapterResponseError") {
      throw error;
    }
    const repair = await runRepair();
    res = repair.response;
    repairUsed = true;
  }

  // Use the SAME salvage the validator used, so a response that passed
  // validation via response.text (not toolArgs) also persists correctly rather
  // than tripping the final !title guard below.
  let salvaged = salvageLeadMagnetContent(res);
  let title = salvaged.title;
  let markdown = prepareGeneratedLeadMagnetMarkdown({
    title,
    markdown: salvaged.markdown,
  });
  let assessment = assessGeneratedLeadMagnetMarkdown(markdown);
  if (!repairUsed && !assessment.passed) {
    const repair = await runRepair({
      title,
      markdown,
      issues: assessment.issues,
    });
    const repaired = repair.response;
    res = repaired;
    salvaged = salvageLeadMagnetContent(repaired);
    title = salvaged.title || title;
    markdown = prepareGeneratedLeadMagnetMarkdown({
      title,
      markdown: salvaged.markdown,
    });
    assessment = assessGeneratedLeadMagnetMarkdown(markdown);
  }
  const selectionSummary =
    typeof res.toolArgs?.selection_summary === "string"
      ? res.toolArgs.selection_summary.trim()
      : "";
  const deliverables = Array.isArray(res.toolArgs?.deliverables)
    ? res.toolArgs.deliverables
        .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
        .map((d) => d.trim())
        .slice(0, 6)
    : [];
  const resourceType = LEAD_MAGNET_RESOURCE_TYPES.includes(
    res.toolArgs?.resource_type as (typeof LEAD_MAGNET_RESOURCE_TYPES)[number],
  )
    ? (res.toolArgs?.resource_type as (typeof LEAD_MAGNET_RESOURCE_TYPES)[number])
    : "guide";
  const estimatedMinutesRaw = Number(res.toolArgs?.estimated_minutes);
  const estimatedMinutes = Number.isFinite(estimatedMinutesRaw)
    ? Math.max(1, Math.min(180, Math.round(estimatedMinutesRaw)))
    : 15;
  if (!title || markdown.length < 80) {
    throw new Error(
      "The model did not return a usable lead magnet. Try a more specific prompt.",
    );
  }
  const body = markdown.slice(0, LEAD_MAGNET_BODY_MAX);
  const metadata = normalizeLeadMagnetMetadata(
    {
      selection_summary: selectionSummary || undefined,
      deliverables: deliverables.length ? deliverables : undefined,
      cta_url: opts.ctaUrl ?? undefined,
      cta_label: opts.ctaLabel ?? undefined,
      quality_status: assessment.passed ? "passed" : "review_suggested",
      quality_warnings: assessment.issues,
      resource_type: resourceType,
      estimated_minutes: estimatedMinutes,
    },
    body,
  );
  // The model may finish at the exact edge of the chat setup deadline. Never
  // persist a resource after the caller has already been told to retry, or the
  // retry can create a duplicate lead magnet.
  opts.signal?.throwIfAborted();
  let insert = opts.sb
    .from("lead_magnets")
    .insert({
      workspace_id: opts.workspaceId,
      user_id: opts.userId,
      title: title.slice(0, 160),
      markdown_body: body,
      source_url: null,
      source_type: "ai",
      public_slug: makePublicSlug(title),
      is_public: true,
      metadata,
    })
    .select(LEAD_MAGNET_COLS);
  if (opts.signal) insert = insert.abortSignal(opts.signal);
  const { data, error } = await insert.single();
  if (error) throw error;
  return {
    leadMagnet: coerceLeadMagnet(data as LeadMagnet),
  };
}
