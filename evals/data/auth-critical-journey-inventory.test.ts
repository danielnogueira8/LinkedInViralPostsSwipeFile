import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
const criticalCommand = packageJson.scripts["e2e:critical"];

describe("authenticated critical journey pack", () => {
  test("runs every product journey spec from one repeatable command", () => {
    for (const spec of [
      "critical-journeys.spec.ts",
      "swipe-bookmark-workflows.spec.ts",
      "client-reconciliation.spec.ts",
      "draft-lifecycle.spec.ts",
    ]) expect(criticalCommand).toContain(spec);
  });

  test("fails browser regressions at the required seams", () => {
    const guard = readFileSync("e2e/helpers/console.ts", "utf8");
    const navigation = readFileSync("e2e/critical-journeys.spec.ts", "utf8");
    const reconciliation = readFileSync("e2e/client-reconciliation.spec.ts", "utf8");
    expect(guard).toContain('page.on("console"');
    expect(guard).toContain('page.on("pageerror"');
    expect(navigation).toContain("assertNonBlankApp");
    expect(reconciliation).toContain("modeled source stays with its owning fresh chat");
    expect(navigation).toContain("loadingOrContent");
    for (const path of [
      "e2e/critical-journeys.spec.ts",
      "e2e/swipe-bookmark-workflows.spec.ts",
      "e2e/client-reconciliation.spec.ts",
      "e2e/draft-lifecycle.spec.ts",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source, `${path} installs the browser error guard`).toContain(
        "failOnConsoleErrors",
      );
      expect(source, `${path} asserts the browser error guard`).toContain(
        "assertNoErrors",
      );
    }
  });
});
