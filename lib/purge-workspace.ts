import { supabaseAdmin } from "@/lib/supabase";

// -----------------------------------------------------------------------------
// Hard-delete ALL of a workspace's data (GDPR erasure / self-serve "delete my
// data"). Uses the service-role client (bypasses RLS) so it can reach every
// per-tenant table, and scopes EVERY delete to the workspace so it can never
// touch another tenant or the shared global catalog.
//
// What is deleted: every table that carries this workspace's data. What is
// deliberately NOT deleted: the shared global catalog (accounts, posts,
// templates, categories) — that's every workspace's data, seeded from the
// Google Sheet, not this user's. Untracking (workspace_accounts) is enough to
// disconnect this workspace from it.
//
// FK cascades already clean some children (chat_messages/chat_artifacts →
// chats, saved_post_overrides → saved_posts, image_prompts → clients), but we
// delete those explicitly too — belt-and-suspenders, so completeness doesn't
// depend on every cascade being present. All deletes are idempotent.
//
// `runs` has a NULLABLE workspace_id: the daily global scrape runs are NULL and
// must survive; we only delete this workspace's own runs.
//
// shared_bookmarks / saved_post_overrides are cross-user: we remove rows where
// this workspace is the sharing OWNER, and rows where the deleting USER is the
// recipient (so their accepted shares + per-user overrides go too).
// -----------------------------------------------------------------------------

export type PurgeResult = {
  ok: boolean;
  deleted: Record<string, number | null>;
  errors: { table: string; error: string }[];
};

export async function purgeWorkspaceData(
  workspaceId: string,
  userId: string | null,
): Promise<PurgeResult> {
  const sb = supabaseAdmin();
  const deleted: Record<string, number | null> = {};
  const errors: { table: string; error: string }[] = [];

  // Run one scoped delete and record its row count under `label`. Never throws
  // — collects errors so one failing table doesn't abort the rest of the
  // erasure (a partial purge that continues beats stopping half-done). `build`
  // receives the raw client so each call picks its own table + predicate; the
  // label (usually the table name) keys the result so a second predicate on the
  // same table can be reported separately.
  async function wipe(
    label: string,
    build: (client: ReturnType<typeof supabaseAdmin>) => unknown,
  ): Promise<void> {
    try {
      const { count, error } = (await build(sb)) as {
        count: number | null;
        error: { message: string } | null;
      };
      if (error) {
        errors.push({ table: label, error: error.message });
        deleted[label] = null;
      } else {
        deleted[label] = count ?? 0;
      }
    } catch (e) {
      errors.push({ table: label, error: (e as Error).message });
      deleted[label] = null;
    }
  }

  const del = (table: string) => sb.from(table).delete({ count: "exact" });

  // Order isn't load-bearing (every delete is workspace-scoped and cascades
  // cover children), but grouped by concern for readability.

  // Chat
  await wipe("chat_artifacts", () => del("chat_artifacts").eq("workspace_id", workspaceId));
  await wipe("chat_messages", () => del("chat_messages").eq("workspace_id", workspaceId));
  await wipe("chat_modeling_sources", () => del("chat_modeling_sources").eq("workspace_id", workspaceId));
  await wipe("chats", () => del("chats").eq("workspace_id", workspaceId));

  // Content / library
  await wipe("saved_posts", () => del("saved_posts").eq("workspace_id", workspaceId));
  await wipe("custom_skills", () => del("custom_skills").eq("workspace_id", workspaceId));
  await wipe("voice_profiles", () => del("voice_profiles").eq("workspace_id", workspaceId));
  await wipe("image_prompts", () => del("image_prompts").eq("workspace_id", workspaceId));
  await wipe("clients", () => del("clients").eq("workspace_id", workspaceId));

  // Tracking link to the shared catalog (removes the link, NOT the catalog)
  await wipe("workspace_accounts", () => del("workspace_accounts").eq("workspace_id", workspaceId));

  // Ops / config
  await wipe("settings", () => del("settings").eq("workspace_id", workspaceId));
  await wipe("usage_events", () => del("usage_events").eq("workspace_id", workspaceId));
  // Only this workspace's runs — the global (NULL workspace_id) scrape runs stay.
  await wipe("runs", () => del("runs").eq("workspace_id", workspaceId));

  // Cross-user sharing: libraries this workspace OWNS...
  await wipe("shared_bookmarks(owner)", () =>
    del("shared_bookmarks").eq("owner_workspace_id", workspaceId),
  );
  // ...and rows where this USER is the recipient (accepted shares + per-user
  // bookmark overrides). Keyed by user, not workspace.
  if (userId) {
    await wipe("shared_bookmarks(recipient)", () =>
      del("shared_bookmarks").eq("recipient_user_id", userId),
    );
    await wipe("saved_post_overrides", () =>
      del("saved_post_overrides").eq("recipient_user_id", userId),
    );
  }

  return { ok: errors.length === 0, deleted, errors };
}
