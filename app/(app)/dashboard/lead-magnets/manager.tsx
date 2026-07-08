"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  BookOpen,
  Bot,
  ChevronLeft,
  ChevronRight,
  Check,
  Copy,
  ExternalLink,
  FilePlus,
  Globe,
  Heading1,
  ImageIcon,
  LinkIcon,
  List,
  ListOrdered,
  Loader2,
  Pencil,
  Plus,
  Quote,
  ScrollText,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { MarkdownDocument } from "@/components/markdown-document";
import {
  EmptyState,
  StatusPill,
  Surface,
  Toolbar,
  segmentedControlClass,
  segmentedItemClass,
} from "@/components/app-surface";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { fetchJson } from "@/lib/api-fetch";
import { copyToClipboard } from "@/lib/clipboard";
import { removeById, reinsertById, byId } from "@/lib/optimistic";
import { cn } from "@/lib/utils";
import {
  LEAD_MAGNET_BODY_MAX,
  LEAD_MAGNET_TITLE_MAX,
  type LeadMagnet,
} from "@/lib/lead-magnets";
import { splitLeadMagnetCreatorImage } from "@/lib/lead-magnet-generation";

type Mode = "manual" | "import" | "ai";
type EditorMode = "edit" | "preview";

const LEAD_MAGNET_GENERATION_STEPS = [
  "Reading your prompt and CTA settings",
  "Structuring the resource",
  "Writing the markdown document",
  "Extracting deliverables for future posts",
  "Saving the public link",
];
const LEAD_MAGNETS_PAGE_SIZE = 10;

export function LeadMagnetsManager({
  initial,
  aiUsed,
  aiLimit,
}: {
  initial: LeadMagnet[];
  aiUsed: number;
  aiLimit: number;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [creating, setCreating] = useState<Mode | null>(null);
  const [editing, setEditing] = useState<LeadMagnet | null>(null);
  const [previewing, setPreviewing] = useState<LeadMagnet | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<LeadMagnet | null>(null);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(() => new Set());
  const [used, setUsed] = useState(aiUsed);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const sorted = useMemo(
    () => [...items].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
    [items],
  );
  const searchIndex = useMemo(() => {
    return new Map(
      sorted.map((item) => {
        const searchable = [
          item.title,
          item.source_url ?? "",
          item.metadata.selection_summary ?? "",
          item.metadata.summary ?? "",
          ...(item.metadata.deliverables ?? []),
          ...(item.metadata.ctas ?? []).flatMap((cta) => [cta.label, cta.url]),
          item.markdown_body,
        ]
          .join(" ")
          .toLowerCase();
        return [item.id, searchable] as const;
      }),
    );
  }, [sorted]);
  const filtered = useMemo(() => {
    const query = deferredSearchQuery.trim().toLowerCase();
    if (!query) return sorted;
    return sorted.filter((item) => searchIndex.get(item.id)?.includes(query));
  }, [deferredSearchQuery, searchIndex, sorted]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / LEAD_MAGNETS_PAGE_SIZE));
  const activePage = Math.min(page, pageCount);
  const pageItems = filtered.slice((activePage - 1) * LEAD_MAGNETS_PAGE_SIZE, activePage * LEAD_MAGNETS_PAGE_SIZE);
  const pageStart = filtered.length ? (activePage - 1) * LEAD_MAGNETS_PAGE_SIZE + 1 : 0;
  const pageEnd = Math.min(activePage * LEAD_MAGNETS_PAGE_SIZE, filtered.length);

  const remove = async (id: string) => {
    if (pendingDeleteIds.has(id)) return;
    const removed = byId(items, id);
    setPendingDeleteIds((cur) => new Set(cur).add(id));
    setItems((cur) => removeById(cur, id));
    setEditing((cur) => (cur?.id === id ? null : cur));
    setPreviewing((cur) => (cur?.id === id ? null : cur));
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(`/api/lead-magnets/${id}`, {
        method: "DELETE",
      });
      if (!data.ok) throw new Error(data.error || "Failed to delete lead magnet");
      toast.success("Lead magnet deleted");
    } catch (e) {
      setItems((cur) => reinsertById(cur, removed));
      toast.error((e as Error).message);
    } finally {
      setPendingDeleteIds((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="space-y-4">
      <Toolbar className="flex flex-col gap-4 p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">Resource library</div>
            <div className="text-xs text-muted-foreground">
              {items.length} lead magnet{items.length === 1 ? "" : "s"} · {used} of {aiLimit} AI-created this month
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => setCreating("import")}>
              <LinkIcon className="h-4 w-4" /> Import link
            </Button>
            <Button
              variant="outline"
              onClick={() => setCreating("ai")}
              disabled={used >= aiLimit}
              title={used >= aiLimit ? `You've used all ${aiLimit} AI lead magnets this month.` : undefined}
            >
              <Sparkles className="h-4 w-4" /> Create with AI
            </Button>
            <Button onClick={() => setCreating("manual")}>
              <Plus className="h-4 w-4" /> New blank
            </Button>
          </div>
        </div>
        {items.length > 0 && (
          <div className="relative max-w-xl">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setPage(1);
              }}
              placeholder="Search lead magnets..."
              className="h-11 rounded-2xl pl-9"
            />
          </div>
        )}
      </Toolbar>

      {items.length ? (
        filtered.length ? (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {pageItems.map((item) => (
                <LeadMagnetCard
                  key={item.id}
                  item={item}
                  onOpen={() => setPreviewing(item)}
                  onEdit={() => setEditing(item)}
                  onDelete={() => setConfirmDelete(item)}
                  isDeleting={pendingDeleteIds.has(item.id)}
                />
              ))}
            </div>
            <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-background/80 px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <div>
                Showing {pageStart}-{pageEnd} of {filtered.length}
                {searchQuery.trim() ? ` matching ${filtered.length === 1 ? "resource" : "resources"}` : " resources"}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((current) => Math.max(1, Math.min(current, activePage) - 1))}
                  disabled={activePage <= 1}
                >
                  <ChevronLeft className="h-4 w-4" /> Previous
                </Button>
                <span className="min-w-16 text-center text-xs font-medium text-foreground">
                  {activePage} / {pageCount}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((current) => Math.min(pageCount, Math.max(current, activePage) + 1))}
                  disabled={activePage >= pageCount}
                >
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState
            icon={<Search className="h-6 w-6" />}
            title="No matching lead magnets"
            description={`No resources match "${searchQuery.trim()}".`}
            action={
              <Button variant="outline" onClick={() => setSearchQuery("")}>
                Clear search
              </Button>
            }
          />
        )
      ) : (
        <EmptyState
          icon={<BookOpen className="h-6 w-6" />}
          title="Create or import your first resource"
          description="Add one useful markdown resource so Cowork can reference it when writing lead-magnet posts."
          action={
            <Button onClick={() => setCreating("manual")}>
              <Plus className="h-4 w-4" /> Create resource
            </Button>
          }
        />
      )}

      <Dialog open={creating !== null} onOpenChange={(open) => !open && setCreating(null)}>
        <DialogContent className="max-h-[calc(100vh-2rem)] w-[min(1180px,calc(100vw-2rem))] overflow-y-auto sm:max-w-none">
          {creating === "manual" && (
            <LeadMagnetForm
              onSaved={(item) => {
                setItems((cur) => [item, ...cur]);
                setCreating(null);
                router.refresh();
              }}
            />
          )}
          {creating === "import" && (
            <ImportForm
              onSaved={(item) => {
                setItems((cur) => [item, ...cur]);
                setCreating(null);
                router.refresh();
              }}
            />
          )}
          {creating === "ai" && (
            <GenerateForm
              used={used}
              limit={aiLimit}
              onSaved={(item, nextUsed) => {
                setItems((cur) => [item, ...cur]);
                setUsed(nextUsed);
                setCreating(null);
                router.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-h-[calc(100vh-2rem)] w-[min(1180px,calc(100vw-2rem))] overflow-y-auto sm:max-w-none">
          {editing && (
            <LeadMagnetForm
              item={editing}
              onSaved={(item) => {
                setItems((cur) => cur.map((x) => (x.id === item.id ? item : x)));
                setEditing(null);
                router.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!previewing} onOpenChange={(open) => !open && setPreviewing(null)}>
        <DialogContent className="max-h-[92vh] w-[min(1120px,calc(100vw-2rem))] overflow-hidden p-0 sm:max-w-none">
          {previewing && <LeadMagnetPreview item={previewing} />}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        title="Delete this lead magnet?"
        description="The public link will stop working immediately."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => {
          if (confirmDelete) void remove(confirmDelete.id);
          setConfirmDelete(null);
        }}
      />
    </div>
  );
}

function LeadMagnetCard({
  item,
  onOpen,
  onEdit,
  onDelete,
  isDeleting,
}: {
  item: LeadMagnet;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const publicUrl = publicLeadMagnetUrl(item.public_slug);
  const deliverables = item.metadata.deliverables ?? [];
  const ctas = leadMagnetCtas(item);
  const summary = item.metadata.selection_summary || item.metadata.summary || item.markdown_body.slice(0, 220);
  return (
    <Surface padding="md" className="group flex min-h-[340px] flex-col gap-4 transition-colors hover:border-primary/25">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={item.source_type === "ai" ? "primary" : item.source_type === "url" ? "success" : "neutral"}>
              {sourceLabel(item.source_type)}
            </StatusPill>
            {item.is_public && <Badge variant="outline">Public link</Badge>}
          </div>
          <button
            className="block text-left text-xl font-semibold leading-snug tracking-tight text-foreground"
            onClick={onOpen}
          >
            {item.title}
          </button>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          title="Delete lead magnet"
          disabled={isDeleting}
          className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
        >
          {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </Button>
      </div>

      <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">{summary}</p>

      <div className="space-y-2 rounded-2xl border border-border/60 bg-muted/15 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs font-medium text-muted-foreground">Deliverables</div>
          {deliverables.length > 3 && <div className="text-xs text-muted-foreground">+{deliverables.length - 3} more</div>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {deliverables.length ? (
            deliverables.slice(0, 3).map((deliverable) => (
              <span key={deliverable} className="max-w-full rounded-full bg-background px-2.5 py-1 text-xs text-foreground shadow-sm">
                {deliverable}
              </span>
            ))
          ) : (
            <span className="text-sm text-muted-foreground">No deliverables extracted yet.</span>
          )}
        </div>
      </div>

      {ctas.length > 0 && (
        <div className="rounded-2xl border border-border/60 px-3 py-2.5 text-sm">
          <div className="text-xs font-medium text-muted-foreground">
            {ctas.length === 1 ? "Resource page CTA" : "Resource page CTAs"}
          </div>
          <div className="mt-1 space-y-1 text-foreground">
            {ctas.slice(0, 2).map((cta) => (
              <div key={cta.url} className="truncate">
                {cta.label}
              </div>
            ))}
            {ctas.length > 2 && <div className="text-xs text-muted-foreground">+{ctas.length - 2} more</div>}
          </div>
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
        <Button variant="default" size="sm" onClick={() => window.open(publicUrl, "_blank", "noreferrer")}>
          <ExternalLink className="h-4 w-4" /> Open resource
        </Button>
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil className="h-4 w-4" /> Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            await copyToClipboard(publicUrl);
            setCopied(true);
            toast.success("Public link copied");
            window.setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} Copy link
        </Button>
      </div>
    </Surface>
  );
}

function LeadMagnetForm({
  item,
  onSaved,
}: {
  item?: LeadMagnet;
  onSaved: (item: LeadMagnet) => void;
}) {
  const [title, setTitle] = useState(item?.title ?? "");
  const [markdown, setMarkdown] = useState(item?.markdown_body ?? "");
  const [ctaUrl, setCtaUrl] = useState(item?.metadata.cta_url ?? "");
  const [ctaLabel, setCtaLabel] = useState(item?.metadata.cta_label ?? "Book a call");
  const [saving, setSaving] = useState(false);
  const isEdit = Boolean(item);
  const save = async () => {
    const trimmedCtaUrl = ctaUrl.trim();
    const trimmedCtaLabel = ctaLabel.trim() || "Open link";
    setSaving(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string; leadMagnet: LeadMagnet }>(
        item ? `/api/lead-magnets/${item.id}` : "/api/lead-magnets",
        {
          method: item ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            markdown_body: markdown,
            source_url: item?.source_url ?? null,
            is_public: true,
            metadata: {
              ...(item?.metadata ?? {}),
              cta_url: trimmedCtaUrl,
              cta_label: trimmedCtaUrl ? trimmedCtaLabel : "",
              ctas: trimmedCtaUrl
                ? [{ url: trimmedCtaUrl, label: trimmedCtaLabel }]
                : [],
            },
          }),
        },
      );
      if (!data.ok) throw new Error(data.error || "Failed to save lead magnet");
      toast.success(isEdit ? "Lead magnet updated" : "Lead magnet created");
      onSaved(data.leadMagnet);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEdit ? "Edit lead magnet" : "New blank lead magnet"}</DialogTitle>
      </DialogHeader>
      <div className="grid gap-4 py-2">
        <div className="grid gap-2">
          <Label htmlFor="lead-title">Title</Label>
          <Input
            id="lead-title"
            value={title}
            maxLength={LEAD_MAGNET_TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Example: LinkedIn Content Audit Checklist"
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_180px]">
          <div className="grid gap-2">
            <Label htmlFor="lead-cta-url">CTA link</Label>
            <Input
              id="lead-cta-url"
              value={ctaUrl}
              onChange={(e) => setCtaUrl(e.target.value)}
              placeholder="https://calendly.com/you/strategy-call"
            />
            <p className="text-xs leading-5 text-muted-foreground">
              Used only on the public resource page, not in generated lead magnet post copy.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="lead-cta-label">CTA label</Label>
            <Input
              id="lead-cta-label"
              value={ctaLabel}
              onChange={(e) => setCtaLabel(e.target.value)}
              placeholder="Book a call"
            />
          </div>
        </div>
        <LeadMagnetMarkdownEditor value={markdown} onChange={setMarkdown} />
      </div>
      <DialogFooter>
        <Button onClick={save} disabled={saving || !title.trim() || !markdown.trim()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FilePlus className="h-4 w-4" />}
          {isEdit ? "Save changes" : "Create lead magnet"}
        </Button>
      </DialogFooter>
    </>
  );
}

type SelectionFormat = "heading" | "bullets" | "numbers" | "callout";

function stripMarkdownLinePrefix(line: string) {
  return line
    .replace(/^(\s*)#{1,6}\s+/, "$1")
    .replace(/^(\s*)[-*+]\s+/, "$1")
    .replace(/^(\s*)\d+[.)]\s+/, "$1")
    .replace(/^(\s*)>\s?/, "$1");
}

function removeMarkdownLinePrefix(line: string, format: SelectionFormat) {
  if (format === "heading") return line.replace(/^(\s*)#{1,6}\s+/, "$1");
  if (format === "bullets") return line.replace(/^(\s*)[-*+]\s+/, "$1");
  if (format === "numbers") return line.replace(/^(\s*)\d+[.)]\s+/, "$1");
  return line.replace(/^(\s*)>\s?/, "$1");
}

function lineHasFormat(line: string, format: SelectionFormat) {
  if (!line.trim()) return true;
  if (format === "heading") return /^\s*#{1,6}\s+/.test(line);
  if (format === "bullets") return /^\s*[-*+]\s+/.test(line);
  if (format === "numbers") return /^\s*\d+[.)]\s+/.test(line);
  return /^\s*>\s?/.test(line);
}

function formatSelectedLines(selected: string, format: SelectionFormat) {
  const lines = selected.split(/\r?\n/);
  const hasContent = lines.some((line) => line.trim());
  const isAlreadyFormatted = hasContent && lines.every((line) => lineHasFormat(line, format));

  if (isAlreadyFormatted) {
    return lines.map((line) => removeMarkdownLinePrefix(line, format)).join("\n");
  }

  let number = 1;
  return lines
    .map((line) => {
      if (!line.trim()) {
        return format === "callout" ? ">" : line;
      }
      const stripped = stripMarkdownLinePrefix(line);
      const leadingWhitespace = stripped.match(/^\s*/)?.[0] ?? "";
      const text = stripped.trimStart();

      if (format === "heading") return `${leadingWhitespace}## ${text}`;
      if (format === "bullets") return `${leadingWhitespace}- ${text}`;
      if (format === "numbers") return `${leadingWhitespace}${number++}. ${text}`;
      return `${leadingWhitespace}> ${text}`;
    })
    .join("\n");
}

function LeadMagnetMarkdownEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [mode, setMode] = useState<EditorMode>("edit");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const undoStackRef = useRef<Array<{ value: string; start: number; end: number }>>([]);

  const pushUndoState = (start: number, end: number) => {
    undoStackRef.current.push({ value, start, end });
    if (undoStackRef.current.length > 50) {
      undoStackRef.current.shift();
    }
  };

  const restoreSelection = (start: number, end: number) => {
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(start, end);
    });
  };

  const undoLastToolbarEdit = () => {
    const previous = undoStackRef.current.pop();
    if (!previous) return false;
    onChange(previous.value);
    restoreSelection(previous.start, previous.end);
    return true;
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
      if (undoLastToolbarEdit()) {
        event.preventDefault();
      }
    }
  };

  const handleManualChange = (next: string) => {
    undoStackRef.current = [];
    onChange(next);
  };

  const replaceRange = ({
    snippet,
    selectText,
    start,
    end,
    preserveSpacing = false,
  }: {
    snippet: string;
    selectText?: string;
    start: number;
    end: number;
    preserveSpacing?: boolean;
  }) => {
    const before = value.slice(0, start);
    const after = value.slice(end);
    const prefix = !preserveSpacing && before && !before.endsWith("\n") ? "\n\n" : "";
    const suffix = !preserveSpacing && after && !after.startsWith("\n") ? "\n\n" : "";
    const next = `${before}${prefix}${snippet}${suffix}${after}`.slice(0, LEAD_MAGNET_BODY_MAX);
    const insertedStart = start + prefix.length;
    const insertedEnd = Math.min(insertedStart + snippet.length, next.length);

    pushUndoState(start, end);
    onChange(next);

    if (selectText && snippet.includes(selectText)) {
      const selectStart = insertedStart + snippet.indexOf(selectText);
      restoreSelection(selectStart, Math.min(selectStart + selectText.length, next.length));
      return;
    }
    restoreSelection(insertedStart, insertedEnd);
  };

  const insertAtCursor = (snippet: string, selectText?: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      pushUndoState(value.length, value.length);
      onChange(`${value}${value ? "\n\n" : ""}${snippet}`);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    replaceRange({ snippet, selectText, start, end, preserveSpacing: end > start });
  };

  const transformSelection = ({
    fallback,
    selectText,
    transform,
  }: {
    fallback: string;
    selectText?: string;
    transform: (selected: string) => string;
  }) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      insertAtCursor(fallback, selectText);
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = value.slice(start, end);
    if (!selected.trim()) {
      replaceRange({ snippet: fallback, selectText, start, end });
      return;
    }
    replaceRange({
      snippet: transform(selected),
      start,
      end,
      preserveSpacing: true,
    });
  };

  const insertLink = () => {
    const href = window.prompt("Paste the link URL");
    if (!href) return;
    const normalizedHref = href.trim();
    if (!/^https?:\/\//i.test(normalizedHref)) {
      toast.error("Use a full http or https URL.");
      return;
    }
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end).trim();
    replaceRange({
      snippet: `[${selected || normalizedHref}](${normalizedHref})`,
      selectText: selected ? undefined : normalizedHref,
      start,
      end,
      preserveSpacing: Boolean(selected),
    });
  };
  const insertImage = () => {
    const src = window.prompt("Paste the image URL");
    if (!src) return;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end).trim();
    replaceRange({
      snippet: `![${selected || "Image description"}](${src.trim()})`,
      selectText: selected ? undefined : "Image description",
      start,
      end,
      preserveSpacing: Boolean(selected),
    });
  };

  return (
    <div className="grid gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Label htmlFor="lead-body">Resource content</Label>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Write in markdown with formatting controls, then check the public-page preview before sharing.
          </p>
        </div>
        <div className={segmentedControlClass("w-fit")}>
          {(["edit", "preview"] as const).map((nextMode) => (
            <button
              key={nextMode}
              type="button"
              onClick={() => setMode(nextMode)}
              className={cn(segmentedItemClass(mode === nextMode), "capitalize")}
            >
              {nextMode}
            </button>
          ))}
        </div>
      </div>

      {mode !== "preview" && (
        <div className="flex flex-wrap gap-1 rounded-2xl border border-border/70 bg-muted/20 p-2">
          <EditorToolButton
            label="Heading"
            onClick={() =>
              transformSelection({
                fallback: "## Section title",
                selectText: "Section title",
                transform: (selected) => formatSelectedLines(selected, "heading"),
              })
            }
          >
            <Heading1 className="h-4 w-4" />
          </EditorToolButton>
          <EditorToolButton
            label="Bullets"
            onClick={() =>
              transformSelection({
                fallback: "- First item\n- Second item",
                selectText: "First item",
                transform: (selected) => formatSelectedLines(selected, "bullets"),
              })
            }
          >
            <List className="h-4 w-4" />
          </EditorToolButton>
          <EditorToolButton
            label="Numbers"
            onClick={() =>
              transformSelection({
                fallback: "1. First step\n2. Second step",
                selectText: "First step",
                transform: (selected) => formatSelectedLines(selected, "numbers"),
              })
            }
          >
            <ListOrdered className="h-4 w-4" />
          </EditorToolButton>
          <EditorToolButton
            label="Callout"
            onClick={() =>
              transformSelection({
                fallback: "> **Note**\n>\n> Add the important takeaway here.",
                selectText: "Add the important takeaway here.",
                transform: (selected) => formatSelectedLines(selected, "callout"),
              })
            }
          >
            <Quote className="h-4 w-4" />
          </EditorToolButton>
          <EditorToolButton label="Link" onClick={insertLink}>
            <LinkIcon className="h-4 w-4" />
          </EditorToolButton>
          <EditorToolButton label="Image" onClick={insertImage}>
            <ImageIcon className="h-4 w-4" />
          </EditorToolButton>
        </div>
      )}

      {mode === "preview" ? (
        <div className="min-h-[520px] overflow-y-auto rounded-2xl border border-border/70 bg-white px-5 py-6 sm:px-8">
          {value.trim() ? (
            <MarkdownDocument markdown={value} />
          ) : (
            <div className="flex min-h-[420px] items-center justify-center text-sm text-muted-foreground">
              Start writing to preview the public resource.
            </div>
          )}
        </div>
      ) : mode === "edit" ? (
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.75fr)]">
          <Textarea
            ref={textareaRef}
            id="lead-body"
            value={value}
            maxLength={LEAD_MAGNET_BODY_MAX}
            onChange={(e) => handleManualChange(e.target.value)}
            onKeyDown={handleEditorKeyDown}
            placeholder={"# Resource title\n\nUse headings, lists, examples, scripts, and checklists."}
            className="min-h-[620px] resize-y font-mono text-sm leading-6"
          />
          <div className="hidden min-h-[620px] overflow-y-auto rounded-2xl border border-border/70 bg-white px-5 py-6 xl:block">
            <div className="mb-4 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Live preview
            </div>
            {value.trim() ? (
              <MarkdownDocument markdown={value} />
            ) : (
              <div className="flex min-h-[360px] items-center justify-center text-sm text-muted-foreground">
                Your formatted resource preview appears here.
              </div>
            )}
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>Stored as markdown so imports, AI generation, and public links keep working.</span>
        <span className="shrink-0 tabular-nums">
          {value.length.toLocaleString()} / {LEAD_MAGNET_BODY_MAX.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

function EditorToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border/60 bg-background px-3 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-accent"
    >
      {children}
      {label}
    </button>
  );
}

function ImportForm({ onSaved }: { onSaved: (item: LeadMagnet) => void }) {
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string; leadMagnet: LeadMagnet }>(
        "/api/lead-magnets/import",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        },
      );
      if (!data.ok) throw new Error(data.error || "Failed to import lead magnet");
      toast.success("Lead magnet imported");
      onSaved(data.leadMagnet);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Import a public resource</DialogTitle>
      </DialogHeader>
      <div className="grid gap-4 py-2">
        <div className="rounded-xl border border-border/60 bg-muted/35 p-4 text-sm leading-6 text-muted-foreground">
          Paste a public Notion page, public Google Doc, or readable webpage. SwipeIn stores the source URL and saves a markdown snapshot.
        </div>
        <div className="grid gap-2">
          <Label htmlFor="lead-url">Public URL</Label>
          <Input
            id="lead-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://docs.google.com/document/d/..."
          />
        </div>
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={saving || !url.trim()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <LinkIcon className="h-4 w-4" />}
          Import
        </Button>
      </DialogFooter>
    </>
  );
}

function GenerateForm({
  used,
  limit,
  onSaved,
}: {
  used: number;
  limit: number;
  onSaved: (item: LeadMagnet, nextUsed: number) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [ctaLabel, setCtaLabel] = useState("Book a call");
  const [saving, setSaving] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const blocked = used >= limit;

  useEffect(() => {
    if (!saving) return;
    const interval = window.setInterval(() => {
      setActiveStep((current) => Math.min(current + 1, LEAD_MAGNET_GENERATION_STEPS.length - 1));
    }, 1800);
    return () => window.clearInterval(interval);
  }, [saving]);

  const submit = async () => {
    setActiveStep(0);
    setSaving(true);
    try {
      const data = await fetchJson<{
        ok: boolean;
        error?: string;
        leadMagnet: LeadMagnet;
        used: number;
        limit: number;
      }>("/api/lead-magnets/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, cta_url: ctaUrl, cta_label: ctaLabel }),
      });
      if (!data.ok) throw new Error(data.error || "Failed to generate lead magnet");
      toast.success("Lead magnet created");
      onSaved(data.leadMagnet, data.used);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Create with AI</DialogTitle>
      </DialogHeader>
      <div className="grid gap-4 py-2">
        <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/35 p-4 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Bot className="h-4 w-4" />
            AI lead magnets this month
          </div>
          <StatusPill tone={blocked ? "danger" : "primary"}>
            {used} / {limit}
          </StatusPill>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="lead-prompt">What should this resource help people do?</Label>
          <Textarea
            id="lead-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Create a checklist founders can use to turn customer calls into LinkedIn post ideas..."
            className="min-h-36"
          />
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_180px]">
          <div className="grid gap-2">
            <Label htmlFor="lead-ai-cta-url">CTA link</Label>
            <Input
              id="lead-ai-cta-url"
              value={ctaUrl}
              onChange={(e) => setCtaUrl(e.target.value)}
              placeholder="https://calendly.com/you/strategy-call"
            />
            <p className="text-xs leading-5 text-muted-foreground">
              Used only on the public resource page, not in generated lead magnet post copy.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="lead-ai-cta-label">CTA label</Label>
            <Input
              id="lead-ai-cta-label"
              value={ctaLabel}
              onChange={(e) => setCtaLabel(e.target.value)}
              placeholder="Book a call"
            />
          </div>
        </div>
        {saving && (
          <div className="rounded-2xl border border-primary/20 bg-primary/[0.04] p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-foreground">Building your lead magnet</div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      SwipeIn is writing the resource, parsing the summary, and creating the public page.
                    </p>
                  </div>
                  <StatusPill tone="primary">
                    {activeStep + 1} / {LEAD_MAGNET_GENERATION_STEPS.length}
                  </StatusPill>
                </div>
                <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-primary/10">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-500"
                    style={{
                      width: `${((activeStep + 1) / LEAD_MAGNET_GENERATION_STEPS.length) * 100}%`,
                    }}
                  />
                </div>
                <div className="mt-4 grid gap-2">
                  {LEAD_MAGNET_GENERATION_STEPS.map((step, index) => {
                    const complete = index < activeStep;
                    const current = index === activeStep;
                    return (
                      <div
                        key={step}
                        className={[
                          "flex items-center gap-2 text-xs transition-colors",
                          complete || current ? "text-foreground" : "text-muted-foreground",
                        ].join(" ")}
                      >
                        <span
                          className={[
                            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                            complete
                              ? "border-primary bg-primary text-primary-foreground"
                              : current
                                ? "border-primary/50 bg-background text-primary"
                                : "border-border bg-background text-muted-foreground",
                          ].join(" ")}
                        >
                          {complete ? (
                            <Check className="h-3 w-3" />
                          ) : current ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <span className="h-1.5 w-1.5 rounded-full bg-current" />
                          )}
                        </span>
                        {step}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={saving || blocked || prompt.trim().length < 8}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {saving ? "Creating resource..." : "Generate lead magnet"}
        </Button>
      </DialogFooter>
    </>
  );
}

function LeadMagnetPreview({
  item,
}: {
  item: LeadMagnet;
}) {
  const publicUrl = publicLeadMagnetUrl(item.public_slug);
  const summary = item.metadata.selection_summary || item.metadata.summary;
  const deliverables = item.metadata.deliverables ?? [];
  const ctas = leadMagnetCtas(item);
  const split = splitLeadMagnetCreatorImage(item.markdown_body, null);
  return (
    <div className="max-h-[92vh] overflow-y-auto overflow-x-hidden px-6 py-6 sm:px-8">
      <DialogHeader className="pr-10">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={item.source_type === "ai" ? "primary" : item.source_type === "url" ? "success" : "neutral"}>
            {sourceLabel(item.source_type)}
          </StatusPill>
          <Badge variant="outline">
            <Globe className="h-3 w-3" /> Public
          </Badge>
        </div>
        <DialogTitle className="max-w-full break-words text-3xl leading-tight tracking-tight sm:text-4xl">
          {item.title}
        </DialogTitle>
      </DialogHeader>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await copyToClipboard(publicUrl);
            toast.success("Public link copied");
          }}
        >
          <Copy className="h-4 w-4" /> Copy public link
        </Button>
        <Button variant="outline" size="sm" onClick={() => window.open(publicUrl, "_blank", "noreferrer")}>
          <ExternalLink className="h-4 w-4" /> Open public page
        </Button>
      </div>
      {(summary || deliverables.length > 0 || ctas.length > 0) && (
        <div className="mt-5 rounded-2xl border border-border/60 bg-muted/30 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
            <ScrollText className="h-4 w-4 text-primary" />
            Parsed resource summary
          </div>
          {summary && <p className="text-sm leading-6 text-muted-foreground">{summary}</p>}
          {deliverables.length > 0 && (
            <div className="mt-4 min-w-0 space-y-2">
              <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Deliverables
              </div>
              {deliverables.slice(0, 8).map((deliverable) => (
                <div
                  key={deliverable}
                  className="min-w-0 break-words rounded-xl border border-border/60 bg-background/75 px-3 py-2 text-sm leading-5 text-foreground"
                >
                  {deliverable}
                </div>
              ))}
            </div>
          )}
          {ctas.length > 0 && (
            <div className="mt-4 space-y-2">
              <div className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                {ctas.length === 1 ? "Resource page CTA" : "Resource page CTAs"}
              </div>
              {ctas.map((cta) => (
                <div
                  key={cta.url}
                  className="min-w-0 rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm text-muted-foreground"
                >
                  <a
                    href={cta.url}
                    target="_blank"
                    rel="noreferrer"
                    className="break-words font-medium text-primary underline underline-offset-4"
                  >
                    {cta.label}
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="mt-5 min-w-0 rounded-2xl border border-border/60 bg-white px-5 py-7 sm:px-10">
        {split.before && <MarkdownDocument markdown={split.before} className="max-w-full overflow-x-hidden" />}
        {split.imageFound && (
          <LeadMagnetPreviewAvatar
            name={split.image?.alt ?? item.title}
            src={split.image?.src ?? null}
          />
        )}
        {split.after && <MarkdownDocument markdown={split.after} className="max-w-full overflow-x-hidden" />}
      </div>
    </div>
  );
}

function LeadMagnetPreviewAvatar({ name, src }: { name: string; src: string | null }) {
  const [broken, setBroken] = useState(false);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return (
    <figure className="my-10 flex justify-center">
      {src && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element -- Lead magnet previews can reference public external profile images.
        <img
          src={src}
          alt={name}
          onError={() => setBroken(true)}
          className="h-36 w-36 rounded-full border border-border/70 object-cover shadow-md"
          loading="lazy"
        />
      ) : (
        <div
          aria-label={name}
          className="grid h-36 w-36 place-items-center rounded-full border border-border/70 bg-primary/10 text-3xl font-semibold text-primary shadow-md"
        >
          {initials || "in"}
        </div>
      )}
    </figure>
  );
}

function publicLeadMagnetUrl(slug: string): string {
  if (typeof window === "undefined") return `/lm/${slug}`;
  return `${window.location.origin}/lm/${slug}`;
}

function leadMagnetCtas(item: LeadMagnet): Array<{ url: string; label: string }> {
  if (item.metadata.ctas?.length) return item.metadata.ctas;
  if (!item.metadata.cta_url) return [];
  return [
    {
      url: item.metadata.cta_url,
      label: item.metadata.cta_label ?? "Book a call",
    },
  ];
}

function sourceLabel(source: LeadMagnet["source_type"]): string {
  if (source === "ai") return "AI-created";
  if (source === "url") return "Imported";
  return "Manual";
}
