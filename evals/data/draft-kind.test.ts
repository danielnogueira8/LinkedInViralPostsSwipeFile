import { describe, test, expect } from "vitest";
import { resolveDraftKind } from "@/lib/post-type";
import { createDraftSchema } from "@/lib/draft-create-schema";

// ---------------------------------------------------------------------------
// resolveDraftKind — the classify-on-generate/save logic. A giveaway
// (meta.lead_magnet) forces lead_magnet; a hook stays a hook; otherwise an
// explicit kind (a user's manual pick) wins and is never re-classified, and a
// kind-less post is auto-tagged regular vs lead-magnet from its body via the
// existing classifyPost detector. Plus the widened createDraftSchema kind enum.
// ---------------------------------------------------------------------------

const LEAD_MAGNET_BODY =
  "I built a 40-page playbook on cold outreach. Comment GROWTH and I'll DM it to you.";
const REGULAR_BODY =
  "We cut churn 40% by doing one boring thing every Monday. Here's the habit.";

describe("resolveDraftKind", () => {
  test("explicit kind always wins (never re-classified)", () => {
    // A body that WOULD classify as lead_magnet, but the user set 'post'.
    expect(resolveDraftKind("post", LEAD_MAGNET_BODY)).toBe("post");
    expect(resolveDraftKind("hook", LEAD_MAGNET_BODY)).toBe("hook");
    expect(resolveDraftKind("lead_magnet", REGULAR_BODY)).toBe("lead_magnet");
  });

  test("no explicit kind → auto-classifies a lead magnet from the body", () => {
    expect(resolveDraftKind(null, LEAD_MAGNET_BODY)).toBe("lead_magnet");
    expect(resolveDraftKind(undefined, LEAD_MAGNET_BODY)).toBe("lead_magnet");
  });

  test("no explicit kind → a regular post stays 'post'", () => {
    expect(resolveDraftKind(null, REGULAR_BODY)).toBe("post");
    expect(resolveDraftKind(undefined, "")).toBe("post");
    expect(resolveDraftKind(undefined, null)).toBe("post");
  });

  test("a giveaway (hasLeadMagnet) forces lead_magnet, even over explicit 'post'", () => {
    // The bug: a post saved with meta.lead_magnet (giveaway attached) kept
    // kind='post' when the body didn't trip the regex or an explicit 'post'
    // was sent. A giveaway only makes sense on a lead-magnet post.
    expect(resolveDraftKind(undefined, REGULAR_BODY, { hasLeadMagnet: true })).toBe(
      "lead_magnet",
    );
    expect(resolveDraftKind("post", REGULAR_BODY, { hasLeadMagnet: true })).toBe(
      "lead_magnet",
    );
    expect(resolveDraftKind(null, LEAD_MAGNET_BODY, { hasLeadMagnet: true })).toBe(
      "lead_magnet",
    );
  });

  test("a hook stays a hook even with a giveaway attached", () => {
    expect(resolveDraftKind("hook", REGULAR_BODY, { hasLeadMagnet: true })).toBe("hook");
  });
});

describe("createDraftSchema — kind enum widened", () => {
  test("accepts lead_magnet and hook, still defaults to auto (kind omitted)", () => {
    expect(createDraftSchema.safeParse({ body: "x", kind: "lead_magnet" }).success).toBe(true);
    expect(createDraftSchema.safeParse({ body: "x", kind: "hook" }).success).toBe(true);
    expect(createDraftSchema.safeParse({ body: "x", kind: "post" }).success).toBe(true);
    // kind is optional now (server auto-classifies when omitted).
    const r = createDraftSchema.safeParse({ body: "x" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.kind).toBeUndefined();
  });

  test("rejects an unknown kind", () => {
    expect(createDraftSchema.safeParse({ body: "x", kind: "idea" }).success).toBe(false);
  });
});
