"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill, Toolbar } from "@/components/app-surface";
import { Gauge, Loader2, Save, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";
import type { DiscoveryThresholds } from "@/lib/discovery-thresholds";
import { RELATIVE_CUTOFF_DISABLED } from "@/lib/viral";

type Pair = { min_reactions: number; min_comments: number };

// Coerce a number-input's raw value to a non-negative integer. A
// `<input type="number">` hands back a string that can be empty (cleared
// field), partial ("1e", "-"), or negative — `Number("")` is 0 but
// `Number("1e")` is NaN, and a NaN here serializes to `null` in the request
// body and corrupts the saved threshold. Applied on SAVE (not per keystroke,
// so the field stays clearable while editing) — state holds the raw string.
function toNonNegInt(raw: string): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function ThresholdSwitch({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  onCheckedChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onCheckedChange}
      className="grid size-11 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
    >
      <span
        aria-hidden
        className={`relative h-6 w-11 rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-muted-foreground/25"
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

export function SettingsForm({
  initial,
}: {
  initial: {
    viral: Pair;
    template: Pair;
    discovery: DiscoveryThresholds;
    relativeCutoffPct: number;
  };
}) {
  // The relative gate is "on" whenever the cutoff is below 100 — 100 means
  // every post is in the top 100% of its creator's history, i.e. no filter.
  // Remembering the last real value means toggling off and back on does not
  // silently reset a workspace's tuned cutoff to the default.
  const [relativeEnabled, setRelativeEnabled] = useState(
    initial.relativeCutoffPct < RELATIVE_CUTOFF_DISABLED,
  );
  const [relativeCutoff, setRelativeCutoff] = useState(
    String(
      initial.relativeCutoffPct < RELATIVE_CUTOFF_DISABLED
        ? initial.relativeCutoffPct
        : 20,
    ),
  );
  const [regularEnabled, setRegularEnabled] = useState(initial.discovery.regular.enabled);
  const [regularLikes, setRegularLikes] = useState(
    String(initial.discovery.regular.minLikes),
  );
  const [leadMagnetEnabled, setLeadMagnetEnabled] = useState(
    initial.discovery.leadMagnet.enabled,
  );
  const [leadMagnetComments, setLeadMagnetComments] = useState(
    String(initial.discovery.leadMagnet.minComments),
  );
  const [busy, setBusy] = useState(false);
  const viral = initial.viral;
  const template = initial.template;

  async function save() {
    // Coerce on save so the raw (possibly empty) editing state can't send a
    // NaN to the server (where it would serialize to null and break threshold
    // comparisons).
    const discovery = {
      regular: {
        enabled: regularEnabled,
        minLikes: toNonNegInt(regularLikes),
      },
      leadMagnet: {
        enabled: leadMagnetEnabled,
        minComments: toNonNegInt(leadMagnetComments),
      },
    };
    // 1-99 only: 0 would mean "top 0%" (nothing qualifies) and 100 is the
    // off switch, which the toggle owns rather than the number field.
    const cutoffPct = toNonNegInt(relativeCutoff);
    if (relativeEnabled && (cutoffPct < 1 || cutoffPct > 99)) {
      toast.error("Top-performer cutoff must be between 1 and 99 percent.");
      return;
    }
    const fields = [
      discovery.regular.minLikes,
      discovery.leadMagnet.minComments,
      viral.min_reactions,
      viral.min_comments,
      template.min_reactions,
      template.min_comments,
    ];
    if (fields.some((n) => !Number.isFinite(n) || n < 0)) {
      toast.error("Thresholds must be whole numbers of 0 or more.");
      return;
    }
    setBusy(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        "/api/settings",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            viral,
            template,
            discovery,
            relative: {
              cutoff_pct: relativeEnabled ? cutoffPct : RELATIVE_CUTOFF_DISABLED,
            },
          }),
        },
      );
      if (!data.ok) throw new Error(data.error);
      toast.success("Minimum engagement settings saved");
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <Toolbar className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Content discovery</div>
          <div className="text-xs text-muted-foreground">
            These thresholds decide what enters Swipe File from tracked creators.
          </div>
        </div>
        <StatusPill tone="neutral" className="h-6">
          Workspace-wide
        </StatusPill>
      </Toolbar>

      <Card className="overflow-hidden border-border/70 bg-card/90 shadow-soft">
        <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-primary/10 bg-primary/[0.07] text-primary">
            <Gauge className="h-4 w-4" />
          </div>
          <CardTitle className="min-w-0 text-base">Minimum engagement</CardTitle>
          <CardDescription className="col-span-2 sm:col-span-1 sm:col-start-2">
            Keep discovery focused with a separate signal for each kind of
            post. Regular posts qualify by likes; lead magnets qualify by
            comments.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-border p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">Regular posts</div>
                  <div className="text-xs text-muted-foreground">Likes only</div>
                </div>
                <ThresholdSwitch
                  checked={regularEnabled}
                  onCheckedChange={() => setRegularEnabled((value) => !value)}
                  label="Use a minimum likes threshold for regular posts"
                />
              </div>
              <div className="mt-4 space-y-1.5">
                <Label htmlFor="regularLikes">Minimum likes</Label>
                <Input
                  id="regularLikes"
                  type="number"
                  min={0}
                  step={1}
                  value={regularLikes}
                  onChange={(event) => setRegularLikes(event.target.value)}
                  disabled={!regularEnabled}
                />
              </div>
            </div>
            <div className="rounded-xl border border-border p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">Lead magnet posts</div>
                  <div className="text-xs text-muted-foreground">Comments only</div>
                </div>
                <ThresholdSwitch
                  checked={leadMagnetEnabled}
                  onCheckedChange={() =>
                    setLeadMagnetEnabled((value) => !value)
                  }
                  label="Use a minimum comments threshold for lead magnet posts"
                />
              </div>
              <div className="mt-4 space-y-1.5">
                <Label htmlFor="leadMagnetComments">Minimum comments</Label>
                <Input
                  id="leadMagnetComments"
                  type="number"
                  min={0}
                  step={1}
                  value={leadMagnetComments}
                  onChange={(event) => setLeadMagnetComments(event.target.value)}
                  disabled={!leadMagnetEnabled}
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-hidden border-border/70 bg-card/90 shadow-soft">
        <CardHeader className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-primary/10 bg-primary/[0.07] text-primary">
            <TrendingUp className="h-4 w-4" />
          </div>
          <CardTitle className="min-w-0 text-base">
            Top performers only
          </CardTitle>
          <CardDescription className="col-span-2 sm:col-span-1 sm:col-start-2">
            Off by default: every post that clears the minimums above counts.
            Turn this on to also require a post to be among a creator&rsquo;s own
            best, judged against their recent history rather than a fixed
            number. A big account&rsquo;s routine post stops qualifying; a small
            account&rsquo;s breakout still does.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-border p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">
                  Compare against the creator&rsquo;s own posts
                </div>
                <div className="text-xs text-muted-foreground">
                  Applies on top of the minimums above
                </div>
              </div>
              <ThresholdSwitch
                checked={relativeEnabled}
                onCheckedChange={() => setRelativeEnabled((value) => !value)}
                label="Only count posts among a creator's own top performers"
              />
            </div>
            <div className="mt-4 space-y-1.5 sm:max-w-xs">
              <Label htmlFor="relativeCutoff">Top percent to keep</Label>
              <Input
                id="relativeCutoff"
                type="number"
                min={1}
                max={99}
                step={1}
                value={relativeCutoff}
                onChange={(event) => setRelativeCutoff(event.target.value)}
                disabled={!relativeEnabled}
              />
              <p className="text-xs text-muted-foreground">
                20 keeps each creator&rsquo;s top 20%. Lower is stricter.
                Creators with fewer than 5 stored posts are judged on the
                minimums alone, since there is not yet enough history to
                compare against.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Button onClick={save} disabled={busy} className="w-full sm:w-auto">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {busy ? "Saving…" : "Save thresholds"}
      </Button>
    </div>
  );
}
