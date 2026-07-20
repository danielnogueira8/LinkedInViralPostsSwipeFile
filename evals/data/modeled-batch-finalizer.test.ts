import { describe, expect, test } from "vitest";
import { modeledBatchFinalizerSpecialists } from "@/lib/agent/finalize/finalizer";

describe("modeledBatchFinalizerSpecialists", () => {
  test("keeps paid rewrite specialists off the modeled-batch blocking path", async () => {
    const body =
      "A useful idea should be clear — not hidden behind generic polish.\n\nMake the argument concrete and relevant.";

    const aiTell = await modeledBatchFinalizerSpecialists.repairAiTells({ body });
    const sameness = await modeledBatchFinalizerSpecialists.checkSameness({
      body,
      priorDrafts: [
        { id: "prior-1", body: "Prior body", createdAt: new Date(0).toISOString() },
      ],
    });

    expect(aiTell).toMatchObject({ body, repaired: false });
    expect(sameness).toMatchObject({ body, rewrote: false });
  });
});
