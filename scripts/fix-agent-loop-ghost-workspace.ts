/**
 * One-off: repair an org→user rekey ghost for the agent loop.
 *
 * The agent loop drafted into the OLD org-keyed workspace (invisible to the
 * user) because (a) duplicate workspace_accounts rows remained under the org
 * id and (b) the cron's workspace discovery truncated before reaching the
 * user-keyed rows. This script:
 *   1. Deletes org-keyed workspace_accounts rows that duplicate user-keyed ones
 *      (so the org ghost stops being processed).
 *   2. Moves the agent-loop rows (opportunities, system chat + messages,
 *      board drafts) from the org id to the user id.
 *   3. Deletes transient org-keyed chat_modeling_sources (pruned daily anyway).
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/fix-agent-loop-ghost-workspace.ts \
 *     --old org_... --new user_... [--apply]
 *
 * Dry-run by default; pass --apply to write.
 */

import { supabaseAdmin } from "@/lib/supabase";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const OLD = arg("old");
const NEW = arg("new");
const APPLY = process.argv.includes("--apply");

async function main() {
  if (!OLD || !NEW) throw new Error("Pass --old <org_id> --new <user_id>");
  const sb = supabaseAdmin();
  const log = (msg: string) => console.log(`${APPLY ? "[apply]" : "[dry]"} ${msg}`);

  // 1. Dedupe workspace_accounts.
  const { data: newAccounts, error: newAccError } = await sb
    .from("workspace_accounts")
    .select("account_id")
    .eq("workspace_id", NEW);
  if (newAccError) throw newAccError;
  const newAccountIds = (newAccounts ?? []).map((r) => r.account_id as string);
  log(`new workspace has ${newAccountIds.length} tracked accounts`);

  const { data: oldAccounts, error: oldAccError } = await sb
    .from("workspace_accounts")
    .select("account_id")
    .eq("workspace_id", OLD);
  if (oldAccError) throw oldAccError;
  const dupes = (oldAccounts ?? [])
    .map((r) => r.account_id as string)
    .filter((id) => newAccountIds.includes(id));
  log(`org workspace has ${(oldAccounts ?? []).length} rows, ${dupes.length} duplicate`);
  if (APPLY && dupes.length > 0) {
    for (let i = 0; i < dupes.length; i += 100) {
      const batch = dupes.slice(i, i + 100);
      const { error } = await sb
        .from("workspace_accounts")
        .delete()
        .eq("workspace_id", OLD)
        .in("account_id", batch);
      if (error) throw error;
    }
    log(`deleted ${dupes.length} duplicate workspace_accounts rows`);
  }

  // 2. Move agent-loop rows.
  const { data: oldChats, error: chatsError } = await sb
    .from("chats")
    .select("id")
    .eq("workspace_id", OLD)
    .eq("title", "Your agent");
  if (chatsError) throw chatsError;
  const chatIds = (oldChats ?? []).map((c) => c.id as string);
  log(`agent chats to move: ${chatIds.length}`);

  const move = async (table: string, filter: (q: any) => any) => {
    const query = filter(sb.from(table).update({ workspace_id: NEW }));
    if (!APPLY) {
      const { count, error } = await filter(
        sb.from(table).select("id", { count: "exact", head: true }),
      );
      if (error) throw error;
      log(`would move ${count ?? 0} rows in ${table}`);
      return;
    }
    const { error } = await query;
    if (error) throw error;
    log(`moved rows in ${table}`);
  };

  await move("agent_opportunities", (q) => q.eq("workspace_id", OLD));
  if (chatIds.length > 0) {
    await move("chats", (q) => q.in("id", chatIds));
    await move("chat_messages", (q) => q.in("chat_id", chatIds));
    await move("chat_artifacts", (q) => q.in("chat_id", chatIds));
  }

  // 3. Transient modeling sources: delete (pruned daily anyway).
  if (APPLY) {
    const { error } = await sb
      .from("chat_modeling_sources")
      .delete()
      .eq("workspace_id", OLD);
    if (error) throw error;
    log("deleted org-keyed chat_modeling_sources");
  }

  log("done");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
