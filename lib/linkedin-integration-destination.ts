export const LINKEDIN_INTEGRATIONS_PATH = "/dashboard/integrations";

export type LinkedInOAuthReturnTo = "integrations" | "welcome";

const OAUTH_DESTINATIONS: Record<LinkedInOAuthReturnTo, string> = {
  integrations: LINKEDIN_INTEGRATIONS_PATH,
  welcome: "/welcome",
};

export function parseLinkedInOAuthReturnTo(
  value: string | null,
): LinkedInOAuthReturnTo | null {
  return value === "integrations" || value === "welcome" ? value : null;
}

export function getLinkedInOAuthDestination(value: string | null): string {
  const returnTo = parseLinkedInOAuthReturnTo(value);
  return returnTo ? OAUTH_DESTINATIONS[returnTo] : LINKEDIN_INTEGRATIONS_PATH;
}
