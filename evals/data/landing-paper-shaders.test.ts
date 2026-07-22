import { describe, expect, test } from "vitest";
import { LANDING_SHADER_CONFIG } from "@/app/(marketing)/landing-print-treatments";

describe("landing paper treatments", () => {
  test("keeps the landing textures static, capped, and free of CMYK halftones", () => {
    expect(LANDING_SHADER_CONFIG.paper.speed).toBe(0);
    expect(LANDING_SHADER_CONFIG.paper.maxPixelCount).toBeLessThanOrEqual(400_000);
    expect("halftone" in LANDING_SHADER_CONFIG).toBe(false);
  });
});
