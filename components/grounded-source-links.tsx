import { ExternalLink } from "lucide-react";
import type { Artifact } from "@/lib/agent/contracts";
import { GROUNDED_SOURCE_PRESENTATION } from "@/lib/agent/grounded-source-citations";

type RehydratedCard = { id?: unknown; postUrl?: unknown };

function safeLinkedInHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com"))
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function groundedSourceHrefs(artifacts: Artifact[]): string[] {
  const seen = new Set<string>();
  const hrefs: string[] = [];
  for (const artifact of artifacts) {
    if (
      artifact.kind !== "cite" ||
      artifact.meta?.presentation !== GROUNDED_SOURCE_PRESENTATION
    ) {
      continue;
    }
    const postId = artifact.meta.postId;
    const card = artifact.meta.card as RehydratedCard | undefined;
    const rehydratedUrl =
      card && card.id === postId ? safeLinkedInHref(card.postUrl) : null;
    const href = rehydratedUrl ?? safeLinkedInHref(artifact.meta.sourceUrl);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    hrefs.push(href);
  }
  return hrefs.slice(0, 4);
}

export function GroundedSourceLinks({ artifacts }: { artifacts?: Artifact[] }) {
  const hrefs = groundedSourceHrefs(artifacts ?? []);
  if (hrefs.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2" aria-label="Verified sources">
      {hrefs.map((href, index) => (
        <a
          key={href}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary"
        >
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          {hrefs.length === 1
            ? "View source post on LinkedIn"
            : `View source ${index + 1} on LinkedIn`}
        </a>
      ))}
    </div>
  );
}
