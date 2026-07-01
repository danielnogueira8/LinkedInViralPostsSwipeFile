import Link from "next/link";
import { Check, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata = {
  title: "Pricing · Swipe File",
  description:
    "One plan. Everything included. Launch offer: $79/month (normally $99), 7-day free trial, cancel anytime.",
};

const PLAN_FEATURES = [
  { label: "Track up to 100 LinkedIn creators", emphasis: true },
  { label: "Daily-scraped viral posts" },
  { label: "Auto-generated post templates" },
  { label: "Brand-recolored graphics for unlimited clients" },
  { label: "Lead-magnet detection and breakdowns" },
  { label: "Claude MCP connector" },
  { label: "Unlimited swipe file access" },
  { label: "Filter by niche, virality, date" },
  { label: "Priority email support" },
];

const FAQS = [
  {
    q: "Is there really only one plan?",
    a: "Yes. We hate pricing-page tier-shopping as much as you do. One plan, everything included — currently $79/month on our launch offer (normally $99).",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. Cancel in your dashboard, no email-back-and-forth. You keep access until the end of the billing period.",
  },
  {
    q: "What happens after the free trial?",
    a: "If you cancel during the 7-day trial, you owe nothing. If you don't cancel, we charge your launch price of $79 and start your monthly billing cycle.",
  },
  {
    q: "Do you offer annual pricing?",
    a: "Not yet. We'll add it once we've stabilized the monthly plan. Email us if you want early access.",
  },
  {
    q: "I need to track more than 100 creators.",
    a: "Email us. We'll set up a custom plan for large agencies.",
  },
  {
    q: "Refund policy?",
    a: "If you're unhappy in the first 14 days after billing, email us and we'll refund you, no questions asked.",
  },
];

export default function PricingPage() {
  return (
    <div className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[400px] bg-gradient-to-b from-accent/30 to-transparent"
      />

      <section className="mx-auto max-w-6xl px-6 pt-20 pb-12 md:pt-28">
        <div className="mx-auto max-w-2xl text-center">
          <h1 className="font-display text-5xl leading-[1.05] tracking-tight md:text-6xl">
            One plan. Everything included.
          </h1>
          <p className="mt-5 text-lg text-muted-foreground md:text-xl">
            No tiers. No add-ons. No surprise upsells.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-20">
        <Card className="relative overflow-hidden border-primary/20 shadow-xl shadow-primary/5">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-br from-primary/[0.04] to-transparent"
          />

          <CardHeader className="pb-6 pt-8">
            <div className="flex items-start justify-between gap-6">
              <div>
                <CardTitle className="text-lg font-medium">Pro</CardTitle>
                <CardDescription className="mt-1.5">
                  Everything you need to ship LinkedIn content faster.
                </CardDescription>
              </div>
              <Badge
                variant="secondary"
                className="border-primary/20 bg-primary/10 text-primary"
              >
                Launch offer
              </Badge>
            </div>

            <div className="mt-6 flex items-baseline gap-3">
              <span className="font-display text-6xl tracking-tight md:text-7xl">
                $79
              </span>
              <span className="font-display text-3xl tracking-tight text-muted-foreground line-through decoration-muted-foreground/50 md:text-4xl">
                $99
              </span>
              <span className="text-lg text-muted-foreground">/month</span>
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              Launch price, locked in while it lasts. Billed monthly. Cancel
              anytime.
            </div>
          </CardHeader>

          <CardContent className="space-y-6 pb-8">
            <div className="h-px bg-border/60" />

            <ul className="grid gap-3 sm:grid-cols-2">
              {PLAN_FEATURES.map((f) => (
                <li key={f.label} className="flex items-start gap-2.5 text-sm">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span className={f.emphasis ? "font-medium" : ""}>
                    {f.label}
                  </span>
                </li>
              ))}
            </ul>

            <div className="pt-2">
              <Link href="/sign-up" className="block">
                <Button className="h-12 w-full text-base" size="lg">
                  Start for free
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
              <p className="mt-3 text-center text-xs text-muted-foreground">
                7 days free, no credit card required, cancel anytime
              </p>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="border-t border-border/60 bg-accent/15 py-20">
        <div className="mx-auto max-w-3xl px-6">
          <div className="text-center">
            <h2 className="font-display text-4xl leading-tight tracking-tight">
              Common questions.
            </h2>
          </div>

          <div className="mt-12 space-y-2">
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
    </div>
  );
}
