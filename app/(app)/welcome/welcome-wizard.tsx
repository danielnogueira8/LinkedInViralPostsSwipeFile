"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Flame, Check, ArrowRight, Loader2, AudioLines, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";

export type WelcomeCategory = {
  id: string;
  label: string;
  count: number;
  sample: string | null;
};

type Step = 1 | 2 | 3 | 4 | 5;

export function WelcomeWizard({ categories }: { categories: WelcomeCategory[] }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [profileUrl, setProfileUrl] = useState("");
  // Move focus to the new step's heading on every step change so keyboard and
  // screen-reader users land in the right place (each step has one h1).
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  // Returning from Zernio's LinkedIn OAuth (finalize bounced us to
  // /welcome?linkedin=connected|connect_failed). Land on the final "You're in"
  // step, toast the result, and strip the param so a refresh doesn't re-toast.
  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get("linkedin");
    if (!result) return;
    if (result === "connected") {
      toast.success("LinkedIn connected — you can schedule posts now.");
    } else if (result === "connect_failed") {
      toast.error("Couldn't finish connecting LinkedIn. You can retry in Integrations.");
    } else {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStep(5);
    window.history.replaceState({}, "", "/welcome");
  }, []);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(categories.map((c) => c.id)));
  }

  // Step 2 → 3: track the chosen categories, then advance to the voice step.
  async function trackCategories(opts: { track: boolean }) {
    setBusy(true);
    try {
      const timezone =
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const body = {
        timezone,
        ...(opts.track && selected.size > 0
          ? { category_ids: Array.from(selected) }
          : {}),
      };
      const data = await fetchJson<{ ok: boolean; error?: string; tracked: number }>(
        "/api/onboarding/complete",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!data.ok) throw new Error(data.error);
      if (data.tracked > 0) {
        toast.success(
          `Tracking ${data.tracked} creators — their viral posts are in your swipe file now.`,
        );
      }
      setStep(3);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setBusy(false);
  }

  // Step 3 → 4 (voice → LinkedIn). Kick off voice generation in the background
  // and move on immediately — the scrape+synthesis takes ~15-25s, which we
  // don't make the user wait on. `keepalive` lets the request survive the
  // navigation, so the route still writes its pending→ready row server-side.
  // If they skip, no profile is generated; they can run it later in the Voice
  // tab. We never block onboarding on this.
  function finishVoice(opts: { generate: boolean }) {
    const url = profileUrl.trim();
    if (opts.generate && url) {
      try {
        void fetch("/api/voice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile_url: url }),
          keepalive: true,
        }).catch(() => {
          // Fire-and-forget — failures surface in the Voice tab (the row flips
          // to `failed` with an error), not here.
        });
        toast.success("Learning your voice — check the Voice tab in a minute.");
      } catch {
        // Ignore — onboarding must not be blocked by a voice hiccup.
      }
    }
    setStep(4);
  }

  // Step 4 (LinkedIn). Start Zernio's hosted OAuth. The finalize callback needs
  // to bring the browser BACK to the wizard (not Settings), so we pass a
  // `returnTo=/welcome` hint; on return, page.tsx already sees the connection
  // and — since onboarding is complete — the user lands wherever they choose.
  // Skippable: connecting is optional here, just like voice. onboarded_at was
  // already written at the end of step 2.
  async function connectLinkedIn() {
    setBusy(true);
    try {
      const data = await fetchJson<{
        ok: boolean;
        authUrl?: string;
        alreadyConnected?: boolean;
        error?: string;
      }>("/api/integrations/linkedin?returnTo=welcome", { method: "POST" });
      // Already connected (e.g. the connection survived a workspace change) —
      // don't start a new OAuth flow; just confirm and let the user move on.
      if (data.ok && data.alreadyConnected) {
        toast.success("LinkedIn is already connected.");
        setBusy(false);
        return;
      }
      if (!data.ok || !data.authUrl) {
        throw new Error(data.error || "Couldn't start connecting.");
      }
      // Hand off to Zernio's hosted OAuth; it redirects back to our finalize
      // callback, which bounces to /welcome?linkedin=connected on success.
      window.location.href = data.authUrl;
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-12rem)] flex items-center justify-center">
      <Card className="w-full max-w-2xl p-8 sm:p-10 space-y-6">
        <Stepper step={step} />

        {step === 1 && (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <Image
                src="/swipeInIcon.png"
                alt=""
                width={48}
                height={48}
                className="h-12 w-12 rounded-xl"
                priority
              />
              <h1 ref={headingRef} tabIndex={-1} className="font-display text-3xl tracking-tight outline-none">
                Welcome to SwipeIn
              </h1>
            </div>
            <div className="space-y-3 text-muted-foreground">
              <p>
                We pull the top LinkedIn creators every day, surface the posts that went
                viral, and turn the winners into templates you can reuse.
              </p>
              <p>
                Pick the categories you care about and your swipe file fills up
                instantly with their best posts — then refreshes every morning.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button onClick={() => setStep(2)} disabled={busy}>
                Get started <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <div>
              <h1 ref={headingRef} tabIndex={-1} className="font-display text-2xl tracking-tight outline-none">
                Pick your categories
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                We&apos;ll start tracking every creator in the categories you pick. Change
                this anytime on the Creators page.
              </p>
            </div>

            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">
                {selected.size === 0
                  ? "Nothing selected"
                  : `${selected.size} ${selected.size === 1 ? "category" : "categories"} selected`}
              </div>
              <button
                type="button"
                onClick={selectAll}
                className="text-xs text-primary hover:underline"
              >
                Select all
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {categories.map((cat) => {
                const isSelected = selected.has(cat.id);
                return (
                  <button
                    key={cat.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => toggle(cat.id)}
                    className={cn(
                      "text-left rounded-lg border p-3 transition-colors",
                      isSelected
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-accent/60",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-medium text-sm">{cat.label}</div>
                      <div
                        className={cn(
                          "h-4 w-4 rounded border flex items-center justify-center shrink-0",
                          isSelected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border",
                        )}
                      >
                        {isSelected && <Check className="h-3 w-3" />}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 tabular-nums">
                      {cat.count} creator{cat.count === 1 ? "" : "s"}
                      {cat.sample && (
                        <>
                          <span className="mx-1 text-border">·</span>
                          <span className="italic">e.g. {cat.sample}</span>
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex justify-between gap-2 pt-2">
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setStep(1)} disabled={busy}>
                  Back
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => trackCategories({ track: false })}
                  disabled={busy}
                >
                  Skip for now
                </Button>
              </div>
              <Button
                onClick={() => trackCategories({ track: true })}
                disabled={busy || selected.size === 0}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
                Track {selected.size > 0 ? `${selected.size} ` : ""}
                {selected.size === 1 ? "category" : "categories"}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <AudioLines className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h1 ref={headingRef} tabIndex={-1} className="font-display text-2xl tracking-tight outline-none">
                  Teach us your voice
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  Optional — but it makes everything we draft sound like you.
                </p>
              </div>
            </div>

            <p className="text-sm text-muted-foreground">
              Paste your LinkedIn profile URL and we&apos;ll read your last 50 posts
              to learn how you write — your audience, topics, tone, and hooks. You
              can always set this up later from the Voice tab.
            </p>

            <div className="space-y-1.5">
              <Label htmlFor="onboardingProfileUrl">Your LinkedIn profile URL</Label>
              <Input
                id="onboardingProfileUrl"
                type="url"
                placeholder="https://www.linkedin.com/in/your-handle/"
                value={profileUrl}
                onChange={(e) => setProfileUrl(e.target.value)}
              />
            </div>

            <div className="flex justify-between gap-2 pt-2">
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setStep(2)} disabled={busy}>
                  Back
                </Button>
                <Button variant="ghost" onClick={() => finishVoice({ generate: false })}>
                  Skip for now
                </Button>
              </div>
              <Button
                onClick={() => finishVoice({ generate: true })}
                disabled={!profileUrl.trim()}
              >
                <AudioLines className="h-4 w-4" />
                Learn my voice
              </Button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <Link2 className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h1 ref={headingRef} tabIndex={-1} className="font-display text-2xl tracking-tight outline-none">
                  Connect LinkedIn
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  Optional — connect now to schedule and auto-publish your posts.
                </p>
              </div>
            </div>

            <p className="text-sm text-muted-foreground">
              Link your LinkedIn account and SwipeIn can publish your approved
              drafts on schedule — no copy-pasting. Without it you can still
              draft and plan everything; you just publish by hand. You can
              connect later from Integrations.
            </p>

            <div className="flex justify-between gap-2 pt-2">
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setStep(3)} disabled={busy}>
                  Back
                </Button>
                <Button variant="ghost" onClick={() => setStep(5)} disabled={busy}>
                  Skip for now
                </Button>
              </div>
              <Button onClick={connectLinkedIn} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Link2 className="h-4 w-4" />
                )}
                Connect LinkedIn
              </Button>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="space-y-5 text-center">
            <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center">
              <Flame className="h-7 w-7 text-primary" />
            </div>
            <div>
              <h1 ref={headingRef} tabIndex={-1} className="font-display text-2xl tracking-tight outline-none">You&apos;re in</h1>
              <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
                Your swipe file is ready — the best posts from the creators you
                picked are waiting. Open it, or just ask the AI to draft your
                first post in your voice.
              </p>
            </div>
            <div className="flex justify-center gap-2 pt-2">
              <Button variant="outline" onClick={() => router.push("/dashboard")}>
                Go to dashboard
              </Button>
              <Button onClick={() => router.push("/dashboard/swipe")}>
                Explore the swipe file <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps = [1, 2, 3, 4, 5];
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Onboarding progress">
      {steps.map((n) => (
        <li
          key={n}
          className="flex items-center gap-2"
          aria-current={n === step ? "step" : undefined}
        >
          <div
            className={cn(
              "h-6 w-6 rounded-full flex items-center justify-center tabular-nums text-[11px] font-medium border",
              n < step
                ? "bg-primary text-primary-foreground border-primary"
                : n === step
                  ? "bg-foreground text-background border-foreground"
                  : "bg-background text-muted-foreground border-border",
            )}
            aria-label={n < step ? `Step ${n} complete` : `Step ${n}`}
          >
            {n < step ? <Check className="h-3 w-3" aria-hidden /> : n}
          </div>
          {n < steps.length && (
            <div
              className={cn(
                "h-px w-6",
                n < step ? "bg-primary" : "bg-border",
              )}
              aria-hidden
            />
          )}
        </li>
      ))}
    </ol>
  );
}
