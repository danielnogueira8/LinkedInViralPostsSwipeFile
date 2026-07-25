// Streamed instantly while the chat workspace server component fetches.
// Mirrors the real ChatWorkspace layout (history sidebar + conversation +
// composer + drafts panel) and its exact outer dimensions, so the skeleton →
// live UI swap doesn't jump. Keeps nav clicks from feeling stuck — the app
// sidebar (layout.tsx) stays painted; this replaces the page body.
export default function ChatLoading() {
  return (
    <div className="-mt-2 animate-pulse">
      <div className="flex h-[calc(100dvh-9rem)] min-h-[520px] rounded-xl border border-border/60 overflow-hidden bg-background">
        {/* Left: chat history */}
        <aside className="hidden md:flex w-60 shrink-0 flex-col border-r border-border/60 bg-sidebar/40">
          <div className="p-3">
            <div className="h-8 w-full rounded-lg bg-muted" />
          </div>
          <div className="px-3 pt-1 flex flex-col gap-1.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-8 w-full rounded-lg bg-muted/60" />
            ))}
          </div>
        </aside>

        {/* Center: conversation + composer */}
        <section className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 px-4 sm:px-8 py-6">
            <div className="max-w-3xl mx-auto flex flex-col gap-6">
              {/* a user bubble (right) + an assistant block (left), twice */}
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-4">
                  <div className="flex justify-end">
                    <div className="h-9 w-2/5 rounded-2xl rounded-br-sm bg-muted" />
                  </div>
                  <div className="space-y-2">
                    <div className="h-3 w-11/12 rounded bg-muted/70" />
                    <div className="h-3 w-10/12 rounded bg-muted/70" />
                    <div className="h-3 w-3/4 rounded bg-muted/60" />
                  </div>
                </div>
              ))}
            </div>
          </div>
          {/* Composer */}
          <div className="border-t border-border/60 p-3 sm:p-4">
            <div className="max-w-3xl mx-auto flex items-end gap-2">
              <div className="h-11 w-11 shrink-0 rounded-lg bg-muted/70" />
              <div className="flex-1 h-11 rounded-lg bg-muted/70" />
              <div className="h-11 w-11 shrink-0 rounded-lg bg-muted" />
            </div>
          </div>
        </section>

        {/* Right: drafts panel */}
        <aside className="hidden lg:flex w-80 xl:w-96 shrink-0 flex-col border-l border-border/60 bg-sidebar/30">
          <div className="flex items-center px-4 h-12 border-b border-border/60">
            <div className="h-4 w-20 rounded bg-muted/70" />
          </div>
          <div className="p-3 flex flex-col gap-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <div
                key={i}
                className="rounded-xl border border-border/60 bg-background overflow-hidden"
              >
                <div className="flex items-center gap-2.5 px-3 pt-3">
                  <div className="h-10 w-10 rounded-full bg-muted/70 shrink-0" />
                  <div className="space-y-1.5">
                    <div className="h-3 w-28 rounded bg-muted/70" />
                    <div className="h-2.5 w-40 rounded bg-muted/50" />
                  </div>
                </div>
                <div className="px-3 py-3 space-y-2">
                  <div className="h-2.5 w-full rounded bg-muted/60" />
                  <div className="h-2.5 w-11/12 rounded bg-muted/60" />
                  <div className="h-2.5 w-9/12 rounded bg-muted/50" />
                </div>
                <div className="border-t border-border" />
                <div className="flex gap-2 px-3 py-2.5">
                  <div className="h-8 w-16 rounded-md bg-muted/60" />
                  <div className="h-8 w-20 rounded-md bg-muted/60" />
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
