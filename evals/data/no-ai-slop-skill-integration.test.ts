import { describe, expect, test } from "vitest";
import { GLOBAL_WRITING_SKILL } from "@/lib/agent/skills";

describe("no-ai-slop guidance integration", () => {
  test("adds the imported human-editing patterns without changing voice precedence", () => {
    expect(GLOBAL_WRITING_SKILL).toMatch(/voice profile governs/i);
    expect(GLOBAL_WRITING_SKILL).toMatch(/faux-insight/i);
    expect(GLOBAL_WRITING_SKILL).toMatch(/colon reveal/i);
    expect(GLOBAL_WRITING_SKILL).toMatch(/rhetorical setup/i);
    expect(GLOBAL_WRITING_SKILL).toMatch(/summary-recap ending/i);
  });
});
