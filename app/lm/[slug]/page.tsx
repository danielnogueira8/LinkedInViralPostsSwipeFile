import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Check, Clock3, FileText } from "lucide-react";
import {
  MarkdownDocument,
  markdownTableOfContents,
} from "@/components/markdown-document";
import {
  leadMagnetDisplayMarkdown,
  splitLeadMagnetCreatorImage,
} from "@/lib/lead-magnet-generation";
import type { LeadMagnetResourceType } from "@/lib/lead-magnets";
import { supabaseAdmin } from "@/lib/supabase";
import { PublicLeadMagnetAvatar } from "./public-lead-magnet-avatar";

export const dynamic = "force-dynamic";

type PublicLeadMagnet = {
  title: string;
  markdown_body: string;
  workspace_id: string;
  updated_at: string;
  metadata: {
    selection_summary?: string | null;
    summary?: string | null;
    deliverables?: string[];
    resource_type?: LeadMagnetResourceType;
    estimated_minutes?: number;
  } | null;
};

type PublicLeadMagnetAuthor = {
  display_name: string | null;
  avatar_url: string | null;
  headline: string | null;
};

const getPublicLeadMagnet = cache(async (slug: string) => {
  const { data, error } = await supabaseAdmin()
    .from("lead_magnets")
    .select("title, markdown_body, workspace_id, updated_at, metadata")
    .eq("public_slug", slug)
    .eq("is_public", true)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as PublicLeadMagnet | null;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const leadMagnet = await getPublicLeadMagnet((await params).slug);
  if (!leadMagnet) return {};
  const description =
    leadMagnet.metadata?.selection_summary ??
    leadMagnet.metadata?.summary ??
    "A practical guide with clear steps you can put to work right away.";
  return {
    title: leadMagnet.title,
    description,
    openGraph: { title: leadMagnet.title, description, type: "article" },
    twitter: { card: "summary", title: leadMagnet.title, description },
  };
}

export default async function PublicLeadMagnetPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const leadMagnet = await getPublicLeadMagnet(slug);
  if (!leadMagnet) notFound();
  const { data: voice } = await supabaseAdmin()
    .from("voice_profiles")
    .select("display_name, avatar_url, headline")
    .eq("workspace_id", leadMagnet.workspace_id)
    .maybeSingle();
  const author = (voice ?? null) as PublicLeadMagnetAuthor | null;
  const displayMarkdown = leadMagnetDisplayMarkdown({
    title: leadMagnet.title,
    markdown: leadMagnet.markdown_body,
  });
  const split = splitLeadMagnetCreatorImage(displayMarkdown, {
    displayName: author?.display_name ?? null,
    avatarUrl: author?.avatar_url ?? null,
  });
  const documentMarkdown = [split.before, split.after].filter(Boolean).join("\n\n");
  const contents = markdownTableOfContents(documentMarkdown)
    .filter((item) => item.level === 2)
    .slice(0, 12);
  const summary = leadMagnet.metadata?.selection_summary ?? leadMagnet.metadata?.summary;
  const deliverables = leadMagnet.metadata?.deliverables ?? [];
  const resourceType = leadMagnet.metadata?.resource_type;
  const estimatedMinutes = leadMagnet.metadata?.estimated_minutes;
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/70 bg-card">
        <div className="mx-auto grid w-full max-w-[1160px] gap-10 px-5 py-12 sm:px-8 sm:py-16 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:py-20">
          <div className="min-w-0">
            <div className="mb-5 flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1">
                <FileText className="h-3.5 w-3.5" aria-hidden />
                {resourceTypeLabel(resourceType)}
              </span>
              {estimatedMinutes && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1">
                  <Clock3 className="h-3.5 w-3.5" aria-hidden />
                  {estimatedMinutes} min to apply
                </span>
              )}
            </div>
            <h1 className="max-w-[18ch] text-[2.5rem] font-semibold leading-[1.02] tracking-[-0.035em] text-balance sm:text-[3.5rem]">
              {leadMagnet.title}
            </h1>
            {summary && (
              <p className="mt-6 max-w-[65ch] text-lg leading-8 text-muted-foreground sm:text-xl sm:leading-9">
                {summary}
              </p>
            )}
            {author?.display_name && (
              <div className="mt-8 flex items-center gap-3 border-t border-border/70 pt-6">
                <PublicLeadMagnetAvatar
                  name={author.display_name}
                  avatarUrl={author.avatar_url ?? split.image?.src ?? null}
                />
                <div className="min-w-0 text-sm leading-5">
                  <div className="font-medium text-foreground">{author.display_name}</div>
                  {author.headline && (
                    <div className="mt-0.5 max-w-[54ch] text-muted-foreground">
                      {author.headline}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {deliverables.length > 0 && (
            <aside className="rounded-2xl border border-border/70 bg-background px-5 py-5 sm:px-6">
              <h2 className="text-base font-semibold tracking-tight text-foreground">
                What you get
              </h2>
              <ul className="mt-4 space-y-3 text-sm leading-6">
                {deliverables.slice(0, 6).map((deliverable) => (
                  <li key={deliverable} className="flex gap-2.5">
                    <span className="mt-1 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-state-success-bg text-state-success">
                      <Check className="h-3 w-3" aria-hidden />
                    </span>
                    <span>{deliverable}</span>
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1040px] gap-12 px-5 py-12 sm:px-8 sm:py-16 lg:grid-cols-[220px_minmax(0,720px)] lg:items-start lg:py-20">
        {contents.length > 1 ? (
          <nav aria-label="Resource contents" className="hidden lg:block lg:sticky lg:top-8">
            <p className="text-sm font-semibold text-foreground">In this resource</p>
            <ol className="mt-4 space-y-2.5 border-t border-border/70 pt-4 text-sm leading-5 text-muted-foreground">
              {contents.map((item) => (
                <li key={item.id}>
                  <a className="transition-colors hover:text-foreground" href={`#${item.id}`}>
                    {item.text}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        ) : (
          <div className="hidden lg:block" />
        )}

        <div className="min-w-0">
          <MarkdownDocument markdown={documentMarkdown} className="text-[16px] leading-8" />
          {author?.display_name && (
            <footer className="mt-16 border-t border-border/70 pt-6 text-sm leading-6 text-muted-foreground">
              Created by <span className="font-medium text-foreground">{author.display_name}</span>
              {author.headline ? `, ${author.headline}` : ""}.
            </footer>
          )}
        </div>
      </div>
    </main>
  );
}

function resourceTypeLabel(type: LeadMagnetResourceType | undefined): string {
  if (!type) return "Practical resource";
  return type
    .split("_")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}
