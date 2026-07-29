"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Zap, Loader2, Plus, X, AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/api-fetch";
import {
  validateAutomationConfig,
  containsUrl,
  ALLOWED_TEMPLATE_VARS,
  type AutomationConfigDraft,
} from "@/lib/leadshark-config";

// Follow-up delay dropdown → minutes. Mirrors LeadShark's own presets so people
// don't compute "2880" for two days.
const DELAY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "15", label: "15 minutes" },
  { value: "60", label: "1 hour" },
  { value: "240", label: "4 hours" },
  { value: "1440", label: "1 day" },
  { value: "4320", label: "3 days" },
];

type AutomationStatus =
  | "configured"
  | "binding"
  | "awaiting_urn"
  | "active"
  | "paused"
  | "failed"
  | "deleted";

type ServerAutomation = {
  id: string;
  status: AutomationStatus;
  config: AutomationConfigDraft & { name: string };
  linkedinPostUrl: string | null;
  lastError: string | null;
  stats: Record<string, number>;
  statsSyncedAt: string | null;
} | null;

type GetResponse = {
  ok: boolean;
  eligible: boolean;
  credentialConnected: boolean;
  automation: ServerAutomation;
  prefill: {
    keyword: string;
    dmTemplate: string;
    leadMagnetId: string | null;
    leadMagnetTitle: string | null;
    leadMagnetUrl: string | null;
    config: AutomationConfigDraft;
  } | null;
};

type FormState = AutomationConfigDraft & { leadMagnetId: string | null };

function blankForm(): FormState {
  return {
    keywords: [],
    dmTemplate: "",
    dmTemplateVariations: [],
    commentReplyTemplates: [],
    nonConnectionReplyTemplates: [],
    autoConnect: false,
    autoLike: false,
    followUpEnabled: false,
    followUpTemplate: null,
    followUpDelayMinutes: 60,
    followUpOnlyIfNoResponse: true,
    leadMagnetId: null,
  };
}

// Hand-rolled toggle (no Checkbox/Switch primitive exists in components/ui).
function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  hint?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex w-full items-start gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2 text-left text-sm transition",
        checked && "border-primary/40 bg-primary/[0.06]",
        disabled && "opacity-60",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border",
          checked ? "border-primary bg-primary text-primary-foreground" : "border-border",
        )}
      >
        {checked ? <CheckCircle2 className="h-3 w-3" /> : null}
      </span>
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </button>
  );
}

// A small string-list editor (keywords, DM variations, reply templates).
function ListEditor({
  values,
  onChange,
  placeholder,
  addLabel,
  multiline,
  max,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addLabel: string;
  multiline?: boolean;
  max?: number;
}) {
  const set = (i: number, v: string) => onChange(values.map((x, j) => (j === i ? v : x)));
  const remove = (i: number) => onChange(values.filter((_, j) => j !== i));
  const atMax = max != null && values.length >= max;
  return (
    <div className="space-y-2">
      {values.map((v, i) => (
        <div key={i} className="flex items-start gap-2">
          {multiline ? (
            <Textarea
              value={v}
              onChange={(e) => set(i, e.target.value)}
              placeholder={placeholder}
              className="min-h-16 flex-1"
            />
          ) : (
            <Input
              value={v}
              onChange={(e) => set(i, e.target.value)}
              placeholder={placeholder}
              className="flex-1"
            />
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => remove(i)}
            aria-label="Remove"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      {!atMax ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1"
          onClick={() => onChange([...values, ""])}
        >
          <Plus className="h-3.5 w-3.5" /> {addLabel}
        </Button>
      ) : null}
    </div>
  );
}

function StatusBanner({ status, error }: { status: AutomationStatus; error: string | null }) {
  const map: Record<AutomationStatus, { tone: "neutral" | "info" | "success" | "warning" | "danger"; text: string }> = {
    configured: { tone: "neutral", text: "Automation ready — activates when this publishes." },
    binding: { tone: "info", text: "Setting up automation…" },
    awaiting_urn: {
      tone: "warning",
      text: error || "Couldn't find your post automatically. Paste its URL below to activate.",
    },
    active: { tone: "success", text: "Automation active." },
    paused: { tone: "neutral", text: "Paused." },
    failed: { tone: "danger", text: error || "Automation failed." },
    deleted: { tone: "neutral", text: "Removed." },
  };
  const { tone, text } = map[status];
  const cls =
    tone === "success"
      ? "border-state-success-border bg-state-success-bg text-state-success"
      : tone === "warning"
        ? "border-state-warning-border bg-state-warning-bg text-state-warning"
        : tone === "danger"
          ? "border-state-danger-border bg-state-danger-bg text-state-danger"
          : "border-border/60 bg-background/45 text-muted-foreground";
  return <div className={cn("rounded-md border px-3 py-2 text-xs", cls)}>{text}</div>;
}

// The LeadShark automation panel — beside the schedule controls in the Posts
// draft editor AND inline on the Cowork chat draft card, for lead-magnet drafts.
// Configures the comment→DM automation and shows its binding status once the
// post publishes. Takes just the persisted draft id (== chat_artifacts.id / board draft id) —
// all its data comes from /api/drafts/:id/automation, so it needs nothing else.
// This lets it mount from the Cowork chat draft card as well as the Posts-board
// draft editor.
export function LeadSharkPanel({ draftId }: { draftId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [data, setData] = useState<GetResponse | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [form, setForm] = useState<FormState>(blankForm());
  const [busy, setBusy] = useState(false);
  // Whether a config has been persisted for this draft (drives the Remove
  // button). State, not a ref, so it re-renders — and so it's never read during
  // render from a ref.
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchJson<GetResponse>(
        `/api/drafts/${draftId}/automation`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      setData(res);
      if (res.automation) {
        setEnabled(true);
        setForm({ ...res.automation.config, leadMagnetId: res.prefill?.leadMagnetId ?? null });
        setSaved(true);
      } else if (res.prefill) {
        // Seed the form with prefills but keep the toggle off until the user opts in.
        setForm((f) => ({
          ...f,
          ...res.prefill!.config,
          leadMagnetId: res.prefill!.leadMagnetId,
        }));
      }
    } catch {
      /* leave defaults */
    } finally {
      setLoaded(true);
    }
  }, [draftId]);

  useEffect(() => {
    // Mount fetch of the automation config from the API (an external system).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const patch = (p: Partial<FormState>) => setForm((f) => ({ ...f, ...p }));

  const issues = useMemo(() => validateAutomationConfig(form), [form]);
  const dmHasNoUrl = enabled && form.dmTemplate.trim() !== "" && !containsUrl(form.dmTemplate);

  const save = async () => {
    if (busy) return;
    if (issues.length) {
      toast.error(issues[0].message);
      return;
    }
    setBusy(true);
    try {
      const res = await fetchJson<{ ok: boolean; error?: string; automation?: ServerAutomation }>(
        `/api/drafts/${draftId}/automation`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        },
      );
      if (!res.ok) throw new Error(res.error || "Couldn't save the automation.");
      setSaved(true);
      if (res.automation) {
        setData((d) => (d ? { ...d, automation: res.automation! } : d));
      }
      toast.success("Automation saved.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeAutomation = async () => {
    setBusy(true);
    try {
      const res = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/drafts/${draftId}/automation`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(res.error || "Couldn't remove the automation.");
      setEnabled(false);
      setSaved(false);
      setData((d) => (d ? { ...d, automation: null } : d));
      toast.success("Automation removed.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking LeadShark…
      </div>
    );
  }
  if (!data?.eligible) return null;

  // No credential → a dismissible hint linking to Integrations (nobody finds a
  // feature that only appears after configuring something they've never heard of).
  if (!data.credentialConnected) {
    return (
      <div className="rounded-lg border border-border/60 bg-background/45 p-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Zap className="h-4 w-4" /> LeadShark automation
        </div>
        <p className="mt-1">
          Auto-DM people who comment on this post. Connect LeadShark in{" "}
          <Link href="/dashboard/integrations" className="underline underline-offset-2">
            Integrations
          </Link>{" "}
          to enable it.
        </p>
      </div>
    );
  }

  const existing = data.automation;
  const readOnly = !!existing && existing.status !== "configured";

  return (
    <section className="space-y-3 rounded-lg border border-border/60 bg-background/40 p-3">
      <Toggle
        checked={enabled}
        onChange={(v) => setEnabled(v)}
        disabled={readOnly}
        label={
          <span className="inline-flex items-center gap-1.5">
            <Zap className="h-4 w-4 text-primary" /> LeadShark automation
          </span>
        }
        hint="Auto-DM people who comment on this post."
      />

      {existing ? <StatusBanner status={existing.status} error={existing.lastError} /> : null}

      {enabled && !readOnly ? (
        <div className="space-y-4">
          {/* Trigger */}
          <div className="space-y-1.5">
            <Label className="text-xs">Trigger keyword — not case-sensitive</Label>
            <ListEditor
              values={form.keywords}
              onChange={(v) => patch({ keywords: v })}
              placeholder="PLAYBOOK"
              addLabel="Add keyword"
              max={20}
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to reply to every comment.
            </p>
          </div>

          {/* DM */}
          <div className="space-y-1.5">
            <Label className="text-xs">DM to send</Label>
            <Textarea
              value={form.dmTemplate}
              onChange={(e) => patch({ dmTemplate: e.target.value })}
              placeholder="Hey {{firstName}}! Here's the…"
              className="min-h-20"
            />
            <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 break-words font-mono">
                {ALLOWED_TEMPLATE_VARS.map((v) => `{{${v}}}`).join("  ")}
              </span>
              <span className={cn("shrink-0", form.dmTemplate.length > 2000 && "text-state-danger")}>
                {form.dmTemplate.length}/2000
              </span>
            </div>
            {dmHasNoUrl ? (
              <p className="flex items-center gap-1 text-xs text-state-warning">
                <AlertTriangle className="h-3 w-3" /> Your DM has no link — that&apos;s usually the
                whole point.
              </p>
            ) : null}
            <div>
              <Label className="text-xs text-muted-foreground">DM variations (rotated)</Label>
              <ListEditor
                values={form.dmTemplateVariations}
                onChange={(v) => patch({ dmTemplateVariations: v })}
                placeholder="A second phrasing of the same DM"
                addLabel="Add variation"
                multiline
                max={10}
              />
            </div>
          </div>

          {/* Replies */}
          <div className="space-y-2 border-t border-border/50 pt-3">
            <Label className="text-xs">When the DM sends (comment reply)</Label>
            <ListEditor
              values={form.commentReplyTemplates}
              onChange={(v) => patch({ commentReplyTemplates: v })}
              placeholder="{{firstNameMention}} just sent it — check your DMs!"
              addLabel="Add reply"
              multiline
              max={10}
            />
            <Label className="text-xs">When they&apos;re not connected (DM can&apos;t send)</Label>
            <ListEditor
              values={form.nonConnectionReplyTemplates}
              onChange={(v) => patch({ nonConnectionReplyTemplates: v })}
              placeholder="{{firstNameMention}}, connect with me and I'll send it over."
              addLabel="Add reply"
              multiline
              max={10}
            />
          </div>

          {/* Engagement */}
          <div className="space-y-2 border-t border-border/50 pt-3">
            <Toggle
              checked={form.autoConnect}
              onChange={(v) => patch({ autoConnect: v })}
              label="Auto-connect"
              hint="⚠ Higher account risk — connection requests at volume can trigger restrictions."
            />
            <Toggle
              checked={form.autoLike}
              onChange={(v) => patch({ autoLike: v })}
              label="Auto-like the comment"
              hint="Requires LeadShark Pro+. If your plan doesn't include it, we'll set the rest up without it."
            />
          </div>

          {/* Follow-up */}
          <div className="space-y-2 border-t border-border/50 pt-3">
            <Toggle
              checked={form.followUpEnabled}
              onChange={(v) => patch({ followUpEnabled: v })}
              label="Send a follow-up DM"
            />
            {form.followUpEnabled ? (
              <div className="space-y-2 pl-1">
                <Textarea
                  value={form.followUpTemplate ?? ""}
                  onChange={(e) => patch({ followUpTemplate: e.target.value })}
                  placeholder="Hey {{firstName}}, just following up…"
                  className="min-h-16"
                />
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Send after</span>
                  <Select
                    value={String(form.followUpDelayMinutes)}
                    onValueChange={(v) => patch({ followUpDelayMinutes: Number(v) })}
                  >
                    <SelectTrigger size="sm" className="w-32">
                      <SelectValue>
                        {(v: string) =>
                          DELAY_OPTIONS.find((o) => o.value === v)?.label ?? `${v} min`
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {DELAY_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Toggle
                  checked={form.followUpOnlyIfNoResponse}
                  onChange={(v) => patch({ followUpOnlyIfNoResponse: v })}
                  label="Only if they haven't replied"
                />
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={busy || issues.length > 0}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save automation"}
            </Button>
            {saved ? (
              <Button size="sm" variant="ghost" onClick={removeAutomation} disabled={busy}>
                Remove
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {readOnly ? (
        <p className="text-xs text-muted-foreground">
          This automation is live. Manage it in LeadShark, or remove it here.
          <Button
            size="sm"
            variant="ghost"
            className="ml-2"
            onClick={removeAutomation}
            disabled={busy}
          >
            Remove
          </Button>
        </p>
      ) : null}
    </section>
  );
}
