"use client";

import { useState } from "react";
import type { Client } from "@/lib/supabase";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";

type Color = { name?: string; hex: string };

export function ClientsManager({ initial }: { initial: Client[] }) {
  const [clients, setClients] = useState(initial);
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">{clients.length} client{clients.length === 1 ? "" : "s"}</div>
        <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add client</Button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-lg">
            <ClientForm
              onSaved={(c) => { setClients((cs) => [c, ...cs]); setOpen(false); }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {clients.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No clients yet. Click <strong>Add client</strong> to create one.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {clients.map((c) => (
            <ClientCard key={c.id} c={c} onDelete={(id) => setClients((cs) => cs.filter((x) => x.id !== id))} />
          ))}
        </div>
      )}
    </div>
  );
}

function ClientCard({ c, onDelete }: { c: Client; onDelete: (id: string) => void }) {
  const [del, setDel] = useState(false);
  async function remove() {
    if (!confirm(`Delete ${c.name}?`)) return;
    setDel(true);
    const res = await fetch(`/api/clients/${c.id}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      toast.success("Client deleted");
      onDelete(c.id);
    } else {
      toast.error(data.error);
      setDel(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-medium truncate">{c.name}</div>
            {c.notes && <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{c.notes}</div>}
          </div>
          <Button variant="ghost" size="icon" onClick={remove} disabled={del} className="h-7 w-7 text-muted-foreground hover:text-destructive">
            {del ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {c.brand_colors.map((col, i) => (
            <div key={i} title={`${col.hex}${col.name ? ` ${col.name}` : ""}`}
              className="h-7 w-7 rounded border" style={{ background: col.hex }} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ClientForm({ onSaved }: { onSaved: (c: Client) => void }) {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [colors, setColors] = useState<Color[]>([{ hex: "#000000" }]);
  const [busy, setBusy] = useState(false);

  function updateColor(i: number, patch: Partial<Color>) {
    setColors((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function addColor() { setColors((cs) => [...cs, { hex: "#000000" }]); }
  function removeColor(i: number) { setColors((cs) => cs.filter((_, idx) => idx !== i)); }

  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, notes: notes || null, brand_colors: colors }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      toast.success(`${name} created`);
      onSaved(data.client);
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add client</DialogTitle>
      </DialogHeader>
      <div className="space-y-4 py-2">
        <div className="space-y-1.5">
          <Label htmlFor="cname">Name</Label>
          <Input id="cname" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cnotes">Notes (optional)</Label>
          <Textarea id="cnotes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Industry, brand voice, anything useful…" rows={2} />
        </div>
        <div className="space-y-2">
          <Label>Brand colors</Label>
          <div className="space-y-2">
            {colors.map((c, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input type="color" value={c.hex} onChange={(e) => updateColor(i, { hex: e.target.value })}
                  className="h-9 w-12 rounded border bg-transparent cursor-pointer" />
                <Input value={c.hex} onChange={(e) => updateColor(i, { hex: e.target.value })} placeholder="#000000" className="w-28 font-mono" />
                <Input value={c.name ?? ""} onChange={(e) => updateColor(i, { name: e.target.value })} placeholder="Label (optional)" className="flex-1" />
                {colors.length > 1 && (
                  <Button variant="ghost" size="icon" onClick={() => removeColor(i)} className="h-9 w-9 text-muted-foreground hover:text-destructive">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            ))}
            <Button variant="ghost" size="sm" onClick={addColor} className="text-muted-foreground"><Plus className="h-3 w-3" /> Add color</Button>
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button onClick={save} disabled={busy || !name}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {busy ? "Saving…" : "Create client"}
        </Button>
      </DialogFooter>
    </>
  );
}
