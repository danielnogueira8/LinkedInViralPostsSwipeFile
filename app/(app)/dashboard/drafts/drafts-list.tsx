"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Copy, Check, Trash2, FileText, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { renderRichText, ScrollableBody, type Author } from "../chat-workspace";
import { DraftEditor } from "../draft-editor";

// Saved-draft list. Renders each saved post as a LinkedIn-style preview card
// (matching the chat artifact panel) with copy + delete. Client-side so copy,
// delete, and optimistic removal work without a round-trip to a server action.

type Draft = {
  id: string;
  title: string | null;
  body: string;
  createdAt: string;
};

export function DraftsList({
  author,
  initialDrafts,
}: {
  author: Author;
  initialDrafts: Draft[];
}) {
  const [drafts, setDrafts] = useState<Draft[]>(initialDrafts);

  const remove = async (id: string) => {
    const prev = drafts;
    setDrafts((d) => d.filter((x) => x.id !== id)); // optimistic
    try {
      const res = await fetch(`/api/drafts/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to delete");
      toast.success("Draft removed");
    } catch (e) {
      setDrafts(prev); // roll back
      toast.error((e as Error).message);
    }
  };

  // Reflect a saved edit in the list so the card's read-only preview matches
  // what was persisted (and survives a re-render).
  const applyEdit = (id: string, body: string) =>
    setDrafts((d) => d.map((x) => (x.id === id ? { ...x, body } : x)));

  if (drafts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center gap-3 py-20 border border-dashed border-border/60 rounded-xl">
        <div className="h-12 w-12 rounded-xl bg-accent flex items-center justify-center">
          <FileText className="h-6 w-6 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">No saved drafts yet</p>
        <p className="text-sm text-muted-foreground max-w-sm">
          When the chat generates a post, hit <span className="font-medium">Save draft</span>{" "}
          and it&apos;ll show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {drafts.map((d) => (
        <DraftCard
          key={d.id}
          draft={d}
          author={author}
          onDelete={() => remove(d.id)}
          onSaved={(body) => applyEdit(d.id, body)}
        />
      ))}
    </div>
  );
}

function DraftCard({
  draft,
  author,
  onDelete,
  onSaved,
}: {
  draft: Draft;
  author: Author;
  onDelete: () => void;
  onSaved: (body: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  // Local working copy while editing; seeded from the persisted draft.
  const [body, setBody] = useState(draft.body);
  const [saving, setSaving] = useState(false);
  const dirty = body !== draft.body;

  const copy = async () => {
    await navigator.clipboard.writeText(editing ? body : draft.body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const save = async () => {
    if (saving || !dirty) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to save");
      onSaved(body); // sync the list's copy
      setEditing(false);
      toast.success("Draft saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const initials = author.name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="rounded-xl border border-border/60 bg-white text-zinc-900 shadow-sm overflow-hidden flex flex-col">
      {/* LinkedIn-style header */}
      <div className="flex items-center gap-2.5 px-3 pt-3">
        {author.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={author.avatarUrl}
            alt=""
            className="h-10 w-10 rounded-full object-cover shrink-0"
          />
        ) : (
          <div className="h-10 w-10 rounded-full bg-zinc-200 text-zinc-600 flex items-center justify-center text-sm font-semibold shrink-0">
            {initials || "in"}
          </div>
        )}
        <div className="min-w-0 leading-tight flex-1">
          <p className="text-[13px] font-semibold truncate">{author.name}</p>
          {author.headline && (
            <p className="text-[11px] text-zinc-500 truncate">{author.headline}</p>
          )}
          <p className="text-[11px] text-zinc-500">now · 🌐</p>
        </div>
        {/* Edit toggle — same affordance as the in-chat draft card. */}
        <button
          type="button"
          onClick={() => (editing ? save() : setEditing(true))}
          disabled={saving}
          className={cn(
            "shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-60",
            editing
              ? "bg-zinc-900 text-white hover:bg-zinc-800"
              : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
          )}
        >
          {editing ? (
            <>
              <Check className="h-3.5 w-3.5" /> {saving ? "Saving…" : "Done"}
            </>
          ) : (
            <>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </>
          )}
        </button>
      </div>

      {/* Body — read-only preview, or the inline editor (same DraftEditor as the
          chat card: formatting toolbar, highlight-to-format, AI Ask-for-changes). */}
      {editing ? (
        <div className="px-3 py-2.5 max-h-96 overflow-y-auto">
          <DraftEditor value={body} onChange={setBody} />
        </div>
      ) : (
        <ScrollableBody contentKey={draft.body} wrapperClassName="flex-1 max-h-80">
          {renderRichText(draft.body)}
        </ScrollableBody>
      )}

      <div className="border-t border-zinc-100" />

      {/* Actions */}
      <div className="flex items-center gap-2 px-3 py-2.5 bg-zinc-50/60">
        <Button size="sm" variant="outline" className="gap-1.5 h-8" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        {editing && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 h-8"
            onClick={save}
            disabled={saving || !dirty}
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8 ml-auto text-muted-foreground hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}
