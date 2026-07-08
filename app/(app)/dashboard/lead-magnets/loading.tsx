import { Gift } from "lucide-react";

import { PageHeader, PageShell, Surface, Toolbar } from "@/components/app-surface";

export default function LeadMagnetsLoading() {
  return (
    <PageShell role="status" aria-live="polite">
      <PageHeader
        title={<span className="block h-8 w-44 animate-pulse rounded-md bg-muted" />}
        description={<span className="block h-4 w-full max-w-xl animate-pulse rounded-md bg-muted/70" />}
        actions={<span className="hidden h-9 w-40 animate-pulse rounded-full bg-muted sm:block" />}
      />

      <Toolbar className="space-y-4 p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-2">
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            <div className="h-3 w-48 animate-pulse rounded bg-muted/70" />
          </div>
          <div className="flex gap-2">
            <div className="h-8 w-28 animate-pulse rounded-full bg-muted/70" />
            <div className="h-8 w-28 animate-pulse rounded-full bg-muted/70" />
            <div className="h-8 w-24 animate-pulse rounded-full bg-muted" />
          </div>
        </div>
      </Toolbar>

      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Surface key={index} className="min-h-[360px] space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <div className="h-7 w-24 animate-pulse rounded-full bg-muted/70" />
                <div className="h-7 w-24 animate-pulse rounded-full bg-muted/70" />
              </div>
              <Gift className="h-4 w-4 text-muted-foreground/40" aria-hidden />
            </div>
            <div className="space-y-2">
              <div className="h-6 w-4/5 animate-pulse rounded bg-muted" />
              <div className="h-6 w-3/5 animate-pulse rounded bg-muted" />
            </div>
            <div className="space-y-2">
              <div className="h-3 w-full animate-pulse rounded bg-muted/70" />
              <div className="h-3 w-11/12 animate-pulse rounded bg-muted/70" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-muted/60" />
            </div>
            <div className="space-y-2">
              <div className="h-5 w-28 animate-pulse rounded bg-muted/70" />
              <div className="h-6 w-52 animate-pulse rounded-full bg-muted/60" />
              <div className="h-6 w-44 animate-pulse rounded-full bg-muted/60" />
            </div>
          </Surface>
        ))}
      </div>
    </PageShell>
  );
}
