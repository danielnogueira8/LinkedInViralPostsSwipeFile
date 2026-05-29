"use client";

import { useState } from "react";
import type { Client } from "@/lib/supabase";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Plus, Trash2, Loader2, ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";

type Color = { name?: string; hex: string };

export function BrandingManager({ initial }: { initial: Client[] }) {
  const [brands, setBrands] = useState(initial);
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {brands.length} brand{brands.length === 1 ? "" : "s"}
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> Add brand
        </Button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-lg">
            <BrandForm
              onSaved={(c) => {
                setBrands((bs) => [c, ...bs]);
                setOpen(false);
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {brands.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No brands yet. Click <strong>Add brand</strong> to create one.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {brands.map((c) => (
            <BrandCard
              key={c.id}
              c={c}
              onDelete={(id) => setBrands((bs) => bs.filter((x) => x.id !== id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BrandCard({ c, onDelete }: { c: Client; onDelete: (id: string) => void }) {
  const [del, setDel] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  async function remove() {
    setDel(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/branding/${c.id}`,
        { method: "DELETE" },
      );
      if (!data.ok) throw new Error(data.error);
      toast.success("Brand deleted");
      onDelete(c.id);
      // No setDel(false) on success — the card unmounts via onDelete.
    } catch (e) {
      toast.error((e as Error).message);
      setDel(false);
      throw e; // keep the confirm dialog open for retry
    }
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            {c.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={c.logo_url}
                alt={`${c.name} logo`}
                className="h-10 w-10 rounded-md object-contain border bg-white shrink-0"
              />
            ) : (
              <div className="h-10 w-10 rounded-md border bg-muted/50 grid place-items-center shrink-0">
                <ImageIcon className="h-4 w-4 text-muted-foreground/60" />
              </div>
            )}
            <div className="min-w-0">
              <div className="font-medium truncate">{c.name}</div>
              {c.notes && (
                <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{c.notes}</div>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setConfirmOpen(true)}
            disabled={del}
            className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
          >
            {del ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </Button>
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title={`Delete ${c.name}?`}
            description="This permanently removes the brand from your workspace. You'll have to recreate it from scratch."
            confirmLabel="Delete"
            variant="destructive"
            onConfirm={remove}
          />
        </div>
        {c.brand_colors.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {c.brand_colors.map((col, i) => (
              <div
                key={i}
                title={`${col.hex}${col.name ? ` ${col.name}` : ""}`}
                className="h-7 w-7 rounded border"
                style={{ background: col.hex }}
              />
            ))}
          </div>
        )}
        {(c.font_primary || c.font_secondary) && (
          <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
            {c.font_primary && (
              <span className="rounded-full border border-border/60 px-2 py-0.5">
                Primary: <span className="font-medium text-foreground">{c.font_primary}</span>
              </span>
            )}
            {c.font_secondary && (
              <span className="rounded-full border border-border/60 px-2 py-0.5">
                Secondary: <span className="font-medium text-foreground">{c.font_secondary}</span>
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BrandForm({ onSaved }: { onSaved: (c: Client) => void }) {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [fontPrimary, setFontPrimary] = useState("");
  const [fontSecondary, setFontSecondary] = useState("");
  const [colors, setColors] = useState<Color[]>([{ hex: "#000000" }]);
  const [busy, setBusy] = useState(false);

  function updateColor(i: number, patch: Partial<Color>) {
    setColors((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function addColor() {
    setColors((cs) => [...cs, { hex: "#000000" }]);
  }
  function removeColor(i: number) {
    setColors((cs) => cs.filter((_, idx) => idx !== i));
  }

  async function save() {
    setBusy(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string; client: unknown }>(
        "/api/branding",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            notes: notes || null,
            brand_colors: colors,
            logo_url: logoUrl.trim() || null,
            font_primary: fontPrimary.trim() || null,
            font_secondary: fontSecondary.trim() || null,
          }),
        },
      );
      if (!data.ok) throw new Error(data.error);
      toast.success(`${name} created`);
      onSaved(data.client as Parameters<typeof onSaved>[0]);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add brand</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="space-y-1.5">
          <Label htmlFor="bname">Name</Label>
          <Input
            id="bname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Corp"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bnotes">Notes (optional)</Label>
          <Textarea
            id="bnotes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Industry, brand voice, anything useful…"
            rows={2}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="blogo">Logo URL (optional)</Label>
          <Input
            id="blogo"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://acme.com/logo.png"
          />
          <p className="text-xs text-muted-foreground">
            Paste a public URL. Claude reads this URL via MCP when generating image prompts.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="bfp">Primary font (optional)</Label>
            <Input
              id="bfp"
              value={fontPrimary}
              onChange={(e) => setFontPrimary(e.target.value)}
              placeholder="Inter"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bfs">Secondary font (optional)</Label>
            <Input
              id="bfs"
              value={fontSecondary}
              onChange={(e) => setFontSecondary(e.target.value)}
              placeholder="IBM Plex Mono"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Brand colors</Label>
          <div className="space-y-2">
            {colors.map((c, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input
                  type="color"
                  value={c.hex}
                  onChange={(e) => updateColor(i, { hex: e.target.value })}
                  className="h-9 w-12 rounded border bg-transparent cursor-pointer"
                />
                <Input
                  value={c.hex}
                  onChange={(e) => updateColor(i, { hex: e.target.value })}
                  placeholder="#000000"
                  className="w-28 font-mono"
                />
                <Input
                  value={c.name ?? ""}
                  onChange={(e) => updateColor(i, { name: e.target.value })}
                  placeholder="Label (optional)"
                  className="flex-1"
                />
                {colors.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeColor(i)}
                    className="h-9 w-9 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              onClick={addColor}
              className="text-muted-foreground"
            >
              <Plus className="h-3 w-3" /> Add color
            </Button>
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button onClick={save} disabled={busy || !name}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? "Saving…" : "Create brand"}
        </Button>
      </DialogFooter>
    </>
  );
}
