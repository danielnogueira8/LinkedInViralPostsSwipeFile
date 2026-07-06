"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  BookOpen,
  Bot,
  Check,
  Copy,
  ExternalLink,
  FilePlus,
  Globe,
  LinkIcon,
  Loader2,
  Pencil,
  Plus,
  ScrollText,
  Sparkles,
  Trash2,
} from "lucide-react";
import { MarkdownDocument } from "@/components/markdown-document";
import { EmptyState, StatusPill, Surface, Toolbar } from "@/components/app-surface";
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
import {
  LEAD_MAGNET_BODY_MAX,
  LEAD_MAGNET_TITLE_MAX,
  type LeadMagnet,
} from "@/lib/lead-magnets";

type Mode = "manual" | "import" | "ai";

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
  const [used, setUsed] = useState(aiUsed);

  const sorted = useMemo(
    () => [...items].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
    [items],
  );

  const remove = async (id: string) => {
    const removed = byId(items, id);
    setItems((cur) => removeById(cur, id));
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(`/api/lead-magnets/${id}`, {
        method: "DELETE",
      });
      if (!data.ok) throw new Error(data.error || "Failed to delete lead magnet");
      toast.success("Lead magnet deleted");
    } catch (e) {
      setItems((cur) => reinsertById(cur, removed));
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <Toolbar className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
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
      </Toolbar>

      {sorted.length ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sorted.map((item) => (
            <LeadMagnetCard
              key={item.id}
              item={item}
              onOpen={() => setPreviewing(item)}
              onEdit={() => setEditing(item)}
              onDelete={() => setConfirmDelete(item)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<BookOpen className="h-6 w-6" />}
          title="No lead magnets yet"
          description="Create a markdown resource, import a public Notion or Google Doc, then share a read-only link."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => setCreating("ai")}>
                <Sparkles className="h-4 w-4" /> Create with AI
              </Button>
              <Button variant="outline" onClick={() => setCreating("import")}>
                <LinkIcon className="h-4 w-4" /> Import link
              </Button>
            </div>
          }
        />
      )}

      <Dialog open={creating !== null} onOpenChange={(open) => !open && setCreating(null)}>
        <DialogContent className="max-h-[calc(100vh-2rem)] w-[min(980px,calc(100vw-2rem))] overflow-y-auto sm:max-w-none">
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
        <DialogContent className="max-h-[calc(100vh-2rem)] w-[min(980px,calc(100vw-2rem))] overflow-y-auto sm:max-w-none">
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
}: {
  item: LeadMagnet;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const publicUrl = publicLeadMagnetUrl(item.public_slug);
  const deliverables = item.metadata.deliverables ?? [];
  const ctaUrl = item.metadata.cta_url ?? null;
  const ctaLabel = item.metadata.cta_label ?? "Book a call";
  return (
    <Surface padding="md" className="flex min-h-[260px] flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={item.source_type === "ai" ? "primary" : item.source_type === "url" ? "success" : "neutral"}>
              {sourceLabel(item.source_type)}
            </StatusPill>
            {item.is_public && <Badge variant="outline">Public link</Badge>}
          </div>
          <button className="block text-left text-lg font-semibold tracking-tight text-foreground hover:underline" onClick={onOpen}>
            {item.title}
          </button>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onDelete} title="Delete lead magnet">
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <p className="line-clamp-3 text-sm leading-6 text-muted-foreground">
        {item.metadata.selection_summary || item.metadata.summary || item.markdown_body.slice(0, 220)}
      </p>

      {deliverables.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">Deliverables</div>
          <div className="flex flex-wrap gap-1.5">
            {deliverables.slice(0, 3).map((deliverable) => (
              <Badge key={deliverable} variant="secondary" className="max-w-full truncate">
                {deliverable}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {ctaUrl && (
        <div className="rounded-xl border border-border/60 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
          Resource page CTA:{" "}
          <span className="font-medium text-foreground">
            {ctaLabel}
          </span>
        </div>
      )}

      <div className="mt-auto flex flex-wrap gap-2 border-t border-border/60 pt-3">
        <Button variant="outline" size="sm" onClick={onOpen}>
          <BookOpen className="h-4 w-4" /> View
        </Button>
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil className="h-4 w-4" /> Edit
        </Button>
        <Button
          variant="outline"
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
        <Button variant="ghost" size="sm" onClick={() => window.open(publicUrl, "_blank", "noreferrer")}>
          <ExternalLink className="h-4 w-4" /> Open
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
              cta_url: ctaUrl,
              cta_label: ctaLabel,
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
        <div className="grid gap-2">
          <Label htmlFor="lead-body">Markdown content</Label>
          <Textarea
            id="lead-body"
            value={markdown}
            maxLength={LEAD_MAGNET_BODY_MAX}
            onChange={(e) => setMarkdown(e.target.value)}
            placeholder={"# Resource title\n\nUse headings, lists, examples, scripts, and checklists."}
            className="min-h-[460px] font-mono text-sm"
          />
          <div className="text-xs text-muted-foreground">
            {markdown.length.toLocaleString()} / {LEAD_MAGNET_BODY_MAX.toLocaleString()} characters
          </div>
        </div>
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
  const blocked = used >= limit;
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
      </div>
      <DialogFooter>
        <Button onClick={submit} disabled={saving || blocked || prompt.trim().length < 8}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          Generate lead magnet
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
  const ctaUrl = item.metadata.cta_url ?? null;
  const ctaLabel = item.metadata.cta_label ?? "Book a call";
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
      {(summary || deliverables.length > 0 || ctaUrl) && (
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
          {ctaUrl && (
            <div className="mt-3 rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm text-muted-foreground">
              Resource page CTA:{" "}
              <a
                href={ctaUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary underline underline-offset-4"
              >
                {ctaLabel}
              </a>
            </div>
          )}
        </div>
      )}
      <div className="mt-5 min-w-0 rounded-2xl border border-border/60 bg-white px-5 py-7 sm:px-10">
        <MarkdownDocument markdown={item.markdown_body} className="max-w-full overflow-x-hidden" />
      </div>
    </div>
  );
}

function publicLeadMagnetUrl(slug: string): string {
  if (typeof window === "undefined") return `/lm/${slug}`;
  return `${window.location.origin}/lm/${slug}`;
}

function sourceLabel(source: LeadMagnet["source_type"]): string {
  if (source === "ai") return "AI-created";
  if (source === "url") return "Imported";
  return "Manual";
}
