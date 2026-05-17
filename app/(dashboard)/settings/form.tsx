"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";

export function SettingsForm({ initial }: { initial: { min_reactions: number; min_comments: number } }) {
  const [r, setR] = useState(initial.min_reactions);
  const [c, setC] = useState(initial.min_comments);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ min_reactions: r, min_comments: c }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      toast.success("Saved — re-evaluated all stored posts");
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="text-base">Viral thresholds</CardTitle>
        <CardDescription>A post is &quot;viral&quot; when reactions ≥ min <em>or</em> comments ≥ min. Saving re-evaluates all stored posts.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="r">Min reactions</Label>
            <Input id="r" type="number" value={r} onChange={(e) => setR(Number(e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="c">Min comments</Label>
            <Input id="c" type="number" value={c} onChange={(e) => setC(Number(e.target.value))} />
          </div>
        </div>
        <Button onClick={save} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {busy ? "Saving…" : "Save thresholds"}
        </Button>
      </CardContent>
    </Card>
  );
}
