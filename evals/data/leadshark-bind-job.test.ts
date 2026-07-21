import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BackgroundJob } from "@/lib/background-jobs";
import type { LeadSharkAutomation } from "@/lib/leadshark-automations";

// ---------------------------------------------------------------------------
// runLeadSharkBindJob — the binding-job branching (build plan §6). We mock the
// client + data layer and assert the job resolves → validates the activity URN
// → creates → reads back → marks bound, and takes the right off-ramp on
// pending / ambiguous / non-activity-URN / read-back-mismatch.
// ---------------------------------------------------------------------------

const getDecryptedKey = vi.fn<() => Promise<string | null>>();
const getAutomationById = vi.fn<() => Promise<LeadSharkAutomation | null>>();
const markBound = vi.fn(async () => {});
const markBindError = vi.fn(async () => {});
const markJobDone = vi.fn(async () => {});
const markJobFailed = vi.fn(async () => {});

const resolve = vi.fn();
const createAutomation = vi.fn();
const getAutomation = vi.fn();
type ListedStub = { id: string; postId: string | null; stats: Record<string, number>; raw: unknown };
const listAutomations =
  vi.fn<() => Promise<{ ok: true; automations: ListedStub[] } | { ok: false; error: unknown }>>(
    async () => ({ ok: true, automations: [] }),
  );

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/background-jobs", () => ({
  markJobDone: (...a: unknown[]) => markJobDone(...(a as [])),
  markJobFailed: (...a: unknown[]) => markJobFailed(...(a as [])),
  enqueueBackgroundJob: vi.fn(),
}));
vi.mock("@/lib/leadshark-credentials", () => ({
  getDecryptedKey: () => getDecryptedKey(),
}));
vi.mock("@/lib/leadshark-automations", () => ({
  getAutomationById: () => getAutomationById(),
  getAutomationForArtifact: vi.fn(),
  markBindingStarted: vi.fn(),
  markBound: (...a: unknown[]) => markBound(...(a as [])),
  markBindError: (...a: unknown[]) => markBindError(...(a as [])),
}));
vi.mock("@/lib/leadshark-binding", () => ({
  resolverFor: () => ({ name: "url_match", resolve: (...a: unknown[]) => resolve(...(a as [])) }),
}));
vi.mock("@/lib/leadshark", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual, // keep the real isActivityUrn / assertActivityUrn guards
    createAutomation: (...a: unknown[]) => createAutomation(...(a as [])),
    getAutomation: (...a: unknown[]) => getAutomation(...(a as [])),
    listAutomations: (...a: unknown[]) => listAutomations(...(a as [])),
  };
});

const { runLeadSharkBindJob } = await import("@/lib/leadshark-bind-job");

function automation(p: Partial<LeadSharkAutomation> = {}): LeadSharkAutomation {
  return {
    id: "auto_1",
    artifactId: "art_1",
    leadMagnetId: null,
    config: {
      name: "n",
      keywords: [],
      dmTemplate: "Hey {{firstName}}: https://x",
      dmTemplateVariations: [],
      commentReplyTemplates: [],
      nonConnectionReplyTemplates: [],
      autoConnect: false,
      autoLike: false,
      followUpEnabled: false,
      followUpTemplate: null,
      followUpDelayMinutes: 60,
      followUpOnlyIfNoResponse: true,
    },
    status: "binding",
    zernioPostUrl: "https://li/feed/update/urn:li:share:777",
    zernioPostUrn: "urn:li:share:777",
    linkedinPostUrn: null,
    linkedinPostUrl: null,
    leadsharkAutomationId: null,
    bindAttempts: 0,
    lastError: null,
    lastErrorCode: null,
    stats: {},
    statsSyncedAt: null,
    createdAt: "",
    updatedAt: "",
    ...p,
  };
}

function job(p: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: "job_1",
    workspace_id: "ws_1",
    type: "leadshark_bind_automation",
    status: "running",
    payload: { automationId: "auto_1" },
    progress: {},
    result: null,
    error: null,
    attempts: 1,
    max_attempts: 6,
    run_after: "",
    locked_at: null,
    locked_by: null,
    started_at: null,
    finished_at: null,
    created_at: "",
    updated_at: "",
    ...p,
  } as BackgroundJob;
}

describe("runLeadSharkBindJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDecryptedKey.mockResolvedValue("ls_key");
    getAutomationById.mockResolvedValue(automation());
    listAutomations.mockResolvedValue({ ok: true, automations: [] });
  });
  afterEach(() => vi.clearAllMocks());

  test("happy path: resolved activity URN → create → read-back match → markBound", async () => {
    resolve.mockResolvedValue({
      kind: "resolved",
      postId: "urn:li:activity:999",
      shareUrl: "https://li/posts/x-activity-999-z",
    });
    createAutomation.mockResolvedValue({
      ok: true,
      automation: { id: "ls_auto_1", postId: "urn:li:activity:999", raw: {} },
      autoLikeDropped: false,
    });
    getAutomation.mockResolvedValue({
      ok: true,
      automation: { id: "ls_auto_1", postId: "urn:li:activity:999", raw: {} },
    });

    const res = await runLeadSharkBindJob(job());
    expect(res.completed).toBe(1);
    expect(markBound).toHaveBeenCalledWith("ws_1", "auto_1", {
      linkedinPostUrn: "urn:li:activity:999",
      linkedinPostUrl: "https://li/posts/x-activity-999-z",
      leadsharkAutomationId: "ls_auto_1",
    });
    expect(markJobDone).toHaveBeenCalled();
  });

  test("resolver pending, not last attempt → throws to requeue, no bind", async () => {
    resolve.mockResolvedValue({ kind: "pending", reason: "not caught up" });
    await expect(runLeadSharkBindJob(job({ attempts: 2, max_attempts: 6 }))).rejects.toThrow();
    expect(createAutomation).not.toHaveBeenCalled();
    expect(markBound).not.toHaveBeenCalled();
  });

  test("resolver pending on the LAST attempt → awaiting_urn, job done (no throw)", async () => {
    resolve.mockResolvedValue({ kind: "pending", reason: "still nothing" });
    const res = await runLeadSharkBindJob(job({ attempts: 6, max_attempts: 6 }));
    expect(res.completed).toBe(1);
    expect(markBindError).toHaveBeenCalledWith(
      "ws_1",
      "auto_1",
      expect.objectContaining({ status: "awaiting_urn" }),
    );
  });

  test("ambiguous → awaiting_urn, never creates", async () => {
    resolve.mockResolvedValue({ kind: "ambiguous", reason: "2 candidates" });
    await runLeadSharkBindJob(job());
    expect(createAutomation).not.toHaveBeenCalled();
    expect(markBindError).toHaveBeenCalledWith(
      "ws_1",
      "auto_1",
      expect.objectContaining({ status: "awaiting_urn" }),
    );
  });

  test("resolved a SHARE urn (not activity) → refuse to bind, awaiting_urn", async () => {
    // The critical guard: even a 'resolved' outcome must be an activity URN.
    resolve.mockResolvedValue({
      kind: "resolved",
      postId: "urn:li:share:777",
      shareUrl: null,
    });
    await runLeadSharkBindJob(job());
    expect(createAutomation).not.toHaveBeenCalled();
    expect(markBindError).toHaveBeenCalledWith(
      "ws_1",
      "auto_1",
      expect.objectContaining({ errorCode: "non_activity_urn", status: "awaiting_urn" }),
    );
  });

  test("read-back post_id mismatch → awaiting_urn (silent-bind caught)", async () => {
    resolve.mockResolvedValue({
      kind: "resolved",
      postId: "urn:li:activity:999",
      shareUrl: null,
    });
    createAutomation.mockResolvedValue({
      ok: true,
      automation: { id: "ls_auto_1", postId: "urn:li:activity:999", raw: {} },
      autoLikeDropped: false,
    });
    // LeadShark stored a DIFFERENT id than we sent.
    getAutomation.mockResolvedValue({
      ok: true,
      automation: { id: "ls_auto_1", postId: "urn:li:activity:000", raw: {} },
    });
    await runLeadSharkBindJob(job());
    expect(markBound).not.toHaveBeenCalled();
    expect(markBindError).toHaveBeenCalledWith(
      "ws_1",
      "auto_1",
      expect.objectContaining({ errorCode: "readback_mismatch", status: "awaiting_urn" }),
    );
  });

  test("no credential → failed, terminal", async () => {
    getDecryptedKey.mockResolvedValue(null);
    const res = await runLeadSharkBindJob(job());
    expect(res.failed).toBe(1);
    expect(markBindError).toHaveBeenCalledWith(
      "ws_1",
      "auto_1",
      expect.objectContaining({ errorCode: "no_credential", status: "failed" }),
    );
  });

  test("already bound (active + id) → idempotent no-op", async () => {
    getAutomationById.mockResolvedValue(
      automation({ status: "active", leadsharkAutomationId: "ls_auto_1" }),
    );
    const res = await runLeadSharkBindJob(job());
    expect(res.completed).toBe(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(createAutomation).not.toHaveBeenCalled();
  });

  test("adopts an existing automation for the same URN (Auto-Automate dedupe)", async () => {
    resolve.mockResolvedValue({
      kind: "resolved",
      postId: "urn:li:activity:999",
      shareUrl: null,
    });
    listAutomations.mockResolvedValue({
      ok: true,
      automations: [{ id: "existing_ls", postId: "urn:li:activity:999", stats: {}, raw: {} }],
    });
    await runLeadSharkBindJob(job());
    // Adopts rather than creating a second (which would double-DM).
    expect(createAutomation).not.toHaveBeenCalled();
    expect(markBound).toHaveBeenCalledWith(
      "ws_1",
      "auto_1",
      expect.objectContaining({ leadsharkAutomationId: "existing_ls" }),
    );
  });
});
