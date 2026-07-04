"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AvatarImg } from "@/components/avatar-img";
import {
  Plus,
  Trash2,
  Pencil,
  Loader2,
  RefreshCw,
  MessageSquare,
  AlertCircle,
  Fingerprint,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/api-fetch";
import { byId, removeById, reinsertById } from "@/lib/optimistic";
import type { CreatorStyleRow } from "@/lib/creator-styles";

// A tracked creator the create-flow can build a style from.
export type PickerCreator = {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
};

// How often we re-poll while any style is still generating.
const POLL_MS = 3000;

// The top structure tags shown on a card (from profile_json.structure_patterns).
function structureTags(row: CreatorStyleRow): string[] {
  return (row.profile_json?.structure_patterns ?? [])
    .map((s) => s.name)
    .filter(Boolean)
    .slice(0, 3);
}

function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function CreatorStylesManager({
  initial,
  creators,
}: {
  initial: CreatorStyleRow[];
  creators: PickerCreator[];
}) {
  const router = useRouter();
  const [styles, setStyles] = useState(initial);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<CreatorStyleRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CreatorStyleRow | null>(null);

  // Poll while ANY style is still generating — refetch the list and merge fresh
  // rows in. Stops once nothing is generating (a settled list needs no polling).
  const anyGenerating = styles.some((s) => s.status === "generating");
  const refetch = useCallback(async () => {
    try {
      const data = await fetchJson<{ ok: boolean; styles?: CreatorStyleRow[] }>(
        "/api/creator-styles",
        { cache: "no-store" },
      );
      if (data?.ok && Array.isArray(data.styles)) setStyles(data.styles);
    } catch {
      /* transient — next tick retries */
    }
  }, []);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!anyGenerating) return;
    pollRef.current = setInterval(() => void refetch(), POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [anyGenerating, refetch]);

  const remove = async (id: string) => {
    const removed = byId(styles, id);
    setStyles((s) => removeById(s, id));
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/creator-styles/${id}`,
        { method: "DELETE" },
      );
      if (!data?.ok) throw new Error(data?.error || "Failed to delete");
      toast.success("Style deleted");
    } catch (e) {
      setStyles((cur) => reinsertById(cur, removed));
      toast.error((e as Error).message);
    }
  };

  const regenerate = async (row: CreatorStyleRow) => {
    // Optimistically flip to generating so the card shows the spinner + the poll
    // kicks in; the server re-runs in after().
    setStyles((cur) =>
      cur.map((s) => (s.id === row.id ? { ...s, status: "generating", error: null } : s)),
    );
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/creator-styles/${row.id}/regenerate`,
        { method: "POST" },
      );
      if (!data?.ok) throw new Error(data?.error || "Couldn't regenerate");
      toast.success("Regenerating this style…");
    } catch (e) {
      await refetch();
      toast.error((e as Error).message);
    }
  };

  const openInCowork = (row: CreatorStyleRow) => {
    // Hand off to Cowork with this style preselected in the composer picker
    // (PR 3 reads ?style=<id> on mount). Mirrors the ?model= / ?skill= handoffs.
    router.push(`/dashboard?style=${encodeURIComponent(row.id)}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm text-muted-foreground">
          {styles.length > 0
            ? `${styles.length} creator style${styles.length === 1 ? "" : "s"}`
            : "No creator styles yet"}
        </div>
        <Button onClick={() => setCreating(true)} disabled={creators.length === 0}>
          <Plus className="h-4 w-4" /> New style
        </Button>
      </div>

      {styles.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {styles.map((row) => (
            <StyleCard
              key={row.id}
              row={row}
              onUse={() => openInCowork(row)}
              onRegenerate={() => regenerate(row)}
              onRename={() => setRenaming(row)}
              onDelete={() => setConfirmDelete(row)}
            />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-12 text-center">
            <Fingerprint className="mx-auto mb-3 h-8 w-8 text-muted-foreground/50" />
            <div className="text-sm font-medium">Create a style from a tracked creator</div>
            <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
              We&rsquo;ll study their posts and distill how they write — hooks,
              rhythm, formatting, structure — so you can write original posts in a
              similar style.
            </p>
            {creators.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground">
                Track a creator on the Creators page first.
              </p>
            ) : (
              <Button className="mt-4" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" /> New style
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Create */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto">
          <CreateStyleForm
            creators={creators}
            onCreated={(row) => {
              setStyles((cur) => [row, ...cur]);
              setCreating(false);
            }}
          />
        </DialogContent>
      </Dialog>

      {/* Rename */}
      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="max-w-md">
          {renaming && (
            <RenameStyleForm
              style={renaming}
              onSaved={(row) => {
                setStyles((cur) => cur.map((x) => (x.id === row.id ? row : x)));
                setRenaming(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={confirmDelete ? `Delete "${confirmDelete.name}"?` : "Delete style?"}
        description="This removes the creator style for the whole workspace."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (confirmDelete) await remove(confirmDelete.id);
          setConfirmDelete(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------
function StyleCard({
  row,
  onUse,
  onRegenerate,
  onRename,
  onDelete,
}: {
  row: CreatorStyleRow;
  onUse: () => void;
  onRegenerate: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const generating = row.status === "generating";
  const failed = row.status === "failed";
  const tags = structureTags(row);
  return (
    <Card className="flex flex-col">
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-center gap-2.5">
          <AvatarImg
            src={row.creator_avatar_url}
            className="h-9 w-9 rounded-lg object-cover ring-1 ring-border/60"
            fallback={
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Fingerprint className="h-4 w-4" />
              </div>
            }
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{row.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {row.creator_name || row.creator_handle || "Creator style"}
              {row.sample_count > 0 && ` · ${row.sample_count} posts`}
            </div>
          </div>
        </div>

        {/* Status / content region */}
        {generating ? (
          <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Distilling this
            creator&rsquo;s writing style…
          </div>
        ) : failed ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{row.error || "Generation failed."}</span>
          </div>
        ) : (
          <>
            {row.description && (
              <p className="line-clamp-2 text-xs text-muted-foreground">{row.description}</p>
            )}
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <span className="text-[10px] text-muted-foreground">
            {relativeTime(row.updated_at)}
          </span>
          <div className="flex items-center gap-1">
            {failed ? (
              <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onRegenerate}>
                <RefreshCw className="h-3.5 w-3.5" /> Retry
              </Button>
            ) : (
              <>
                <IconBtn label="Regenerate" onClick={onRegenerate} disabled={generating}>
                  <RefreshCw className="h-3.5 w-3.5" />
                </IconBtn>
                <IconBtn label="Rename" onClick={onRename}>
                  <Pencil className="h-3.5 w-3.5" />
                </IconBtn>
              </>
            )}
            <IconBtn label="Delete" onClick={onDelete} className="hover:text-destructive">
              <Trash2 className="h-3.5 w-3.5" />
            </IconBtn>
            <Button
              size="sm"
              className="h-8 gap-1.5"
              onClick={onUse}
              disabled={generating || failed}
            >
              <MessageSquare className="h-3.5 w-3.5" /> Use in Cowork
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Create form — pick a tracked creator + name → POST → optimistic generating row
// ---------------------------------------------------------------------------
function CreateStyleForm({
  creators,
  onCreated,
}: {
  creators: PickerCreator[];
  onCreated: (row: CreatorStyleRow) => void;
}) {
  const [creatorId, setCreatorId] = useState<string>(creators[0]?.id ?? "");
  const chosen = creators.find((c) => c.id === creatorId);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  // Default the name to the creator's when one is chosen and the user hasn't typed.
  const effectiveName = name.trim() || (chosen ? `${chosen.name}'s style` : "");

  const submit = async () => {
    if (busy || !creatorId) return;
    setBusy(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string; style?: CreatorStyleRow }>(
        "/api/creator-styles",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: effectiveName, sourceAccountId: creatorId }),
        },
      );
      if (!data?.ok || !data.style) throw new Error(data?.error || "Couldn't create the style");
      toast.success("Generating your style — it'll be ready shortly.");
      onCreated(data.style);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>New creator style</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="space-y-1.5">
          <Label>Creator</Label>
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-1">
            {creators.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCreatorId(c.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                  creatorId === c.id ? "bg-primary/10" : "hover:bg-muted",
                )}
              >
                <AvatarImg
                  src={c.avatarUrl}
                  className="h-7 w-7 rounded-full object-cover"
                  fallback={
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground">
                      {c.name.slice(0, 2).toUpperCase()}
                    </div>
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{c.name}</div>
                  {c.handle && (
                    <div className="truncate text-xs text-muted-foreground">@{c.handle}</div>
                  )}
                </div>
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            We&rsquo;ll analyze this creator&rsquo;s top posts and distill their writing
            style. Only mechanics — never their topics or words.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="style-name">Name</Label>
          <Input
            id="style-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={chosen ? `${chosen.name}'s style` : "Name this style"}
          />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={busy || !creatorId || !effectiveName}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
          Generate style
        </Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Rename form
// ---------------------------------------------------------------------------
function RenameStyleForm({
  style,
  onSaved,
}: {
  style: CreatorStyleRow;
  onSaved: (row: CreatorStyleRow) => void;
}) {
  const [name, setName] = useState(style.name);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string; style?: CreatorStyleRow }>(
        `/api/creator-styles/${style.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        },
      );
      if (!data?.ok || !data.style) throw new Error(data?.error || "Couldn't rename");
      onSaved(data.style);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Rename style</DialogTitle>
      </DialogHeader>
      <div className="py-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={busy || !name.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
