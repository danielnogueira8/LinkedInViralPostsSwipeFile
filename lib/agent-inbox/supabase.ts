import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAllRows } from "@/lib/db-paginate";
import { AGENT_INBOX_LANES } from "@/lib/agent-inbox";
import { loadAgentDismissalFeedback } from "@/lib/agent-inbox/feedback";
import type {
  AgentInboxFeedback,
  AgentInboxIdea,
  AgentInboxLane,
  AgentInboxPreferences,
  AgentInboxRepository,
  AgentInboxTransition,
  GeneratedAgentInboxIdea,
} from "@/lib/agent-inbox";

const IDEA_COLUMNS =
  "id, workspace_id, lane, status, headline, angle, why, evidence, source_kind, source_ref, source_url, source_title, source_published_at, score, fingerprint, available_on, expires_at, snoozed_until, acted_at, discard_reason, read_at, created_at, updated_at";

type IdeaRow = Record<string, unknown>;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function ideaFromRow(row: IdeaRow): AgentInboxIdea {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    lane: row.lane as AgentInboxIdea["lane"],
    status: row.status as AgentInboxIdea["status"],
    headline: String(row.headline),
    angle: String(row.angle),
    why: Array.isArray(row.why)
      ? row.why.filter((value): value is string => typeof value === "string")
      : [],
    evidence: Array.isArray(row.evidence)
      ? (row.evidence as AgentInboxIdea["evidence"])
      : [],
    sourceKind: row.source_kind as AgentInboxIdea["sourceKind"],
    sourceRef: stringOrNull(row.source_ref),
    sourceUrl: stringOrNull(row.source_url),
    sourceTitle: stringOrNull(row.source_title),
    sourcePublishedAt: stringOrNull(row.source_published_at),
    score: Number(row.score ?? 0),
    fingerprint: String(row.fingerprint),
    availableOn: String(row.available_on),
    expiresAt: stringOrNull(row.expires_at),
    snoozedUntil: stringOrNull(row.snoozed_until),
    actedAt: stringOrNull(row.acted_at),
    discardReason: stringOrNull(row.discard_reason),
    readAt: stringOrNull(row.read_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function generatedRow(
  workspaceId: string,
  idea: GeneratedAgentInboxIdea,
  localDate: string,
) {
  return {
    workspace_id: workspaceId,
    lane: idea.lane,
    status: "active",
    headline: idea.headline,
    angle: idea.angle,
    why: idea.why,
    evidence: idea.evidence,
    source_kind: idea.sourceKind,
    source_ref: idea.sourceRef,
    source_url: idea.sourceUrl,
    source_title: idea.sourceTitle,
    source_published_at: idea.sourcePublishedAt,
    score: idea.score,
    fingerprint: idea.fingerprint,
    available_on: localDate,
    expires_at: idea.expiresAt,
  };
}

export const DEFAULT_AGENT_INBOX_PREFERENCES: AgentInboxPreferences = {
  enabled: true,
  timezone: "UTC",
  deliveryLocalTime: "08:00",
  topics: [],
  newsSensitivity: "standard",
};

export function createAgentInboxRepository(
  db: SupabaseClient,
): AgentInboxRepository {
  return {
    async readActive(workspaceId, now) {
      const { data, error } = await db
        .from("agent_inbox_ideas")
        .select(IDEA_COLUMNS)
        .eq("workspace_id", workspaceId)
        .eq("status", "active")
        .in("lane", [...AGENT_INBOX_LANES])
        .or(`expires_at.is.null,expires_at.gt.${now.toISOString()}`)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as IdeaRow[]).map(ideaFromRow);
    },

    async readRecentActivity(workspaceId, limit) {
      const { data, error } = await db
        .from("agent_inbox_ideas")
        .select(IDEA_COLUMNS)
        .eq("workspace_id", workspaceId)
        .neq("status", "active")
        .in("lane", [...AGENT_INBOX_LANES])
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return ((data ?? []) as IdeaRow[]).map(ideaFromRow);
    },

    async readRecentFingerprints(workspaceId, since) {
      // Paged rather than `.limit(500)`: the window is 90 days and a workspace
      // can produce up to nine ideas a day, so a fixed cap silently truncates
      // and lets already-pitched ideas come back. Which rows a bare limit drops
      // is also unordered, so the loss was arbitrary.
      const rows = await selectAllRows<{ fingerprint: unknown }>(() =>
        db
          .from("agent_inbox_ideas")
          .select("fingerprint")
          .eq("workspace_id", workspaceId)
          .gte("created_at", since.toISOString())
          .order("created_at", { ascending: false }),
      );
      return new Set(
        rows
          .map((row) => row.fingerprint)
          .filter((value): value is string => typeof value === "string"),
      );
    },

    async readRecentSources(workspaceId, since) {
      // Same window as fingerprints, but keyed on the source. A story pitched
      // yesterday under a different headline has a different fingerprint, so
      // without this it could be re-pitched the next day as though it were new.
      const rows = await selectAllRows<{
        source_url: unknown;
        source_ref: unknown;
      }>(() =>
        db
          .from("agent_inbox_ideas")
          .select("source_url, source_ref")
          .eq("workspace_id", workspaceId)
          .gte("created_at", since.toISOString())
          .order("created_at", { ascending: false }),
      );
      return new Set(
        rows
          .map((row) => stringOrNull(row.source_url) ?? stringOrNull(row.source_ref))
          .filter((value): value is string => Boolean(value)),
      );
    },

    async readRecentFeedback(workspaceId) {
      return (await loadAgentDismissalFeedback(db, workspaceId)).map(
        (entry) => ({
          ...entry,
          lane: entry.lane as AgentInboxFeedback["lane"],
        }),
      );
    },

    async releaseDueSnoozed(workspaceId, now) {
      const { error } = await db.rpc("release_due_agent_inbox_ideas", {
        p_workspace_id: workspaceId,
        p_now: now.toISOString(),
      });
      if (error) throw error;
    },

    async claimDailyRun(workspaceId, localDate, timezone, lanes) {
      const { data, error } = await db.rpc("claim_agent_inbox_run", {
        p_workspace_id: workspaceId,
        p_local_date: localDate,
        p_timezone: timezone,
        p_requested_lanes: lanes,
      });
      if (error) throw error;
      return data === true;
    },

    async completeDailyRun(workspaceId, localDate, ideaIds) {
      const { error } = await db
        .from("agent_inbox_runs")
        .update({
          status: "completed",
          created_idea_ids: ideaIds,
          error: null,
          completed_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspaceId)
        .eq("local_date", localDate)
        .eq("status", "running");
      if (error) throw error;
    },

    async releaseDailyRun(workspaceId, localDate) {
      // Hand the claim back as `failed` rather than deleting the row: the
      // attempts counter is what stops an endlessly retrying workspace, and a
      // delete would reset it. claim_agent_inbox_run treats `failed` as
      // reclaimable, so the next tick can pick the day up again.
      const { error } = await db
        .from("agent_inbox_runs")
        .update({
          status: "failed",
          error: "No evidence available for the requested lanes",
          completed_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspaceId)
        .eq("local_date", localDate)
        .eq("status", "running");
      if (error) throw error;
    },

    async failDailyRun(workspaceId, localDate, message) {
      const { error } = await db
        .from("agent_inbox_runs")
        .update({
          status: "failed",
          error: message.slice(0, 500),
          completed_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspaceId)
        .eq("local_date", localDate)
        .eq("status", "running");
      if (error) throw error;
    },

    async insertIdeas(workspaceId, ideas, localDate) {
      // One statement per idea keeps the per-row unique-violation skip: a
      // single batch insert would fail the whole set on one duplicate
      // fingerprint. They run concurrently rather than sequentially so up to
      // nine round-trips do not stretch the window in which a crash would
      // strand the run as `running`.
      const settled = await Promise.all(
        ideas.map(async (idea) => {
          const { data, error } = await db
            .from("agent_inbox_ideas")
            .insert(generatedRow(workspaceId, idea, localDate))
            .select(IDEA_COLUMNS)
            .single();
          if (error?.code === "23505") return null;
          if (error) throw error;
          return ideaFromRow(data as IdeaRow);
        }),
      );
      return settled.filter((row): row is AgentInboxIdea => row !== null);
    },

    async transition(workspaceId, ideaId, action) {
      const rpcInput = transitionRpcInput(workspaceId, ideaId, action);
      const { data, error } = await db.rpc(
        "transition_agent_inbox_idea",
        rpcInput,
      );
      if (error) throw error;
      if (!data) return null;
      const row = Array.isArray(data) ? data[0] : data;
      return row ? ideaFromRow(row as IdeaRow) : null;
    },

    async readPreferences(workspaceId) {
      const { data, error } = await db
        .from("agent_inbox_preferences")
        .select(
          "enabled, timezone, delivery_local_time, topics, news_sensitivity",
        )
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        const { data: slot, error: slotError } = await db
          .from("posting_slots")
          .select("timezone")
          .eq("workspace_id", workspaceId)
          .is("deleted_at", null)
          .limit(1)
          .maybeSingle();
        if (slotError) throw slotError;
        return {
          ...DEFAULT_AGENT_INBOX_PREFERENCES,
          timezone: stringOrNull(slot?.timezone) ?? "UTC",
        };
      }
      return {
        enabled: data.enabled !== false,
        timezone: stringOrNull(data.timezone) ?? "UTC",
        deliveryLocalTime:
          stringOrNull(data.delivery_local_time)?.slice(0, 5) ?? "08:00",
        topics: Array.isArray(data.topics)
          ? data.topics.filter(
              (value): value is string => typeof value === "string",
            )
          : [],
        newsSensitivity:
          data.news_sensitivity === "low" || data.news_sensitivity === "high"
            ? data.news_sensitivity
            : "standard",
      };
    },
  };
}

function transitionRpcInput(
  workspaceId: string,
  ideaId: string,
  action: AgentInboxTransition,
) {
  return {
    p_workspace_id: workspaceId,
    p_idea_id: ideaId,
    p_action: action.kind,
    p_reason:
      action.kind === "discard" ? (action.reason ?? "Not relevant") : null,
    p_snoozed_until:
      action.kind === "snooze" ? action.until.toISOString() : null,
  };
}

export async function saveAgentInboxPreferences(
  db: SupabaseClient,
  workspaceId: string,
  preferences: AgentInboxPreferences,
): Promise<void> {
  const { error } = await db.from("agent_inbox_preferences").upsert(
    {
      workspace_id: workspaceId,
      enabled: preferences.enabled,
      timezone: preferences.timezone,
      delivery_local_time: preferences.deliveryLocalTime,
      topics: preferences.topics,
      news_sensitivity: preferences.newsSensitivity,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id" },
  );
  if (error) throw error;
}

export async function readAgentInboxIdea(
  db: SupabaseClient,
  workspaceId: string,
  ideaId: string,
): Promise<AgentInboxIdea | null> {
  const { data, error } = await db
    .from("agent_inbox_ideas")
    .select(IDEA_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", ideaId)
    .in("lane", [...AGENT_INBOX_LANES])
    .maybeSingle();
  if (error) throw error;
  return data ? ideaFromRow(data as IdeaRow) : null;
}

export async function listAgentInboxWorkspaces(
  db: SupabaseClient,
): Promise<
  Array<{ workspaceId: string; timezone: string; deliveryLocalTime: string }>
> {
  const activeSince = new Date(Date.now() - 30 * 86_400_000).toISOString();
  // These five reads are CROSS-WORKSPACE, so they grow with total users rather
  // than with one workspace's data — and together they decide which workspaces
  // are eligible for inbox cards at all. `.limit(5000)` did not lift
  // PostgREST's 1000-row cap, so once any of them passed 1000 rows the extra
  // workspaces silently vanished from the eligibility list and stopped
  // receiving cards, with no error: a short response is indistinguishable from
  // "that is all there is". `chats` is the nearest ceiling — it counts CHATS
  // updated in 30 days, not workspaces.
  const [preferences, voice, learning, recentChats, postingSlots] =
    await Promise.all([
      selectAllRows<{
        workspace_id: string | null;
        timezone: string | null;
        delivery_local_time: string | null;
      }>(() =>
        db
          .from("agent_inbox_preferences")
          .select("workspace_id, timezone, delivery_local_time")
          .eq("enabled", true) as never,
      ),
      selectAllRows<{ workspace_id: string | null }>(() =>
        db
          .from("voice_profiles")
          .select("workspace_id")
          .eq("status", "ready") as never,
      ),
      selectAllRows<{ workspace_id: string | null }>(() =>
        db
          .from("workspace_learning_snapshots")
          .select("workspace_id")
          .eq("status", "active") as never,
      ),
      selectAllRows<{ workspace_id: string | null }>(() =>
        db
          .from("chats")
          .select("workspace_id")
          .gte("updated_at", activeSince)
          .order("updated_at", { ascending: false }) as never,
      ),
      selectAllRows<{
        workspace_id: string | null;
        timezone: string | null;
      }>(() =>
        db
          .from("posting_slots")
          .select("workspace_id, timezone")
          .is("deleted_at", null) as never,
      ),
    ]);
  const postingTimezone = new Map<string, string>();
  for (const row of postingSlots) {
    if (
      typeof row.workspace_id === "string" &&
      typeof row.timezone === "string" &&
      !postingTimezone.has(row.workspace_id)
    ) {
      postingTimezone.set(row.workspace_id, row.timezone);
    }
  }
  const recentlyActive = new Set(
    recentChats
      .map((row) => row.workspace_id)
      .filter((value): value is string => typeof value === "string"),
  );
  const timezoneByWorkspace = new Map<string, string>();
  const deliveryByWorkspace = new Map<string, string>();
  for (const row of preferences) {
    if (typeof row.workspace_id === "string") {
      timezoneByWorkspace.set(
        row.workspace_id,
        stringOrNull(row.timezone) ?? "UTC",
      );
      deliveryByWorkspace.set(
        row.workspace_id,
        stringOrNull(row.delivery_local_time)?.slice(0, 5) ?? "08:00",
      );
    }
  }
  for (const row of [...voice, ...learning]) {
    if (
      typeof row.workspace_id === "string" &&
      recentlyActive.has(row.workspace_id) &&
      !timezoneByWorkspace.has(row.workspace_id)
    ) {
      timezoneByWorkspace.set(
        row.workspace_id,
        postingTimezone.get(row.workspace_id) ?? "UTC",
      );
    }
  }
  return [...timezoneByWorkspace.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([workspaceId, timezone]) => ({
      workspaceId,
      timezone,
      deliveryLocalTime: deliveryByWorkspace.get(workspaceId) ?? "08:00",
    }));
}

export function lanesFromIdeas(ideas: AgentInboxIdea[]): AgentInboxLane[] {
  const occupied = new Set(ideas.map((idea) => idea.lane));
  return AGENT_INBOX_LANES.filter(
    (lane) => !occupied.has(lane),
  );
}
