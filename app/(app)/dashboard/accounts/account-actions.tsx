"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

export function AddAccountButton({ knownNiches }: { knownNiches: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [profileUrl, setProfileUrl] = useState("");
  const [name, setName] = useState("");
  const [niche, setNiche] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch("/api/accounts/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile_url: profileUrl, name, niche: niche || null }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      toast.success(`Added ${data.account.name}`);
      setProfileUrl(""); setName(""); setNiche("");
      setOpen(false);
      router.refresh();
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Add account
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add account manually</DialogTitle>
            <DialogDescription>
              Adds a creator outside of the Google Sheet. Sheet sync won&apos;t overwrite or remove it.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="manual-url">LinkedIn profile URL</Label>
              <Input
                id="manual-url"
                type="url"
                placeholder="https://www.linkedin.com/in/zach-schieffer"
                value={profileUrl}
                onChange={(e) => setProfileUrl(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manual-name">Name</Label>
              <Input
                id="manual-name"
                placeholder="Zach Schieffer"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manual-niche">Niche <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <NicheCombobox value={niche} onChange={setNiche} options={knownNiches} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy || !profileUrl || !name}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add account
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function NicheCombobox({
  value, onChange, options,
}: { value: string; onChange: (v: string) => void; options: string[] }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return options.slice(0, 12);
    return options.filter((o) => o.toLowerCase().includes(q)).slice(0, 12);
  }, [value, options]);

  function pick(v: string) {
    onChange(v);
    setOpen(false);
    inputRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true); setActive(0); e.preventDefault(); return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") { setActive((a) => Math.min(filtered.length - 1, a + 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { setActive((a) => Math.max(0, a - 1)); e.preventDefault(); }
    else if (e.key === "Enter" && filtered[active]) { pick(filtered[active]); e.preventDefault(); }
    else if (e.key === "Escape") { setOpen(false); }
  }

  // Close when focus leaves the wrapper entirely.
  function onBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (!wrapRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
  }

  return (
    <div ref={wrapRef} className="relative" onBlur={onBlur}>
      <Input
        ref={inputRef}
        id="manual-niche"
        placeholder="e.g. Email Marketing"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        autoComplete="off"
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-popover shadow-soft-lg max-h-56 overflow-y-auto py-1">
          {filtered.map((opt, i) => (
            <button
              key={opt}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(opt)}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "block w-full text-left px-3 py-1.5 text-sm transition-colors",
                i === active ? "bg-accent text-foreground" : "text-foreground/80 hover:bg-accent/60",
              )}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DeleteAccountButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function del() {
    if (!confirm(`Delete ${name}? This removes the account and all its posts.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/accounts/manual?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      toast.success(`Deleted ${name}`);
      router.refresh();
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  }

  return (
    <button
      type="button"
      onClick={del}
      disabled={busy}
      className="text-muted-foreground hover:text-destructive rounded-md p-1 hover:bg-muted transition-colors disabled:opacity-50"
      title="Delete account"
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
    </button>
  );
}
