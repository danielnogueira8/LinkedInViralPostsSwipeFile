"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusPill } from "@/components/app-surface";
import { Plus, Trash2, Pencil, Loader2, Check, X, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";
import { byId, removeById, reinsertById } from "@/lib/optimistic";
import {
  PREF_RULE_MAX,
  PREFS_PER_WORKSPACE_MAX,
  type ContentPreference,
} from "@/lib/preferences";

// -----------------------------------------------------------------------------
// PreferencesManager — CRUD for the workspace's standing writing rules.
//
// These are the durable rules the chat agent applies to every post ("no
// em-dashes", "under 900 chars"). The user can type their own AND the agent can
// learn one mid-chat (remember_preference) — this panel is the load-bearing
// review surface for the latter: every learned rule shows a "Learned" badge and
// is one-click deletable, so a mis-captured rule never silently sticks. A rule
// is one short line, so add/edit are inline (no dialog) — only delete confirms.
// -----------------------------------------------------------------------------

export function PreferencesManager({
  initial,
}: {
  initial: ContentPreference[];
}) {
  const [prefs, setPrefs] = useState(initial);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] =
    useState<ContentPreference | null>(null);

  const atCap = prefs.length >= PREFS_PER_WORKSPACE_MAX;

  const add = async () => {
    const rule = adding.trim();
    if (!rule || busy) return;
    setBusy(true);
    try {
      const data = await fetchJson<{
        ok: boolean;
        error?: string;
        preference?: ContentPreference;
      }>("/api/preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule }),
      });
      if (!data?.ok || !data.preference)
        throw new Error(data?.error || "Failed to add");
      setPrefs((cur) => [data.preference as ContentPreference, ...cur]);
      setAdding("");
      toast.success("Preference saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const removed = byId(prefs, id);
    setPrefs((s) => removeById(s, id));
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/preferences/${id}`,
        { method: "DELETE" },
      );
      if (!data?.ok) throw new Error(data?.error || "Failed to delete");
      toast.success("Preference removed");
    } catch (e) {
      setPrefs((cur) => reinsertById(cur, removed));
      toast.error((e as Error).message);
    }
  };

  const saveEdit = async (id: string, rule: string) => {
    const trimmed = rule.trim();
    if (!trimmed) return toast.error("A preference can't be empty.");
    try {
      const data = await fetchJson<{
        ok: boolean;
        error?: string;
        preference?: ContentPreference;
      }>(`/api/preferences/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule: trimmed }),
      });
      if (!data?.ok || !data.preference)
        throw new Error(data?.error || "Failed to save");
      setPrefs((cur) =>
        cur.map((p) => (p.id === id ? (data.preference as ContentPreference) : p)),
      );
      setEditingId(null);
      toast.success("Preference updated");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Card className="overflow-hidden border-border/70 bg-card/88 shadow-soft">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-base">Memory rules</CardTitle>
            <CardDescription>
              Hard rules Cowork remembers for every post it writes for you.
              Add them here, or tell Cowork a lasting rule in chat.
            </CardDescription>
          </div>
          <StatusPill tone="neutral">
            {prefs.length}/{PREFS_PER_WORKSPACE_MAX}
          </StatusPill>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add a new rule inline */}
        <div className="flex items-start gap-2">
          <Input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="e.g. Never use em-dashes"
            maxLength={PREF_RULE_MAX}
            disabled={atCap || busy}
          />
          <Button onClick={add} disabled={atCap || busy || !adding.trim()}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Add
          </Button>
        </div>
        {atCap && (
          <p className="text-xs text-amber-600">
            You&apos;ve reached the limit of {PREFS_PER_WORKSPACE_MAX} memory
            rules. Remove one to add another.
          </p>
        )}

        {prefs.length === 0 ? (
          <div className="rounded-[0.95rem] border border-dashed border-border/60 bg-background/45 px-4 py-8 text-center">
            <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl border border-primary/10 bg-primary/[0.07] text-primary">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="text-sm font-medium text-foreground">
              No memory rules yet
            </div>
            <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">
              Add a lasting rule here, or tell Cowork something like
              &quot;Never say effortless again&quot; and review it on this page.
            </p>
          </div>
        ) : (
          <ul className="overflow-hidden rounded-[0.95rem] border border-border/60 bg-background/45">
            {prefs.map((p) => (
              <PreferenceRow
                key={p.id}
                pref={p}
                editing={editingId === p.id}
                onStartEdit={() => setEditingId(p.id)}
                onCancelEdit={() => setEditingId(null)}
                onSaveEdit={(rule) => saveEdit(p.id, rule)}
                onDelete={() => setConfirmDelete(p)}
              />
            ))}
          </ul>
        )}
      </CardContent>

      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title="Remove this memory rule?"
        description="The assistant will stop applying it to new posts."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (confirmDelete) await remove(confirmDelete.id);
          setConfirmDelete(null);
        }}
      />
    </Card>
  );
}

function PreferenceRow({
  pref,
  editing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
}: {
  pref: ContentPreference;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (rule: string) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(pref.rule);

  if (editing) {
    return (
      <li className="flex items-center gap-2 p-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSaveEdit(draft);
            }
            if (e.key === "Escape") onCancelEdit();
          }}
          maxLength={PREF_RULE_MAX}
          autoFocus
        />
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onSaveEdit(draft)}
          aria-label="Save"
        >
          <Check className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => {
            setDraft(pref.rule);
            onCancelEdit();
          }}
          aria-label="Cancel"
        >
          <X className="h-4 w-4" />
        </Button>
      </li>
    );
  }

  return (
    <li className="group flex items-center gap-2 p-3">
      <span className="flex-1 text-sm break-words">{pref.rule}</span>
      {pref.source === "learned" && (
        <StatusPill tone="primary" className="h-5 px-2 text-[10px]">
          <Sparkles className="h-3 w-3" aria-hidden />
          Learned
        </StatusPill>
      )}
      <Button
        size="icon"
        variant="ghost"
        className="shrink-0"
        onClick={onStartEdit}
        aria-label="Edit"
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="shrink-0 text-destructive"
        onClick={onDelete}
        aria-label="Delete"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}
