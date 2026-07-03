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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Share2, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { fetchJson } from "@/lib/api-fetch";

type ConnState = {
  status: "active" | "disconnected";
  connected: boolean;
  displayName: string | null;
  avatarUrl: string | null;
  disconnectedReason: string | null;
} | null;

// Settings → "Publishing": connect the workspace's LinkedIn account (via Zernio)
// so scheduled drafts auto-publish. Three states: not connected, connected, and
// disconnected/expired (Reconnect). Distinct from "Tracked Accounts" (the
// creators the app scrapes) — this is where WE post FROM.
export function PublishingCard() {
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
    router.replace("/dashboard/settings");
  }, [searchParams, router, load]);

  const connect = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const data = await fetchJson<{ ok: boolean; authUrl?: string; error?: string }>(
        "/api/integrations/linkedin",
        { method: "POST" },
      );
      if (!data.ok || !data.authUrl) throw new Error(data.error || "Couldn't start connecting.");
      // Hand off to Zernio's hosted OAuth; it redirects back to our finalize
      // callback, which bounces to /settings?linkedin=connected.
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Share2 className="h-5 w-5 text-primary" />
          Publish to LinkedIn
        </CardTitle>
        <CardDescription>
          Connect your LinkedIn account so scheduled posts publish automatically.
          This is separate from Tracked Accounts (the creators we learn from).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!loaded ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking connection…
          </div>
        ) : connected ? (
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
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
          <div className="flex items-start gap-3 rounded-lg border border-amber-300/60 bg-amber-50 p-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
            <div className="flex-1">
              <div className="text-sm font-medium text-amber-900">
                Reconnect your LinkedIn account
              </div>
              <div className="text-xs text-amber-800">
                {conn?.disconnectedReason ||
                  "The connection expired. Reconnect to keep scheduling posts."}
              </div>
            </div>
            <Button size="sm" onClick={connect} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reconnect"}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="flex-1 text-sm text-muted-foreground">
              Not connected yet.
            </div>
            <Button onClick={connect} disabled={busy} className="gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
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
