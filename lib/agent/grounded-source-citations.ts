import type { Artifact } from "@/lib/agent/contracts";
import type { GroundedSource } from "@/lib/agent/evidence";

export const GROUNDED_SOURCE_PRESENTATION = "grounded_answer_source";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function verifiedLinkedInSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com"))
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function groundedWorkspaceSourceArtifacts(
  evidence: GroundedSource[],
): Artifact[] {
  const seen = new Set<string>();
  return evidence.flatMap((source) => {
    if (
      source.kind !== "workspace_post" ||
      !UUID_RE.test(source.id) ||
      seen.has(source.id)
    ) {
      return [];
    }
    seen.add(source.id);
    const sourceUrl = verifiedLinkedInSourceUrl(source.url);
    return [
      {
        id: `grounded-source:${source.id}`,
        kind: "cite" as const,
        title: "Verified source post",
        body: "" as const,
        meta: {
          postId: source.id,
          presentation: GROUNDED_SOURCE_PRESENTATION,
          ...(sourceUrl ? { sourceUrl } : {}),
        },
      },
    ];
  });
}

export function persistedCiteMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const presentation =
    meta?.presentation === GROUNDED_SOURCE_PRESENTATION
      ? GROUNDED_SOURCE_PRESENTATION
      : undefined;
  const sourceUrl = presentation
    ? verifiedLinkedInSourceUrl(meta?.sourceUrl)
    : undefined;
  return {
    postId: typeof meta?.postId === "string" ? meta.postId : undefined,
    ...(presentation ? { presentation } : {}),
    // Keep the validated URL as an immediate-render fallback. The workspace-
    // scoped rehydrated card still wins whenever it is available, so a changed
    // canonical URL is picked up on reload without leaving the just-finished
    // turn linkless during the stream-to-canonical handoff.
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}
