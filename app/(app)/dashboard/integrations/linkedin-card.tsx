"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/app-surface";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { fetchJson } from "@/lib/api-fetch";
import { LINKEDIN_INTEGRATIONS_PATH } from "@/lib/linkedin-integration-destination";

type ConnState = {
  status: "active" | "disconnected";
  connected: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  disconnectedReason: string | null;
} | null;

function LinkedInMark({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-grid place-items-center rounded-[0.22rem] bg-[#0A66C2] font-bold leading-none text-white ${className}`}
    >
      in
    </span>
  );
}

// LinkedIn publishing connection card used by Integrations.
// Three states: not connected, connected, and disconnected/expired (Reconnect).
// Distinct from "Tracked Accounts" (the creators the app scrapes) — this is
// where WE post FROM.
export function LinkedInPublishingCard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [conn, setConn] = useState<ConnState>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchJson<{ ok: boolean; connection: ConnState }>(
        "/api/integrations/linkedin",
        { cache: "no-store" },
      );
      if (data.ok) setConn(data.connection);
    } catch {
      /* leave null → not-connected copy */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    // Mount fetch of the connection status from the API (an external system) —
    // the sanctioned use of an effect. load() setStates after its await, so the
    // set-state-in-effect lint fires on the call; it's an intended one-time sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Surface the OAuth callback result (?linkedin=connected|connect_failed) once,
  // then clear the param so a refresh doesn't re-toast.
  const handledParam = useRef(false);
  useEffect(() => {
    const result = searchParams.get("linkedin");
    if (!result || handledParam.current) return;
    handledParam.current = true;
    if (result === "connected") {
      toast.success("LinkedIn connected — you can schedule posts now.");
      // Re-sync the connection status from the API after a successful connect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void load();
    } else if (result === "connect_failed") {
      toast.error("Couldn't finish connecting LinkedIn. Please try again.");
    }
    router.replace(LINKEDIN_INTEGRATIONS_PATH);
  }, [searchParams, router, load]);

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const data = await fetchJson<{
        ok: boolean;
        authUrl?: string;
        alreadyConnected?: boolean;
        error?: string;
      }>("/api/integrations/linkedin?returnTo=integrations", { method: "POST" });
      // Already connected — don't start a new OAuth flow. Re-sync the card so it
      // shows the connected state and let the user know.
      if (data.ok && data.alreadyConnected) {
        toast.success("LinkedIn is already connected.");
        await load();
        setBusy(false);
        return;
      }
      if (!data.ok || !data.authUrl) throw new Error(data.error || "Couldn't start connecting.");
      // Hand off to Zernio's hosted OAuth; it redirects back to our finalize
      // callback, which returns to Integrations.
      window.location.href = data.authUrl;
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        "/api/integrations/linkedin",
        { method: "DELETE" },
      );
      if (!data.ok) throw new Error(data.error || "Couldn't disconnect.");
      toast.success("LinkedIn disconnected.");
      setConfirmOpen(false);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const connected = conn?.connected === true;
  const expired = !!conn && !conn.connected && conn.status === "disconnected";

  return (
    <Card className="max-w-3xl overflow-hidden border-border/70 bg-card/90 shadow-soft">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-primary/10 bg-primary/[0.07] text-primary">
              <LinkedInMark className="h-5 w-5 text-[10px]" />
            </div>
            <div className="min-w-0 space-y-1">
              <CardTitle className="text-base">Publish to LinkedIn</CardTitle>
              <CardDescription>
                Connect your LinkedIn account so scheduled posts publish automatically.
              </CardDescription>
            </div>
          </div>
          {loaded ? (
            <StatusPill tone={connected ? "success" : expired ? "warning" : "neutral"}>
              {connected ? "Connected" : expired ? "Reconnect" : "Not connected"}
            </StatusPill>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {!loaded ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking connection…
          </div>
        ) : connected ? (
          <div className="flex flex-col gap-3 rounded-lg border border-state-success-border bg-state-success-bg p-3 sm:flex-row sm:items-center">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-state-success" />
            <div className="flex-1">
              <div className="text-sm font-medium">
                Connected{conn?.displayName ? ` · ${conn.displayName}` : ""}
              </div>
              <div className="text-xs text-muted-foreground">
                Scheduled drafts will publish to this account.
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={busy}
            >
              Disconnect
            </Button>
          </div>
        ) : expired ? (
          <div className="flex flex-col gap-3 rounded-lg border border-state-warning-border bg-state-warning-bg p-3 sm:flex-row sm:items-start">
            <AlertTriangle className="h-5 w-5 shrink-0 text-state-warning" />
            <div className="flex-1">
              <div className="text-sm font-medium text-state-warning">
                Reconnect your LinkedIn account
              </div>
              <div className="text-xs text-state-warning">
                {conn?.disconnectedReason ||
                  "The connection expired. Reconnect to keep scheduling posts."}
              </div>
            </div>
            <Button size="sm" onClick={connect} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reconnect"}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-background/45 p-3 sm:flex-row sm:items-center">
            <div className="flex-1 text-sm text-muted-foreground">
              Not connected yet.
            </div>
            <Button onClick={connect} disabled={busy} className="gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LinkedInMark className="h-4 w-4 text-[8px]" />}
              Connect LinkedIn
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect LinkedIn?</DialogTitle>
            <DialogDescription>
              Scheduled posts won&apos;t publish until you reconnect. Your drafts
              stay on your board.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={disconnect} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
