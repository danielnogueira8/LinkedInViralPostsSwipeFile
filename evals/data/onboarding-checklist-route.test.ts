import { beforeEach, describe, expect, test, vi } from "vitest";

// Onboarding checklist route: every box must tick from the action the label
// describes. These tests pin the signal each item reads so a future refactor
// can't quietly untick a completed action (see codex/checklist-completion).

const hoisted = vi.hoisted(() => ({
  dbState: {
    voiceReady: 0,
    trackedAccountIds: [] as string[],
    artifacts: 0,
    assistantMessages: 0,
    scheduledArtifacts: 0,
    savedPosts: 0,
    scrapedPosts: 0,
    dismissedSettings: 0,
  } satisfies Record<string, unknown>,
  connection: null as unknown,
}));

type Filter = [string, unknown];
type Resolution = { data: unknown; error: null; count: number };

class Query implements PromiseLike<Resolution> {
  private readonly filters: Filter[] = [];

  constructor(private readonly table: string) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push([`eq:${column}`, value]);
    return this;
  }

  in(column: string, value: unknown) {
    this.filters.push([`in:${column}`, value]);
    return this;
  }

  or(value: string) {
    this.filters.push(["or", value]);
    return this;
  }

  private resolve(): Resolution {
    const state = hoisted.dbState;
    switch (this.table) {
      case "voice_profiles":
        return { data: null, error: null, count: state.voiceReady };
      case "workspace_accounts":
        // Serves both the head-count probe and the account_id follow-up.
        return {
          data: state.trackedAccountIds.map((id) => ({ account_id: id })),
          error: null,
          count: state.trackedAccountIds.length,
        };
      case "chat_artifacts": {
        const isScheduledQuery = this.filters.some(([name]) => name === "or");
        return {
          data: null,
          error: null,
          count: isScheduledQuery
            ? state.scheduledArtifacts
            : state.artifacts,
        };
      }
      case "chat_messages":
        return { data: null, error: null, count: state.assistantMessages };
      case "saved_posts":
        return { data: null, error: null, count: state.savedPosts };
      case "posts":
        return { data: null, error: null, count: state.scrapedPosts };
      case "settings":
        return { data: null, error: null, count: state.dismissedSettings };
      default:
        throw new Error(`unexpected table ${this.table}`);
    }
  }

  then<TResult1 = Resolution, TResult2 = never>(
    onfulfilled?:
      | ((value: Resolution) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.resolve()).then(onfulfilled, onrejected);
  }
}

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-under-test",
    raw: { from: (table: string) => new Query(table) },
  }),
}));

vi.mock("@/lib/publishing", () => ({
  getConnection: async () => hoisted.connection,
  canPublish: (connection: unknown) => Boolean(connection),
}));

import { GET } from "@/app/api/onboarding/checklist/route";

type ChecklistBody = {
  ok: true;
  dismissed: boolean;
  items: {
    voice: boolean;
    linkedin: boolean;
    creators: boolean;
    inspiration: boolean;
    batch: boolean;
    scheduled: boolean;
  };
};

async function getChecklist(): Promise<ChecklistBody> {
  const response = await GET();
  return (await response.json()) as ChecklistBody;
}

beforeEach(() => {
  hoisted.dbState = {
    voiceReady: 0,
    trackedAccountIds: [],
    artifacts: 0,
    assistantMessages: 0,
    scheduledArtifacts: 0,
    savedPosts: 0,
    scrapedPosts: 0,
    dismissedSettings: 0,
  };
  hoisted.connection = null;
});

describe("GET /api/onboarding/checklist", () => {
  test("a brand-new workspace has every item unticked and is not dismissed", async () => {
    const body = await getChecklist();
    expect(body.ok).toBe(true);
    expect(body.dismissed).toBe(false);
    expect(body.items).toEqual({
      voice: false,
      linkedin: false,
      creators: false,
      inspiration: false,
      batch: false,
      scheduled: false,
    });
  });

  test("Set up voice ticks from a ready voice profile", async () => {
    hoisted.dbState.voiceReady = 1;
    expect((await getChecklist()).items.voice).toBe(true);
  });

  test("Connect LinkedIn ticks from a publishable connection", async () => {
    hoisted.connection = { accessToken: "token" };
    expect((await getChecklist()).items.linkedin).toBe(true);
  });

  test("Track creators ticks from a tracked account", async () => {
    hoisted.dbState.trackedAccountIds = ["account-1"];
    expect((await getChecklist()).items.creators).toBe(true);
  });

  test("Fill inspiration ticks from scraped posts of tracked accounts", async () => {
    hoisted.dbState.trackedAccountIds = ["account-1"];
    hoisted.dbState.scrapedPosts = 3;
    expect((await getChecklist()).items.inspiration).toBe(true);
  });

  test("Fill inspiration also ticks from a bookmarked (saved) post — saving is filling", async () => {
    hoisted.dbState.savedPosts = 1;
    expect((await getChecklist()).items.inspiration).toBe(true);
  });

  test("Generate a post ticks from a draft artifact or any assistant reply", async () => {
    hoisted.dbState.artifacts = 1;
    expect((await getChecklist()).items.batch).toBe(true);

    hoisted.dbState.artifacts = 0;
    hoisted.dbState.assistantMessages = 1;
    expect((await getChecklist()).items.batch).toBe(true);
  });

  test("Schedule a post ticks from a scheduled/publishing/published artifact", async () => {
    hoisted.dbState.artifacts = 1; // the draft exists but is not scheduled
    hoisted.dbState.scheduledArtifacts = 0;
    expect((await getChecklist()).items.scheduled).toBe(false);

    hoisted.dbState.scheduledArtifacts = 1;
    expect((await getChecklist()).items.scheduled).toBe(true);
  });

  test("the dismissed setting hides the checklist", async () => {
    hoisted.dbState.dismissedSettings = 1;
    expect((await getChecklist()).dismissed).toBe(true);
  });

  test("every action together completes the whole checklist", async () => {
    hoisted.dbState = {
      voiceReady: 1,
      trackedAccountIds: ["account-1"],
      artifacts: 1,
      assistantMessages: 1,
      scheduledArtifacts: 1,
      savedPosts: 0,
      scrapedPosts: 2,
      dismissedSettings: 0,
    };
    hoisted.connection = { accessToken: "token" };
    const body = await getChecklist();
    expect(Object.values(body.items).every(Boolean)).toBe(true);
  });
});
