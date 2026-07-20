import { describe, expect, test } from "vitest";
import {
  EditorResultSchema,
  AI_TELL_CATEGORIES,
} from "@/lib/agent/specialists/contracts";

describe("EditorResult", () => {
  test("only accepts declared AI-tell categories", () => {
    const good = EditorResultSchema.safeParse({
      body: "clean body",
      changed: true,
      usedModel: false,
      fixedCategories: ["em_dash", "dense_paragraph"],
      notes: [],
    });
    expect(good.success).toBe(true);

    const bad = EditorResultSchema.safeParse({
      body: "clean body",
      changed: true,
      usedModel: false,
      fixedCategories: ["sparkle"],
      notes: [],
    });
    expect(bad.success).toBe(false);
  });

  test("every declared tell category parses", () => {
    const r = EditorResultSchema.safeParse({
      body: "x",
      changed: false,
      usedModel: false,
      fixedCategories: [...AI_TELL_CATEGORIES],
      notes: [],
    });
    expect(r.success).toBe(true);
  });
});
