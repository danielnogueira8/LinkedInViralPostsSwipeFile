"use client";

import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Check, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";

// A chip-based category picker with inline "New" custom-category creation,
// shared by the Add-creator dialog and the Save-a-post dialog. Extracted here so
// both flows offer the same affordance: pick an existing category OR type a new
// one and create it on the spot (POST /api/categories, workspace-private).

export type CategoryOption = { id: string; label: string };

// Shared category state for dialogs: merges the server-provided list with any
// categories created in-dialog (before the next router.refresh), and exposes a
// create-and-select helper. Deduped by id at render time so we never fight the
// server list once it catches up — avoids the state-in-effect reconciliation the
// React Compiler flags.
export function useCreateCategory(
  serverCategories: CategoryOption[],
  onSelect: (id: string) => void,
) {
  const [localCategories, setLocalCategories] = useState<CategoryOption[]>([]);
  const options = useMemo(() => {
    if (localCategories.length === 0) return serverCategories;
    const seen = new Set(serverCategories.map((c) => c.id));
    return [...serverCategories, ...localCategories.filter((c) => !seen.has(c.id))];
  }, [serverCategories, localCategories]);

  // Create a custom, workspace-private category and select it. Returns the new
  // category's id on success (so callers can use it without waiting for the
  // `value` state update), or null on failure. The route is idempotent on label
  // (returns the existing row with existed:true), so re-typing a name just
  // re-selects it instead of erroring.
  async function createCategory(label: string): Promise<string | null> {
    try {
      const data = await fetchJson<{
        ok: boolean;
        error?: string;
        existed?: boolean;
        category: CategoryOption;
      }>("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (!data.ok) throw new Error(data.error);
      setLocalCategories((prev) =>
        prev.some((c) => c.id === data.category.id) ? prev : [...prev, data.category],
      );
      onSelect(data.category.id);
      if (!data.existed) toast.success(`Created “${data.category.label}”`);
      return data.category.id;
    } catch (e) {
      toast.error((e as Error).message);
      return null;
    }
  }

  return { options, createCategory };
}

export type CategoryPickerHandle = {
  flushPending: () => Promise<{ ok: true; categoryId: string | null } | { ok: false }>;
};

export function CategoryPicker({
  value,
  onChange,
  options,
  onCreate,
  commitRef,
  onPendingChange,
  uncategorizedLabel = "Uncategorized",
}: {
  value: string;
  onChange: (v: string) => void;
  options: CategoryOption[];
  // Creates a custom category server-side, then selects it. Resolves to the new
  // category id on success, null on failure. Owns its own error toast.
  onCreate: (label: string) => Promise<string | null>;
  // Parent-owned ref; we populate it with a flushPending() the parent calls on
  // submit. Optional so the picker still works standalone.
  commitRef?: React.MutableRefObject<CategoryPickerHandle | null>;
  // Notified whenever the inline "new category" input goes from empty to
  // non-empty (or back), so the parent can treat uncommitted text as a pending
  // change (e.g. enable a Save button). Optional.
  onPendingChange?: (hasPending: boolean) => void;
  // Label for the "no category" chip. Defaults to "Uncategorized".
  uncategorizedLabel?: string;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);

  // Update the draft and tell the parent whether there's now pending text.
  function updateDraft(next: string) {
    setDraft(next);
    onPendingChange?.(next.trim().length > 0);
  }

  // commit() handles a single label: select an existing match or create+select
  // a new one. Returns the resulting selection: { ok, categoryId } on success
  // (categoryId is the committed id, since `value` state won't have updated yet
  // this tick), or { ok: false } if the create failed. With no pending draft it
  // returns the current `value` unchanged.
  async function commit(): Promise<
    { ok: true; categoryId: string | null } | { ok: false }
  > {
    const label = draft.trim();
    if (!label) return { ok: true, categoryId: value || null }; // nothing pending
    if (creating) return { ok: false };
    // If the typed name already matches an existing chip (case-insensitive),
    // just select it instead of round-tripping to create a duplicate.
    const existing = options.find((c) => c.label.toLowerCase() === label.toLowerCase());
    if (existing) {
      onChange(existing.id);
      updateDraft("");
      setAdding(false);
      return { ok: true, categoryId: existing.id };
    }
    setCreating(true);
    const newId = await onCreate(label);
    setCreating(false);
    if (newId) {
      updateDraft("");
      setAdding(false);
      return { ok: true, categoryId: newId };
    }
    return { ok: false };
  }

  // Expose flushPending() to the parent. It commits whatever the user has typed
  // (if anything) before the parent reads the selection on submit. Wired in an
  // effect (not during render) so we don't touch a ref while rendering; the
  // empty-less dep means it re-points at the latest `commit` closure each render
  // (cheap, and `commit` captures the current draft/value/options).
  useEffect(() => {
    if (!commitRef) return;
    commitRef.current = { flushPending: () => commit() };
    return () => {
      commitRef.current = null;
    };
  });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => onChange("")}
        className={cn(
          "px-2.5 py-1 rounded-full border text-xs transition-colors",
          !value
            ? "bg-foreground text-background border-foreground"
            : "bg-background text-muted-foreground border-border hover:text-foreground hover:bg-accent/60",
        )}
      >
        {uncategorizedLabel}
      </button>
      {options.map((c) => {
        const active = value === c.id;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            className={cn(
              "px-2.5 py-1 rounded-full border text-xs transition-colors",
              active
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:text-foreground hover:bg-accent/60",
            )}
          >
            {c.label}
          </button>
        );
      })}
      {adding ? (
        <span className="inline-flex items-center gap-1">
          <Input
            value={draft}
            onChange={(e) => updateDraft(e.target.value)}
            // Enter commits without submitting the outer form; Escape cancels
            // the inline input.
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                updateDraft("");
                setAdding(false);
              }
            }}
            placeholder="New category…"
            maxLength={40}
            autoFocus
            disabled={creating}
            className="h-7 w-36 text-xs"
          />
          <button
            type="button"
            onClick={() => void commit()}
            disabled={creating || !draft.trim()}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
            title="Create category"
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-dashed border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
          title="Create a custom category"
        >
          <Plus className="h-3 w-3" /> New
        </button>
      )}
    </div>
  );
}
