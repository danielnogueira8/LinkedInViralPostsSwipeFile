const LINKEDIN_RETURN_RESULTS = new Set(["connected", "connect_failed"]);

export function shouldRedirectFromWelcome(
  onboarded: boolean,
  linkedinResult: string | undefined,
): boolean {
  return onboarded && !LINKEDIN_RETURN_RESULTS.has(linkedinResult ?? "");
}

export function stepAfterAlreadyConnected(
  alreadyConnected: boolean,
): 5 | null {
  return alreadyConnected ? 5 : null;
}
