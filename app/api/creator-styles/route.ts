import { NextResponse, after } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  creatorStyleCreateSchema,
  CREATOR_STYLES_PER_WORKSPACE_MAX,
  type CreatorStyleRow,
} from "@/lib/creator-styles";
import { runCreatorStyleGeneration } from "@/lib/agent/creator-style-profile";
import { checkChatRateLimit } from "@/lib/agent/rate-limit";
import {
  isLiveGeneratingStyle,
  recoverStaleGeneratingStyle,
} from "@/lib/creator-styles-cooldown";

export const runtime = "nodejs";
// Generation runs in after() but shares this route's budget (mirrors the voice
// route): a few model calls over ~8-20 posts fits comfortably under 300s.
export const maxDuration = 300;

const COLS =
  "id, workspace_id, name, creator_name, creator_handle, creator_avatar_url, source_account_id, description, sample_count, status, error, profile_json, prompt_block, generated_at, generating_started_at, created_at, updated_at";

// -----------------------------------------------------------------------------
// /api/creator-styles — list + create the workspace's creator style profiles.
// Workspace-scoped via scopedSupabase (RLS also enforces it). Creating a style
// inserts a 'generating' row and kicks the distillation off in after(), then
// returns the row immediately; the client polls GET until it flips to
// 'ready' | 'failed'. Mirrors /api/content-templates + the async voice route.
// -----------------------------------------------------------------------------

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("creator_style_profiles")
      .select(COLS)
      .eq("workspace_id", sb.workspaceId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    // Self-heal any style stuck 'generating' because its after() job died
    // mid-flight — otherwise the card would spin "Distilling…" forever. This
    // poll (the manager fetches it while anything is generating) is exactly the
    // read path that should recover it. Best-effort + scoped to still-generating
    // rows, so a concurrent success is never clobbered.
    const rows = (data ?? []) as CreatorStyleRow[];
    const styles = await Promise.all(
      rows.map((r) => recoverStaleGeneratingStyle(sb, r)),
    );
    return NextResponse.json({ ok: true, styles });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const parsed = creatorStyleCreateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();

    // Cost guard: building a style is a paid Apify fetch + an LLM synthesis, so
    // gate it on the same monthly budget as chat/voice. A workspace at its cap
    // can't burn the rest of the month's budget generating styles. (Mirrors the
    // voice route's pre-check.)
    const limit = await checkChatRateLimit(sb.workspaceId);
    if (!limit.ok) {
      return NextResponse.json(
        { ok: false, error: limit.message ?? "You've hit your usage limit for this period." },
        { status: 429 },
      );
    }

    // Per-workspace cap so the library stays bounded AND total style-generation
    // spend is capped (each style is a paid fetch + synthesis).
    const { count } = await sb.raw
      .from("creator_style_profiles")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", sb.workspaceId);
    if ((count ?? 0) >= CREATOR_STYLES_PER_WORKSPACE_MAX) {
      return NextResponse.json(
        {
          ok: false,
          error: `You've reached the limit of ${CREATOR_STYLES_PER_WORKSPACE_MAX} creator styles. Delete one to add another.`,
        },
        { status: 409 },
      );
    }

    // In-flight throttle: creating a style kicks off paid scrape + synthesis in
    // after(). Keep one live distillation per workspace so rapid clicks/new tabs
    // cannot fan out several expensive jobs. Stale rows are allowed through; the
    // next GET poll will recover them to failed.
    const { data: generating } = await sb.raw
      .from("creator_style_profiles")
      .select("id, status, generating_started_at, created_at")
      .eq("workspace_id", sb.workspaceId)
      .eq("status", "generating")
      .order("created_at", { ascending: false })
      .limit(1);
    if (isLiveGeneratingStyle((generating ?? [])[0])) {
      return NextResponse.json(
        {
          ok: false,
          error: "A creator style is already being generated. Wait for it to finish before starting another.",
        },
        { status: 409 },
      );
    }

    // Resolve the creator display metadata from the tracked account (verified to
    // belong to this workspace via the workspace_accounts join). Never trust the
    // client for these — a bad account id just yields null metadata + no posts.
    let creatorName: string | null = null;
    let creatorHandle: string | null = null;
    let creatorAvatarUrl: string | null = null;
    if (parsed.data.sourceAccountId) {
      const { data: acct } = await sb.raw
        .from("accounts")
        .select("name, linkedin_handle, profile_pic_url")
        .eq("id", parsed.data.sourceAccountId)
        .maybeSingle();
      const isTracked = await sb.raw
        .from("workspace_accounts")
        .select("account_id")
        .eq("workspace_id", sb.workspaceId)
        .eq("account_id", parsed.data.sourceAccountId)
        .maybeSingle();
      if (!isTracked.data) {
        return NextResponse.json(
          { ok: false, error: "That creator isn't tracked by your workspace." },
          { status: 404 },
        );
      }
      creatorName = (acct?.name as string | null) ?? null;
      creatorHandle = (acct?.linkedin_handle as string | null) ?? null;
      creatorAvatarUrl = (acct?.profile_pic_url as string | null) ?? null;
    }

    const { data: inserted, error } = await sb.raw
      .from("creator_style_profiles")
      .insert({
        workspace_id: sb.workspaceId,
        name: parsed.data.name,
        creator_name: creatorName,
        creator_handle: creatorHandle,
        creator_avatar_url: creatorAvatarUrl,
        source_account_id: parsed.data.sourceAccountId ?? null,
        status: "generating",
      })
      .select(COLS)
      .single();
    if (error) throw error;
    const row = inserted as CreatorStyleRow;

    // Kick off distillation after the response is sent.
    after(() =>
      runCreatorStyleGeneration({
        workspaceId: sb.workspaceId,
        profileId: row.id,
        sourceAccountId: parsed.data.sourceAccountId ?? null,
        savedPostIds: parsed.data.savedPostIds ?? null,
      }),
    );

    return NextResponse.json({ ok: true, style: row });
  } catch (e) {
    return errorResponse(e);
  }
}
