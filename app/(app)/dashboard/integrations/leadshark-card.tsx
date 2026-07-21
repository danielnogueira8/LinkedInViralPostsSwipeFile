"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill } from "@/components/app-surface";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
} from "lucide-react";
import { fetchJson } from "@/lib/api-fetch";

type CredentialSafe = {
  connected: boolean;
  status: "active" | "invalid" | "revoked";
  keyHint: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
};

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return "just now";
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// Integrations → LeadShark: connect a user-supplied LeadShark API key so
// lead-magnet posts can auto-DM commenters. Three states mirror PublishingCard:
// not connected, connected, and invalid (reconnect). The key is write-only — it
// is never returned by the API, so there is no "reveal key".
export function LeadSharkCard({ initial }: { initial: CredentialSafe }) {
  const [cred, setCred] = useState<CredentialSafe>(initial);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const connect = async () => {
    if (busy) return;
    const key = apiKey.trim();
    if (!key) {
      toast.error("Enter your LeadShark API key.");
      return;
    }
    setBusy(true);
    try {
      const data = await fetchJson<{
        ok: boolean;
        credential?: CredentialSafe;
        error?: string;
      }>("/api/integrations/leadshark", {
        method: "POST",
        body: JSON.stringify({ apiKey: key }),
        headers: { "Content-Type": "application/json" },
      });
      if (!data.ok || !data.credential) {
        throw new Error(data.error || "Couldn't connect LeadShark.");
      }
      setCred(data.credential);
      setApiKey(""); // never keep the key in component state after success
      toast.success("LeadShark connected.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        "/api/integrations/leadshark",
        { method: "DELETE" },
      );
      if (!data.ok) throw new Error(data.error || "Couldn't disconnect.");
      setCred({
        connected: false,
        status: "revoked",
        keyHint: null,
        lastVerifiedAt: null,
        lastError: null,
      });
      setConfirmOpen(false);
      toast.success("LeadShark disconnected.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const connected = cred.status === "active";
  const invalid = cred.status === "invalid";

  return (
    <Card className="max-w-3xl overflow-hidden border-border/70 bg-card/90 shadow-soft">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-primary/10 bg-primary/[0.07] text-primary">
              <span aria-hidden className="text-lg">
                🦈
              </span>
            </div>
            <div className="min-w-0 space-y-1">
              <CardTitle className="text-base">LeadShark automation</CardTitle>
              <CardDescription>
                Auto-DM people who comment on your lead-magnet posts — LeadShark
                delivers the resource link for you.
              </CardDescription>
            </div>
          </div>
          <StatusPill tone={connected ? "success" : invalid ? "warning" : "neutral"}>
            {connected ? "Connected" : invalid ? "Reconnect" : "Not connected"}
          </StatusPill>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {connected ? (
          <div className="flex flex-col gap-3 rounded-lg border border-state-success-border bg-state-success-bg p-3 sm:flex-row sm:items-center">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-state-success" />
            <div className="flex-1">
              <div className="text-sm font-medium">
                Connected{cred.keyHint ? ` · key ${cred.keyHint}` : ""}
              </div>
              <div className="text-xs text-muted-foreground">
                {cred.lastVerifiedAt
                  ? `Last verified ${relativeTime(cred.lastVerifiedAt)}.`
                  : "Ready to automate lead-magnet posts."}
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
        ) : (
          <>
            {invalid ? (
              <div className="flex flex-col gap-2 rounded-lg border border-state-warning-border bg-state-warning-bg p-3 sm:flex-row sm:items-start">
                <AlertTriangle className="h-5 w-5 shrink-0 text-state-warning" />
                <div className="flex-1 text-xs text-state-warning">
                  {cred.lastError ||
                    "LeadShark rejected your API key. It may have been regenerated. Paste a fresh key to reconnect."}
                </div>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="leadshark-key" className="text-sm">
                LeadShark API key
              </Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="leadshark-key"
                  type="password"
                  autoComplete="off"
                  placeholder="Paste your LeadShark API key"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void connect();
                  }}
                  disabled={busy}
                  className="flex-1"
                />
                <Button onClick={connect} disabled={busy || !apiKey.trim()} className="gap-2">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {invalid ? "Reconnect" : "Connect"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Find it in LeadShark under{" "}
                <span className="font-medium">Settings → API Access</span>. It
                requires a paid LeadShark plan (Pro or above).
              </p>
            </div>

            {/* Consent copy (LinkedIn ToS / account safety) — reviewed before launch. */}
            <p className="rounded-md border border-border/60 bg-background/45 p-3 text-xs leading-relaxed text-muted-foreground">
              LeadShark sends DMs, comment replies, and (if enabled) connection
              requests from your LinkedIn account on your behalf. Automated
              activity may put your LinkedIn account at risk, including
              restriction. You&apos;re responsible for how you use it.
            </p>

            {/* Auto-Automate double-DM guard (§9.4). */}
            <p className="text-xs text-muted-foreground">
              If you use LeadShark&apos;s Auto-Automate, turn it off — SwipeIn
              sets up automations for you.
            </p>

            <a
              href="https://apex.leadshark.io"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2"
            >
              Open LeadShark <ExternalLink className="h-3 w-3" />
            </a>
          </>
        )}
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect LeadShark?</DialogTitle>
            <DialogDescription>
              We&apos;ll remove your stored API key. Automations already set up in
              LeadShark keep running there, but SwipeIn won&apos;t create new ones
              until you reconnect.
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
