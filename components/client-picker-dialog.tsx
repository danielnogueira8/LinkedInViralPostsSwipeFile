"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Check, Users } from "lucide-react";
import Link from "next/link";

type Client = {
  id: string;
  name: string;
  brand_colors?: { name?: string; hex: string }[];
};

export function ClientPickerDialog({
  open,
  onOpenChange,
  clients,
  onPick,
  busyId,
  title = "Pick a brand",
  description = "The image prompt will be generated using this brand's colors.",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  clients: Client[];
  onPick: (clientId: string, clientName: string) => Promise<void> | void;
  busyId: string | null;
  title?: string;
  description?: string;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {clients.length === 0 ? (
          <div className="py-8 text-center space-y-3">
            <div className="h-10 w-10 rounded-full bg-muted grid place-items-center mx-auto">
              <Users className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="text-sm font-medium">No brands yet</div>
            <div className="text-xs text-muted-foreground">Add one to recolor graphics.</div>
            <Link href="/dashboard/branding">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Add a brand
              </Button>
            </Link>
          </div>
        ) : (
          <div className="space-y-1 max-h-[400px] overflow-y-auto -mx-2 px-2">
            {clients.map((c) => {
              const isBusy = busyId === c.id;
              const anyBusy = busyId !== null;
              return (
                <button
                  key={c.id}
                  disabled={anyBusy}
                  onClick={() => onPick(c.id, c.name)}
                  onMouseEnter={() => setHoveredId(c.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  className="w-full flex items-center gap-3 p-3 rounded-md border bg-card hover:bg-accent hover:border-foreground/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-left"
                >
                  <div className="flex -space-x-1 shrink-0">
                    {(c.brand_colors ?? []).slice(0, 5).map((col, i) => (
                      <div
                        key={i}
                        className="h-7 w-7 rounded-full border-2 border-background"
                        style={{ background: col.hex, zIndex: 5 - i }}
                        title={col.hex}
                      />
                    ))}
                    {(c.brand_colors ?? []).length === 0 && (
                      <div className="h-7 w-7 rounded-full border-2 border-background bg-muted" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{c.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {(c.brand_colors ?? []).length} brand color{(c.brand_colors ?? []).length === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="shrink-0">
                    {isBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    ) : hoveredId === c.id ? (
                      <Check className="h-4 w-4 text-muted-foreground" />
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
