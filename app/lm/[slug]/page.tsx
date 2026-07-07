import { notFound } from "next/navigation";
import { MarkdownDocument } from "@/components/markdown-document";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type PublicLeadMagnet = {
  title: string;
  markdown_body: string;
  updated_at: string;
};

export default async function PublicLeadMagnetPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { data, error } = await supabaseAdmin()
    .from("lead_magnets")
    .select("title, markdown_body, updated_at")
    .eq("public_slug", slug)
    .eq("is_public", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) notFound();
  const leadMagnet = data as PublicLeadMagnet;
  return (
    <main className="min-h-screen bg-[#fbfaf7] text-foreground">
      <div className="mx-auto w-full max-w-[760px] px-5 py-12 sm:px-8 sm:py-16">
        <div className="mb-10 space-y-3">
          <h1 className="text-4xl font-display font-semibold tracking-tight sm:text-5xl">
            {leadMagnet.title}
          </h1>
        </div>
        <MarkdownDocument markdown={leadMagnet.markdown_body} className="text-[16px] leading-8" />
      </div>
    </main>
  );
}
