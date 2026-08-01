import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentAvatarSvgSrc } from "./agent-avatar-src";

// Agent avatars on the Claude Workflows page. The bundled art is DiceBear
// "Bottts Neutral" (Pablo Stanley — free for personal and commercial use), one SVG
// per agent in public/agents/<slug>.svg.
//
// To replace one with your own art, drop a PNG at public/agents/<slug>.png —
// it wins automatically at request time, no code change needed.
export function agentAvatarSrc(slug: string): string {
  return existsSync(join(process.cwd(), "public", "agents", `${slug}.png`))
    ? `/agents/${slug}.png`
    : agentAvatarSvgSrc(slug);
}

export function AgentAvatar({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  // Decorative: the agent's name renders next to it.
  // eslint-disable-next-line @next/next/no-img-element -- SVG avatar files; next/image adds nothing here
  return <img src={agentAvatarSrc(slug)} alt="" className={className} />;
}
