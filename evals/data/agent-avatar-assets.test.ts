import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("agent avatar assets", () => {
  test("Newsjacking uses the same DiceBear Bottts asset format as its peers", () => {
    const avatar = readFileSync(
      join(process.cwd(), "public", "agents", "newsjacking.svg"),
      "utf8",
    );

    expect(avatar).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"',
    );
    expect(avatar).toContain("<dc:title>Bottts</dc:title>");
  });
});
