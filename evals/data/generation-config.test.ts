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
  test("serializes only an explicit 1-5 draft selection", () => {
    expect(generationConfigForSelection("auto")).toBeUndefined();
    expect(generationConfigForSelection(1)).toEqual({
      version: 1,
      draftCount: 1,
    });
    expect(generationConfigForSelection(5)).toEqual({
      version: 1,
      draftCount: 5,
    });
  });

  test.each([
    {},
    { version: 2, draftCount: 3 },
    { version: 1, draftCount: 0 },
    { version: 1, draftCount: 6 },
    { version: 1, draftCount: 2.5 },
    { version: 1, draftCount: "3" },
    { version: 1, draftCount: 3, extra: true },
  ])("rejects malformed or unversioned wire input: %j", (value) => {
    expect(generationConfigV1Schema.safeParse(value).success).toBe(false);
  });

  test("makes an explicit UI selection authoritative when text has no output count", () => {
    expect(
      resolveGenerationConfig({
        selected: { version: 1, draftCount: 4 },
        explicitMessageDraftCount: null,
      }),
    ).toEqual({ version: 1, draftCount: 4, draftCountSource: "ui" });
  });

  test("makes an explicit UI selection authoritative over the message output count", () => {
    expect(
      resolveGenerationConfig({
        selected: { version: 1, draftCount: 5 },
        explicitMessageDraftCount: 1,
      }),
    ).toEqual({ version: 1, draftCount: 5, draftCountSource: "ui" });
  });

  test("records message and default provenance when the selector is Auto", () => {
    expect(
      resolveGenerationConfig({
        explicitMessageDraftCount: 3,
      }),
    ).toEqual({ version: 1, draftCount: 3, draftCountSource: "message" });
    expect(resolveGenerationConfig({})).toEqual({
      version: 1,
      draftCount: 1,
      draftCountSource: "default",
    });
  });

  test("the frozen retry representation is strict and bounded", () => {
    expect(
      resolvedGenerationConfigSchema.safeParse({
        version: 1,
        draftCount: 5,
        draftCountSource: "ui",
      }).success,
    ).toBe(true);
    expect(
      resolvedGenerationConfigSchema.safeParse({
        version: 1,
        draftCount: 5,
        draftCountSource: "client-claimed",
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
