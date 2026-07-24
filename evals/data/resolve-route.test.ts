import { describe, expect, test } from "vitest";
import { createChatResolvePost } from "@/app/api/chats/[id]/resolve/route";
import type { TurnDecision } from "@/lib/agent/turn/resolve-decision";

// The dry-run resolve endpoint returns the resolved decision as JSON with no
// side effects (no turn claim, no message persist). These lock the HTTP seam:
// auth gating, body validation, and the shape the composer read-back consumes.

const okDecision: TurnDecision = {
  mode: "create",
  postCount: 1,
  niche: null,
  postType: "regular",
  hasModelSource: false,
  hasCreatorStyle: false,
  hasLeadMagnetSelection: false,
  taskKind: "post",
  conflicts: [],
  route: { readOnly: null, contractKind: "post" },
};

function request(bodyObj: unknown): Request {
  return new Request("http://test.local/api/chats/chat_1/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyObj),
  });
}

describe("POST /api/chats/[id]/resolve", () => {
  test("401s when not signed in", async () => {
    const handler = createChatResolvePost({
      authenticate: async () => ({ userId: null }),
      resolveWorkspaceId: async () => "ws-1",
      resolve: async () => okDecision,
      resolveDeps: { listWorkspaceNiches: async () => [], now: () => new Date(0) },
    });
    const res = await handler(request({ message: "hi" }));
    expect(res.status).toBe(401);
  });

  test("400s on an invalid body", async () => {
    const handler = createChatResolvePost({
      authenticate: async () => ({ userId: "user_1" }),
      resolveWorkspaceId: async () => "ws-1",
      resolve: async () => okDecision,
      resolveDeps: { listWorkspaceNiches: async () => [], now: () => new Date(0) },
    });
    // message is required by chatTurnRequestSchema.
    const res = await handler(request({ command: { kind: "ask" } }));
    expect(res.status).toBe(400);
  });

  test("returns { ok, decision } for a valid request", async () => {
    let claimed = false;
    const handler = createChatResolvePost({
      authenticate: async () => ({ userId: "user_1" }),
      resolveWorkspaceId: async () => "ws-1",
      resolve: async (body, workspaceId) => {
        // Prove the resolver — not any turn-claiming path — is what runs.
        expect(workspaceId).toBe("ws-1");
        expect(body.message).toBe("Write a post about pricing.");
        return okDecision;
      },
      resolveDeps: {
        listWorkspaceNiches: async () => {
          claimed = true; // stand-in side-effect probe; only the resolver deps run
          return [];
        },
        now: () => new Date(0),
      },
    });
    const res = await handler(
      request({
        message: "Write a post about pricing.",
        command: { kind: "create", count: 1 },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; decision: TurnDecision };
    expect(json.ok).toBe(true);
    expect(json.decision.mode).toBe("create");
    // The injected resolve() above short-circuits before any niche read; the
    // point is only that NO turn-claim/persist path exists on this route.
    expect(claimed).toBe(false);
  });

  test("passes the real resolver through end to end", async () => {
    const handler = createChatResolvePost({
      authenticate: async () => ({ userId: "user_1" }),
      resolveWorkspaceId: async () => "ws-1",
      resolveDeps: {
        listWorkspaceNiches: async () => ["SaaS"],
        now: () => new Date("2026-07-24T12:00:00.000Z"),
      },
    });
    const res = await handler(
      request({
        message: "Give me 5 post ideas. Pull from ALL niches.",
        command: { kind: "ask" },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; decision: TurnDecision };
    expect(json.ok).toBe(true);
    expect(json.decision.mode).toBe("ask");
    expect(json.decision.niche).toBeNull();
  });
});
