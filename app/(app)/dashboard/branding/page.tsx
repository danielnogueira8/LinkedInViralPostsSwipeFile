import Link from "next/link";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { Plug, Sparkles, MessageSquare } from "lucide-react";
import { ClaudeIcon } from "@/components/claude-icon";
import { BrandingManager } from "./manager";
import { CopyPrompt } from "../claude/copy";

const BRAND_PROMPTS: { tag: string; title: string; prompt: string }[] = [
  {
    tag: "Image prompt",
    title: "GPT-image-2.0 prompt that matches a brand",
    prompt:
      "Use the linkedin-swipe connector. Call get_brand to load the brand named 'Acme' (colors, logo URL, fonts). Then write me a single GPT-image-2.0 prompt that recreates the attached reference image using Acme's exact hex palette, swaps any logo in the image for Acme's logo, and uses the brand's primary font for headlines and secondary font for body. Output the prompt as one paragraph I can paste into gpt-image-1.",
  },
  {
    tag: "Recolor",
    title: "Recolor a viral graphic in brand palette",
    prompt:
      "Pull the top viral post from the last 7 days with a graphic. Then call get_brand for 'Acme' and write a gpt-image-1 prompt that recreates that graphic in Acme's brand palette and fonts, keeping the layout and copy intact.",
  },
  {
    tag: "Multi-brand",
    title: "One source, every brand",
    prompt:
      "Call list_brands. For each brand, write me a gpt-image-1 prompt that renders this concept — 'a stat card showing 3 metrics' — in that brand's colors, logo, and fonts. Return one prompt per brand.",
  },
  {
    tag: "Carousel",
    title: "Carousel slides with the brand applied",
    prompt:
      "Call get_brand for 'Acme'. Generate 5 gpt-image-1 prompts for a LinkedIn carousel — title slide + 3 content slides + CTA — each using the Acme palette, logo placement in the bottom-right corner, primary font for headers and secondary for body.",
  },
];

const SETUP_STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Add a brand here",
    body: (
      <>
        Click <span className="font-medium text-foreground">Add brand</span> below and fill in
        name, brand colors, logo URL, and fonts. You can edit later — none of the fields are locked.
      </>
    ),
  },
  {
    title: "Connect Claude to your workspace",
    body: (
      <>
        Open the{" "}
        <Link
          href="/dashboard/claude"
          className="font-medium text-foreground underline underline-offset-4"
        >
          Claude tab
        </Link>{" "}
        and follow the 4-step setup to paste the MCP connector URL into Claude. Takes about a minute.
      </>
    ),
  },
  {
    title: "Ask Claude to use your brand",
    body: (
      <>
        In any Claude chat, reference a brand by name. Claude calls{" "}
        <code className="rounded bg-background px-1 font-mono text-[11px]">get_brand</code> to load
        the colors, logo URL, and fonts — then writes image prompts, copy, or carousels with the
        brand baked in.
      </>
    ),
  },
];

export default async function BrandingPage() {
  const sb = await scopedSupabase();
  const { data: clients } = await sb
    .clientsSelect("*")
    .order("created_at", { ascending: false });
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-4xl font-display tracking-tight">Branding</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Store your brand assets — colors, logo, fonts — once. Then have Claude pull them via MCP
          whenever you generate image prompts, carousels, or recolored graphics.
        </p>
      </div>

      <BrandingManager initial={clients ?? []} />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <Plug className="h-4 w-4 text-muted-foreground" />
            Use it from Claude via MCP
          </h2>
          <p className="text-sm text-muted-foreground">
            Your brands are exposed as MCP tools so Claude can read them when drafting prompts.
            New to MCP?{" "}
            <Link
              href="/dashboard/claude"
              className="font-medium text-foreground underline underline-offset-4 inline-flex items-center gap-1"
            >
              <ClaudeIcon className="h-3.5 w-3.5" />
              Connect Claude
            </Link>{" "}
            first — it&apos;s a one-time setup.
          </p>
        </div>
        <ol className="grid gap-3 md:grid-cols-3">
          {SETUP_STEPS.map((step, i) => (
            <li
              key={step.title}
              className="rounded-xl border border-border/60 bg-card p-4 shadow-[0_1px_2px_0_rgba(15,23,42,0.04)]"
            >
              <div className="flex items-start gap-3">
                <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-foreground text-[12px] font-medium text-background">
                  {i + 1}
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-medium">{step.title}</div>
                  <div className="text-sm text-muted-foreground leading-6">{step.body}</div>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="rounded-xl border border-border/60 bg-muted/30 p-5">
        <div className="space-y-2">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            MCP tools for branding
          </h3>
          <p className="text-sm text-muted-foreground">
            Two tools Claude can call once the connector is live. Most of the time you just
            mention a brand by name and Claude figures out which one to load.
          </p>
        </div>
        <div className="mt-4 grid gap-2 text-[13px] sm:grid-cols-2">
          {[
            ["list_brands", "List every brand in your workspace with colors, logo, fonts."],
            ["get_brand", "Fetch a single brand by name or id — full palette + assets."],
          ].map(([name, desc]) => (
            <div key={name} className="flex items-start gap-3">
              <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground border border-border/60 shrink-0">
                {name}
              </code>
              <span className="text-muted-foreground leading-5">{desc}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            Prompt examples
          </h2>
          <p className="text-sm text-muted-foreground">
            Copy any of these into Claude after you&apos;ve connected the MCP. Replace{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">&apos;Acme&apos;</code>{" "}
            with one of your brand names.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {BRAND_PROMPTS.map((p) => (
            <div
              key={p.title}
              className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4 shadow-[0_1px_2px_0_rgba(15,23,42,0.04)]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {p.tag}
                </span>
                <CopyPrompt prompt={p.prompt} />
              </div>
              <div className="text-sm font-medium">{p.title}</div>
              <p className="text-[13px] leading-6 text-muted-foreground whitespace-pre-wrap">
                {p.prompt}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
