"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  MessageSquare,
  Loader2,
  Copy,
  Check,
  Trash2,
  X,
  ListChecks,
  Calendar,
  Type,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DraftEditor } from "./draft-editor";
import { cn } from "@/lib/utils";
import { POST_INTENTS } from "@/lib/post-intents";
import type { Draft, DraftStatus } from "./posts/drafts-list";

const STATUS_OPTIONS: { value: DraftStatus; label: string }[] = [
  { value: "idea", label: "Ideas & hooks" },
  { value: "drafting", label: "Drafting" },
  { value: "ready", label: "Ready" },
  { value: "posted", label: "Posted" },
];

// The post detail drawer — a Notion-style panel that slides in from the right
// when a board card is opened. The board card itself is just the post name; all
// the editing lives here: preview name, status, due date, body, plus copy,
// delete, and the "Model in Chat" AI handoff.
//
// Two modes, decided by `draft`:
//   - existing post  → property changes PATCH immediately (optimistic via the
//     parent callbacks); the body saves on blur / explicit Save.
//   - new post (null) → nothing exists yet, so the body must be saved (POST)
//     before status/date/name editing or the AI handoff are meaningful. We show
//     a streamlined "write + create" state and unlock the rest after creation.
//
// All persistence funnels through the parent (onCreated / onSaved / onMeta /
// onDelete) so the board stays the single source of truth.
export function DraftEditorModal({
  open,
  onOpenChange,
  draft,
  onCreated,
  onSaved,
  onMeta,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  // null → creating a new post; otherwise editing this one.
  draft: Draft | null;
  onCreated: (draft: Draft) => void;
  onSaved: (id: string, body: string) => void;
  // Optimistic property change on an existing post (title / status / date).
  onMeta: (id: string, patch: Partial<Draft>) => void;
  onDelete: (id: string) => void;
}) {
  const router = useRouter();
  const isNew = draft === null;
  const [body, setBody] = useState(draft?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [handing, setHanding] = useState(false);
  const [copied, setCopied] = useState(false);

  // Re-seed on open / draft change (state-during-render, keyed on `open` so a
  // close+reopen of the same post re-reads its body and never shows stale text).
  const [seed, setSeed] = useState<string | null>(null);
  const seedKey = open ? `open:${draft?.id ?? "__new__"}` : "__closed__";
  if (seed !== seedKey) {
    setSeed(seedKey);
    if (open) setBody(draft?.body ?? "");
  }

  const trimmed = body.trim();
  const dirty = trimmed !== (draft?.body ?? "").trim();
  const busy = saving || handing;

  // ---- persistence -----------------------------------------------------------

  // Save the body (create on new, PATCH on existing). Returns the post id or
  // null. Shared by Save and the Model-in-Chat handoff (which needs an id).
  const persistBody = async (): Promise<string | null> => {
    if (!trimmed) {
      toast.error("Write something first.");
      return null;
    }
    try {
      if (isNew) {
        const res = await fetch("/api/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: trimmed }),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || "Failed to create post");
        onCreated(normalizeDraft(data.draft));
        return data.draft.id as string;
      }
      if (!dirty) return draft!.id;
      const res = await fetch(`/api/drafts/${draft!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: trimmed }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to save");
      onSaved(draft!.id, trimmed);
      return draft!.id;
    } catch (e) {
      toast.error((e as Error).message);
      return null;
    }
  };

  const save = async () => {
    if (busy) return;
    setSaving(true);
    const id = await persistBody();
    setSaving(false);
    if (id) {
      toast.success(isNew ? "Post created" : "Post saved");
      onOpenChange(false);
    }
  };

  // A property change (title / status / date) on an EXISTING post. Optimistic via
  // onMeta; PATCH in the background. New posts can't have properties yet (no id),
  // so these controls are disabled until the body is created.
  const patchMeta = async (patch: Partial<Draft>, body: Record<string, unknown>) => {
    if (isNew || !draft) return;
    onMeta(draft.id, patch); // optimistic
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to update");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(trimmed || draft?.body || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard.");
    }
  };

  const remove = () => {
    if (isNew || !draft) {
      onOpenChange(false);
      return;
    }
    onDelete(draft.id);
    onOpenChange(false);
  };

  // "Model in Chat": save the post (need a draft id), stash it as a modeling
  // source (source: 'draft'), then open the chat at ?model=<id>&intent=refine —
  // the SAME flow as the swipe-file / bookmark "Model in Chat", so the chat shows
  // the source chip above a clean composer instead of stuffing a refine blob in.
  const modelInChat = async () => {
    if (busy) return;
    setHanding(true);
    const id = await persistBody();
    if (!id) {
      setHanding(false);
      return;
    }
    try {
      const res = await fetch("/api/model-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "draft", postId: id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Couldn't open this post in chat");
      router.push(
        `/dashboard?model=${encodeURIComponent(data.id)}&intent=${POST_INTENTS.refine.key}`,
      );
    } catch (e) {
      toast.error((e as Error).message);
      setHanding(false);
    }
  };

  // Local title state mirrors the draft; commits on blur / Enter. Re-seeded
  // alongside the body when the panel opens onto a post (same seedKey gate).
  const [titleDraft, setTitleDraft] = useState("");
  const [titleSeed, setTitleSeed] = useState<string | null>(null);
  if (titleSeed !== seedKey) {
    setTitleSeed(seedKey);
    if (open) setTitleDraft(draft?.title ?? "");
  }
  const commitTitle = () => {
    if (isNew || !draft) return;
    const next = titleDraft.trim();
    if (next === (draft.title ?? "").trim()) return;
    void patchMeta({ title: next || null }, { title: next });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent
        showCloseButton={false}
        // Pin to the right edge, full height — the Notion-style detail drawer.
        className="left-auto right-0 top-0 bottom-0 h-screen max-h-screen w-full translate-x-0 translate-y-0 gap-0 rounded-none rounded-l-xl p-0 sm:max-w-[480px] data-open:slide-in-from-right-4 flex flex-col"
      >
        {/* Header: close + actions */}
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
          <button
            type="button"
            onClick={() => !busy && onOpenChange(false)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5"
              onClick={copy}
              disabled={!trimmed && !draft}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-muted-foreground hover:text-destructive"
              onClick={remove}
              aria-label="Delete post"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <DialogTitle className="sr-only">
          {isNew ? "New post" : "Edit post"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Edit the post body, preview name, status, and planned date.
        </DialogDescription>

        <div className="flex-1 overflow-y-auto">
          {/* Preview name — the editable title shown on the board card. */}
          <div className="px-5 pt-5">
            <input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              disabled={isNew}
              placeholder={isNew ? "Name set after you create the post" : "Untitled post"}
              className="w-full bg-transparent text-xl font-semibold leading-tight tracking-tight outline-none placeholder:text-muted-foreground/50 disabled:opacity-60"
              aria-label="Preview name"
            />
          </div>

          {/* Properties — Notion-style rows. Disabled until a new post is created. */}
          <div className="mt-4 space-y-1 px-5">
            <PropRow icon={<ListChecks className="h-4 w-4" />} label="Status">
              <select
                value={draft?.status ?? "idea"}
                onChange={(e) =>
                  patchMeta(
                    { status: e.target.value as DraftStatus },
                    { status: e.target.value },
                  )
                }
                disabled={isNew}
                className="-ml-1 h-8 rounded-md bg-transparent px-1 text-sm outline-none hover:bg-accent focus:bg-accent disabled:opacity-60"
                aria-label="Status"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </PropRow>

            <PropRow icon={<Calendar className="h-4 w-4" />} label="Due date">
              <input
                type="date"
                value={draft?.planToPostOn ?? ""}
                onChange={(e) =>
                  patchMeta(
                    { planToPostOn: e.target.value || null },
                    { plan_to_post_on: e.target.value || null },
                  )
                }
                disabled={isNew}
                className="-ml-1 h-8 rounded-md bg-transparent px-1 text-sm text-muted-foreground outline-none hover:bg-accent focus:bg-accent disabled:opacity-60"
                aria-label="Due date"
              />
            </PropRow>

            <PropRow icon={<Type className="h-4 w-4" />} label="Kind">
              <span className="px-1 text-sm capitalize text-muted-foreground">
                {draft?.kind ?? "post"}
              </span>
            </PropRow>
          </div>

          <div className="mx-5 my-4 border-t border-border/60" />

          {/* Body editor */}
          <div className="px-5 pb-5">
            <DraftEditor value={body} onChange={setBody} />
          </div>
        </div>

        {/* Footer: Model in Chat + Save */}
        <div className="flex items-center justify-between gap-2 border-t border-border/60 bg-muted/40 px-5 py-3">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={modelInChat}
            disabled={busy || !trimmed}
            title="Open this post in the chat and refine it with AI"
          >
            {handing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <MessageSquare className="h-3.5 w-3.5" />
            )}
            {handing ? "Opening…" : "Model in Chat"}
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={save}
            disabled={busy || !trimmed || (!isNew && !dirty)}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {saving ? "Saving…" : isNew ? "Create post" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// One Notion-style property row: icon + label on the left, control on the right.
function PropRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex w-28 shrink-0 items-center gap-2 text-sm text-muted-foreground">
        <span className="text-muted-foreground/70">{icon}</span>
        {label}
      </div>
      <div className={cn("min-w-0 flex-1")}>{children}</div>
    </div>
  );
}

// Coerce the API row (loose strings from JSON) into the board's Draft shape.
// Exported for the unit test; kept in sync with drafts-list's Draft type.
export function normalizeDraft(row: {
  id: string;
  title: string | null;
  body: string;
  kind: string;
  status: string;
  plan_to_post_on: string | null;
  chat_id: string | null;
  created_at: string;
}): Draft {
  const status: DraftStatus =
    row.status === "idea" ||
    row.status === "drafting" ||
    row.status === "ready" ||
    row.status === "posted"
      ? row.status
      : "idea";
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    kind: row.kind === "hook" ? "hook" : "post",
    status,
    planToPostOn: row.plan_to_post_on,
    chatId: row.chat_id,
    createdAt: row.created_at,
  };
}
