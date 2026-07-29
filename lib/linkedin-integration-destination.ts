export const LINKEDIN_INTEGRATIONS_PATH = "/dashboard/integrations";
export const LINKEDIN_SETTINGS_PATH = "/dashboard/settings";

export type LinkedInConnectionSurface = "integrations" | "settings";
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
  return returnTo ? OAUTH_DESTINATIONS[returnTo] : LINKEDIN_SETTINGS_PATH;
}

export function getLinkedInConnectionPath(
  surface: LinkedInConnectionSurface,
): string {
  return surface === "integrations"
    ? LINKEDIN_INTEGRATIONS_PATH
    : LINKEDIN_SETTINGS_PATH;
}

export function getLinkedInConnectEndpoint(
  surface: LinkedInConnectionSurface,
): string {
  return surface === "integrations"
    ? "/api/integrations/linkedin?returnTo=integrations"
    : "/api/integrations/linkedin";
}
