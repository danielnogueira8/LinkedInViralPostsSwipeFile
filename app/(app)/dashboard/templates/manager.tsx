"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AvatarImg } from "@/components/avatar-img";
import { EmptyState, StatusPill, Toolbar, segmentedItemClass } from "@/components/app-surface";
import { FileText, Plus, Trash2, Pencil, Loader2, Copy, Check, Lock, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/api-fetch";
import { byId, removeById, reinsertById } from "@/lib/optimistic";
import { copyToClipboard } from "@/lib/clipboard";
import { useCopiedFlag } from "@/lib/use-copied-flag";
import {
  extractPlaceholders,
  isPlaceholderToken,
  splitOnPlaceholders,
  templateCategoryLabel,
  TEMPLATE_CATEGORIES,
  TEMPLATE_CATEGORY_LABELS,
  TEMPLATE_BODY_MAX,
  TEMPLATE_TITLE_MAX,
  type ContentTemplate,
  type TemplateCategory,
  type BuiltinTemplate,
} from "@/lib/templates";
import { BUILTIN_TEMPLATES } from "@/lib/templates-builtin";
import { POST_INTENTS } from "@/lib/post-intents";
import { HorizontalCategoryRail } from "@/components/horizontal-category-rail";

// A row the card list renders — either a workspace custom template (DB row) or
// an app-owned built-in. `builtin` gates the edit/delete actions.
type Row = {
  id: string;
  title: string;
  category: string | null;
  body: string;
  builtin: boolean;
};

function builtinToRow(t: BuiltinTemplate): Row {
  return { id: t.id, title: t.title, category: t.category, body: t.body, builtin: true };
}
function customToRow(t: ContentTemplate): Row {
  return { id: t.id, title: t.title, category: t.category, body: t.body, builtin: false };
}

// The user's author identity for the LinkedIn-style card header. Both fields
// may be null before a voice profile exists — the card then shows a neutral
// "You" + an initials avatar.
export type TemplateAuthor = { name: string | null; avatarUrl: string | null };

// Deterministic tint for the initials-avatar fallback (matches the post cards'
// palette so a template card sits visually alongside a real swipe-file post).
const AVATAR_TINTS = [
  "bg-state-warning-bg text-state-warning",
  "bg-state-warning-bg text-state-warning",
  "bg-state-danger-bg text-state-danger",
  "bg-state-brand-bg text-state-brand",
  "bg-state-info-bg text-state-info",
  "bg-state-success-bg text-state-success",
];
function tintFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_TINTS[Math.abs(h) % AVATAR_TINTS.length];
}
function initialsOf(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// The category filter's "All" sentinel plus the real categories, in registry
// order (namejack/brandjack included). Client-side instant filter — no reload.
type CategoryFilter = "all" | TemplateCategory;

export function TemplatesManager({
  initial,
  author,
}: {
  initial: ContentTemplate[];
  author: TemplateAuthor;
}) {
  const [custom, setCustom] = useState(initial);
  const [editing, setEditing] = useState<ContentTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ContentTemplate | null>(null);
  const [filter, setFilter] = useState<CategoryFilter>("all");

  // The full library: the user's custom templates first (newest-first, as
  // fetched), then the app's built-in starters. Built-ins are always shown so
  // the page is useful before the user has added anything.
  const rows: Row[] = useMemo(
    () => [...custom.map(customToRow), ...BUILTIN_TEMPLATES.map(builtinToRow)],
    [custom],
  );

  // The visible rows after the client-side category filter. "all" shows every
  // template; otherwise match the row's category exactly.
  const visibleRows = useMemo(
    () => (filter === "all" ? rows : rows.filter((r) => r.category === filter)),
    [rows, filter],
  );

  // Only show a category pill when the library actually has a template in it —
  // an empty category is noise. Count per category from the current library.
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (r.category) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
    }
    return counts;
  }, [rows]);

  const remove = async (id: string) => {
    const removed = byId(custom, id);
    setCustom((s) => removeById(s, id));
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/content-templates/${id}`,
        { method: "DELETE" },
      );
      if (!data?.ok) throw new Error(data?.error || "Failed to delete");
      toast.success("Template deleted");
    } catch (e) {
      setCustom((cur) => reinsertById(cur, removed));
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <Toolbar className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Template library</div>
          <div className="text-xs text-muted-foreground">
            {custom.length > 0
              ? `${custom.length} custom, ${BUILTIN_TEMPLATES.length} built-in`
              : `${BUILTIN_TEMPLATES.length} built-in templates to get you started`}
          </div>
        </div>
        <Button className="w-full sm:w-auto" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New template
        </Button>
      </Toolbar>

      {/* Category filter — the SAME rail chrome as the bookmarks / swipe-file
          filter (card wrapper, "Category" label, pills, right-side active
          summary) for a consistent look across the app. Client-side instant
          filter (no reload); only categories present in the library get a pill,
          so it never shows an empty bucket. */}
      <Toolbar className="overflow-hidden">
        <div className="px-4 py-3 sm:px-5">
          <div className="flex items-center gap-3">
            <div className="text-xs font-medium text-muted-foreground shrink-0 hidden sm:block">
              Category
            </div>
            <HorizontalCategoryRail>
                <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
                  All <span className="ml-1 text-[10px] opacity-60">{rows.length}</span>
                </FilterChip>
                {TEMPLATE_CATEGORIES.filter((c) => categoryCounts.has(c)).map((c) => (
                  <FilterChip key={c} active={filter === c} onClick={() => setFilter(c)}>
                    {TEMPLATE_CATEGORY_LABELS[c]}
                    <span className="ml-1 text-[10px] opacity-60">{categoryCounts.get(c)}</span>
                  </FilterChip>
                ))}
            </HorizontalCategoryRail>
            <div className="hidden md:flex items-center text-[11px] text-muted-foreground shrink-0 pl-2 border-l border-border/60">
              <span className="font-medium text-foreground">
                {filter === "all" ? "All templates" : TEMPLATE_CATEGORY_LABELS[filter]}
              </span>
            </div>
          </div>
        </div>
      </Toolbar>

      {/* 3-column responsive grid, same shape as the swipe file / bookmarks. */}
      {visibleRows.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {visibleRows.map((row) => (
            <TemplateCard
              key={row.id}
              row={row}
              author={author}
              onEdit={() => {
                const t = custom.find((c) => c.id === row.id);
                if (t) setEditing(t);
              }}
              onDelete={() => {
                const t = custom.find((c) => c.id === row.id);
                if (t) setConfirmDelete(t);
              }}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<FileText className="h-6 w-6" />}
          title="No templates in this category"
          description={`Switch categories or add a ${templateCategoryLabel(filter === "all" ? null : filter).toLowerCase()} template for Cowork to fill.`}
          action={
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" /> New template
            </Button>
          }
        />
      )}

      {/* Create */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto">
          <TemplateForm
            onSaved={(t) => {
              setCustom((cur) => [t, ...cur]);
              setCreating(false);
            }}
          />
        </DialogContent>
      </Dialog>

      {/* Edit */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto">
          {editing && (
            <TemplateForm
              template={editing}
              onSaved={(t) => {
                setCustom((cur) => cur.map((x) => (x.id === t.id ? t : x)));
                setEditing(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={confirmDelete ? `Delete "${confirmDelete.title}"?` : "Delete template?"}
        description="This removes the template for the whole workspace."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (confirmDelete) await remove(confirmDelete.id);
          setConfirmDelete(null);
        }}
      />
    </div>
  );
}

function TemplateCard({
  row,
  author,
  onEdit,
  onDelete,
}: {
  row: Row;
  author: TemplateAuthor;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const router = useRouter();
  const [copied, markCopied] = useCopiedFlag();
  const [modeling, setModeling] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Only show "See more/less" when the clamped body actually overflows —
  // a dead toggle on short templates reads as broken chrome.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 2);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [row.body]);
  const placeholders = useMemo(() => extractPlaceholders(row.body), [row.body]);

  // Author identity for the LinkedIn-style header. Falls back to a neutral "You"
  // + initials avatar before a voice profile exists; the real pic swaps in once
  // it does.
  const authorName = author.name?.trim() || "You";
  const categoryLabel = row.category ? templateCategoryLabel(row.category) : null;

  async function copy() {
    const ok = await copyToClipboard(row.body, "Template copied");
    if (!ok) return;
    markCopied();
  }

  // Take this template into the chat: stash its body server-side (resolved by
  // id — a built-in slug or a custom row) via /api/model-source, then open the
  // chat at ?model=<id> with the "fill the template" prompt prefilled. Same
  // mechanism as the swipe-file / Posts "Model in Chat".
  async function modelInChat() {
    if (modeling) return;
    setModeling(true);
    try {
      const res = await fetch("/api/model-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "template", postId: row.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Couldn't open this template in chat");
      router.push(
        `/dashboard?model=${encodeURIComponent(data.id)}&intent=${POST_INTENTS.fill_template.key}&handoff=${encodeURIComponent(data.id)}`,
      );
      // Navigating away; leave busy set to avoid an idle-button flash.
    } catch (e) {
      toast.error((e as Error).message);
      setModeling(false);
    }
  }

  return (
    <Card className="overflow-hidden flex flex-col border-border/70 bg-card/90 shadow-soft transition-[border-color,box-shadow] duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none hover:border-primary/18 hover:shadow-soft-lg">
      {/* LinkedIn-style author header: the user's pic + name, then a "Template ·
          {category}" subline (where a real post shows niche · time). */}
      <CardContent className="p-4 flex flex-col gap-3 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <AvatarImg
              src={author.avatarUrl}
              alt={authorName}
              className="h-10 w-10 rounded-full object-cover shrink-0 bg-muted"
              fallback={
                <div
                  className={cn(
                    "h-10 w-10 rounded-full grid place-items-center text-xs font-semibold shrink-0",
                    tintFor(authorName),
                  )}
                >
                  {initialsOf(authorName) || "?"}
                </div>
              }
            />
            <div className="min-w-0">
              <span className="text-sm font-semibold truncate leading-tight block">
                {authorName}
              </span>
              {(categoryLabel || row.builtin) && (
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {categoryLabel && (
                    <StatusPill tone="info" className="h-5 px-2 text-[10px]">
                      {categoryLabel}
                    </StatusPill>
                  )}
                  {row.builtin && (
                    <StatusPill tone="neutral" className="h-5 px-2 text-[10px]">
                      <Lock className="h-2.5 w-2.5" /> Built-in
                    </StatusPill>
                  )}
                </div>
              )}
            </div>
          </div>
          {placeholders.length > 0 && (
            <StatusPill
              tone="warning"
              className="h-5 px-2 text-[10px]"
              title={`${placeholders.length} fill-in-the-blank spot${placeholders.length === 1 ? "" : "s"}`}
            >
              {placeholders.length} blank{placeholders.length === 1 ? "" : "s"}
            </StatusPill>
          )}
        </div>

        {/* Title as the post's lead line, then the body with {placeholders}
            highlighted. Clamped to keep the grid tidy; "See more" expands it in
            place (like the LinkedIn "…see more" affordance). */}
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground mb-1">{row.title}</p>
          <div
            ref={bodyRef}
            className={cn(
              "text-sm whitespace-pre-wrap break-words text-foreground/90 leading-relaxed",
              !expanded && "line-clamp-[10]",
            )}
          >
            <HighlightedBody body={row.body} />
          </div>
          {(overflows || expanded) && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {expanded ? "See less" : "See more"}
            </button>
          )}
        </div>

        {/* Footer actions, pinned to the bottom so cards in a row align. */}
        <div className="mt-auto flex items-center gap-1.5 pt-3 flex-wrap border-t border-border/50">
          <Button
            size="sm"
            className="gap-1.5"
            onClick={modelInChat}
            disabled={modeling}
            title="Fill this template in your voice in the chat"
          >
            {modeling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <MessageSquare className="h-3.5 w-3.5" />
            )}
            {modeling ? "Opening…" : "Model with Cowork"}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5 text-state-success" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
          {!row.builtin && (
            <>
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={onEdit}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-destructive"
                onClick={onDelete}
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Category filter pill — client-side (onClick), mirroring the swipe-file /
// bookmarks FilterChip look (rounded, active = inverted).
function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        segmentedItemClass(active),
      )}
    >
      {children}
    </button>
  );
}

// Render a template body with {placeholder} tokens visually highlighted. Uses
// the SHARED split/predicate from lib/templates so what's highlighted is exactly
// what extractPlaceholders counts. Pure presentation.
function HighlightedBody({ body }: { body: string }) {
  const parts = splitOnPlaceholders(body);
  return (
    <>
      {parts.map((part, i) =>
        isPlaceholderToken(part) ? (
          <span
            key={i}
            className="rounded bg-primary/10 text-primary px-1 py-0.5 text-[13px] font-medium"
          >
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function TemplateForm({
  template,
  onSaved,
}: {
  template?: ContentTemplate;
  onSaved: (t: ContentTemplate) => void;
}) {
  const [title, setTitle] = useState(template?.title ?? "");
  const [category, setCategory] = useState<TemplateCategory>(
    (template?.category as TemplateCategory) ?? "other",
  );
  const [body, setBody] = useState(template?.body ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    if (!title.trim()) return toast.error("Give the template a title.");
    if (!body.trim()) return toast.error("The template needs a body.");
    setBusy(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string; template?: ContentTemplate }>(
        template ? `/api/content-templates/${template.id}` : "/api/content-templates",
        {
          method: template ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, category, body }),
        },
      );
      if (!data?.ok || !data.template) throw new Error(data?.error || "Failed to save");
      toast.success(template ? "Template updated" : "Template created");
      onSaved(data.template);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{template ? "Edit template" : "New template"}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="tpl-title">Title</Label>
          <Input
            id="tpl-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Contrarian take"
            maxLength={TEMPLATE_TITLE_MAX}
            className="truncate"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tpl-category">Category</Label>
          <Select value={category} onValueChange={(v) => setCategory(v as TemplateCategory)}>
            <SelectTrigger id="tpl-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TEMPLATE_CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {TEMPLATE_CATEGORY_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tpl-body">Template</Label>
          <Textarea
            id="tpl-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={
              "Everyone tells you to {common advice}.\n\nHere's what it actually got me: {result}.\n\nWhat works instead: {your alternative}."
            }
            rows={12}
            maxLength={TEMPLATE_BODY_MAX}
            className="resize-none overflow-y-scroll break-words [field-sizing:fixed] max-h-[28rem]"
          />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground leading-snug">
              Use {"{curly braces}"} for fill-in-the-blank spots, e.g.{" "}
              <code>{"{industry}"}</code>.
            </p>
            <p className="text-xs text-right shrink-0 tabular-nums text-muted-foreground">
              {body.length.toLocaleString()}/{TEMPLATE_BODY_MAX.toLocaleString()}
            </p>
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button onClick={save} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {template ? "Save changes" : "Create template"}
        </Button>
      </DialogFooter>
    </>
  );
}

// Re-export for the page to reference the built-in count without importing the
// registry directly (keeps the page a thin server component).
export const BUILTIN_TEMPLATE_COUNT = BUILTIN_TEMPLATES.length;
