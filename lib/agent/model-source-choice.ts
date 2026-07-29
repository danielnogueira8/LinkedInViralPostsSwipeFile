import type { SupabaseClient } from "@supabase/supabase-js";
import { neutralizeMarkers } from "@/lib/agent/untrusted";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_SOURCE_CHOICE_PREFIX = "model-source:";
const NO_ROWS_SENTINEL = "00000000-0000-0000-0000-000000000000";

export function isModelSourceChoicePostId(postId: string): boolean {
  return UUID_RE.test(postId);
}

export function modelSourceChoiceId(postId: string): string {
  if (!isModelSourceChoicePostId(postId)) {
    throw new Error("Model source choices require a valid post id.");
  }
  return `${MODEL_SOURCE_CHOICE_PREFIX}${postId}`;
}

export function parseModelSourceChoiceId(
  choiceId: string | undefined,
): { postId: string } | null {
  if (!choiceId?.startsWith(MODEL_SOURCE_CHOICE_PREFIX)) return null;
  const postId = choiceId.slice(MODEL_SOURCE_CHOICE_PREFIX.length);
  return isModelSourceChoicePostId(postId)
    ? { postId }
    : null;
}

/**
 * Re-resolve a persisted candidate against the workspace before it can become
 * a modeling source. The choice id is only a pointer; current database scope
 * and source text remain authoritative.
 */
export async function stashWorkspacePostAsModelSource(input: {
  db: SupabaseClient;
  workspaceId: string;
  postId: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  if (!isModelSourceChoicePostId(input.postId)) return null;
  input.signal?.throwIfAborted();

  let accountQuery = input.db
    .from("workspace_accounts")
    .select("account_id")
    .eq("workspace_id", input.workspaceId);
  if (input.signal) accountQuery = accountQuery.abortSignal(input.signal);
  const { data: accountRows, error: accountError } = await accountQuery;
  if (accountError) throw accountError;
  const accountIds = (accountRows ?? []).flatMap((row) =>
    typeof row.account_id === "string" ? [row.account_id] : [],
  );

  let postQuery = input.db
    .from("posts")
    .select(
      "id, text, post_type, account_id, accounts!inner(name, profile_pic_url)",
    )
    .eq("id", input.postId)
    .in(
      "account_id",
      accountIds.length > 0 ? accountIds : [NO_ROWS_SENTINEL],
    );
  if (input.signal) postQuery = postQuery.abortSignal(input.signal);
  const { data: post, error: postError } = await postQuery.maybeSingle();
  if (postError) throw postError;
  const postText =
    post && typeof post.text === "string" ? post.text.trim() : "";
  if (!post || !postText) return null;

  const account = Array.isArray(post.accounts)
    ? post.accounts[0]
    : post.accounts;
  input.signal?.throwIfAborted();
  let insertQuery = input.db
    .from("chat_modeling_sources")
    .insert({
      workspace_id: input.workspaceId,
      post_text: neutralizeMarkers(postText),
      author_name:
        account && typeof account.name === "string" ? account.name : null,
      author_avatar:
        account && typeof account.profile_pic_url === "string"
          ? account.profile_pic_url
          : null,
      source: "swipe",
      source_post_id: input.postId,
      post_type: post.post_type === "lead_magnet" ? "lead_magnet" : "regular",
      partial: false,
    })
    .select("id");
  if (input.signal) insertQuery = insertQuery.abortSignal(input.signal);
  const { data: source, error: insertError } = await insertQuery.single();
  if (insertError) throw insertError;
  return typeof source?.id === "string" ? source.id : null;
}
