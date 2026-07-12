import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { MarkdownDocument } from "@/components/markdown-document";
import { splitLeadMagnetCreatorImage } from "@/lib/lead-magnet-generation";
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
  const split = splitLeadMagnetCreatorImage(leadMagnet.markdown_body, {
    displayName: author?.display_name ?? null,
    avatarUrl: author?.avatar_url ?? null,
  });
  const summary = leadMagnet.metadata?.selection_summary ?? leadMagnet.metadata?.summary;
  const deliverables = leadMagnet.metadata?.deliverables ?? [];
  return (
    <main className="min-h-screen bg-[#fbfaf7] text-foreground">
      <div className="mx-auto w-full max-w-[760px] px-5 py-12 sm:px-8 sm:py-16">
        <header className="mb-10 space-y-5 border-b border-black/10 pb-8">
          <h1 className="text-4xl font-display font-semibold tracking-tight sm:text-5xl">
            {leadMagnet.title}
          </h1>
          {summary && <p className="max-w-2xl text-lg leading-8 text-foreground/70">{summary}</p>}
          {author?.display_name && (
            <p className="text-sm text-foreground/60">
              By <span className="font-medium text-foreground">{author.display_name}</span>
              {author.headline ? `, ${author.headline}` : ""}
            </p>
          )}
        </header>
        {deliverables.length > 0 && (
          <aside className="mb-10 rounded-2xl border border-black/10 bg-white px-5 py-5 sm:px-6">
            <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-foreground/60">
              Inside this guide
            </h2>
            <ul className="mt-3 grid gap-2 text-sm leading-6 sm:grid-cols-2">
              {deliverables.slice(0, 6).map((deliverable) => (
                <li key={deliverable} className="flex gap-2">
                  <span aria-hidden="true" className="text-primary">✓</span>
                  <span>{deliverable}</span>
                </li>
              ))}
            </ul>
          </aside>
        )}
        {split.before && <MarkdownDocument markdown={split.before} className="text-[16px] leading-8" />}
        {split.imageFound && (
          <PublicLeadMagnetAvatar
            name={author?.display_name ?? split.image?.alt ?? null}
            avatarUrl={author?.avatar_url ?? split.image?.src ?? null}
          />
        )}
        {split.after && <MarkdownDocument markdown={split.after} className="text-[16px] leading-8" />}
        {author?.display_name && (
          <footer className="mt-14 border-t border-black/10 pt-6 text-sm text-foreground/60">
            Created by <span className="font-medium text-foreground">{author.display_name}</span>
            {author.headline ? `, ${author.headline}` : ""}.
          </footer>
        )}
      </div>
    </main>
  );
}
