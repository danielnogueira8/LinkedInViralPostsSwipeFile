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

export function SettingsForm({ initial }: { initial: { viral: Pair; template: Pair } }) {
  const [vR, setVR] = useState(String(initial.viral.min_reactions));
  const [vC, setVC] = useState(String(initial.viral.min_comments));
  const [busy, setBusy] = useState(false);
  const template = initial.template;

  async function save() {
    // Coerce on save so the raw (possibly empty) editing state can't send a
    // NaN to the server (where it would serialize to null and break threshold
    // comparisons).
    const viral = { min_reactions: toNonNegInt(vR), min_comments: toNonNegInt(vC) };
    const fields = [viral.min_reactions, viral.min_comments, template.min_reactions, template.min_comments];
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
          }),
        },
      );
      if (!data.ok) throw new Error(data.error);
      toast.success("Saved — re-evaluated all stored posts");
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
              <CardTitle className="text-base">Swipe file threshold</CardTitle>
              <CardDescription>
                A post appears in the swipe file when reactions or comments meet
                the minimum AND it&apos;s in the creator&apos;s top 20% of recent
                posts (only creators with enough history are compared; new
                creators use the minimum alone). Saving re-evaluates every
                stored post.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="vR">Min reactions</Label>
              <Input id="vR" type="number" min={0} step={1} value={vR} onChange={(e) => setVR(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vC">Min comments</Label>
              <Input id="vC" type="number" min={0} step={1} value={vC} onChange={(e) => setVC(e.target.value)} />
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
