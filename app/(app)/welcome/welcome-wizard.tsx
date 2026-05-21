"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Flame, Check, ArrowRight, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export type WelcomeCategory = {
  id: string;
  label: string;
  count: number;
  sample: string | null;
};

type Step = 1 | 2 | 3;

export function WelcomeWizard({ categories }: { categories: WelcomeCategory[] }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

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

  async function finish(opts: { trackCategories: boolean }) {
    setBusy(true);
    try {
      const body =
        opts.trackCategories && selected.size > 0
          ? { category_ids: Array.from(selected) }
          : {};
      const res = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      if (data.tracked > 0) {
        toast.success(`Tracking ${data.tracked} creators. First pull queued.`);
      }
      setStep(3);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <div className="min-h-[calc(100vh-12rem)] flex items-center justify-center">
      <Card className="w-full max-w-2xl p-8 sm:p-10 space-y-6">
        <Stepper step={step} />

        {step === 1 && (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <Image
                src="/lavaIconNoBG.png"
                alt=""
                width={48}
                height={48}
                className="h-12 w-12 rounded-xl"
                priority
              />
              <h1 className="font-display text-3xl tracking-tight">Welcome to L.A.V.A</h1>
            </div>
            <div className="space-y-3 text-muted-foreground">
              <p>
                We pull the top LinkedIn creators every day, surface the posts that went
                viral, and turn the winners into templates you can reuse.
              </p>
              <p>
                Pick the categories you care about and your swipe file fills itself in
                under 24 hours.
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
              <h1 className="font-display text-2xl tracking-tight">
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
              <Button
                variant="ghost"
                onClick={() => finish({ trackCategories: false })}
                disabled={busy}
              >
                Skip for now
              </Button>
              <Button
                onClick={() => finish({ trackCategories: true })}
                disabled={busy || selected.size === 0}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                Track {selected.size > 0 ? `${selected.size} ` : ""}
                {selected.size === 1 ? "category" : "categories"}
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5 text-center">
            <div className="mx-auto h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center">
              <Flame className="h-7 w-7 text-primary" />
            </div>
            <div>
              <h1 className="font-display text-2xl tracking-tight">You&apos;re in</h1>
              <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
                Your first daily pull is queued. Check back in 24 hours and the swipe
                file will be populated. In the meantime, take a look around.
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
  return (
    <div className="flex items-center gap-2 text-xs">
      {[1, 2, 3].map((n) => (
        <div key={n} className="flex items-center gap-2">
          <div
            className={cn(
              "h-6 w-6 rounded-full flex items-center justify-center tabular-nums text-[11px] font-medium border",
              n < step
                ? "bg-primary text-primary-foreground border-primary"
                : n === step
                  ? "bg-foreground text-background border-foreground"
                  : "bg-background text-muted-foreground border-border",
            )}
          >
            {n < step ? <Check className="h-3 w-3" /> : n}
          </div>
          {n < 3 && (
            <div
              className={cn(
                "h-px w-6",
                n < step ? "bg-primary" : "bg-border",
              )}
            />
          )}
        </div>
      ))}
    </div>
  );
}
