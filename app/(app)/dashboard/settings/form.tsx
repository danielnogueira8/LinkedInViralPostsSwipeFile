"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill, Toolbar } from "@/components/app-surface";
import { Gauge, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";
import type { DiscoveryThresholds } from "@/lib/discovery-thresholds";

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

export function SettingsForm({
  initial,
}: {
  initial: { viral: Pair; template: Pair; discovery: DiscoveryThresholds };
}) {
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
        <CardHeader>
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-primary/10 bg-primary/[0.07] text-primary">
              <Gauge className="h-4 w-4" />
            </div>
            <div className="min-w-0 space-y-1">
              <CardTitle className="text-base">Minimum engagement</CardTitle>
              <CardDescription>
                Keep discovery focused with a separate signal for each kind of
                post. Regular posts qualify by likes; lead magnets qualify by
                comments.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-border p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">Regular posts</div>
                  <div className="text-xs text-muted-foreground">Likes only</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={regularEnabled}
                  onClick={() => setRegularEnabled((value) => !value)}
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    regularEnabled ? "bg-primary" : "bg-muted-foreground/25"
                  }`}
                  aria-label="Use a minimum likes threshold for regular posts"
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                      regularEnabled ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
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
                <button
                  type="button"
                  role="switch"
                  aria-checked={leadMagnetEnabled}
                  onClick={() => setLeadMagnetEnabled((value) => !value)}
                  className={`relative h-6 w-11 rounded-full transition-colors ${
                    leadMagnetEnabled ? "bg-primary" : "bg-muted-foreground/25"
                  }`}
                  aria-label="Use a minimum comments threshold for lead magnet posts"
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                      leadMagnetEnabled ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
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

      <Button onClick={save} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {busy ? "Saving…" : "Save thresholds"}
      </Button>
    </div>
  );
}
