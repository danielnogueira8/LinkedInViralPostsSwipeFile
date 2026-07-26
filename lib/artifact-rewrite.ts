export type StoredArtifact = { id?: string } & Record<string, unknown>;

/** Replace one persisted chat artifact without disturbing sibling artifacts. */
export function rewriteArtifactInPlace(
  arts: StoredArtifact[],
  input: {
    targetId: string;
    body: string;
    title?: string;
    meta?: Record<string, unknown>;
  },
): { next: StoredArtifact[]; changed: boolean } {
  let changed = false;
  const next = arts.map((artifact) => {
    if (artifact?.id !== input.targetId) return artifact;
    changed = true;
    const originalMeta =
      artifact.meta && typeof artifact.meta === "object"
        ? (artifact.meta as Record<string, unknown>)
        : null;
    const nextMeta =
      input.meta !== undefined ? { ...input.meta } : undefined;
    if (nextMeta) {
      // Generation lineage is server-owned provenance. Browser edits may
      // replace user-facing metadata, but cannot add, remove, or alter this
      // immutable seed.
      delete nextMeta.content_lineage;
      if (originalMeta?.content_lineage !== undefined) {
        nextMeta.content_lineage = originalMeta.content_lineage;
      }
      delete nextMeta.content_lineage_origin;
    }
    return {
      ...artifact,
      body: input.body,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(nextMeta !== undefined ? { meta: nextMeta } : {}),
    };
  });
  return { next, changed };
}
