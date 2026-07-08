import { describe, expect, test } from "vitest";
import {
  selectWriterKind,
  writerPromptModule,
  WRITER_PROMPT_MODULE,
} from "@/lib/agent/specialists/writer";

describe("selectWriterKind", () => {
  test("lead-magnet applies → lead_magnet writer, regardless of text", () => {
    expect(
      selectWriterKind({ userText: "write me a post", leadMagnetApplies: true }),
    ).toBe("lead_magnet");
    // Even a hook-ish phrasing stays lead_magnet when the route classified it so.
    expect(
      selectWriterKind({ userText: "give me a hook for the giveaway", leadMagnetApplies: true }),
    ).toBe("lead_magnet");
  });

  test("hook/opener request with no full-post intent → hook writer", () => {
    expect(
      selectWriterKind({ userText: "give me 5 hooks", leadMagnetApplies: false }),
    ).toBe("hook");
    expect(
      selectWriterKind({ userText: "write some openers for this", leadMagnetApplies: false }),
    ).toBe("hook");
  });

  test("a full post that merely mentions a hook → regular writer", () => {
    expect(
      selectWriterKind({
        userText: "write a post about pricing with a strong hook",
        leadMagnetApplies: false,
      }),
    ).toBe("regular");
    expect(
      selectWriterKind({
        userText: "draft a post on hiring, punchy opening line",
        leadMagnetApplies: false,
      }),
    ).toBe("regular");
  });

  test("plain post request → regular writer", () => {
    expect(
      selectWriterKind({ userText: "write a post about my launch", leadMagnetApplies: false }),
    ).toBe("regular");
  });
});

describe("writerPromptModule", () => {
  test("maps each writer kind to its prompt module label", () => {
    expect(writerPromptModule("regular")).toBe(WRITER_PROMPT_MODULE.regular);
    expect(writerPromptModule("lead_magnet")).toBe("lead-magnet");
    expect(writerPromptModule("hook")).toBe("hooks");
  });

  test("throws on an invalid writer kind (boundary validation)", () => {
    // @ts-expect-error — deliberately invalid to prove the boundary check fires.
    expect(() => writerPromptModule("carousel")).toThrow();
  });
});
