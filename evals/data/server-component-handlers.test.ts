import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;

// React event handlers cannot cross the server/client boundary. A component
// without "use client" that passes one renders fine in dev and throws in
// production:
//
//   Event handlers cannot be passed to Client Component props.
//     {src: ..., alt: ..., onError: function onError}
//
// featured-post-card.tsx did exactly this and threw on every render of
// /dashboard/swipe (Sentry SWIPEIN-PROD-N). Neither tsc nor eslint catches it —
// the JSX is type-correct and the rule is a runtime boundary — so this test is
// the guard.
const HANDLER_RE = /\bon[A-Z][A-Za-z]*=\{/;

function tsxFilesIn(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsxFilesIn(full));
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("server components never pass event handlers", () => {
  test("every .tsx passing an on* prop is a client component", () => {
    const offenders: string[] = [];
    for (const file of [
      ...tsxFilesIn(join(ROOT, "app")),
      ...tsxFilesIn(join(ROOT, "components")),
    ]) {
      const source = readFileSync(file, "utf8");
      if (!HANDLER_RE.test(source)) continue;
      // "use client" must be the first statement in the module.
      const isClient = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(
        source,
      );
      if (!isClient) offenders.push(file.slice(ROOT.length));
    }
    // Named rather than counted: a failure should say WHICH file regressed.
    expect(offenders).toEqual([]);
  });
});
