import { describe, expect, test } from "vitest";
import {
  resolveTurnOutcome,
  terminalReasonForOutcome,
  type TurnOutcome,
} from "@/lib/agent/turn/outcome";

describe("resolveTurnOutcome", () => {
  describe('terminal "failure"', () => {
    test("persistence failure is always a hard_failure", () => {
      for (const staged of [
        null,
        "delivered",
        "clarified",
        "recoverable_error",
      ] as const) {
        expect(
          resolveTurnOutcome({
            terminal: "failure",
            staged,
            persistenceFailed: true,
            cancelled: false,
          }),
        ).toBe("hard_failure");
      }
    });

    test("keeps a staged recoverable_error when persistence succeeded", () => {
      expect(
        resolveTurnOutcome({
          terminal: "failure",
          staged: "recoverable_error",
          persistenceFailed: false,
          cancelled: false,
        }),
      ).toBe("recoverable_error");
    });

    test.each([null, "delivered", "clarified", "cancelled"] as const)(
      "hard_failure when staged is %s and persistence succeeded",
      (staged) => {
        expect(
          resolveTurnOutcome({
            terminal: "failure",
            staged,
            persistenceFailed: false,
            cancelled: false,
          }),
        ).toBe("hard_failure");
      },
    );
  });

  describe('terminal "cancelled"', () => {
    test("resolves to cancelled regardless of staged or persistence state", () => {
      for (const staged of [null, "delivered", "recoverable_error"] as const) {
        for (const persistenceFailed of [false, true]) {
          expect(
            resolveTurnOutcome({
              terminal: "cancelled",
              staged,
              persistenceFailed,
              cancelled: true,
            }),
          ).toBe("cancelled");
        }
      }
    });

    test("the cancelled flag alone resolves to cancelled", () => {
      expect(
        resolveTurnOutcome({
          terminal: "done",
          staged: "delivered",
          persistenceFailed: false,
          cancelled: true,
        }),
      ).toBe("cancelled");
    });
  });

  describe('terminal "deadline"', () => {
    test("resolves to recoverable_error", () => {
      for (const staged of [null, "delivered", "recoverable_error"] as const) {
        expect(
          resolveTurnOutcome({
            terminal: "deadline",
            staged,
            persistenceFailed: false,
            cancelled: false,
          }),
        ).toBe("recoverable_error");
      }
    });
  });

  describe('terminal "done" / "ask"', () => {
    test.each(["done", "ask"] as const)(
      'keeps the staged outcome for terminal "%s"',
      (terminal) => {
        for (const staged of [
          "delivered",
          "clarified",
          "recoverable_error",
        ] as const) {
          expect(
            resolveTurnOutcome({
              terminal,
              staged,
              persistenceFailed: false,
              cancelled: false,
            }),
          ).toBe(staged);
        }
      },
    );

    test.each(["done", "ask"] as const)(
      'hard_failure when nothing was staged for terminal "%s"',
      (terminal) => {
        expect(
          resolveTurnOutcome({
            terminal,
            staged: null,
            persistenceFailed: false,
            cancelled: false,
          }),
        ).toBe("hard_failure");
      },
    );
  });
});

describe("terminalReasonForOutcome", () => {
  test.each([
    ["delivered", "done"],
    ["clarified", "ask"],
    ["cancelled", "cancelled"],
    ["recoverable_error", "deadline"],
    ["hard_failure", "error"],
  ] as const)("maps %s to persisted terminal_reason %s", (outcome, reason) => {
    expect(terminalReasonForOutcome(outcome)).toBe(reason);
  });

  test("covers every TurnOutcome", () => {
    const outcomes: TurnOutcome[] = [
      "delivered",
      "clarified",
      "cancelled",
      "recoverable_error",
      "hard_failure",
    ];
    for (const outcome of outcomes) {
      expect(terminalReasonForOutcome(outcome)).toMatch(
        /^(done|ask|cancelled|deadline|error)$/,
      );
    }
  });
});
