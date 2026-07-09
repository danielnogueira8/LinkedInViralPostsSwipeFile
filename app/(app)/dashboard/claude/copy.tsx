"use client";

import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { useCopiedFlag } from "@/lib/use-copied-flag";

export function CopyConnectorUrl({ url }: { url: string }) {
  const [copied, markCopied] = useCopiedFlag();

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      markCopied();
      toast.success("Connector URL copied");
    } catch {
      toast.error("Couldn't copy — copy it manually");
    }
  }

  return (
    <div className="flex items-stretch gap-2">
      <div className="flex-1 rounded-lg border border-border/60 bg-background px-3 py-2.5 font-mono text-[13px] text-foreground overflow-x-auto">
        {url}
      </div>
      <button
        onClick={handleCopy}
        className="flex shrink-0 items-center gap-2 rounded-lg bg-foreground px-3.5 py-2.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function CopyPrompt({ prompt }: { prompt: string }) {
  const [copied, markCopied] = useCopiedFlag();

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(prompt);
      markCopied();
      toast.success("Prompt copied");
    } catch {
      toast.error("Couldn't copy — copy it manually");
    }
  }

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground hover:bg-muted"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
