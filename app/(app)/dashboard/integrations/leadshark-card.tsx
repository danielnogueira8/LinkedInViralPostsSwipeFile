"use client";

import { useState, useSyncExternalStore } from "react";
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
import { Textarea } from "@/components/ui/textarea";
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
  Save,
} from "lucide-react";
import { fetchJson } from "@/lib/api-fetch";
import {
  RESOURCE_NAME_TOKEN,
  RESOURCE_URL_TOKEN,
  validateLeadSharkAutomationDefaults,
  type LeadSharkAutomationDefaults,
} from "@/lib/leadshark-default-config";

type CredentialSafe = {
  connected: boolean;
  status: "active" | "invalid" | "revoked";
  keyHint: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
};

const subscribeHydration = () => () => {};
const getHydratedSnapshot = () => true;
const getServerHydratedSnapshot = () => false;

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 60) return "just now";
  const mins = Math.round(diffSec / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function verificationLabel(
  lastVerifiedAt: string | null,
  hydrated: boolean,
  now = Date.now(),
): string {
  if (!lastVerifiedAt) return "Ready to automate lead-magnet posts.";
  if (!hydrated) return "Last verified.";
  const relative = relativeTime(lastVerifiedAt, now);
  return relative ? `Last verified ${relative}.` : "Last verified.";
}

// Integrations → LeadShark: connect a user-supplied LeadShark API key so
// lead-magnet posts can auto-DM commenters. Three states mirror LinkedInPublishingCard:
// not connected, connected, and invalid (reconnect). The key is write-only — it
// is never returned by the API, so there is no "reveal key".
function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function DefaultsToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 text-sm"
    >
      <span
        aria-hidden
        className={`relative h-6 w-11 rounded-full transition-colors ${
          checked ? "bg-primary" : "bg-muted-foreground/25"
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-5" : ""
          }`}
        />
      </span>
      {label}
    </button>
  );
}

export function LeadSharkCard({
  initial,
  initialDefaults,
  defaultsAvailable,
}: {
  initial: CredentialSafe;
  initialDefaults: LeadSharkAutomationDefaults;
  defaultsAvailable: boolean;
}) {
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    getHydratedSnapshot,
    getServerHydratedSnapshot,
  );
  const [cred, setCred] = useState<CredentialSafe>(initial);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [defaults, setDefaults] =
    useState<LeadSharkAutomationDefaults>(initialDefaults);
  const [savingDefaults, setSavingDefaults] = useState(false);

  const patchDefaults = (patch: Partial<LeadSharkAutomationDefaults>) =>
    setDefaults((current) => ({ ...current, ...patch }));

  const saveDefaults = async () => {
    const issues = validateLeadSharkAutomationDefaults(defaults);
    if (issues.length) {
      toast.error(issues[0].message);
      return;
    }
    setSavingDefaults(true);
    try {
      const data = await fetchJson<{
        ok: boolean;
        defaults?: LeadSharkAutomationDefaults;
        error?: string;
      }>("/api/integrations/leadshark/defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(defaults),
      });
      if (!data.ok) throw new Error(data.error ?? "Couldn't save defaults.");
      if (data.defaults) setDefaults(data.defaults);
      toast.success("Automation defaults saved.");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSavingDefaults(false);
    }
  };

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
        {
          method: "DELETE",
        },
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
          <StatusPill
            tone={connected ? "success" : invalid ? "warning" : "neutral"}
          >
            {connected ? "Connected" : invalid ? "Reconnect" : "Not connected"}
          </StatusPill>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {connected ? (
          <>
            <div className="flex flex-col gap-3 rounded-lg border border-state-success-border bg-state-success-bg p-3 sm:flex-row sm:items-center">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-state-success" />
              <div className="flex-1">
                <div className="text-sm font-medium">
                  Connected{cred.keyHint ? ` · key ${cred.keyHint}` : ""}
                </div>
                <div className="text-xs text-muted-foreground">
                  {verificationLabel(cred.lastVerifiedAt, hydrated)}
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
            <section className="space-y-4 rounded-xl border border-border/70 p-4">
              <div>
                <h3 className="text-sm font-semibold">Automation defaults</h3>
                <p className="text-xs text-muted-foreground">
                  Applied to each new lead-magnet automation. SwipeIn generates
                  the trigger keyword from that post and replaces{" "}
                  <code>{RESOURCE_NAME_TOKEN}</code> and{" "}
                  <code>{RESOURCE_URL_TOKEN}</code> with its selected resource.
                </p>
              </div>
              {!defaultsAvailable ? (
                <p
                  role="status"
                  className="rounded-lg border border-state-warning-border bg-state-warning-bg p-3 text-xs text-state-warning"
                >
                  These are the defaults SwipeIn will use. Saving changes will
                  be available after the Automation Defaults database update is
                  installed.
                </p>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="leadshark-default-dm">Default DM</Label>
                <Textarea
                  id="leadshark-default-dm"
                  value={defaults.dmTemplate}
                  onChange={(event) =>
                    patchDefaults({ dmTemplate: event.target.value })
                  }
                  rows={4}
                />
                <p className="text-xs text-muted-foreground">
                  Keep {RESOURCE_URL_TOKEN} in every DM so the right resource is
                  always delivered. {RESOURCE_NAME_TOKEN} is optional.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="leadshark-default-dm-variations">
                  DM variations (one per line)
                </Label>
                <Textarea
                  id="leadshark-default-dm-variations"
                  value={defaults.dmTemplateVariations.join("\n")}
                  onChange={(event) =>
                    patchDefaults({
                      dmTemplateVariations: lines(event.target.value),
                    })
                  }
                  rows={4}
                  placeholder={`Every variation must include ${RESOURCE_URL_TOKEN}`}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="leadshark-default-replies">
                    Comment replies (one per line)
                  </Label>
                  <Textarea
                    id="leadshark-default-replies"
                    value={defaults.commentReplyTemplates.join("\n")}
                    onChange={(event) =>
                      patchDefaults({
                        commentReplyTemplates: lines(event.target.value),
                      })
                    }
                    rows={4}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="leadshark-default-nonconnection">
                    Not connected replies (one per line)
                  </Label>
                  <Textarea
                    id="leadshark-default-nonconnection"
                    value={defaults.nonConnectionReplyTemplates.join("\n")}
                    onChange={(event) =>
                      patchDefaults({
                        nonConnectionReplyTemplates: lines(event.target.value),
                      })
                    }
                    rows={4}
                  />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <DefaultsToggle
                  checked={defaults.autoConnect}
                  onChange={(autoConnect) => patchDefaults({ autoConnect })}
                  label="Auto-connect"
                />
                <DefaultsToggle
                  checked={defaults.autoLike}
                  onChange={(autoLike) => patchDefaults({ autoLike })}
                  label="Auto-like comments"
                />
                <DefaultsToggle
                  checked={defaults.followUpEnabled}
                  onChange={(followUpEnabled) =>
                    patchDefaults({ followUpEnabled })
                  }
                  label="Send a follow-up DM"
                />
                <DefaultsToggle
                  checked={defaults.followUpOnlyIfNoResponse}
                  onChange={(followUpOnlyIfNoResponse) =>
                    patchDefaults({ followUpOnlyIfNoResponse })
                  }
                  label="Follow up only if no reply"
                />
              </div>
              {defaults.followUpEnabled ? (
                <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
                  <div className="space-y-1.5">
                    <Label htmlFor="leadshark-default-followup">
                      Follow-up message
                    </Label>
                    <Textarea
                      id="leadshark-default-followup"
                      value={defaults.followUpTemplate ?? ""}
                      onChange={(event) =>
                        patchDefaults({
                          followUpTemplate: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="leadshark-default-delay">
                      Delay (minutes)
                    </Label>
                    <Input
                      id="leadshark-default-delay"
                      type="number"
                      min={1}
                      max={43_200}
                      value={defaults.followUpDelayMinutes}
                      onChange={(event) =>
                        patchDefaults({
                          followUpDelayMinutes:
                            Number(event.target.value) || 60,
                        })
                      }
                    />
                  </div>
                </div>
              ) : null}
              <Button
                onClick={() => void saveDefaults()}
                disabled={savingDefaults || !defaultsAvailable}
              >
                {savingDefaults ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Save />
                )}
                Save automation defaults
              </Button>
            </section>
          </>
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
                <Button
                  onClick={connect}
                  disabled={busy || !apiKey.trim()}
                  className="gap-2"
                >
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
              We&apos;ll remove your stored API key. Automations already set up
              in LeadShark keep running there, but SwipeIn won&apos;t create new
              ones until you reconnect.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={disconnect} disabled={busy}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Disconnect"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
