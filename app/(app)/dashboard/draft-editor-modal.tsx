"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MessageSquare, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DraftEditor } from "./draft-editor";
import type { Draft, DraftStatus } from "./posts/drafts-list";

// A roomy, full-size editor for a draft — the alternative to editing inside the
// cramped board card. Opened from a card's "Edit" and from the "New draft"
// button. Wraps the same Unicode-formatting DraftEditor used in the card, so
// what's typed here pastes into LinkedIn with bold/lists intact.
//
// Two modes, decided by `draft`:
//   - existing draft  → Save PATCHes /api/drafts/[id]; "Model in chat" hands the
//     saved body to the chat to refine.
//   - new draft (null) → Save POSTs /api/drafts; "Model in chat" requires a save
//     first (we need a draft id to hand off), so it saves then navigates.
//
// All persistence is funneled through the parent via onCreated/onSaved so the
// board stays the single source of truth (optimistic add/update, no reload).
export function DraftEditorModal({
  open,
  onOpenChange,
  draft,
  onCreated,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  // null → creating a new draft; otherwise editing this one.
  draft: Draft | null;
  onCreated: (draft: Draft) => void;
  onSaved: (id: string, body: string) => void;
}) {
  const router = useRouter();
  const isNew = draft === null;
  const [body, setBody] = useState(draft?.body ?? "");
  const [saving, setSaving] = useState(false);
  // True while saving + navigating to the chat (Model-in-chat path).
  const [handing, setHanding] = useState(false);
  // Re-seed the working copy whenever the editor opens (or opens onto a
  // different draft). State-during-render (not an effect) so the textarea shows
  // the right body on first paint, with no flash of the previous draft.
  //
  // The key folds in `open`: the modal is permanently mounted (rendered in the
  // board, only hidden on close), so without keying on `open` a Cancel-then-
  // reopen of the SAME draft — or a second "New draft" after creating one —
  // would keep the previous (discarded) body. Becoming "__closed__" while shut
  // forces a fresh re-seed on the next open.
  const [seed, setSeed] = useState<string | null>(null);
  const seedKey = open ? `open:${draft?.id ?? "__new__"}` : "__closed__";
  if (seed !== seedKey) {
    setSeed(seedKey);
    if (open) setBody(draft?.body ?? "");
  }

  const trimmed = body.trim();
  const dirty = trimmed !== (draft?.body ?? "").trim();
  const busy = saving || handing;

  // Persist the current body. Returns the draft id on success (the existing id,
  // or the freshly created one), or null on failure. Shared by Save and the
  // Model-in-chat path (which needs an id to hand off).
  const persist = async (): Promise<string | null> => {
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
      // Existing draft — only hit the network if the body actually changed.
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
    const id = await persist();
    setSaving(false);
    if (id) {
      toast.success(isNew ? "Post created" : "Post saved");
      onOpenChange(false);
    }
  };

  // "Model in chat": save first (we need a draft id), then open the chat at
  // /dashboard?draft=<id>, where it loads the body and prefills a refine prompt
  // so the agent edits THIS draft in the user's voice.
  const modelInChat = async () => {
    if (busy) return;
    setHanding(true);
    const id = await persist();
    if (!id) {
      setHanding(false);
      return;
    }
    // Navigate away; leave `handing` set so the button doesn't flash idle during
    // the route transition.
    router.push(`/dashboard?draft=${encodeURIComponent(id)}`);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="flex max-h-[88vh] w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border/60 px-5 py-4">
          <DialogTitle>{isNew ? "New post" : "Edit post"}</DialogTitle>
          <DialogDescription>
            Format it the way it should read on LinkedIn — bold, lists, and emoji
            carry through when you copy it out.
          </DialogDescription>
        </DialogHeader>

        {/* The editor itself, scrollable so a long post never blows out the
            dialog height. */}
        <div className="min-h-[280px] flex-1 overflow-y-auto px-5 py-4">
          <DraftEditor value={body} onChange={setBody} />
        </div>

        {/* Footer: Model-in-chat on the left (the AI handoff), Cancel + Save on
            the right (the primary path). */}
        <div className="flex flex-col-reverse gap-2 border-t border-border/60 bg-muted/40 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
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
          <div className="flex items-center gap-2 sm:justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
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
        </div>
      </DialogContent>
    </Dialog>
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
