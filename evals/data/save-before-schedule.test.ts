import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { saveThenSchedule } from "@/lib/save-before-schedule";

describe("saveThenSchedule", () => {
  test("saves before scheduling and returns the schedule result", async () => {
    const order: string[] = [];
    const result = await saveThenSchedule({
      save: async () => {
        order.push("save");
        return true;
      },
      schedule: async () => {
        order.push("schedule");
        return "scheduled";
      },
    });
    expect(order).toEqual(["save", "schedule"]);
    expect(result).toEqual({ ok: true, value: "scheduled" });
  });

  test("never schedules when saving fails", async () => {
    const schedule = vi.fn();
    const result = await saveThenSchedule({
      save: async () => false,
      schedule,
    });
    expect(schedule).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, stage: "save" });
  });

  test("keeps a successful save committed when scheduling fails", async () => {
    const failure = new Error("provider unavailable");
    const result = await saveThenSchedule({
      save: async () => true,
      schedule: async () => {
        throw failure;
      },
    });
    expect(result).toEqual({ ok: false, stage: "schedule", error: failure });
  });
});

describe("draft editor scheduling wiring", () => {
  const source = readFileSync(
    "app/(app)/dashboard/draft-editor-modal.tsx",
    "utf8",
  );

  test("exact-time and queue actions share the same save-first seam", () => {
    expect(source.match(/saveThenSchedule\(\{/g)).toHaveLength(2);
    expect(source).toContain("onSaveBeforeSchedule={!isNew ? saveBeforeScheduling");
  });

  test("a new post saves before using the recurring queue", () => {
    expect(source).toContain(
      "onCreateAndQueue={isNew ? createAndQueue : undefined}",
    );
    expect(source).toMatch(
      /const createAndQueue[\s\S]*persistBody\(\)[\s\S]*draftOperations\.queue\(id, input\)/,
    );
    expect(source).toContain("(!draft && !onCreateAndQueue)");
    expect(source).not.toContain(
      "Save this post before adding it to the queue.",
    );
  });

  test("the schedule validation sees the live editor body", () => {
    expect(source).toContain("previewBody={body}");
    expect(source).toContain("previewBody ?? draft?.body");
  });
});
