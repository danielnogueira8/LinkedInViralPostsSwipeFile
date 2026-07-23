import { describe, expect, test } from "vitest";
import {
  LANDING_SHADER_CONFIG,
  LANDING_SOURCE_MATERIAL_IMAGE,
} from "@/app/(marketing)/landing-print-treatments";

describe("landing paper treatments", () => {
  test("keeps the landing textures static, capped, and free of CMYK halftones", () => {
    expect(LANDING_SHADER_CONFIG.paper.speed).toBe(0);
    expect(LANDING_SHADER_CONFIG.paper.maxPixelCount).toBeLessThanOrEqual(400_000);
    expect("halftone" in LANDING_SHADER_CONFIG).toBe(false);
  });

  test("keeps the original Swipe File visual in the paper treatment", () => {
    expect(LANDING_SOURCE_MATERIAL_IMAGE).toEqual({
      src: "/swipe-file-posts.png",
      width: 2762,
      height: 1644,
    });
  });
});
