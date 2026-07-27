"use client";

import { useCallback, useEffect, useState } from "react";
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
import { invalidateNavBadges } from "../nav-badges";

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
  outgoing: outgoingInitial = [],
  incoming: incomingInitial = [],
}: {
  outgoing?: Outgoing[];
  incoming?: Incoming[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(outgoingInitial.length > 0 || incomingInitial.length > 0);
  const [loading, setLoading] = useState(false);
  const [outgoingInitialState, setOutgoingInitialState] = useState(outgoingInitial);
  const [incomingInitialState, setIncomingInitialState] = useState(incomingInitial);
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Optimistic deltas applied on top of the server props at render time (the
  // same pattern as the creator picker — avoids set-state-in-effect reseed
  // churn the React Compiler flags). `removedIds` hides accepted/declined/
  // revoked rows instantly; `optimisticOutgoing` shows a just-sent invite
  // before the refresh lands. Both reconcile idempotently: once the server
  // list catches up, a removed id that's already gone / a synthetic invite
  // that now has a real row are harmless. We dedupe synthetic invites by
  // email against the server list so they don't double up after refresh.
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [optimisticOutgoing, setOptimisticOutgoing] = useState<Outgoing[]>([]);

  const loadShares = useCallback(async () => {
    if (loading || loaded) return;
    setLoading(true);
    try {
      const claim = await fetchJson<{ ok: boolean; error?: string }>(
        "/api/shared-bookmarks/pending-count",
        { method: "POST" },
      );
      if (!claim.ok) throw new Error(claim.error || "Failed to resolve sharing invites");
      const data = await fetchJson<{
        ok: boolean;
        error?: string;
        outgoing?: Outgoing[];
        incoming?: Array<Incoming & { status?: string }>;
      }>("/api/shared-bookmarks");
      if (!data.ok) throw new Error(data.error || "Failed to load sharing details");
      setOutgoingInitialState(data.outgoing ?? []);
      setIncomingInitialState(
        (data.incoming ?? []).filter((item) => item.status === "pending"),
      );
      setLoaded(true);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [loaded, loading]);

  function setOpenAndLoad(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) void loadShares();
  }

  function hideRow(id: string) {
    setRemovedIds((prev) => new Set(prev).add(id));
  }
  function restoreRow(id: string) {
    setRemovedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  const incoming = removedIds.size
    ? incomingInitialState.filter((inv) => !removedIds.has(inv.id))
    : incomingInitialState;
  const outgoing = (() => {
    const base = removedIds.size
      ? outgoingInitialState.filter((s) => !removedIds.has(s.id))
      : outgoingInitialState;
    if (optimisticOutgoing.length === 0) return base;
    const seenEmails = new Set(base.map((s) => s.recipient_email.toLowerCase()));
    const extras = optimisticOutgoing.filter(
      (s) => !seenEmails.has(s.recipient_email.toLowerCase()),
    );
    return [...extras, ...base];
  })();

  const pendingIncomingCount = incoming.length;

  // The full incoming list only loads when the dialog opens, so the trigger
  // badge would never render without this: seed it from the pending-count
  // endpoint on mount (same POST the nav badge uses — it also claims
  // email-matched invites). Once the real list is loaded it takes over.
  const [pendingCountSeed, setPendingCountSeed] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchJson<{ ok: boolean; count?: number }>(
      "/api/shared-bookmarks/pending-count",
      { method: "POST" },
    )
      .then((data) => {
        if (!cancelled && data.ok && typeof data.count === "number") {
          setPendingCountSeed(data.count);
        }
      })
      .catch(() => {
        /* badge stays hidden — the dialog still loads the list on open */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const pendingBadgeCount = loaded
    ? pendingIncomingCount
    : (pendingCountSeed ?? pendingIncomingCount);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    const recipient = email.trim();
    if (!recipient) return;
    setInviting(true);
    // Optimistic: show a pending invite row right away.
    const tempId = `optimistic-${recipient.toLowerCase()}`;
    setOptimisticOutgoing((prev) => [
      {
        id: tempId,
        recipient_email: recipient,
        recipient_user_id: null,
        status: "pending",
        created_at: new Date().toISOString(),
        accepted_at: null,
      },
      ...prev.filter((s) => s.id !== tempId),
    ]);
    setEmail("");
    try {
      const data = await fetchJson<{ ok: boolean; error?: string; alreadyInvited?: boolean }>(
        "/api/shared-bookmarks",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipient_email: recipient }),
        },
      );
      if (!data.ok) throw new Error(data.error);
      toast.success(
        data.alreadyInvited
          ? `${recipient} was already invited`
          : `Invite sent to ${recipient}`,
      );
      router.refresh(); // real row replaces the synthetic one (deduped by email)
    } catch (err) {
      // Roll back the optimistic row and restore the typed email.
      setOptimisticOutgoing((prev) => prev.filter((s) => s.id !== tempId));
      setEmail(recipient);
      toast.error((err as Error).message);
    }
    setInviting(false);
  }

  async function patch(id: string, action: "accept" | "decline" | "revoke") {
    setBusyId(id);
    // Optimistic: all three actions remove the row from its current list
    // (accept also moves the invite out of the pending section; the accepted
    // library shows up after refresh).
    hideRow(id);
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
      // Accept/decline change the pending-incoming count that drives the nav
      // badge; router.refresh() only re-runs server components, not the badge's
      // client fetch, so the badge would stay stale. Invalidate it explicitly.
      // (Revoke is outgoing-only and won't change the count, but invalidating
      // is harmless — the refetch just returns the same number.)
      invalidateNavBadges();
      router.refresh();
    } catch (err) {
      restoreRow(id); // bring the row back
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
        onClick={() => setOpenAndLoad(true)}
        className="inline-flex items-center gap-1.5 relative"
      >
        <Share2 className="h-3.5 w-3.5" /> Share
        {pendingBadgeCount > 0 && (
          <span
            className="absolute -top-1 -right-1 h-4 min-w-4 px-1 rounded-full bg-primary text-background text-[10px] font-semibold inline-flex items-center justify-center"
            aria-label={`${pendingBadgeCount} pending invite${pendingBadgeCount === 1 ? "" : "s"}`}
          >
            {pendingBadgeCount}
          </span>
        )}
      </Button>

      <Dialog open={open} onOpenChange={setOpenAndLoad}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Share2 className="h-4 w-4 text-primary" /> Share bookmarks
            </DialogTitle>
            <DialogDescription>
              People you invite can view your bookmarks and add new ones.
              They can&rsquo;t delete yours.
            </DialogDescription>
          </DialogHeader>

          {loading && !loaded && (
            <div className="rounded-xl border border-border/70 bg-muted/30 p-4 text-sm text-muted-foreground">
              <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
              Loading sharing details…
            </div>
          )}

          {pendingIncomingCount > 0 && (
            <section className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Invitations for you
              </div>
              <div className="space-y-1.5">
                {incoming.map((inv) => (
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
            {outgoing.length === 0 ? (
              <div className="text-xs text-muted-foreground italic px-3 py-2">
                Nobody yet.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-56 overflow-y-auto">
                {outgoing.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-border/60 bg-card"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate">{s.recipient_email}</div>
                      <div
                        className={cn(
                          "text-[10px] uppercase tracking-wide font-medium",
                          s.status === "accepted" ? "text-state-success" : "text-muted-foreground",
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
