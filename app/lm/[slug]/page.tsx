import { notFound } from "next/navigation";
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
};

type PublicLeadMagnetAuthor = {
  display_name: string | null;
  avatar_url: string | null;
};

export default async function PublicLeadMagnetPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { data, error } = await supabaseAdmin()
    .from("lead_magnets")
    .select("title, markdown_body, workspace_id, updated_at")
    .eq("public_slug", slug)
    .eq("is_public", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) notFound();
  const leadMagnet = data as PublicLeadMagnet;
  const { data: voice } = await supabaseAdmin()
    .from("voice_profiles")
    .select("display_name, avatar_url")
    .eq("workspace_id", leadMagnet.workspace_id)
    .maybeSingle();
  const author = (voice ?? null) as PublicLeadMagnetAuthor | null;
  const split = splitLeadMagnetCreatorImage(leadMagnet.markdown_body, {
    displayName: author?.display_name ?? null,
    avatarUrl: author?.avatar_url ?? null,
  });
  return (
    <main className="min-h-screen bg-[#fbfaf7] text-foreground">
      <div className="mx-auto w-full max-w-[760px] px-5 py-12 sm:px-8 sm:py-16">
        <div className="mb-10 space-y-3">
          <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Lead magnet
          </div>
          <h1 className="text-4xl font-display font-semibold tracking-tight sm:text-5xl">
            {leadMagnet.title}
          </h1>
        </div>
        {split.before && <MarkdownDocument markdown={split.before} className="text-[16px] leading-8" />}
        {split.imageFound && (
          <PublicLeadMagnetAvatar
            name={author?.display_name ?? null}
            avatarUrl={author?.avatar_url ?? null}
          />
        )}
        {split.after && <MarkdownDocument markdown={split.after} className="text-[16px] leading-8" />}
      </div>
    </main>
  );
}
