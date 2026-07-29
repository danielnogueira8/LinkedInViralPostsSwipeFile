"use client";

import { useDeferredValue, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertCircle,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Check,
  Copy,
  ExternalLink,
  FilePlus,
  FileText,
  Globe,
  Heading1,
  ImageIcon,
  LinkIcon,
  List,
  ListOrdered,
  Loader2,
  Pencil,
  Quote,
  ScrollText,
  Search,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { MarkdownDocument } from "@/components/markdown-document";
import {
  EmptyState,
  StatusPill,
  Surface,
  Toolbar,
  segmentedControlClass,
  segmentedItemClass,
} from "@/components/app-surface";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { fetchJson } from "@/lib/api-fetch";
import { copyToClipboard } from "@/lib/clipboard";
import { useCopiedFlag } from "@/lib/use-copied-flag";
import { removeById, reinsertById, byId } from "@/lib/optimistic";
import { cn } from "@/lib/utils";
import {
  LEAD_MAGNET_BODY_MAX,
  LEAD_MAGNET_TITLE_MAX,
  leadMagnetQualityWarning,
  type LeadMagnet,
} from "@/lib/lead-magnets";
import {
  leadMagnetDisplayMarkdown,
  splitLeadMagnetCreatorImage,
} from "@/lib/lead-magnet-generation";

type Mode = "manual" | "import" | "ai";
type EditorMode = "edit" | "preview";
type AiResourceQuota = { used: number; limit: number; blocked: boolean };

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
  const [isCreatingOpen, setIsCreatingOpen] = useState(false);
  const [editing, setEditing] = useState<LeadMagnet | null>(null);
  const [previewing, setPreviewing] = useState<LeadMagnet | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<LeadMagnet | null>(null);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(() => new Set());
  const [used, setUsed] = useState(aiUsed);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const aiQuota: AiResourceQuota = { used, limit: aiLimit, blocked: used >= aiLimit };

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
    <div className="space-y-5">
      <ResourceBuilder
        quota={aiQuota}
        onCreate={(mode) => {
          setCreating(mode);
          setIsCreatingOpen(true);
        }}
      />

      <Toolbar className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <FileText className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">Your resource library</div>
            <div className="text-xs text-muted-foreground">
              {items.length} resource{items.length === 1 ? "" : "s"} ready for Cowork
            </div>
          </div>
        </div>
        {items.length > 0 && (
          <SearchField
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setPage(1);
              }}
              onClear={() => {
                setSearchQuery("");
                setPage(1);
              }}
              placeholder="Search lead magnets..."
              aria-label="Search lead magnets"
              containerClassName="w-full sm:max-w-md"
            />
        )}
      </Toolbar>

      {items.length ? (
        filtered.length ? (
          <>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
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
            <div className="flex flex-col gap-3 border-t border-border/70 px-1 pt-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <div>
                {pageCount > 1
                  ? `Showing ${pageStart}-${pageEnd} of ${filtered.length}`
                  : `${filtered.length} ${filtered.length === 1 ? "resource" : "resources"}`}
                {searchQuery.trim() ? " matching your search" : ""}
              </div>
              {pageCount > 1 && (
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
              )}
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
          title="Your resource library is empty"
          description={
            aiQuota.blocked
              ? "Import an existing resource above, or start with a blank document."
              : "Choose a starting point above. Create with AI for the fastest path, import an existing resource, or start with a blank document."
          }
        />
      )}

      <Dialog
        open={isCreatingOpen}
        onOpenChange={setIsCreatingOpen}
        onOpenChangeComplete={(open) => {
          if (!open) setCreating(null);
        }}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] w-[min(1180px,calc(100vw-2rem))] overflow-y-auto sm:max-w-none">
          {creating === "manual" && (
            <LeadMagnetForm
              onSaved={(item) => {
                setItems((cur) => [item, ...cur]);
                setIsCreatingOpen(false);
                router.refresh();
              }}
            />
          )}
          {creating === "import" && (
            <ImportForm
              onSaved={(item) => {
                setItems((cur) => [item, ...cur]);
                setIsCreatingOpen(false);
                router.refresh();
              }}
            />
          )}
          {creating === "ai" && (
            <GenerateForm
              quota={aiQuota}
              onSaved={(item, nextUsed) => {
                setItems((cur) => [item, ...cur]);
                setUsed(nextUsed);
                setIsCreatingOpen(false);
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

function ResourceBuilder({
  quota,
  onCreate,
}: {
  quota: AiResourceQuota;
  onCreate: (mode: Mode) => void;
}) {
  return (
    <Surface padding="none" className="overflow-hidden">
      <div className="flex flex-col gap-2 border-b border-border/60 px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">Build a resource</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Choose how to build it: generate from an idea, import existing work, or start blank.
          </p>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {quota.used} of {quota.limit} AI resources used this month
        </span>
      </div>

      <div className="grid divide-y divide-border/60 md:grid-cols-3 md:divide-x md:divide-y-0">
        <ResourceCommand
          icon={AiIcon}
          title="Create with AI"
          description={quota.blocked ? "Monthly AI limit reached" : "Turn an idea into a polished, shareable resource."}
          badge={quota.blocked ? "Limit reached" : "Fastest"}
          featured={!quota.blocked}
          disabled={quota.blocked}
          onClick={() => onCreate("ai")}
        />
        <ResourceCommand
          icon={LinkIcon}
          title="Import from a link"
          description="Bring in a public Notion page, Google Doc, or webpage."
          badge={quota.blocked ? "Recommended" : undefined}
          featured={quota.blocked}
          onClick={() => onCreate("import")}
        />
        <ResourceCommand
          icon={FilePlus}
          title="Start from blank"
          description="Open the markdown editor and build the resource yourself."
          onClick={() => onCreate("manual")}
        />
      </div>
    </Surface>
  );
}

function ResourceCommand({
  icon: Icon,
  title,
  description,
  badge,
  featured = false,
  disabled = false,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  badge?: string;
  featured?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group flex min-h-32 items-start gap-3 bg-card px-4 py-5 text-left text-foreground transition-colors duration-150 enabled:hover:bg-muted/40 enabled:active:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-55 motion-reduce:transition-none sm:px-5",
      )}
    >
      <span
        className={cn(
          "grid h-10 w-10 shrink-0 place-items-center rounded-xl border transition-colors duration-150 motion-reduce:transition-none",
          featured
            ? "border-primary/15 bg-primary/10 text-primary"
            : "border-border/70 bg-muted text-muted-foreground group-hover:text-foreground",
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{title}</span>
          {badge && (
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                featured
                  ? "border-primary/15 bg-background/70 text-primary"
                  : "border-border bg-background text-muted-foreground",
              )}
            >
              {badge}
            </span>
          )}
        </span>
        <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
      <ChevronRight
        className={cn(
          "mt-3 h-4 w-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none",
          featured ? "text-primary" : "text-muted-foreground",
        )}
      />
    </button>
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
  const [copied, markCopied] = useCopiedFlag(1200);
  const publicUrl = publicLeadMagnetUrl(item.public_slug);
  const deliverables = item.metadata.deliverables ?? [];
  const ctas = leadMagnetCtas(item);
  const summary = item.metadata.selection_summary || item.metadata.summary || item.markdown_body.slice(0, 220);
  return (
    <Surface padding="none" className="group flex min-h-[320px] flex-col overflow-hidden transition-colors hover:border-foreground/20">
      <div className="flex items-center justify-between gap-3 border-b border-border/55 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusPill tone={item.source_type === "ai" ? "brand" : item.source_type === "url" ? "info" : "neutral"}>
            {sourceLabel(item.source_type)}
          </StatusPill>
          {item.metadata.resource_type && (
            <StatusPill tone="neutral">
              {resourceTypeLabel(item.metadata.resource_type)}
            </StatusPill>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          title="Delete lead magnet"
          aria-label={`Delete ${item.title}`}
          disabled={isDeleting}
          className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
        >
          {isDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </Button>
      </div>

      <div className="flex flex-1 flex-col gap-4 px-4 py-4 sm:px-5">
        <div className="flex items-start gap-3">
          <Image
            src={`https://api.dicebear.com/10.x/shapes/svg?seed=${encodeURIComponent(item.id)}`}
            alt=""
            width={40}
            height={40}
            unoptimized
            className="h-10 w-10 shrink-0 rounded-xl"
          />
          <button
            className="line-clamp-3 min-w-0 text-left text-lg font-semibold leading-snug text-balance text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
            onClick={onOpen}
            title={item.title}
          >
            {item.title}
          </button>
        </div>

        <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">{summary}</p>

        {leadMagnetQualityWarning(item.metadata) && (
          <div className="flex items-start gap-1.5 rounded-md border border-state-warning-border bg-state-warning-bg px-2.5 py-1.5 text-xs text-state-warning">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{leadMagnetQualityWarning(item.metadata)}</span>
          </div>
        )}

        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">Inside this resource</div>
          {deliverables.length ? (
            <div className="space-y-1.5">
              {deliverables.slice(0, 2).map((deliverable) => (
                <div key={deliverable} className="flex min-w-0 items-start gap-2 text-xs leading-5 text-foreground/85">
                  <Check className="mt-1 h-3 w-3 shrink-0 text-state-success" />
                  <span className="line-clamp-1">{deliverable}</span>
                </div>
              ))}
              {deliverables.length > 2 && <div className="pl-5 text-xs text-muted-foreground">+{deliverables.length - 2} more deliverables</div>}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">No deliverables extracted yet.</span>
          )}
        </div>

        {ctas.length > 0 && (
          <div className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">Public CTA: <span className="text-foreground">{ctas[0].label}</span></span>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-muted/15 px-4 py-3 sm:px-5">
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
            if (await copyToClipboard(publicUrl, "Public link copied")) markCopied();
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
        <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[2fr_1fr]">
          <div className="grid content-start gap-1.5">
            <Label htmlFor="lead-cta-url">CTA link</Label>
            <Input
              id="lead-cta-url"
              value={ctaUrl}
              onChange={(e) => setCtaUrl(e.target.value)}
              placeholder="https://calendly.com/you/strategy-call"
            />
          </div>
          <div className="grid content-start gap-1.5">
            <Label htmlFor="lead-cta-label">CTA label</Label>
            <Input
              id="lead-cta-label"
              value={ctaLabel}
              onChange={(e) => setCtaLabel(e.target.value)}
              placeholder="Book a call"
            />
          </div>
          <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
            Used only on the public resource page, not in generated lead magnet post copy.
          </p>
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
  const [urlDialog, setUrlDialog] = useState<null | "link" | "image">(null);
  const [urlValue, setUrlValue] = useState("");
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

  const openUrlDialog = (kind: "link" | "image") => {
    setUrlValue("");
    setUrlDialog(kind);
  };
  const confirmUrlDialog = () => {
    const url = urlValue.trim();
    if (!url || !urlDialog) return;
    if (urlDialog === "link" && !/^https?:\/\//i.test(url)) {
      toast.error("Use a full http or https URL.");
      return;
    }
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end).trim();
    if (urlDialog === "link") {
      replaceRange({
        snippet: `[${selected || url}](${url})`,
        selectText: selected ? undefined : url,
        start,
        end,
        preserveSpacing: Boolean(selected),
      });
    } else {
      replaceRange({
        snippet: `![${selected || "Image description"}](${url})`,
        selectText: selected ? undefined : "Image description",
        start,
        end,
        preserveSpacing: Boolean(selected),
      });
    }
    setUrlDialog(null);
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
              aria-pressed={mode === nextMode}
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
          <EditorToolButton label="Link" onClick={() => openUrlDialog("link")}>
            <LinkIcon className="h-4 w-4" />
          </EditorToolButton>
          <EditorToolButton label="Image" onClick={() => openUrlDialog("image")}>
            <ImageIcon className="h-4 w-4" />
          </EditorToolButton>
        </div>
      )}

      {mode !== "preview" && urlDialog && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/70 bg-muted/20 p-2">
          <Input
            autoFocus
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                confirmUrlDialog();
              }
              if (e.key === "Escape") setUrlDialog(null);
            }}
            placeholder={
              urlDialog === "link"
                ? "https://example.com/resource"
                : "https://example.com/image.png"
            }
            aria-label={urlDialog === "link" ? "Link URL" : "Image URL"}
            className="h-9 min-w-56 flex-1"
          />
          <Button size="sm" onClick={confirmUrlDialog} disabled={!urlValue.trim()}>
            Insert
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setUrlDialog(null)}>
            Cancel
          </Button>
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
      ) : (
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
      )}

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
  quota,
  onSaved,
}: {
  quota: AiResourceQuota;
  onSaved: (item: LeadMagnet, nextUsed: number) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [ctaLabel, setCtaLabel] = useState("Book a call");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
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
            <AiIcon className="h-4 w-4" />
            AI lead magnets this month
          </div>
          <StatusPill tone={quota.blocked ? "danger" : "brand"}>
            {quota.used} / {quota.limit}
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
        <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[2fr_1fr]">
          <div className="grid content-start gap-1.5">
            <Label htmlFor="lead-ai-cta-url">CTA link</Label>
            <Input
              id="lead-ai-cta-url"
              value={ctaUrl}
              onChange={(e) => setCtaUrl(e.target.value)}
              placeholder="https://calendly.com/you/strategy-call"
            />
          </div>
          <div className="grid content-start gap-1.5">
            <Label htmlFor="lead-ai-cta-label">CTA label</Label>
            <Input
              id="lead-ai-cta-label"
              value={ctaLabel}
              onChange={(e) => setCtaLabel(e.target.value)}
              placeholder="Book a call"
            />
          </div>
          <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
            Used only on the public resource page, not in generated lead magnet post copy.
          </p>
        </div>
        {saving && (
          <div className="rounded-2xl border border-primary/20 bg-primary/[0.04] p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <AiIcon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-foreground">Building your lead magnet</div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      SwipeIn is writing the resource, parsing the summary, and creating the public page.
                    </p>
                  </div>
                  <StatusPill tone="info">Working…</StatusPill>
                </div>
                {/* No fake progress: generation is a single request, so we show
                    the steps as information about what happens — not as a
                    timer-driven progress bar that lies about real progress. */}
                <div className="mt-4 grid gap-2" aria-live="polite">
                  {LEAD_MAGNET_GENERATION_STEPS.map((step) => (
                    <div
                      key={step}
                      className="flex items-center gap-2 text-xs text-muted-foreground"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-background">
                        <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      </span>
                      {step}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={saving || quota.blocked || prompt.trim().length < 8}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <AiIcon className="h-4 w-4" />}
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
  const displayMarkdown = leadMagnetDisplayMarkdown({
    title: item.title,
    markdown: item.markdown_body,
  });
  const split = splitLeadMagnetCreatorImage(displayMarkdown, null);
  return (
    <div className="max-h-[92vh] overflow-y-auto overflow-x-hidden px-6 py-6 sm:px-8">
      <DialogHeader className="pr-10">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={item.source_type === "ai" ? "brand" : item.source_type === "url" ? "info" : "neutral"}>
            {sourceLabel(item.source_type)}
          </StatusPill>
          <StatusPill tone="success">
            <Globe className="h-3 w-3" /> Public
          </StatusPill>
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
            await copyToClipboard(publicUrl, "Public link copied");
          }}
        >
          <Copy className="h-4 w-4" /> Copy public link
        </Button>
        <Button variant="outline" size="sm" onClick={() => window.open(publicUrl, "_blank", "noreferrer")}>
          <ExternalLink className="h-4 w-4" /> Open public page
        </Button>
      </div>
      {leadMagnetQualityWarning(item.metadata) && (
        <div className="mt-4 flex items-start gap-2 rounded-lg border border-state-warning-border bg-state-warning-bg px-3 py-2.5 text-xs text-state-warning">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {leadMagnetQualityWarning(item.metadata)} This resource is already publicly
            shareable — review it before sending the link.
          </span>
        </div>
      )}
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

function resourceTypeLabel(type: NonNullable<LeadMagnet["metadata"]["resource_type"]>): string {
  return type
    .split("_")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}
