import type { Artifact } from "@/lib/agent/contracts";
import { editDraftBodySync } from "@/lib/agent/specialists/editor";
import { looksCorruptedDraft } from "@/lib/agent/specialists/nets";
import { MAX_CITES } from "@/lib/cite-resolve";

let artifactSequence = 0;

export function extractArtifacts(text: string): Artifact[] {
  const artifacts: Artifact[] = [];
  const fences = /```(post)\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fences.exec(text)) !== null) {
    const body = match[2].replace(/\s+$/, "");
    if (!body.trim()) continue;
    const corruption = looksCorruptedDraft(body);
    if (corruption) {
      console.log(
        JSON.stringify({
          corrupt_draft_dropped: {
            source: "fence",
            kind: "post",
            reason: corruption,
          },
        }),
      );
      continue;
    }
    const finalBody = editDraftBodySync(body, "post").body;
    artifacts.push({
      id: `art_${Date.now()}_${artifactSequence++}`,
      kind: "post",
      title: finalBody.split("\n", 1)[0].slice(0, 60).trim() || "Draft post",
      body: finalBody,
    });
  }
  return artifacts;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function extractCiteIds(text: string): string[] {
  const ids: string[] = [];
  const fences = /```cite\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fences.exec(text)) !== null) {
    const id = match[1].trim();
    if (UUID_RE.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, MAX_CITES);
}
