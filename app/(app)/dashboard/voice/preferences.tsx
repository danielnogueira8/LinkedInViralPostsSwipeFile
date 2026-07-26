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
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusPill } from "@/components/app-surface";
import {
  Plus,
  Trash2,
  Pencil,
  Loader2,
  Check,
  X,
  ListPlus,
  NotebookText,
} from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";
import { byId, removeById, reinsertById } from "@/lib/optimistic";
import {
  PREF_RULE_MAX,
  PREF_DETAIL_MAX,
  PREFS_PER_WORKSPACE_MAX,
} from "@/lib/preferences";
import type {
  PreferenceEvidence,
  ReviewableContentPreference,
} from "@/lib/preference-evidence";

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
  initial: ReviewableContentPreference[];
}) {
  const [prefs, setPrefs] = useState(initial);
  const [adding, setAdding] = useState("");
  const [addingDetail, setAddingDetail] = useState("");
  const [showAddDetail, setShowAddDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] =
    useState<ReviewableContentPreference | null>(null);

  const atCap = prefs.length >= PREFS_PER_WORKSPACE_MAX;

  const add = async () => {
    const rule = adding.trim();
    if (!rule || busy) return;
    setBusy(true);
    try {
      const data = await fetchJson<{
        ok: boolean;
        error?: string;
        preference?: Omit<ReviewableContentPreference, "evidence">;
      }>("/api/preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule, detail: addingDetail.trim() || undefined }),
      });
      if (!data?.ok || !data.preference)
        throw new Error(data?.error || "Failed to add");
      setPrefs((cur) => [
        { ...data.preference!, evidence: [] },
        ...cur,
      ]);
      setAdding("");
      setAddingDetail("");
      setShowAddDetail(false);
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

  const saveEdit = async (id: string, rule: string, detail: string) => {
    const trimmed = rule.trim();
    if (!trimmed) return toast.error("A preference can't be empty.");
    try {
      const data = await fetchJson<{
        ok: boolean;
        error?: string;
        preference?: Omit<ReviewableContentPreference, "evidence">;
      }>(`/api/preferences/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rule: trimmed, detail: detail.trim() || undefined }),
      });
      if (!data?.ok || !data.preference)
        throw new Error(data?.error || "Failed to save");
      setPrefs((cur) =>
        cur.map((p) =>
          p.id === id
            ? { ...data.preference!, evidence: p.evidence }
            : p,
        ),
      );
      setEditingId(null);
      toast.success("Preference updated");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Card className="overflow-hidden border-border/70 bg-card/90 shadow-soft">
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
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <Input
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !showAddDetail) {
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
          {showAddDetail ? (
            <Textarea
              value={addingDetail}
              onChange={(e) => setAddingDetail(e.target.value)}
              placeholder="Optional: the why, a number, a date, a caveat — real context Cowork should have alongside the rule above."
              maxLength={PREF_DETAIL_MAX}
              rows={2}
              disabled={atCap || busy}
              className="text-sm"
            />
          ) : (
            <button
              type="button"
              onClick={() => setShowAddDetail(true)}
              disabled={atCap || busy}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <NotebookText className="h-3.5 w-3.5" />
              Add context (optional)
            </button>
          )}
        </div>
        {atCap && (
          <p className="text-xs text-state-warning">
            You&apos;ve reached the limit of {PREFS_PER_WORKSPACE_MAX} memory
            rules. Remove one to add another.
          </p>
        )}

        {prefs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-background/45 px-4 py-8 text-center">
            <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-xl border border-primary/10 bg-primary/[0.07] text-primary">
              <ListPlus className="h-5 w-5" />
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
          <ul className="overflow-hidden rounded-lg border border-border/60 bg-background/45">
            {prefs.map((p) => (
              <PreferenceRow
                key={p.id}
                pref={p}
                editing={editingId === p.id}
                onStartEdit={() => setEditingId(p.id)}
                onCancelEdit={() => setEditingId(null)}
                onSaveEdit={(rule, detail) => saveEdit(p.id, rule, detail)}
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
  pref: ReviewableContentPreference;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (rule: string, detail: string) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(pref.rule);
  const [draftDetail, setDraftDetail] = useState(pref.detail ?? "");

  if (editing) {
    return (
      <li className="space-y-2 p-2">
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onCancelEdit();
            }}
            maxLength={PREF_RULE_MAX}
            autoFocus
          />
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onSaveEdit(draft, draftDetail)}
            aria-label="Save"
          >
            <Check className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => {
              setDraft(pref.rule);
              setDraftDetail(pref.detail ?? "");
              onCancelEdit();
            }}
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <Textarea
          value={draftDetail}
          onChange={(e) => setDraftDetail(e.target.value)}
          placeholder="Optional context — the why, a number, a date, a caveat."
          maxLength={PREF_DETAIL_MAX}
          rows={2}
          className="text-sm"
        />
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-2 p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <span className="block text-sm break-words">{pref.rule}</span>
        {pref.detail && (
          <span className="block text-xs text-muted-foreground break-words">
            {pref.detail}
          </span>
        )}
        {pref.source === "edit_delta" && pref.evidence.length > 0 && (
          <details className="group/evidence pt-1">
            <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
              Why Cowork learned this
            </summary>
            <div className="mt-2 space-y-2">
              {pref.evidence.map((evidence, index) => (
                <PreferenceEvidenceCard
                  key={evidence.id}
                  evidence={evidence}
                  index={index}
                  currentRule={pref.rule}
                />
              ))}
            </div>
          </details>
        )}
        {pref.source === "edit_delta" && pref.evidence.length === 0 && (
          <p className="pt-1 text-xs text-muted-foreground">
            Supporting edits are unavailable for this earlier learned rule.
          </p>
        )}
      </div>
      {pref.source === "learned" && (
        <StatusPill tone="brand" className="h-5 shrink-0 px-2 text-[10px]">
          <AiIcon className="h-3 w-3" aria-hidden />
          Learned
        </StatusPill>
      )}
      {pref.source === "edit_delta" && (
        <StatusPill tone="brand" className="h-5 shrink-0 px-2 text-[10px]">
          <AiIcon className="h-3 w-3" aria-hidden />
          Learned from edits
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

function PreferenceEvidenceCard({
  evidence,
  index,
  currentRule,
}: {
  evidence: PreferenceEvidence;
  index: number;
  currentRule: string;
}) {
  const origin =
    evidence.editOrigin === "posts_editor"
      ? "Posts editor"
      : evidence.editOrigin === "cowork_artifact"
        ? "Cowork draft"
        : "Draft edit";
  const signedDelta =
    evidence.changeSummary.deltaChars > 0
      ? `+${evidence.changeSummary.deltaChars}`
      : String(evidence.changeSummary.deltaChars);

  return (
    <div className="rounded-md border border-border/60 bg-card/70 p-2.5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          Supporting edit {index + 1} · {origin}
        </span>
        <span>{signedDelta} characters</span>
      </div>
      {evidence.ruleSnapshot !== currentRule && (
        <p className="mb-2 text-xs text-muted-foreground">
          This evidence originally produced: “{evidence.ruleSnapshot}”
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <EvidenceExcerpt
          label="Before"
          body={evidence.beforeExcerpt}
          truncated={evidence.beforeTruncated}
        />
        <EvidenceExcerpt
          label="After"
          body={evidence.afterExcerpt}
          truncated={evidence.afterTruncated}
        />
      </div>
    </div>
  );
}

function EvidenceExcerpt({
  label,
  body,
  truncated,
}: {
  label: string;
  body: string;
  truncated: boolean;
}) {
  return (
    <div className="min-w-0 rounded border border-border/50 bg-background/70 p-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-foreground/85">
        {body}
        {truncated ? "…" : ""}
      </div>
    </div>
  );
}
