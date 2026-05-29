"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";
import { Loader2, Mail, Share2, Trash2, Check, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Manages "your bookmarks library is shared with N people" + "N people
// shared their library with you". Single modal so the user sees both
// sides of the relationship in one place; the trigger button shows a
// dot when there are unread incoming invites.

type Outgoing = {
  id: string;
  recipient_email: string;
  recipient_user_id: string | null;
  status: string;
  created_at: string;
  accepted_at: string | null;
};

type Incoming = {
  id: string;
  owner_name: string;
  owner_email: string | null;
  created_at: string;
};

export function SharedBookmarksManager({
  outgoing: outgoingInitial,
  incoming: incomingInitial,
}: {
  outgoing: Outgoing[];
  incoming: Incoming[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const pendingIncomingCount = incomingInitial.length;

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setInviting(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string; alreadyInvited?: boolean }>(
        "/api/shared-bookmarks",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipient_email: email.trim() }),
        },
      );
      if (!data.ok) throw new Error(data.error);
      toast.success(
        data.alreadyInvited
          ? `${email} was already invited`
          : `Invite sent to ${email}`,
      );
      setEmail("");
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
    setInviting(false);
  }

  async function patch(id: string, action: "accept" | "decline" | "revoke") {
    setBusyId(id);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/shared-bookmarks/${id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      if (!data.ok) throw new Error(data.error);
      toast.success(
        action === "accept"
          ? "Share accepted"
          : action === "decline"
            ? "Invite declined"
            : "Share revoked",
      );
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
    setBusyId(null);
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 relative"
      >
        <Share2 className="h-3.5 w-3.5" /> Share
        {pendingIncomingCount > 0 && (
          <span
            className="absolute -top-1 -right-1 h-4 min-w-4 px-1 rounded-full bg-primary text-background text-[10px] font-semibold inline-flex items-center justify-center"
            aria-label={`${pendingIncomingCount} pending invite${pendingIncomingCount === 1 ? "" : "s"}`}
          >
            {pendingIncomingCount}
          </span>
        )}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Share2 className="h-4 w-4 text-primary" /> Share bookmarks
            </DialogTitle>
            <DialogDescription>
              People you invite can view your bookmarks and add new ones.
              They can&rsquo;t delete or edit yours.
            </DialogDescription>
          </DialogHeader>

          {pendingIncomingCount > 0 && (
            <section className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Invitations for you
              </div>
              <div className="space-y-1.5">
                {incomingInitial.map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-border/60 bg-card"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">
                        {inv.owner_name}
                      </div>
                      {inv.owner_email && (
                        <div className="text-xs text-muted-foreground truncate" title={inv.owner_email}>
                          {inv.owner_email}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => patch(inv.id, "decline")}
                        disabled={busyId === inv.id}
                      >
                        {busyId === inv.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <X className="h-3.5 w-3.5" />
                        )}
                        Decline
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => patch(inv.id, "accept")}
                        disabled={busyId === inv.id}
                      >
                        {busyId === inv.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                        Accept
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Invite someone
            </div>
            <form onSubmit={invite} className="flex items-stretch gap-2">
              <div className="relative flex-1">
                <Mail className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  type="email"
                  required
                  placeholder="teammate@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={inviting}
                  className="pl-8"
                />
              </div>
              <Button type="submit" size="sm" disabled={inviting || !email.trim()}>
                {inviting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Share2 className="h-3.5 w-3.5" />
                )}
                {inviting ? "Inviting…" : "Invite"}
              </Button>
            </form>
          </section>

          <section className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              You&rsquo;ve shared with
            </div>
            {outgoingInitial.length === 0 ? (
              <div className="text-xs text-muted-foreground italic px-3 py-2">
                Nobody yet.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-56 overflow-y-auto">
                {outgoingInitial.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-border/60 bg-card"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate">{s.recipient_email}</div>
                      <div
                        className={cn(
                          "text-[10px] uppercase tracking-wide font-medium",
                          s.status === "accepted" ? "text-emerald-600" : "text-muted-foreground",
                        )}
                      >
                        {s.status}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => patch(s.id, "revoke")}
                      disabled={busyId === s.id}
                      title="Revoke share"
                      aria-label="Revoke share"
                    >
                      {busyId === s.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </DialogContent>
      </Dialog>
    </>
  );
}
