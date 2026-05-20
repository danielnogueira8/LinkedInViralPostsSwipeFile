import Link from "next/link";
import {
  Flame,
  Sparkles,
  Users,
  FileText,
  Palette,
  Plug,
  ArrowRight,
  Check,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function LandingPage() {
  return (
    <>
      <Hero />
      <FeatureGrid />
      <HowItWorks />
      <PricingTeaser />
      <FAQ />
      <FinalCTA />
    </>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* soft warm gradient backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-accent/30 via-background to-background"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 left-1/2 -z-10 h-[500px] w-[800px] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
      />
      <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <Badge
            variant="secondary"
            className="mb-6 rounded-full px-3 py-1 text-xs font-medium"
          >
            <Sparkles className="mr-1.5 h-3 w-3" />
            Updated daily with fresh viral posts
          </Badge>
          <h1 className="font-display text-5xl leading-[1.05] tracking-tight md:text-7xl">
            LinkedIn viral posts,{" "}
            <span className="text-primary">dissected daily.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground md:text-xl">
            Track 100 top creators. Get post templates, brand-recolored
            graphics, and lead-magnet teardowns delivered to your dashboard —
            so you stop guessing what to post.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/sign-up">
              <Button size="lg" className="h-12 px-7 text-base">
                Start free trial
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            <Link href="/pricing">
              <Button
                variant="ghost"
                size="lg"
                className="h-12 px-6 text-base"
              >
                See pricing
              </Button>
            </Link>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            No credit card required. 7-day free trial.
          </p>
        </div>

        {/* Hero visual placeholder — a stylized card stack */}
        <div className="relative mx-auto mt-16 max-w-5xl">
          <div className="rounded-2xl border border-border/60 bg-card/80 p-3 shadow-2xl shadow-primary/5 backdrop-blur">
            <div className="rounded-xl border border-border/40 bg-background/80 p-6 md:p-8">
              <div className="grid gap-4 md:grid-cols-3">
                {SAMPLE_POSTS.map((post, i) => (
                  <SamplePostCard key={i} {...post} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SamplePostCard({
  author,
  niche,
  preview,
  reactions,
  comments,
  viral,
}: {
  author: string;
  niche: string;
  preview: string;
  reactions: string;
  comments: string;
  viral?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card p-4 transition-all hover:shadow-md">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">{author}</div>
          <div className="text-[11px] text-muted-foreground">{niche}</div>
        </div>
        {viral && (
          <Badge
            variant="secondary"
            className="border-orange-500/20 bg-orange-500/10 px-1.5 py-0.5 text-[10px] text-orange-600"
          >
            <Flame className="mr-0.5 h-2.5 w-2.5" />
            Viral
          </Badge>
        )}
      </div>
      <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
        {preview}
      </p>
      <div className="mt-4 flex items-center gap-4 text-[11px] text-muted-foreground">
        <span>♥ {reactions}</span>
        <span>💬 {comments}</span>
      </div>
    </div>
  );
}

const SAMPLE_POSTS = [
  {
    author: "Lara Acosta",
    niche: "Personal branding",
    preview:
      "I made $2M from LinkedIn in 2 years. Here are the 5 frameworks I'd teach my younger self...",
    reactions: "12.4k",
    comments: "847",
    viral: true,
  },
  {
    author: "Justin Welsh",
    niche: "Solopreneurship",
    preview:
      "Most people overcomplicate writing on LinkedIn. The 3-step template I've used 500+ times...",
    reactions: "8.9k",
    comments: "412",
    viral: true,
  },
  {
    author: "Hatice Kamran",
    niche: "Content strategy",
    preview:
      "Comment 'PLAYBOOK' and I'll DM you the full 47-page guide I sold to 200+ founders...",
    reactions: "5.2k",
    comments: "1.8k",
  },
];

function FeatureGrid() {
  return (
    <section id="features" className="border-t border-border/60 py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <div className="text-sm font-medium uppercase tracking-wider text-primary">
            Features
          </div>
          <h2 className="mt-3 font-display text-4xl leading-tight tracking-tight md:text-5xl">
            Everything you need to write like a top creator.
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            We do the scraping, classifying, and templating. You do the
            writing.
          </p>
        </div>

        <div className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <Card
              key={f.title}
              className="border-border/60 transition-all hover:shadow-md"
            >
              <CardHeader>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <f.icon className="h-5 w-5" />
                </div>
                <CardTitle className="mt-4 text-lg">{f.title}</CardTitle>
                <CardDescription className="leading-relaxed">
                  {f.description}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

const FEATURES = [
  {
    icon: Flame,
    title: "Daily-scraped viral swipe file",
    description:
      "Every morning, we pull the highest-performing posts from the creators you track. Filter by niche, date, or virality threshold.",
  },
  {
    icon: FileText,
    title: "Auto-generated post templates",
    description:
      "We turn viral posts into reusable fill-in-the-blank templates. Skip the blank-page paralysis.",
  },
  {
    icon: Palette,
    title: "Brand-recolored graphics",
    description:
      "Add your client's brand colors once and we'll recolor every post graphic to match. No Figma fiddling.",
  },
  {
    icon: Users,
    title: "Track 100 creators",
    description:
      "Add anyone's LinkedIn profile. We watch their posts daily and surface the breakouts so you don't have to scroll.",
  },
  {
    icon: Zap,
    title: "Lead-magnet detection",
    description:
      "Our classifier flags lead-magnet posts (the 'comment PLAYBOOK and I'll DM you' kind) so you can study what's converting.",
  },
  {
    icon: Plug,
    title: "MCP connector for Claude",
    description:
      "Pipe your entire swipe file into Claude. Ask 'what hooks worked best last week?' and get instant answers.",
  },
];

function HowItWorks() {
  return (
    <section className="border-t border-border/60 bg-accent/15 py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <div className="text-sm font-medium uppercase tracking-wider text-primary">
            How it works
          </div>
          <h2 className="mt-3 font-display text-4xl leading-tight tracking-tight md:text-5xl">
            Three steps to a working swipe file.
          </h2>
        </div>

        <div className="mt-14 grid gap-8 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <div key={step.title} className="relative">
              <div className="absolute -top-2 left-0 font-display text-7xl leading-none text-primary/10">
                {String(i + 1).padStart(2, "0")}
              </div>
              <div className="relative pt-12">
                <h3 className="font-display text-2xl tracking-tight">
                  {step.title}
                </h3>
                <p className="mt-3 leading-relaxed text-muted-foreground">
                  {step.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const STEPS = [
  {
    title: "Add the creators you track",
    description:
      "Paste up to 100 LinkedIn profile URLs. We start watching their posts immediately.",
  },
  {
    title: "We scrape and classify, daily",
    description:
      "Each morning we pull new posts, flag viral ones, detect lead magnets, and generate templates.",
  },
  {
    title: "You write — faster, smarter",
    description:
      "Browse the swipe file, copy templates, recolor graphics for your clients. Done in minutes.",
  },
];

function PricingTeaser() {
  return (
    <section
      id="pricing-teaser"
      className="border-t border-border/60 py-20 md:py-28"
    >
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <div className="text-sm font-medium uppercase tracking-wider text-primary">
            Pricing
          </div>
          <h2 className="mt-3 font-display text-4xl leading-tight tracking-tight md:text-5xl">
            One plan. Everything included.
          </h2>
          <p className="mt-4 text-lg text-muted-foreground">
            No tiers, no add-ons, no upsells. Cancel anytime.
          </p>
        </div>

        <div className="mx-auto mt-12 max-w-lg">
          <Card className="relative overflow-hidden border-primary/20 shadow-lg shadow-primary/5">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-br from-primary/[0.04] to-transparent"
            />
            <CardHeader className="pb-4 text-center">
              <CardTitle className="text-base font-medium">Pro</CardTitle>
              <div className="mt-3 flex items-baseline justify-center gap-1.5">
                <span className="font-display text-6xl tracking-tight">
                  $99
                </span>
                <span className="text-muted-foreground">/month</span>
              </div>
              <CardDescription className="mt-2">
                Everything you need to ship LinkedIn content faster.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-2">
              <ul className="space-y-3 text-sm">
                {PLAN_FEATURES.map((f) => (
                  <li key={f} className="flex items-start gap-2.5">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <Link href="/sign-up" className="block pt-3">
                <Button className="w-full" size="lg">
                  Start free trial
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <p className="text-center text-xs text-muted-foreground">
                7 days free. No credit card required.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}

const PLAN_FEATURES = [
  "Track up to 100 creators",
  "Daily viral post scraping",
  "Auto-generated post templates",
  "Brand-recolored graphics",
  "Lead-magnet detection",
  "Claude MCP connector",
  "Unlimited swipe file access",
  "Priority email support",
];

function FAQ() {
  return (
    <section
      id="faq"
      className="border-t border-border/60 bg-accent/15 py-20 md:py-28"
    >
      <div className="mx-auto max-w-3xl px-6">
        <div className="text-center">
          <div className="text-sm font-medium uppercase tracking-wider text-primary">
            FAQ
          </div>
          <h2 className="mt-3 font-display text-4xl leading-tight tracking-tight md:text-5xl">
            Frequently asked.
          </h2>
        </div>

        <div className="mt-14 space-y-2">
          {FAQS.map((qa) => (
            <details
              key={qa.q}
              className="group rounded-xl border border-border/60 bg-card/60 px-5 py-4 transition-colors open:bg-card"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-medium">
                {qa.q}
                <span className="text-muted-foreground transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="mt-3 leading-relaxed text-muted-foreground">
                {qa.a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

const FAQS = [
  {
    q: "How do you actually get the LinkedIn posts?",
    a: "We use a public-data scraping pipeline (via Apify) that respects LinkedIn's public surface area. You add the profiles you want to track and we pull their public posts daily.",
  },
  {
    q: "Can I track my own clients' competitors?",
    a: "Yes. Most users add a mix of top creators in their niche plus their clients' direct competitors. The platform is built around tracking 100 profiles per workspace.",
  },
  {
    q: "What does 'brand-recolored graphics' mean?",
    a: "When a viral post includes a graphic, we generate a version recolored to match your client's brand palette — so you can repurpose proven visuals without manually editing them in Figma.",
  },
  {
    q: "What's the Claude MCP connector?",
    a: "MCP (Model Context Protocol) lets Claude securely connect to your swipe file. You can then ask Claude things like 'what hooks worked best in the last 30 days?' and it'll answer using your actual data.",
  },
  {
    q: "Is there a free plan?",
    a: "There's a 7-day free trial — full access, no credit card required. After that it's $99/month, billed monthly. Cancel anytime.",
  },
  {
    q: "Can I add more than 100 creators?",
    a: "100 is the cap on the Pro plan. If you need more (large agency use cases), email us and we'll work something out.",
  },
];

function FinalCTA() {
  return (
    <section className="border-t border-border/60 py-20 md:py-28">
      <div className="mx-auto max-w-3xl px-6 text-center">
        <h2 className="font-display text-4xl leading-tight tracking-tight md:text-6xl">
          Start writing like the top 1%.
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-lg text-muted-foreground">
          7 days free. No credit card. Cancel anytime.
        </p>
        <div className="mt-9 flex justify-center">
          <Link href="/sign-up">
            <Button size="lg" className="h-12 px-7 text-base">
              Start free trial
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}
