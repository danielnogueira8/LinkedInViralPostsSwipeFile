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
    return {
      ...artifact,
      body: input.body,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
    };
  });
  return { next, changed };
}
