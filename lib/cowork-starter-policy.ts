export const COWORK_PRIMARY_STARTER_ID = "write-original";

export const COWORK_ALTERNATIVE_STARTER_IDS = [
  "model-top-viral",
  "brainstorm",
] as const;

type IdentifiedStarter = {
  id: string;
};

export function partitionCoworkStarters<T extends IdentifiedStarter>(starters: T[]) {
  const primary = starters.find(
    (starter) => starter.id === COWORK_PRIMARY_STARTER_ID,
  );
  if (!primary) {
    throw new Error(
      `Cowork starter policy requires "${COWORK_PRIMARY_STARTER_ID}".`,
    );
  }

  const alternatives = COWORK_ALTERNATIVE_STARTER_IDS.map((id) => {
    const starter = starters.find((candidate) => candidate.id === id);
    if (!starter) {
      throw new Error(`Cowork starter policy requires "${id}".`);
    }
    return starter;
  });

  const recommendedIds = new Set([
    primary.id,
    ...alternatives.map((starter) => starter.id),
  ]);

  return {
    primary,
    alternatives,
    library: starters.filter(
      (starter) => !recommendedIds.has(starter.id),
    ),
  };
}
