"use client";

import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { Plus, Trash2, Pencil, Loader2, Copy, Check, Lock } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/api-fetch";
import { byId, removeById, reinsertById } from "@/lib/optimistic";
import { copyToClipboard } from "@/lib/clipboard";
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

export function TemplatesManager({ initial }: { initial: ContentTemplate[] }) {
  const [custom, setCustom] = useState(initial);
  const [editing, setEditing] = useState<ContentTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ContentTemplate | null>(null);

  // The full library: the user's custom templates first (newest-first, as
  // fetched), then the app's built-in starters. Built-ins are always shown so
  // the page is useful before the user has added anything.
  const rows: Row[] = useMemo(
    () => [...custom.map(customToRow), ...BUILTIN_TEMPLATES.map(builtinToRow)],
    [custom],
  );

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
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm text-muted-foreground">
          {custom.length > 0
            ? `${custom.length} of your templates · ${BUILTIN_TEMPLATES.length} built-in`
            : `${BUILTIN_TEMPLATES.length} built-in templates to get you started`}
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" /> New template
        </Button>
      </div>

      <div className="space-y-4">
        {rows.map((row) => (
          <TemplateCard
            key={row.id}
            row={row}
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
  onEdit,
  onDelete,
}: {
  row: Row;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const placeholders = useMemo(() => extractPlaceholders(row.body), [row.body]);

  async function copy() {
    const ok = await copyToClipboard(row.body, "Template copied");
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-medium truncate">{row.title}</h3>
              {row.category && (
                <Badge variant="secondary" className="shrink-0 text-[11px]">
                  {templateCategoryLabel(row.category)}
                </Badge>
              )}
              {row.builtin && (
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
                  <Lock className="h-3 w-3" /> built-in
                </span>
              )}
            </div>
            {placeholders.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {placeholders.length} placeholder{placeholders.length === 1 ? "" : "s"} to fill
              </p>
            )}
          </div>
        </div>

        {/* Body with {placeholders} highlighted so the fill-in points read at a
            glance. Whitespace-pre-wrap preserves the blank-line paragraph shape. */}
        <div className="text-sm whitespace-pre-wrap break-words max-h-72 overflow-y-auto pr-1 text-foreground/90 leading-relaxed">
          <HighlightedBody body={row.body} />
        </div>

        <div className="flex items-center gap-2 pt-1">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5 text-lime-700" /> : <Copy className="h-3.5 w-3.5" />}
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
