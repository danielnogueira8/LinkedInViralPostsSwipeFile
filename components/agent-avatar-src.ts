// Browser-safe default path for the bundled agent avatar set. The server-only
// AgentAvatar component can layer its PNG override on top of this path.
export function agentAvatarSvgSrc(slug: string): string {
  return `/agents/${slug}.svg`;
}
