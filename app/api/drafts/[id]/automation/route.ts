import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { createSupabaseDraftLifecycleRepository } from "@/lib/draft-lifecycle-supabase";
import { artifactLeadMagnet } from "@/lib/chat-artifact-policy";
import { getCredentialSafe } from "@/lib/leadshark-credentials";
import {
  getAutomationForArtifact,
  upsertAutomationConfig,
  deleteAutomationForArtifact,
} from "@/lib/leadshark-automations";
import {
  validateAutomationConfig,
  type AutomationConfigDraft,
} from "@/lib/leadshark-config";
import { MAX_KEYWORDS } from "@/lib/leadshark";
import { getLeadSharkAutomationDefaults } from "@/lib/leadshark-defaults";
import { buildAutomationPrefill } from "@/lib/leadshark-prefill";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// The LeadShark automation config for a single lead-magnet draft.
//   GET    → current config (or prefill defaults) + gating (kind + credential).
//   PUT    → validate + upsert the config (status stays 'configured' pre-publish).
//   DELETE → remove the automation config for this draft.
//
// Gated on kind === 'lead_magnet'. The lead-magnet URL + keyword prefills are
// derived server-side from the artifact's meta.lead_magnet.
// -----------------------------------------------------------------------------

function originFrom(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

async function loadContext(id: string, sb: Awaited<ReturnType<typeof scopedSupabase>>) {
  const repo = createSupabaseDraftLifecycleRepository(sb.raw, sb.workspaceId);
  const draft = await repo.find(id);
  return draft;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const draft = await loadContext(id, sb);
    if (!draft) {
      return NextResponse.json({ ok: false, error: "Draft not found." }, { status: 404 });
    }

    const isLeadMagnet = draft.kind === "lead_magnet";
    const credential = await getCredentialSafe(sb.workspaceId);
    const existing = await getAutomationForArtifact(sb.workspaceId, id);
    const lm = isLeadMagnet
      ? artifactLeadMagnet({ meta: draft.meta ?? undefined })
      : null;

    // Prefill from the lead magnet, only when it's a lead-magnet draft.
    let prefill: {
      keyword: string;
      dmTemplate: string;
      leadMagnetId: string | null;
      leadMagnetTitle: string | null;
      leadMagnetUrl: string | null;
      config: AutomationConfigDraft;
    } | null = null;
    if (isLeadMagnet) {
      const { data: marker } = await sb.raw
        .from("app_schema_version")
        .select("version")
        .eq("singleton", true)
        .maybeSingle();
      const savedDefaults =
        (marker?.version ?? 0) >= 153
          ? await getLeadSharkAutomationDefaults(sb.workspaceId, sb.raw)
          : null;
      // Shared with the not-yet-created-post route so a new post and a saved
      // one cannot start from different configs.
      prefill = buildAutomationPrefill({
        leadMagnet: lm,
        body: draft.body ?? "",
        origin: originFrom(req),
        savedDefaults,
      });
    }

    return NextResponse.json({
      ok: true,
      eligible: isLeadMagnet,
      credentialConnected: credential.connected,
      automation: existing,
      prefill,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

// Zod shape. Keywords optional (blank = every comment). DM required. The deep
// content rules (length, template vars, follow-up-required) run in
// validateAutomationConfig so client and server share one source of truth.
const putSchema = z.object({
  keywords: z.array(z.string().trim().min(1)).max(MAX_KEYWORDS).default([]),
  dmTemplate: z.string().min(1).max(4000),
  dmTemplateVariations: z.array(z.string().trim().min(1)).max(10).default([]),
  commentReplyTemplates: z.array(z.string().trim().min(1)).max(10).default([]),
  nonConnectionReplyTemplates: z.array(z.string().trim().min(1)).max(10).default([]),
  autoConnect: z.boolean().default(false),
  autoLike: z.boolean().default(false),
  followUpEnabled: z.boolean().default(false),
  followUpTemplate: z.string().max(4000).nullable().default(null),
  followUpDelayMinutes: z.number().int().positive().max(43200).default(60),
  followUpOnlyIfNoResponse: z.boolean().default(true),
});

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();

    const draft = await loadContext(id, sb);
    if (!draft) {
      return NextResponse.json({ ok: false, error: "Draft not found." }, { status: 404 });
    }
    if (draft.kind !== "lead_magnet") {
      return NextResponse.json(
        { ok: false, error: "LeadShark automations are only for lead-magnet posts." },
        { status: 400 },
      );
    }
    // A SwipeIn-hosted resource is optional. Users often give away something
    // that does not live here — a Notion doc, a Calendly, a file on their own
    // site — and put that link in the DM themselves. Requiring an attached
    // resource blocked those automations from being saved at all.
    //
    // When a resource IS attached, its id is still stored so {{resourceUrl}}
    // resolves to the hosted link at send time.
    const leadMagnet = artifactLeadMagnet({
      meta: draft.meta ?? undefined,
    });
    const leadMagnetId =
      leadMagnet?.id && leadMagnet.publicSlug ? leadMagnet.id : null;

    const parsed = putSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Invalid request.";
      return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    }
    const input = parsed.data;

    // Authoritative content validation (shared with the client).
    const cfg: AutomationConfigDraft = {
      keywords: input.keywords,
      dmTemplate: input.dmTemplate,
      dmTemplateVariations: input.dmTemplateVariations,
      commentReplyTemplates: input.commentReplyTemplates,
      nonConnectionReplyTemplates: input.nonConnectionReplyTemplates,
      autoConnect: input.autoConnect,
      autoLike: input.autoLike,
      followUpEnabled: input.followUpEnabled,
      followUpTemplate: input.followUpTemplate,
      followUpDelayMinutes: input.followUpDelayMinutes,
      followUpOnlyIfNoResponse: input.followUpOnlyIfNoResponse,
    };
    const issues = validateAutomationConfig(cfg);
    if (issues.length) {
      return NextResponse.json(
        { ok: false, error: issues[0].message, issues },
        { status: 400 },
      );
    }

    const automation = await upsertAutomationConfig(sb.workspaceId, {
      artifactId: id,
      leadMagnetId,
      ...cfg,
    });
    return NextResponse.json({ ok: true, automation });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    await deleteAutomationForArtifact(sb.workspaceId, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
