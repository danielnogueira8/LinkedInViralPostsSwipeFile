import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { getCredentialSafe } from "@/lib/leadshark-credentials";
import { getLeadSharkAutomationDefaults } from "@/lib/leadshark-defaults";
import { buildAutomationPrefill } from "@/lib/leadshark-prefill";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// The automation starting config for a post that does not exist yet.
//
// The editor lets you fill in the comment-to-DM automation while still writing
// a new post, and creates the post when you save. Until that save there is no
// id, so GET /api/drafts/[id]/automation cannot answer — and the form was
// coming up EMPTY, ignoring the workspace's saved defaults. Users read that as
// "my settings didn't save": create the post, reopen it, and the same screen
// suddenly had their defaults in it.
//
// POST rather than GET because the post body feeds keyword inference and a body
// does not belong in a query string.
//
// Deliberately NOT a write: it resolves nothing but text, so opening the form
// still leaves no trace.
// -----------------------------------------------------------------------------

const bodySchema = z.object({
  // The chosen giveaway, if any. Resolved server-side rather than trusted from
  // the client so the title and public slug match what the post will actually
  // carry once it is created.
  leadMagnetId: z.string().uuid().nullable().default(null),
  body: z.string().max(20_000).default(""),
});

function originFrom(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export async function POST(req: Request) {
  try {
    const sb = await scopedSupabase();
    const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Invalid request.";
      return NextResponse.json({ ok: false, error: msg }, { status: 400 });
    }

    const credential = await getCredentialSafe(sb.workspaceId);

    // Workspace-scoped: an id from another workspace resolves to nothing and
    // simply falls back to the no-resource prefill.
    let leadMagnet: {
      id?: string | null;
      title?: string | null;
      publicSlug?: string | null;
    } | null = null;
    if (parsed.data.leadMagnetId) {
      const { data, error } = await sb.raw
        .from("lead_magnets")
        .select("id, title, public_slug")
        .eq("id", parsed.data.leadMagnetId)
        .eq("workspace_id", sb.workspaceId)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        leadMagnet = {
          id: String(data.id),
          title: typeof data.title === "string" ? data.title : null,
          publicSlug:
            typeof data.public_slug === "string" ? data.public_slug : null,
        };
      }
    }

    const { data: marker } = await sb.raw
      .from("app_schema_version")
      .select("version")
      .eq("singleton", true)
      .maybeSingle();
    const savedDefaults =
      (marker?.version ?? 0) >= 153
        ? await getLeadSharkAutomationDefaults(sb.workspaceId, sb.raw)
        : null;

    return NextResponse.json({
      ok: true,
      credentialConnected: credential.connected,
      prefill: buildAutomationPrefill({
        leadMagnet,
        body: parsed.data.body,
        origin: originFrom(req),
        savedDefaults,
      }),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
