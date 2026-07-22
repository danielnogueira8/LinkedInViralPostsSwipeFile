import { describe, expect, test } from "vitest";
import {
  draftForCurrentTurn,
  latestChatDraft,
} from "@/lib/agent/turn/context";
import type { Artifact } from "@/lib/agent/contracts";

// ---------------------------------------------------------------------------
// latestChatDraft — "the draft this chat is currently working on". Newest-first
// walk over persisted rows' artifacts, returning the most recent post/hook. This
// is the target an implicit ("make it punchier") edit refers to and the body the
// turn injects so the model can see what it already wrote (draft continuity).
// ---------------------------------------------------------------------------

function post(id: string, body = "Body"): Artifact {
  return { id, kind: "post", title: id, body };
}
function hook(id: string, body = "Hook body"): Artifact {
  return { id, kind: "hook", title: id, body };
}
function cite(id: string): Artifact {
  return { id, kind: "cite", title: id, body: "A cited source post" };
}
function assistant(artifacts: Artifact[]) {
  return { role: "assistant" as const, artifacts };
}
function user() {
  return { role: "user" as const, artifacts: null };
}

describe("latestChatDraft", () => {
  test("returns null when the chat has no drafts", () => {
    expect(latestChatDraft([])).toBeNull();
    expect(latestChatDraft([user(), assistant([])])).toBeNull();
  });

  test("returns the only draft in the chat", () => {
    const a = post("art_1");
    expect(latestChatDraft([assistant([a])])).toEqual(a);
  });

  test("returns the NEWEST draft when several exist across turns", () => {
    const older = post("art_old");
    const newer = post("art_new");
    expect(
      latestChatDraft([
        assistant([older]),
        user(),
        assistant([newer]),
      ]),
    ).toEqual(newer);
  });

  test("within one row, the last artifact wins (newest slot)", () => {
    const first = post("art_a");
    const second = post("art_b");
    expect(latestChatDraft([assistant([first, second])])).toEqual(second);
  });

  test("a hook draft is a valid target", () => {
    const h = hook("hook_1");
    expect(latestChatDraft([assistant([h])])).toEqual(h);
  });

  test("cite artifacts (source-post previews) are never treated as drafts", () => {
    // A row with only a cite → no draft. A cite alongside a post → the post.
    expect(latestChatDraft([assistant([cite("cite_1")])])).toBeNull();
    const p = post("art_1");
    expect(latestChatDraft([assistant([cite("cite_1"), p])])).toEqual(p);
  });

  test("skips newer rows that carry no drafts to reach the last real one", () => {
    const draft = post("art_1");
    expect(
      latestChatDraft([
        assistant([draft]),
        user(),
        assistant([]), // a later reply with no draft (e.g. an answer/ask turn)
        user(),
      ]),
    ).toEqual(draft);
  });

  test("tolerates rows with undefined/null artifacts", () => {
    const draft = post("art_1");
    expect(
      latestChatDraft([
        { artifacts: undefined },
        { artifacts: null },
        assistant([draft]),
      ]),
    ).toEqual(draft);
  });

  test("an explicit review target wins over the newest draft", () => {
    const older = post("art_requested", "Review this exact older draft.");
    const newer = post("art_latest", "Do not review this newer draft.");
    const rows = [
      {
        role: "assistant" as const,
        content: "",
        tool_calls: null,
        tool_call_id: null,
        artifacts: [older],
      },
      {
        role: "assistant" as const,
        content: "",
        tool_calls: null,
        tool_call_id: null,
        artifacts: [newer],
      },
    ];

    expect(draftForCurrentTurn(rows, older.id)).toEqual(older);
    expect(draftForCurrentTurn(rows, "missing")).toBeNull();
  });
});
