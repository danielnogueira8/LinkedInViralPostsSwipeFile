"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";

type Pair = { min_reactions: number; min_comments: number };

export function SettingsForm({ initial }: { initial: { viral: Pair; template: Pair } }) {
  const [vR, setVR] = useState(initial.viral.min_reactions);
  const [vC, setVC] = useState(initial.viral.min_comments);
  const [tR, setTR] = useState(initial.template.min_reactions);
  const [tC, setTC] = useState(initial.template.min_comments);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          viral: { min_reactions: vR, min_comments: vC },
          template: { min_reactions: tR, min_comments: tC },
        }),
      });
      const data = await res.json();
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
              <Input id="vR" type="number" value={vR} onChange={(e) => setVR(Number(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vC">Min comments</Label>
              <Input id="vC" type="number" value={vC} onChange={(e) => setVC(Number(e.target.value))} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Auto-template threshold</CardTitle>
          <CardDescription>Only posts above this threshold get auto-templated by the cron. Set higher than the swipe-file threshold to save Anthropic spend. You can still hit &quot;Generate template&quot; on any swipe-file post manually.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="tR">Min reactions</Label>
              <Input id="tR" type="number" value={tR} onChange={(e) => setTR(Number(e.target.value))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tC">Min comments</Label>
              <Input id="tC" type="number" value={tC} onChange={(e) => setTC(Number(e.target.value))} />
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
