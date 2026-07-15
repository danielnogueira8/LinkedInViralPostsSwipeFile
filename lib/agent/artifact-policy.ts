import type { Artifact } from "@/lib/agent/contracts";
import { editDraftBodySync } from "@/lib/agent/specialists/editor";
import { looksCorruptedDraft } from "@/lib/agent/specialists/nets";
import { MAX_CITES } from "@/lib/cite-resolve";

let artifactSequence = 0;

export function extractPostBodies(text: string): string[] {
  const bodies: string[] = [];
  const fences = /```(post)\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fences.exec(text)) !== null) {
    const body = match[2].replace(/\s+$/, "");
    if (body.trim()) bodies.push(body);
  }
  return bodies;
}

export type UnclosedPostFence = {
  body: string;
  openIndex: number;
  prefix: string;
};

/**
 * Finds a post fence whose opener has no closing fence. Callers use the
 * prefix as the only releasable text and route the suffix through the draft
 * finalizer as an incomplete delivery envelope.
 */
export function extractUnclosedPostFence(
  text: string,
): UnclosedPostFence | null {
  const opener = /```post\b[^\S\r\n]*(?:\r?\n|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(text)) !== null) {
    const bodyStart = match.index + match[0].length;
    const closeIndex = text.indexOf("```", bodyStart);
    if (closeIndex < 0) {
      return {
        body: text.slice(bodyStart),
        openIndex: match.index,
        prefix: text.slice(0, match.index),
      };
    }
    opener.lastIndex = closeIndex + 3;
  }
  return null;
}

export function extractArtifacts(text: string): Artifact[] {
  const artifacts: Artifact[] = [];
  for (const body of extractPostBodies(text)) {
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
