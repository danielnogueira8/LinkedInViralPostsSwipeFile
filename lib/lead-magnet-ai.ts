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
  coerceLeadMagnet,
  makePublicSlug,
  monthStartIso,
  normalizeLeadMagnetMetadata,
  type LeadMagnet,
} from "@/lib/lead-magnets";
import {
  renderLeadMagnetCreatorContext,
  renderLeadMagnetQualityRequirements,
  renderLeadMagnetStructureRequirements,
  sanitizeGeneratedLeadMagnetMarkdown,
} from "@/lib/lead-magnet-generation";

const EMIT_LEAD_MAGNET_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "emit_lead_magnet",
    description: "Return the generated lead magnet as a markdown document.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["title", "markdown_body"],
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
            "3-6 concrete deliverables included in the resource, e.g. templates, checklists, scripts, prompts, frameworks.",
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
}): Promise<{ leadMagnet: LeadMagnet; used: number; limit: number }> {
  const { count, error: countError } = await opts.sb
    .from("lead_magnets")
    .select("id", { count: "exact", head: true })
    .eq("user_id", opts.userId)
    .eq("source_type", "ai")
    .gte("created_at", monthStartIso());
  if (countError) throw countError;
  if ((count ?? 0) >= LEAD_MAGNET_AI_MONTHLY_LIMIT) {
    throw new Error(
      `You've used all ${LEAD_MAGNET_AI_MONTHLY_LIMIT} AI lead magnets for this month.`,
    );
  }

  const { data: voice, error: voiceError } = await opts.sb
    .from("voice_profiles")
    .select("display_name, avatar_url, headline, summary")
    .eq("workspace_id", opts.workspaceId)
    .maybeSingle();
  if (voiceError) throw voiceError;

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

  const res = await completeChat({
    model: BACKGROUND_MODEL,
    maxTokens: 3500,
    tools: [EMIT_LEAD_MAGNET_TOOL],
    forceTool: "emit_lead_magnet",
    messages: [
      {
        role: "system",
        content:
          "You create concise, useful markdown lead magnets for LinkedIn creators. Return only structured tool output. The resource must feel like expert working material, not generic educational prose. Do not invent personal case studies, names, credentials, companies, years of experience, client counts, or metrics. Make the resource practical enough that someone would be happy to receive it after replying to a LinkedIn post.",
      },
      {
        role: "user",
        content: [
          `Create a lead magnet about:\n${opts.prompt}`,
          creatorContext,
          structureRequirements,
          qualityRequirements,
          [
            "Requirements:",
            "- Markdown only.",
            "- Follow the opening structure exactly before the practical sections.",
            "- Match the format to the requested resource instead of forcing every resource into the same template.",
            "- If the user asks for something broad, narrow it into the most useful practical asset.",
            `- Keep it under ${LEAD_MAGNET_BODY_MAX} characters.`,
          ].join("\n"),
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });
  await logOpenRouterUsage("lead_magnet_generate", BACKGROUND_MODEL, res.usage, opts.workspaceId, {
    user_id: opts.userId,
  });

  const title = typeof res.toolArgs?.title === "string" ? res.toolArgs.title.trim() : "";
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
  const rawMarkdown =
    typeof res.toolArgs?.markdown_body === "string"
      ? res.toolArgs.markdown_body.trim()
      : res.text.trim();
  const markdown = sanitizeGeneratedLeadMagnetMarkdown(rawMarkdown);
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
    },
    body,
  );
  const { data, error } = await opts.sb
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
    .select(LEAD_MAGNET_COLS)
    .single();
  if (error) throw error;
  return {
    leadMagnet: coerceLeadMagnet(data as LeadMagnet),
    used: (count ?? 0) + 1,
    limit: LEAD_MAGNET_AI_MONTHLY_LIMIT,
  };
}
