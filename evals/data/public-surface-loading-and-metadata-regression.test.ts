import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const loadingRoutes = [
  "app/(marketing)/loading.tsx",
  "app/lm/[slug]/loading.tsx",
];

const metadataRoutes = [
  "app/(marketing)/page.tsx",
  "app/(marketing)/pricing/page.tsx",
  "app/(marketing)/privacy/page.tsx",
  "app/(marketing)/terms/page.tsx",
  "app/sign-in/[[...sign-in]]/page.tsx",
  "app/sign-up/[[...sign-up]]/page.tsx",
];

function metadataDeclaration(path: string): string {
  const source = readFileSync(path, "utf8");
  const start = source.indexOf("export const metadata");
  const end = source.indexOf("\n};", start);
  return source.slice(start, end === -1 ? undefined : end + 3);
}

describe("public surface route contracts", () => {
  test("dynamic public routes expose an accessible loading fallback", () => {
    for (const path of loadingRoutes) {
      expect(existsSync(path), path).toBe(true);
      const source = readFileSync(path, "utf8");
      expect(source, path).toContain("LoadingState");
      expect(source, path).toContain("label=");
    }
  });

  test("public routes declare route-specific SwipeIn metadata", () => {
    for (const path of metadataRoutes) {
      const declaration = metadataDeclaration(path);
      expect(declaration, path).toContain("SwipeIn");
      expect(declaration, path).not.toContain("Swipe File");
      expect(declaration, path).toContain("description");
    }
  });
});
