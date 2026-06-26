"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, CornerDownLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_DESTINATIONS } from "@/app/(app)/dashboard/nav";

// Global command palette (Cmd-K / Ctrl-K): a centered modal with one fuzzy input
// over the nav destinations + "New chat". Keyboard-native — ↑/↓ to move, Enter to
// run, Esc to close. Dependency-free (no cmdk), matching the hand-rolled UI kit.
// Mounted once in the dashboard layout. Security-safe: rows are plain text/icons,
// no links/images loaded from untrusted content.

type Command = {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ className?: string }>;
  run: () => void;
};

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeRaw, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  // The command set: every nav destination (jump-to). Kept to navigation in v1 —
  // robust and the core "I can't find it" win; actions can be added later.
  const commands: Command[] = useMemo(
    () =>
      NAV_DESTINATIONS.map((d) => ({
        id: `nav:${d.href}`,
        label: d.label,
        hint: "Go to",
        icon: d.icon,
        run: () => router.push(d.href),
      })),
    [router],
  );

  // Simple case-insensitive substring filter (subsequence would be fancier, but
  // the list is ~12 items — substring is plenty and predictable).
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  // Global Cmd-K / Ctrl-K to open; toggles closed if already open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Clamp the active index in range — derived during render, not an effect.
  const active = Math.min(activeRaw, Math.max(0, results.length - 1));
  // Focus the input when opening.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const runActive = useCallback(() => {
    const cmd = results[active];
    if (cmd) {
      close();
      cmd.run();
    }
  }, [results, active, close]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={close} aria-hidden="true" />

      <div
        className="relative w-full max-w-lg overflow-hidden rounded-xl border border-border/60 bg-popover shadow-2xl"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            runActive();
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Jump to a screen…"
            className="flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden sm:inline rounded border border-border/60 bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No matches
            </p>
          ) : (
            results.map((c, i) => {
              const Icon = c.icon;
              return (
                <button
                  key={c.id}
                  type="button"
                  onMouseMove={() => setActive(i)}
                  onClick={runActive}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm",
                    i === active ? "bg-accent text-foreground" : "text-muted-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0 opacity-80" />
                  <span className="flex-1 text-foreground">{c.label}</span>
                  {c.hint && <span className="text-[11px] text-muted-foreground">{c.hint}</span>}
                  {i === active && (
                    <CornerDownLeft className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
