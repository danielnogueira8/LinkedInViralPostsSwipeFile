export type CoworkDestination = "agent";

const COWORK_DESTINATION_KEY = "swipein:cowork-destination";

export function shouldRestoreAgentDestination({
  savedDestination,
  hasExplicitDestination,
}: {
  savedDestination: CoworkDestination | null;
  hasExplicitDestination: boolean;
}): boolean {
  return savedDestination === "agent" && !hasExplicitDestination;
}

export function readCoworkDestination(): CoworkDestination | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(COWORK_DESTINATION_KEY) === "agent"
      ? "agent"
      : null;
  } catch {
    return null;
  }
}

export function writeCoworkDestination(destination: CoworkDestination): void {
  try {
    window.sessionStorage.setItem(COWORK_DESTINATION_KEY, destination);
  } catch {
    /* Session storage is best-effort (for example, private browsing). */
  }
}

export function clearCoworkDestination(): void {
  try {
    window.sessionStorage.removeItem(COWORK_DESTINATION_KEY);
  } catch {
    /* Session storage is best-effort (for example, private browsing). */
  }
}
