import type { SupabaseClient } from "@supabase/supabase-js";
import { AGENT_CHAT_TITLE } from "@/lib/agent-loop/constants";

/** Get the workspace's active agent chat, creating it exactly once on a race. */
export async function getOrCreateAgentSystemChat(
  db: SupabaseClient,
  workspaceId: string,
): Promise<string> {
  const { data: existing, error: existingError } = await db
    .from("chats")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("title", AGENT_CHAT_TITLE)
    .is("archived_at", null)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.id) return existing.id as string;

  const { data: created, error: createError } = await db
    .from("chats")
    .insert({ workspace_id: workspaceId, title: AGENT_CHAT_TITLE })
    .select("id")
    .maybeSingle();
  if (!createError && created?.id) return created.id as string;
  if (createError?.code !== "23505") {
    if (createError) throw createError;
    throw new Error("Agent chat was created without an id.");
  }

  const { data: raced, error: racedError } = await db
    .from("chats")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("title", AGENT_CHAT_TITLE)
    .is("archived_at", null)
    .maybeSingle();
  if (racedError) throw racedError;
  if (raced?.id) return raced.id as string;
  throw createError;
}
