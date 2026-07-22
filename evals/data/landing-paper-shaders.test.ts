import { describe, expect, test } from "vitest";
import { LANDING_SHADER_CONFIG } from "@/app/(marketing)/landing-print-treatments";

describe("landing print treatments", () => {
  test("keeps both landing shaders static and within the visual performance budget", () => {
    expect(LANDING_SHADER_CONFIG.paper.speed).toBe(0);
    expect(LANDING_SHADER_CONFIG.halftone.speed).toBe(0);
    expect(LANDING_SHADER_CONFIG.paper.maxPixelCount).toBeLessThanOrEqual(400_000);
    expect(LANDING_SHADER_CONFIG.halftone.maxPixelCount).toBeLessThanOrEqual(400_000);
  });
});
