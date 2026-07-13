import { describe, expect, test } from "vitest";
import {
  NEW_CONVERSATION_HREF,
  postsDraftHref,
  requestedDraftId,
} from "@/lib/action-handoffs";

describe("successful action handoffs", () => {
  test("opens the exact Ready post and safely encodes its id", () => {
    expect(postsDraftHref("draft/with spaces")).toBe(
      "/dashboard/posts?draft=draft%2Fwith%20spaces",
    );
  });

  test("normalizes the requested post id from Next search params", () => {
    expect(requestedDraftId(" draft-1 ")).toBe("draft-1");
    expect(requestedDraftId(["draft-2", "ignored"])).toBe("draft-2");
    expect(requestedDraftId("   ")).toBeNull();
    expect(requestedDraftId(undefined)).toBeNull();
  });

  test("starts another post in a fresh Cowork conversation", () => {
    expect(NEW_CONVERSATION_HREF).toBe("/dashboard?new=1");
  });
});
