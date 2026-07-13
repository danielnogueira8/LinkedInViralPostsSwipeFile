import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { claimAiOperation, releaseAiOperation } from "@/lib/ai-operation-claims";
import { checkChatRateLimit } from "@/lib/agent/rate-limit";
import {
  CREATOR_STYLES_PER_WORKSPACE_MAX,
  type CreatorStyleCreateInput,
  type CreatorStyleRow,
} from "@/lib/creator-styles";
import { isLiveGeneratingStyle } from "@/lib/creator-styles-cooldown";

export const CREATOR_STYLE_COLS =
  "id, workspace_id, name, creator_name, creator_handle, creator_avatar_url, source_account_id, description, sample_count, status, error, profile_json, prompt_block, generated_at, generating_started_at, created_at, updated_at";

export type StartCreatorStyleResult =
  | { ok: true; status: 200; style: CreatorStyleRow }
  | { ok: false; status: number; error: string };

export async function startCreatorStyleGeneration(input: {
  workspaceId: string;
  data: CreatorStyleCreateInput;
  db: SupabaseClient;
}): Promise<StartCreatorStyleResult> {
  const { workspaceId, data: request, db } = input;
  let claimId: string | null = null;
  try {
    claimId = await claimAiOperation({ workspaceId, operationKey: "creator-style-generation", ttlSeconds: 15 * 60, sb: db });
    if (!claimId) return { ok: false, status: 409, error: "A creator style is already being generated. Wait for it to finish before starting another." };

    const allowance = await checkChatRateLimit(workspaceId);
    if (!allowance.ok) return { ok: false, status: 429, error: allowance.message ?? "You've hit your usage limit for this period." };

    const { count, error: countError } = await db
      .from("creator_style_profiles")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    if (countError) throw countError;
    if ((count ?? 0) >= CREATOR_STYLES_PER_WORKSPACE_MAX) {
      return { ok: false, status: 409, error: `You've reached the limit of ${CREATOR_STYLES_PER_WORKSPACE_MAX} creator styles. Delete one to add another.` };
    }

    const { data: generating, error: generatingError } = await db
      .from("creator_style_profiles")
      .select("id, status, generating_started_at, created_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "generating")
      .order("created_at", { ascending: false })
      .limit(1);
    if (generatingError) throw generatingError;
    if (isLiveGeneratingStyle((generating ?? [])[0])) {
      return { ok: false, status: 409, error: "A creator style is already being generated. Wait for it to finish before starting another." };
    }

    let creator: { name?: string | null; linkedin_handle?: string | null; profile_pic_url?: string | null } | null = null;
    if (request.sourceAccountId) {
      const tracked = await db
        .from("workspace_accounts")
        .select("account_id")
        .eq("workspace_id", workspaceId)
        .eq("account_id", request.sourceAccountId)
        .maybeSingle();
      if (tracked.error) throw tracked.error;
      if (!tracked.data) return { ok: false, status: 404, error: "That creator isn't tracked by your workspace." };
      const account = await db
        .from("accounts")
        .select("name, linkedin_handle, profile_pic_url")
        .eq("id", request.sourceAccountId)
        .maybeSingle();
      if (account.error) throw account.error;
      creator = account.data;
    } else {
      const saved = await db
        .from("saved_posts")
        .select("id")
        .eq("workspace_id", workspaceId)
        .in("id", request.savedPostIds!);
      if (saved.error) throw saved.error;
      if ((saved.data ?? []).length !== request.savedPostIds!.length) {
        return { ok: false, status: 404, error: "One or more saved posts are not available in this workspace." };
      }
    }

    const { data: row, error } = await db
      .from("creator_style_profiles")
      .insert({
        workspace_id: workspaceId,
        name: request.name,
        creator_name: creator?.name ?? null,
        creator_handle: creator?.linkedin_handle ?? null,
        creator_avatar_url: creator?.profile_pic_url ?? null,
        source_account_id: request.sourceAccountId ?? null,
        status: "generating",
        generating_started_at: new Date().toISOString(),
      })
      .select(CREATOR_STYLE_COLS)
      .single();
    if (error) throw error;

    try {
      await enqueueBackgroundJob({
        workspaceId,
        type: "creator_style_generation",
        payload: { profileId: row.id, sourceAccountId: request.sourceAccountId ?? null, savedPostIds: request.savedPostIds ?? null },
        progress: { stage: "Queued", profileId: row.id },
        sb: db,
      });
    } catch (error) {
      await db
        .from("creator_style_profiles")
        .update({ status: "failed", error: "We couldn't queue creator style generation. Please try again.", generating_started_at: null, updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("workspace_id", workspaceId)
        .eq("status", "generating");
      throw error;
    }

    return { ok: true, status: 200, style: row as CreatorStyleRow };
  } finally {
    if (claimId) await releaseAiOperation({ workspaceId, claimId, sb: db }).catch(() => {});
  }
}
