"use client";

import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { useCopiedFlag } from "@/lib/use-copied-flag";

type CopyButtonProps = {
  value: string;
  label: string;
  copiedLabel: string;
  successMessage: string;
  errorMessage: string;
  className: string;
  iconClassName: string;
};

function CopyButton({
  value,
  label,
  copiedLabel,
  successMessage,
  errorMessage,
  className,
  iconClassName,
}: CopyButtonProps) {
  const [copied, markCopied] = useCopiedFlag();

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      markCopied();
      toast.success(successMessage);
    } catch {
      toast.error(errorMessage);
    }
  }

  return (
    <button type="button" onClick={handleCopy} className={className}>
      {copied ? <Check className={iconClassName} /> : <Copy className={iconClassName} />}
      {copied ? copiedLabel : label}
    </button>
  );
}

export function CopyConnectorUrl({ url }: { url: string }) {
  return (
    <div className="flex items-stretch gap-2">
      <div className="flex-1 rounded-lg border border-border/60 bg-background px-3 py-2.5 font-mono text-[13px] text-foreground overflow-x-auto">
        {url}
      </div>
      <CopyButton
        value={url}
        label="Copy"
        copiedLabel="Copied"
        successMessage="Connector URL copied"
        errorMessage="Couldn't copy — copy it manually"
        className="flex shrink-0 items-center gap-2 rounded-lg bg-foreground px-3.5 py-2.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
        iconClassName="h-3.5 w-3.5"
      />
    </div>
  );
}

export function CopyPrompt({ prompt }: { prompt: string }) {
  return (
    <CopyButton
      value={prompt}
      label="Copy"
      copiedLabel="Copied"
      successMessage="Prompt copied"
      errorMessage="Couldn't copy — copy it manually"
      className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground hover:bg-muted"
      iconClassName="h-3 w-3"
    />
  );
}

export function CopyAiInstructions({ prompt }: { prompt: string }) {
  return (
    <CopyButton
      value={prompt}
      label="Copy instructions for AI"
      copiedLabel="Instructions copied"
      successMessage="AI instructions copied"
      errorMessage="Couldn't copy — open llms.txt to copy manually"
      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      iconClassName="h-3.5 w-3.5"
    />
  );
}
