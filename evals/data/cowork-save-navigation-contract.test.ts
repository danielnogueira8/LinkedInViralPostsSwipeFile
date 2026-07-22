import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const workspaceSource = readFileSync(
  "app/(app)/dashboard/chat-workspace.tsx",
  "utf8",
);
const artifactCardStart = workspaceSource.indexOf("function ArtifactCard({");
const artifactCardEnd = workspaceSource.indexOf(
  "function DraftMediaPreview(",
  artifactCardStart,
);
const artifactCardSource = workspaceSource.slice(artifactCardStart, artifactCardEnd);

describe("Cowork save navigation contract", () => {
  test("draft mutations do not refresh away from the active client-created chat", () => {
    expect(artifactCardStart).toBeGreaterThan(-1);
    expect(artifactCardEnd).toBeGreaterThan(artifactCardStart);
    expect(artifactCardSource).not.toContain("router.refresh()");
  });

  test("an already-linked board draft is saved on the card's first render", () => {
    expect(artifactCardSource).not.toContain(
      "const [saved, setSaved] = useState(false)",
    );
  });

  test("a saved Cowork draft toast links directly to its Posts editor", () => {
    expect(artifactCardSource).toContain('label: "Open post"');
    expect(artifactCardSource).toContain("/dashboard/posts?open=${encodeURIComponent(savedDraftId)}");
  });

  test.each([
    "app/api/chats/[id]/artifacts/route.ts",
    "app/api/drafts/[id]/route.ts",
    "app/api/drafts/[id]/schedule/route.ts",
  ])("%s owns Posts cache invalidation", (routePath) => {
    const routeSource = readFileSync(routePath, "utf8");
    expect(routeSource).toContain('revalidatePath("/dashboard/posts")');
  });
});
