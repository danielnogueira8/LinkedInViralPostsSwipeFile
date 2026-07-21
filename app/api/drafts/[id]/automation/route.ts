import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { createSupabaseDraftLifecycleRepository } from "@/lib/draft-lifecycle-supabase";
import { artifactLeadMagnet } from "@/lib/chat-artifact-policy";
import { inferCommentKeyword } from "@/lib/lead-magnet-image-generation";
import { getCredentialSafe } from "@/lib/leadshark-credentials";
import {
  getAutomationForArtifact,
  upsertAutomationConfig,
  deleteAutomationForArtifact,
} from "@/lib/leadshark-automations";
import {
  validateAutomationConfig,
  defaultDmTemplate,
  type AutomationConfigDraft,
} from "@/lib/leadshark-config";
import { MAX_KEYWORDS } from "@/lib/leadshark";

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

    // Prefill from the lead magnet, only when it's a lead-magnet draft.
    let prefill: {
      keyword: string;
      dmTemplate: string;
      leadMagnetId: string | null;
      leadMagnetTitle: string | null;
      leadMagnetUrl: string | null;
    } | null = null;
    if (isLeadMagnet) {
      const lm = artifactLeadMagnet({ meta: draft.meta ?? undefined });
      const title = lm?.title ?? "resource";
      const slug = lm?.publicSlug ?? null;
      const url = slug ? `${originFrom(req)}/lm/${slug}` : "";
      prefill = {
        keyword: inferCommentKeyword(draft.body ?? "", lm?.title ?? ""),
        dmTemplate: defaultDmTemplate(title, url || "your link"),
        leadMagnetId: lm?.id ?? null,
        leadMagnetTitle: lm?.title ?? null,
        leadMagnetUrl: url || null,
      };
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
  leadMagnetId: z.string().uuid().nullable().default(null),
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
      leadMagnetId: input.leadMagnetId,
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
