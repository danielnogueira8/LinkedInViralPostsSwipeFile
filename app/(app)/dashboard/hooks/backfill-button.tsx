"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

export function BackfillHooksButton({ missing }: { missing: number }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  if (missing === 0) return null;

  async function run() {
    setBusy(true);
    try {
      const res = await fetch("/api/backfill-hooks", { method: "POST" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      const parts = [
        `${data.extracted} hooks extracted`,
        data.viaHeuristic > 0 && `${data.viaHeuristic} heuristic`,
        data.viaClaude > 0 && `${data.viaClaude} via Claude`,
        data.errors > 0 && `${data.errors} errors`,
      ].filter(Boolean);
      toast.success(parts.join(" · "));
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <Button onClick={run} disabled={busy}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
      {busy ? "Extracting…" : `Extract missing (${missing})`}
    </Button>
  );
}
