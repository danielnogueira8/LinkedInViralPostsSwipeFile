import { describe, expect, test } from "vitest";
import {
  MAX_TURN_DRAFT_COUNT,
  SINGLE_DRAFT_CALL_TIMEOUT_MS,
  SINGLE_DRAFT_CHAIN_MAX_CALLS,
  SLOT_BATCH_BUDGET_MS,
  SLOT_CALL_TIMEOUT_MS,
  SLOT_CONCURRENCY,
  SLOT_MAX_CHAIN_CALLS,
  WRITER_TURN_BUDGET_MS,
} from "@/lib/agent/execute/writer";

describe("writer deadline budgets", () => {
  test("single-draft worst-case chain fits the writer turn budget", () => {
    expect(
      SINGLE_DRAFT_CHAIN_MAX_CALLS * SINGLE_DRAFT_CALL_TIMEOUT_MS,
    ).toBeLessThanOrEqual(WRITER_TURN_BUDGET_MS);
  });

  test("slot-batch worst-case chain fits the slot batch budget", () => {
    const waves = Math.ceil(MAX_TURN_DRAFT_COUNT / SLOT_CONCURRENCY);
    expect(
      waves * SLOT_MAX_CHAIN_CALLS * SLOT_CALL_TIMEOUT_MS,
    ).toBeLessThanOrEqual(SLOT_BATCH_BUDGET_MS);
  });
});
