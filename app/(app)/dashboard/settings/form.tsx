"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";

type Pair = { min_reactions: number; min_comments: number };

// Coerce a number-input's raw value to a non-negative integer for state. A
// `<input type="number">` hands back a string that can be empty (cleared
// field), partial ("1e", "-"), or negative — `Number("")` is 0 but
// `Number("1e")` is NaN, and a NaN here serializes to `null` in the request
// body and corrupts the saved threshold. Clamp every keystroke so state never
// holds NaN or a negative threshold.
function toNonNegInt(raw: string): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function SettingsForm({ initial }: { initial: { viral: Pair; template: Pair } }) {
  const [vR, setVR] = useState(initial.viral.min_reactions);
  const [vC, setVC] = useState(initial.viral.min_comments);
  const [tR, setTR] = useState(initial.template.min_reactions);
  const [tC, setTC] = useState(initial.template.min_comments);
  const [busy, setBusy] = useState(false);

  async function save() {
    // Belt-and-suspenders: state is already sanitized per keystroke, but guard
    // the payload too so a NaN can never reach the server (where it would
    // serialize to null and break threshold comparisons).
    const fields = [vR, vC, tR, tC];
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
            viral: { min_reactions: vR, min_comments: vC },
            template: { min_reactions: tR, min_comments: tC },
          }),
        },
      );
      if (!data.ok) throw new Error(data.error);
      toast.success("Saved — re-evaluated all stored posts");
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  }

  return (
    <div className="space-y-4 max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Swipe file threshold</CardTitle>
          <CardDescription>A post appears in the swipe file when reactions ≥ min <em>or</em> comments ≥ min. Saving re-evaluates all stored posts.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="vR">Min reactions</Label>
              <Input id="vR" type="number" min={0} step={1} value={vR} onChange={(e) => setVR(toNonNegInt(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vC">Min comments</Label>
              <Input id="vC" type="number" min={0} step={1} value={vC} onChange={(e) => setVC(toNonNegInt(e.target.value))} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Auto-template threshold</CardTitle>
          <CardDescription>A post auto-templates when reactions ≥ min <em>or</em> comments ≥ min. Set higher than the swipe-file threshold to save Anthropic spend. You can still hit &quot;Generate template&quot; on any swipe-file post manually.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="tR">Min reactions</Label>
              <Input id="tR" type="number" min={0} step={1} value={tR} onChange={(e) => setTR(toNonNegInt(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tC">Min comments</Label>
              <Input id="tC" type="number" min={0} step={1} value={tC} onChange={(e) => setTC(toNonNegInt(e.target.value))} />
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
