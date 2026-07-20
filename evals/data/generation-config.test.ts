import { describe, expect, test } from "vitest";
import {
  generationConfigForSelection,
  generationConfigV1Schema,
  resolveGenerationConfig,
  resolvedGenerationConfigSchema,
} from "@/lib/generation-config";
import {
  chatTurnRequestSchema,
  explicitMessageDraftCount,
  generationConfigSelectionMarkerFromToolCalls,
  generationConfigToolCall,
} from "@/lib/agent/chat-turn";

describe("generation configuration", () => {
  test("serializes only an explicit 1-6 draft selection", () => {
    expect(generationConfigForSelection("auto")).toBeUndefined();
    expect(generationConfigForSelection(1)).toEqual({
      version: 1,
      draftCount: 1,
    });
    expect(generationConfigForSelection(6)).toEqual({
      version: 1,
      draftCount: 6,
    });
  });

  test("serializes an explicit post-type selection even when draft count stays Auto", () => {
    // A user who explicitly picks a post type but leaves drafts on Auto must
    // not silently lose that selection — the object is emitted whenever
    // EITHER field is explicit, not only when both are.
    expect(generationConfigForSelection("auto", "auto")).toBeUndefined();
    expect(generationConfigForSelection("auto", "lead_magnet")).toEqual({
      version: 1,
      draftCount: 1,
      postType: "lead_magnet",
    });
    expect(generationConfigForSelection(3, "regular")).toEqual({
      version: 1,
      draftCount: 3,
      postType: "regular",
    });
  });

  test.each([
    {},
    { version: 2, draftCount: 3 },
    { version: 1, draftCount: 0 },
    { version: 1, draftCount: 7 },
    { version: 1, draftCount: 2.5 },
    { version: 1, draftCount: "3" },
    { version: 1, draftCount: 3, extra: true },
    { version: 1, draftCount: 3, postType: "regular_post" },
    { version: 1, draftCount: 3, postType: "" },
  ])("rejects malformed or unversioned wire input: %j", (value) => {
    expect(generationConfigV1Schema.safeParse(value).success).toBe(false);
  });

  test("accepts an optional, well-formed post type on the wire schema", () => {
    expect(
      generationConfigV1Schema.safeParse({
        version: 1,
        draftCount: 3,
        postType: "regular",
      }).success,
    ).toBe(true);
    expect(
      generationConfigV1Schema.safeParse({
        version: 1,
        draftCount: 3,
        postType: "lead_magnet",
      }).success,
    ).toBe(true);
    // Still optional — a config with no postType at all remains valid,
    // matching every pre-existing draft-count-only fixture in this suite.
    expect(
      generationConfigV1Schema.safeParse({ version: 1, draftCount: 3 })
        .success,
    ).toBe(true);
  });

  test("makes an explicit UI selection authoritative when text has no output count", () => {
    expect(
      resolveGenerationConfig({
        selected: { version: 1, draftCount: 4 },
        explicitMessageDraftCount: null,
      }),
    ).toEqual({
      version: 1,
      draftCount: 4,
      draftCountSource: "ui",
      postTypeSource: "default",
    });
  });

  test("makes an explicit UI selection authoritative over the message output count", () => {
    expect(
      resolveGenerationConfig({
        selected: { version: 1, draftCount: 5 },
        explicitMessageDraftCount: 1,
      }),
    ).toEqual({
      version: 1,
      draftCount: 5,
      draftCountSource: "ui",
      postTypeSource: "default",
    });
  });

  test("records message and default provenance when the selector is Auto", () => {
    expect(
      resolveGenerationConfig({
        explicitMessageDraftCount: 3,
      }),
    ).toEqual({
      version: 1,
      draftCount: 3,
      draftCountSource: "message",
      postTypeSource: "default",
    });
    expect(resolveGenerationConfig({})).toEqual({
      version: 1,
      draftCount: 1,
      draftCountSource: "default",
      postTypeSource: "default",
    });
  });

  test("an explicit UI post-type selection is authoritative and independent of draft count provenance", () => {
    // Post type has no message-derived tier here (unlike draft count) — an
    // absent UI pick always resolves to postTypeSource: "default", leaving
    // the read-only orchestrator's own instruction regex as the sole
    // fallback. This is the exact precedence the composer/orchestrator seam
    // relies on: explicit UI > (orchestrator's own fallback), never a
    // message-parsed post type materializing here.
    expect(
      resolveGenerationConfig({
        selected: { version: 1, draftCount: 2, postType: "lead_magnet" },
        explicitMessageDraftCount: null,
      }),
    ).toEqual({
      version: 1,
      draftCount: 2,
      draftCountSource: "ui",
      postType: "lead_magnet",
      postTypeSource: "ui",
    });
    expect(
      resolveGenerationConfig({
        selected: { version: 1, draftCount: 2 },
        explicitMessageDraftCount: null,
      }),
    ).toEqual({
      version: 1,
      draftCount: 2,
      draftCountSource: "ui",
      postTypeSource: "default",
    });
  });

  test("clamps an out-of-range message count into the 1-6 rule", () => {
    expect(
      resolveGenerationConfig({ explicitMessageDraftCount: 10 }),
    ).toEqual({
      version: 1,
      draftCount: 6,
      draftCountSource: "message",
      postTypeSource: "default",
    });
    expect(resolveGenerationConfig({ explicitMessageDraftCount: 0 })).toEqual({
      version: 1,
      draftCount: 1,
      draftCountSource: "message",
      postTypeSource: "default",
    });
  });

  test("the frozen retry representation is strict and bounded", () => {
    // postTypeSource is required on the RESOLVED shape (unlike the wire-input
    // postType, which stays optional) — resolveGenerationConfig always stamps
    // one of "ui"/"default", so a hand-built fixture missing it is malformed.
    expect(
      resolvedGenerationConfigSchema.safeParse({
        version: 1,
        draftCount: 5,
        draftCountSource: "ui",
        postTypeSource: "default",
      }).success,
    ).toBe(true);
    expect(
      resolvedGenerationConfigSchema.safeParse({
        version: 1,
        draftCount: 5,
        draftCountSource: "client-claimed",
        postTypeSource: "default",
      }).success,
    ).toBe(false);
  });

  test("the frozen retry representation bounds postTypeSource to ui/default, never message", () => {
    // Post type has no message-derived tier — "message" is a valid
    // draftCountSource but must never be accepted for postTypeSource.
    expect(
      resolvedGenerationConfigSchema.safeParse({
        version: 1,
        draftCount: 5,
        draftCountSource: "ui",
        postType: "lead_magnet",
        postTypeSource: "ui",
      }).success,
    ).toBe(true);
    expect(
      resolvedGenerationConfigSchema.safeParse({
        version: 1,
        draftCount: 5,
        draftCountSource: "ui",
        postType: "lead_magnet",
        postTypeSource: "message",
      }).success,
    ).toBe(false);
  });

  test("the chat boundary accepts the versioned control and rejects arbitrary settings", () => {
    expect(
      chatTurnRequestSchema.safeParse({
        message: "Write posts about content systems.",
        generationConfig: { version: 1, draftCount: 4 },
      }).success,
    ).toBe(true);
    expect(
      chatTurnRequestSchema.safeParse({
        message: "Write posts about content systems.",
        generationConfig: { version: 1, draftCount: 4, temperature: 2 },
      }).success,
    ).toBe(false);
  });

  test("extracts only explicit output counts, never research-source quantities", () => {
    expect(
      explicitMessageDraftCount(
        "Find 10 top posts in my swipe file and create original posts modeled after them.",
      ),
    ).toBeNull();
    expect(
      explicitMessageDraftCount(
        "Find 10 top posts in my swipe file and create 3 original posts modeled after them.",
      ),
    ).toBe(3);
    expect(
      explicitMessageDraftCount(
        "Write 4 original posts about content systems.",
      ),
    ).toBe(4);
  });

  test("round-trips exactly one strict server-owned retry marker", () => {
    const config = {
      version: 1 as const,
      draftCount: 4 as const,
      draftCountSource: "ui" as const,
      postTypeSource: "default" as const,
    };
    expect(
      generationConfigSelectionMarkerFromToolCalls([
        generationConfigToolCall(config),
      ]),
    ).toEqual({ kind: "valid", config });
    expect(
      generationConfigSelectionMarkerFromToolCalls([
        generationConfigToolCall(config),
        generationConfigToolCall(config),
      ]),
    ).toEqual({ kind: "invalid" });
    expect(
      generationConfigSelectionMarkerFromToolCalls([
        { ...generationConfigToolCall(config), id: "model-authored-call" },
      ]),
    ).toEqual({ kind: "none" });
  });
});
