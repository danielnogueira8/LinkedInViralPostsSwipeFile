import { supabaseAdmin } from "@/lib/supabase";

// -----------------------------------------------------------------------------
// Hard-delete ALL of a workspace's data (GDPR erasure / self-serve "delete my
// data"). Uses the service-role client (bypasses RLS) so it can reach every
// per-tenant table, and scopes EVERY delete to the workspace so it can never
// touch another tenant or the shared global catalog.
//
// What is deleted: every table that carries this workspace's data. What is
// deliberately NOT deleted: the shared global catalog (accounts, posts,
// templates, categories) — that's the app-owned catalog shared by every
// workspace, not this user's. Untracking (workspace_accounts) is enough to
// disconnect this workspace from it.
//
// FK cascades already clean some children (chat_messages → chats,
// saved_post_overrides → saved_posts, image_prompts → clients), but we delete
// workspace-scoped children explicitly too so completeness does not depend on
// every cascade being present. Children are deleted before parents. All
// deletes are idempotent.
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

  // Transient work and caches. Provider locks must precede their jobs.
  await wipe("ai_operation_claims", () =>
    del("ai_operation_claims").eq("workspace_id", workspaceId),
  );
  await wipe("lead_magnet_generation_claims", () =>
    del("lead_magnet_generation_claims").eq("workspace_id", workspaceId),
  );
  await wipe("media_quota_claims", () =>
    del("media_quota_claims").eq("workspace_id", workspaceId),
  );
  await wipe("freshness_constraint_cache", () =>
    del("freshness_constraint_cache").eq("workspace_id", workspaceId),
  );
  await wipe("image_analysis_cache", () =>
    del("image_analysis_cache").eq("workspace_id", workspaceId),
  );
  await wipe("provider_locks", () =>
    del("provider_locks").eq("workspace_id", workspaceId),
  );
  await wipe("background_jobs", () =>
    del("background_jobs").eq("workspace_id", workspaceId),
  );

  // Chat and generated content. Analytics references artifacts.
  await wipe("post_analytics", () =>
    del("post_analytics").eq("workspace_id", workspaceId),
  );
  // Content Outcomes are append-only during normal use. The domain purge
  // operation removes corrections and outcomes before their owning Drafts.
  await wipe("content_outcomes", async (client) => {
    const { data, error } = await client.rpc("purge_content_outcomes", {
      p_workspace_id: workspaceId,
    });
    return {
      count: typeof data === "number" ? data : null,
      error,
    };
  });
  await wipe("content_learning_processing_cursors", () =>
    del("content_learning_processing_cursors").eq(
      "workspace_id",
      workspaceId,
    ),
  );
  // Review history is append-only and cascades only during this owning-item
  // erasure.
  await wipe("workspace_knowledge_items", async (client) => {
    const { data, error } = await client.rpc("purge_workspace_knowledge", {
      p_workspace_id: workspaceId,
    });
    return {
      count: typeof data === "number" ? data : null,
      error,
    };
  });
  await wipe("content_preference_evidence", () =>
    del("content_preference_evidence").eq("workspace_id", workspaceId),
  );
  await wipe("content_preference_learning_outcomes", () =>
    del("content_preference_learning_outcomes").eq(
      "workspace_id",
      workspaceId,
    ),
  );
  await wipe("workspace_learning_snapshots", async () => {
    const { data, error } = await sb.rpc("purge_workspace_learning", {
      p_workspace_id: workspaceId,
    });
    return {
      count: typeof data === "number" ? data : null,
      error,
    };
  });
  await wipe("draft_edit_events", () =>
    del("draft_edit_events").eq("workspace_id", workspaceId),
  );
  await wipe("content_feedback", () =>
    del("content_feedback").eq("workspace_id", workspaceId),
  );
  await wipe("chat_action_retry_contexts", () =>
    del("chat_action_retry_contexts").eq("workspace_id", workspaceId),
  );
  await wipe("chat_action_turn_controls", () =>
    del("chat_action_turn_controls").eq("workspace_id", workspaceId),
  );
  await wipe("chat_action_checkpoints", () =>
    del("chat_action_checkpoints").eq("workspace_id", workspaceId),
  );
  await wipe("modeled_draft_slots", () =>
    del("modeled_draft_slots").eq("workspace_id", workspaceId),
  );
  await wipe("modeled_draft_batches", () =>
    del("modeled_draft_batches").eq("workspace_id", workspaceId),
  );
  await wipe("chat_artifacts", () => del("chat_artifacts").eq("workspace_id", workspaceId));
  // Lineage is append-only during normal lifecycle. Its delete trigger allows
  // this explicit GDPR erasure only after the owning Artifact is gone.
  await wipe("artifact_lineage", () =>
    del("artifact_lineage").eq("workspace_id", workspaceId),
  );
  await wipe("chat_messages", () => del("chat_messages").eq("workspace_id", workspaceId));
  await wipe("chat_modeling_sources", () => del("chat_modeling_sources").eq("workspace_id", workspaceId));
  await wipe("chats", () => del("chats").eq("workspace_id", workspaceId));

  // Batch and publishing state.
  await wipe("batch_draft_slots", () =>
    del("batch_draft_slots").eq("workspace_id", workspaceId),
  );
  await wipe("batch_runs", () => del("batch_runs").eq("workspace_id", workspaceId));
  await wipe("publishing_connections", () =>
    del("publishing_connections").eq("workspace_id", workspaceId),
  );

  // Content, styles, and media. Style sources reference profiles; image
  // prompts reference clients.
  await wipe("creator_style_profile_sources", () =>
    del("creator_style_profile_sources").eq("workspace_id", workspaceId),
  );
  await wipe("creator_style_profiles", () =>
    del("creator_style_profiles").eq("workspace_id", workspaceId),
  );
  await wipe("saved_posts", () => del("saved_posts").eq("workspace_id", workspaceId));
  await wipe("lead_magnets", () => del("lead_magnets").eq("workspace_id", workspaceId));
  await wipe("custom_skills", () => del("custom_skills").eq("workspace_id", workspaceId));
  await wipe("content_templates", () =>
    del("content_templates").eq("workspace_id", workspaceId),
  );
  await wipe("content_preferences", () =>
    del("content_preferences").eq("workspace_id", workspaceId),
  );
  await wipe("voice_profiles", () => del("voice_profiles").eq("workspace_id", workspaceId));
  await wipe("media_assets", () => del("media_assets").eq("workspace_id", workspaceId));
  await wipe("image_prompts", () => del("image_prompts").eq("workspace_id", workspaceId));
  await wipe("clients", () => del("clients").eq("workspace_id", workspaceId));

  // Per-workspace state attached to the shared post/account catalog.
  await wipe("workspace_post_classification", () =>
    del("workspace_post_classification").eq("workspace_id", workspaceId),
  );
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

  // Custom categories are workspace-owned, while curated categories have a
  // NULL workspace_id and survive. Delete this parent last because saved posts,
  // overrides, workspace-account links, and shared account metadata can refer
  // to it. The accounts FK uses ON DELETE SET NULL.
  await wipe("categories", () => del("categories").eq("workspace_id", workspaceId));

  return { ok: errors.length === 0, deleted, errors };
}
