"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { StatusPill, Toolbar } from "@/components/app-surface";
import {
  Loader2,
  RefreshCw,
  AlertCircle,
  Pencil,
  X,
  Plus,
  ExternalLink,
} from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";
import type { VoiceProfile } from "@/lib/claude";

// The persisted voice_profiles row, as returned by GET/POST /api/voice. The
// `profile` jsonb is null while pending or after a failed run.
export type VoiceRow = {
  id: string;
  linkedin_handle: string | null;
  profile_url: string | null;
  display_name: string | null;
  avatar_url: string | null;
  headline: string | null;
  profile: VoiceProfile | null;
  summary: string | null;
  source_post_count: number;
  status: "pending" | "ready" | "failed";
  error: string | null;
  model: string | null;
  generated_at: string | null;
  created_at: string;
  // When the current `pending` run started. Drives the stale-pending recovery
  // (a run that died mid-flight is flipped to `failed`). Null unless pending.
  pending_started_at: string | null;
};

type VoiceResponse = {
  ok: true;
  voice: VoiceRow | null;
  canRegenerate?: boolean;
  regenAvailableAt?: string | null;
  daysUntilRegen?: number;
};

export function VoiceManager({
  row,
  setRow,
  canRegenerate,
  regenAvailableAt,
  daysUntilRegen,
}: {
  row: VoiceRow | null;
  setRow: React.Dispatch<React.SetStateAction<VoiceRow | null>>;
  canRegenerate: boolean;
  regenAvailableAt: string | null;
  daysUntilRegen: number;
}) {
  const [cooldown, setCooldown] = useState({
    canRegenerate,
    regenAvailableAt,
    daysUntilRegen,
  });
  const [url, setUrl] = useState(row?.profile_url ?? "");
  const [busy, setBusy] = useState(false);
  // When a profile already exists we show the pretty profile card instead of
  // the raw URL field. This toggle reveals the field again so the user can
  // point the voice at a different profile.
  const [changingProfile, setChangingProfile] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Hard ceiling on poll attempts so a row that never settles can't spin the
  // loop (and the network) forever. The server flips a stuck `pending` row to
  // `failed` after STALE_PENDING_MS (5 min) on any GET, so in practice the poll
  // ends well before this. We set the ceiling generously past that window
  // (200 ticks * 3s ≈ 10 min) purely as a backstop against a pathological
  // never-recovering row; on hit we stop polling and surface a retry.
  const POLL_INTERVAL_MS = 3000;
  const MAX_POLL_ATTEMPTS = 200;
  const pollAttemptsRef = useRef(0);
  // Remember the last status we saw so a poll can detect the moment a run
  // settles (pending -> ready/failed) and fire the matching toast exactly once.
  // Generation is async (the POST returns a pending row and the work finishes
  // in the background), so the polling loop — not generate() — owns the
  // success/failure notification.
  const prevStatusRef = useRef<VoiceRow["status"] | undefined>(row?.status);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // While a row is `pending`, poll GET until it settles. This is the heart of
  // the async flow: the POST kicks off background work and returns immediately,
  // so this loop is what carries the UI from "Analyzing…" to the finished
  // profile (or a failure), and announces the transition.
  const refresh = useCallback(async () => {
    // Count this attempt first so a hung/never-settling run can't poll forever.
    // The server recovers a stuck `pending` row to `failed` within 5 min on any
    // GET, so this ceiling is only a backstop; on hit we stop and let the user
    // retry rather than spinning silently.
    pollAttemptsRef.current += 1;
    if (pollAttemptsRef.current > MAX_POLL_ATTEMPTS) {
      stopPolling();
      setRow((r) =>
        r && r.status === "pending"
          ? {
              ...r,
              status: "failed",
              error:
                "Generation is taking longer than expected. Please try again.",
            }
          : r,
      );
      prevStatusRef.current = "failed";
      return;
    }
    try {
      const data = await fetchJson<VoiceResponse>("/api/voice");
      if (!data.ok) return;
      setRow(data.voice);
      setCooldown({
        canRegenerate: data.canRegenerate ?? true,
        regenAvailableAt: data.regenAvailableAt ?? null,
        daysUntilRegen: data.daysUntilRegen ?? 0,
      });
      const next = data.voice?.status;
      // Fire a toast only on the actual pending -> settled transition, so we
      // don't re-announce on every 3s tick or on an initial load of a row
      // that was already ready/failed.
      if (prevStatusRef.current === "pending" && next && next !== "pending") {
        if (next === "ready") toast.success("Voice profile ready");
        else if (next === "failed") {
          toast.error(data.voice?.error || "Voice generation failed");
        }
      }
      prevStatusRef.current = next;
      if (next !== "pending") stopPolling();
    } catch {
      // Transient — keep polling; the next tick may succeed.
    }
  }, [stopPolling, setRow]);

  useEffect(() => {
    if (row?.status === "pending" && !pollRef.current) {
      // Fresh polling session — reset the attempt budget so a prior settled run
      // doesn't eat into this one's ceiling.
      pollAttemptsRef.current = 0;
      pollRef.current = setInterval(refresh, POLL_INTERVAL_MS);
    }
    return stopPolling;
  }, [row?.status, refresh, stopPolling]);

  async function generate() {
    setBusy(true);
    // Mark the baseline as pending so the first settling poll detects the
    // pending -> ready/failed transition and toasts (even on a first-ever run
    // where the previous status was undefined, or a regenerate from ready).
    prevStatusRef.current = "pending";
    // Optimistically reflect the pending state so the user sees progress
    // immediately, even before the POST returns.
    setRow((r) => (r ? { ...r, status: "pending", error: null } : null));
    try {
      // Generation is ASYNC: the POST kicks off the work in the background and
      // returns a `pending` row right away (202) — it no longer waits on the
      // scrape, so it can't time out / 504. We adopt that pending row; the
      // polling effect (keyed on status === "pending") then drives the UI to
      // ready/failed and fires the matching toast (see refresh()).
      const data = await fetchJson<VoiceResponse>("/api/voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile_url: url.trim() || undefined }),
      });
      if (!data.ok || !data.voice) throw new Error("Voice generation failed");
      setRow(data.voice);
      setCooldown({
        canRegenerate: data.canRegenerate ?? false,
        regenAvailableAt: data.regenAvailableAt ?? null,
        daysUntilRegen: data.daysUntilRegen ?? 0,
      });
      setChangingProfile(false);
    } catch (e) {
      toast.error((e as Error).message);
      // Pull the real row back (e.g. a fast validation failure or an
      // already-in-progress conflict left the server row in a known state).
      await refresh();
    }
    // The kickoff is done — hand off to the polling effect. isPending is driven
    // by the row's status from here, not `busy`.
    setBusy(false);
  }

  const profile = row?.profile;
  const isReady = row?.status === "ready" && profile;
  const isPending = row?.status === "pending" || busy;
  const isFailed = row?.status === "failed" && !busy;

  // Show the pretty LinkedIn-style card once a profile exists and the user
  // isn't actively pointing at a different profile. We keep showing it while a
  // regenerate is in flight (status flips to "pending" but we still have the
  // previous profile + display fields) so the UI doesn't flash back to the
  // bare input form mid-regenerate.
  const hasProfile = Boolean(row?.profile);
  const showProfileCard = hasProfile && !changingProfile;
  const cooldownNote =
    row && !cooldown.canRegenerate ? (
      <p className="text-xs text-muted-foreground">
        You can refresh your voice again in {cooldown.daysUntilRegen} day
        {cooldown.daysUntilRegen === 1 ? "" : "s"}
        {cooldown.regenAvailableAt
          ? ` (${new Date(cooldown.regenAvailableAt).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })})`
          : ""}
        .
      </p>
    ) : null;

  return (
    <div className="space-y-4">
      <Toolbar className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Voice setup</div>
          <div className="text-xs text-muted-foreground">
            Source profile, extracted writing traits, and standing preferences.
          </div>
        </div>
        <StatusPill tone={isReady ? "success" : isPending ? "warning" : isFailed ? "danger" : "neutral"}>
          {isReady ? "Ready" : isPending ? "Analyzing" : isFailed ? "Needs retry" : "Not set up"}
        </StatusPill>
      </Toolbar>

      {showProfileCard && row ? (
        <ProfileCard
          row={row}
          isPending={isPending}
          canRegenerate={cooldown.canRegenerate}
          cooldownNote={cooldownNote}
          onRegenerate={generate}
          onChangeProfile={() => setChangingProfile(true)}
        />
      ) : (
        /* Source / generate control. Shown on first run and when re-pointing
           the voice at a different profile. */
        <Card className="overflow-hidden border-border/70 bg-card/90 shadow-soft">
          <CardHeader>
            <div className="flex items-start gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-primary/10 bg-primary/[0.07] text-primary">
                <AiIcon className="h-4 w-4" />
              </div>
              <div className="min-w-0 space-y-1">
                <CardTitle className="text-base">Your LinkedIn profile</CardTitle>
                <CardDescription>
                  We&apos;ll read your last 50 posts to learn your voice. Paste your
                  public LinkedIn profile URL.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="profileUrl">Profile URL</Label>
              <Input
                id="profileUrl"
                type="url"
                placeholder="https://www.linkedin.com/in/your-handle/"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={isPending}
              />
            </div>

            {cooldownNote}

            <div className="flex items-center gap-2">
              <Button
                onClick={generate}
                disabled={isPending || (Boolean(row) && !cooldown.canRegenerate)}
              >
                {isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isReady ? (
                  <RefreshCw className="h-4 w-4" />
                ) : (
                  <AiIcon className="h-4 w-4" />
                )}
                {isPending
                  ? "Analyzing your posts…"
                  : isReady
                    ? "Regenerate voice"
                    : "Generate voice"}
              </Button>
              {/* Let the user back out to the existing card without generating. */}
              {isReady && !isPending ? (
                <Button variant="ghost" onClick={() => setChangingProfile(false)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      )}

      {isFailed ? (
        <Card className="border-destructive/30 bg-destructive/[0.035] shadow-soft">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2 text-destructive">
              <AlertCircle className="h-4 w-4" /> Generation failed
            </CardTitle>
            <CardDescription>
              {row?.error ||
                "Something went wrong. Check the profile URL is correct and public, then try again."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {isReady ? (
        <ProfileView
          row={row}
          profile={profile}
          onSaved={(saved) => setRow(saved)}
        />
      ) : null}
    </div>
  );
}

// Turn a linkedin slug into a presentable name when we have no real display
// name: "jane-doe-12345" -> "Jane Doe". Drops trailing id-ish segments.
function prettifyHandle(handle: string | null): string {
  if (!handle) return "Your profile";
  const words = handle
    .split("-")
    .filter((w) => w && !/^\d+$/.test(w) && !/^[0-9a-f]{6,}$/i.test(w));
  const titled = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  return titled || handle;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0).toUpperCase()).join("") || "?";
}

// A LinkedIn-style profile card shown once a voice profile exists: avatar
// (with initials fallback), name, headline, a link to the profile, and the
// regenerate controls. Replaces the bare URL input so the "source" section
// sits prettier.
function ProfileCard({
  row,
  isPending,
  canRegenerate,
  cooldownNote,
  onRegenerate,
  onChangeProfile,
}: {
  row: VoiceRow;
  isPending: boolean;
  canRegenerate: boolean;
  cooldownNote: React.ReactNode;
  onRegenerate: () => void;
  onChangeProfile: () => void;
}) {
  const name = row.display_name?.trim() || prettifyHandle(row.linkedin_handle);
  const initials = initialsOf(name);
  // LinkedIn CDN URLs can expire; fall back to the initials avatar on error.
  // Track which URL broke so a fresh avatar_url (e.g. after regenerate) resets
  // the fallback instead of staying stuck on initials.
  const [brokenAvatarUrl, setBrokenAvatarUrl] = useState<string | null>(null);
  const showAvatar = Boolean(row.avatar_url) && brokenAvatarUrl !== row.avatar_url;

  return (
    <Card className="overflow-hidden border-border/70 bg-card/90 shadow-soft">
      <CardContent className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="shrink-0">
              {showAvatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={row.avatar_url as string}
                  alt={name}
                  onError={() => setBrokenAvatarUrl(row.avatar_url)}
                className="h-20 w-20 rounded-2xl border border-border/70 object-cover bg-muted"
              />
            ) : (
                <div className="grid h-20 w-20 place-items-center rounded-2xl border border-border/70 bg-muted text-xl font-semibold text-muted-foreground">
                  {initials}
                </div>
              )}
            </div>
            <div className="min-w-0">
              <div className="truncate text-lg font-semibold leading-tight">{name}</div>
              {row.headline ? (
                <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                  {row.headline}
                </p>
              ) : null}
              {row.profile_url ? (
                <a
                  href={row.profile_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  View on LinkedIn <ExternalLink className="h-3 w-3" />
                </a>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {row.source_post_count > 0 ? (
            <StatusPill tone="info">
              Voice learned from {row.source_post_count} recent post
              {row.source_post_count === 1 ? "" : "s"}
            </StatusPill>
          ) : null}
        </div>

        {cooldownNote}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onRegenerate} disabled={isPending || !canRegenerate}>
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {isPending ? "Analyzing your posts…" : "Regenerate voice"}
          </Button>
          <Button variant="outline" onClick={onChangeProfile} disabled={isPending}>
            Use a different profile
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ProfileView({
  row,
  profile,
  onSaved,
}: {
  row: VoiceRow;
  profile: VoiceProfile;
  onSaved: (saved: VoiceRow) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<VoiceProfile>(profile);
  const [saving, setSaving] = useState(false);

  // Keep the draft in sync when the underlying profile changes (e.g. after a
  // regenerate) using React's "adjust state during render" pattern — no effect,
  // no ref. We track the last profile we synced from in state; when a new
  // profile arrives and we're not mid-edit, reset the draft. React re-runs the
  // render immediately with the updated state instead of painting stale UI.
  const [syncedProfile, setSyncedProfile] = useState(profile);
  if (!editing && syncedProfile !== profile) {
    setSyncedProfile(profile);
    setDraft(profile);
  }

  const startEdit = () => {
    setDraft(profile);
    setEditing(true);
  };
  const cancelEdit = () => {
    setDraft(profile);
    setEditing(false);
  };

  async function save() {
    if (!draft.summary.trim()) {
      toast.error("The summary can't be empty.");
      return;
    }
    setSaving(true);
    try {
      const data = await fetchJson<VoiceResponse>("/api/voice", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: draft }),
      });
      if (!data.ok || !data.voice) throw new Error("Couldn't save your edits");
      onSaved(data.voice);
      setEditing(false);
      toast.success("Voice profile updated");
    } catch (e) {
      toast.error((e as Error).message);
    }
    setSaving(false);
  }

  const generatedOn = row.generated_at
    ? new Date(row.generated_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null;

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden border-border/70 bg-card/90 shadow-soft">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-base">Voice summary</CardTitle>
              <CardDescription>
                {row.source_post_count > 0
                  ? `Synthesized from ${row.source_post_count} of your recent post${
                      row.source_post_count === 1 ? "" : "s"
                    }`
                  : "Synthesized from your recent posts"}
                {generatedOn ? ` · last updated ${generatedOn}` : ""}
              </CardDescription>
            </div>
            {editing ? (
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>
                  <X className="h-4 w-4" /> Cancel
                </Button>
                <Button size="sm" onClick={save} disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Save changes
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" className="shrink-0" onClick={startEdit}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {editing ? (
            <EditProfileForm draft={draft} setDraft={setDraft} />
          ) : (
            <ReadProfile profile={profile} />
          )}
        </CardContent>
      </Card>

      {!editing && profile.exemplars.length > 0 ? (
        <Card className="overflow-hidden border-border/70 bg-card/90 shadow-soft">
          <CardHeader>
            <CardTitle className="text-base">Style exemplars</CardTitle>
            <CardDescription>
              A few of your own posts, used as anchors when drafting in your voice.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {profile.exemplars.map((ex, i) => (
              <div
                key={i}
                className="rounded-lg border border-border/60 bg-background/55 p-3 text-sm whitespace-pre-wrap leading-relaxed text-foreground"
              >
                {ex}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {!editing &&
      profile.lead_magnet_style &&
      profile.lead_magnet_style.exemplars.length > 0 ? (
        <Card className="overflow-hidden border-border/70 bg-card/90 shadow-soft">
          <CardHeader>
            <CardTitle className="text-base">Lead magnet exemplars</CardTitle>
            <CardDescription>
              A few of your promotional / giveaway posts. Used only when drafting a
              lead magnet — not your regular posts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {profile.lead_magnet_style.exemplars.map((ex, i) => (
              <div
                key={i}
                className="rounded-lg border border-border/60 bg-background/55 p-3 text-sm whitespace-pre-wrap leading-relaxed text-foreground"
              >
                {ex}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// Read-only rendering of the profile (the original ProfileView body).
function ReadProfile({ profile }: { profile: VoiceProfile }) {
  return (
    <>
      {profile.summary ? (
        <p className="text-sm text-foreground leading-relaxed">{profile.summary}</p>
      ) : null}

      <Section title="Audience">
        {profile.audience.primary ? (
          <p className="text-sm text-muted-foreground">{profile.audience.primary}</p>
        ) : null}
        <ChipList label="Pain points" items={profile.audience.pain_points} />
        <ChipList label="Outcomes" items={profile.audience.outcomes} />
      </Section>

      <ChipSection title="Topics" items={profile.topics} />

      {profile.positioning ? (
        <Section title="Positioning">
          <p className="text-sm text-muted-foreground">{profile.positioning}</p>
        </Section>
      ) : null}

      <ChipSection title="Tone" items={profile.tone} />

      <Section title="Format patterns">
        <ChipList label="Hook styles" items={profile.format_patterns.hook_styles} />
        <LabeledValue label="Structure" value={profile.format_patterns.structure} />
        <LabeledValue label="Length" value={profile.format_patterns.length} />
        <LabeledValue
          label="Sentence rhythm"
          value={profile.format_patterns.sentence_rhythm}
        />
        <LabeledValue label="Paragraphing" value={profile.format_patterns.paragraphing} />
        <ChipList label="Vocabulary" items={profile.format_patterns.vocabulary} />
        <LabeledValue label="Punctuation" value={profile.format_patterns.punctuation} />
        <ChipList
          label="Rhetorical devices"
          items={profile.format_patterns.rhetorical_devices}
        />
      </Section>

      <ChipSection title="Signature moves" items={profile.signature_moves} />
      <ChipSection title="Do" items={profile.do} />
      <ChipSection title="Don't" items={profile.dont} />

      {profile.lead_magnet_style ? (
        <Section title="Lead magnet style">
          <p className="text-xs text-muted-foreground">
            How you run promotional / giveaway posts. Kept separate from your
            regular voice — used only when drafting a lead magnet.
          </p>
          <ChipList label="Hook styles" items={profile.lead_magnet_style.hook_styles} />
          <ChipList label="CTA patterns" items={profile.lead_magnet_style.cta_patterns} />
        </Section>
      ) : null}
    </>
  );
}

function LabeledValue({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <p className="text-sm text-muted-foreground">
      <span className="font-medium text-foreground">{label}:</span> {value}
    </p>
  );
}

// Editable form mirroring ReadProfile. Every field maps to a draft setter;
// arrays use an add/remove chip editor. Exemplars are editable here too so the
// whole profile is hand-tunable. The summary is required (enforced on save).
function EditProfileForm({
  draft,
  setDraft,
}: {
  draft: VoiceProfile;
  setDraft: React.Dispatch<React.SetStateAction<VoiceProfile>>;
}) {
  // Helpers that produce a new profile with one field replaced (immutable
  // updates so React re-renders).
  const setField = <K extends keyof VoiceProfile>(key: K, value: VoiceProfile[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setAudience = <K extends keyof VoiceProfile["audience"]>(
    key: K,
    value: VoiceProfile["audience"][K],
  ) => setDraft((d) => ({ ...d, audience: { ...d.audience, [key]: value } }));
  const setFormat = <K extends keyof VoiceProfile["format_patterns"]>(
    key: K,
    value: VoiceProfile["format_patterns"][K],
  ) =>
    setDraft((d) => ({
      ...d,
      format_patterns: { ...d.format_patterns, [key]: value },
    }));
  // Lead-magnet block is optional; this only fires when the draft already has
  // one (the section below renders conditionally). Replaces one LM field
  // immutably, preserving the others.
  const setLeadMagnet = <K extends keyof NonNullable<VoiceProfile["lead_magnet_style"]>>(
    key: K,
    value: NonNullable<VoiceProfile["lead_magnet_style"]>[K],
  ) =>
    setDraft((d) =>
      d.lead_magnet_style
        ? { ...d, lead_magnet_style: { ...d.lead_magnet_style, [key]: value } }
        : d,
    );

  return (
    <div className="space-y-5">
      <EditField label="Summary" required>
        <Textarea
          value={draft.summary}
          onChange={(e) => setField("summary", e.target.value)}
          rows={3}
          placeholder="2-3 sentences describing your voice and what you post about."
        />
      </EditField>

      <EditSection title="Audience">
        <EditField label="Primary audience">
          <Input
            value={draft.audience.primary}
            onChange={(e) => setAudience("primary", e.target.value)}
            placeholder="Who you write for"
          />
        </EditField>
        <ChipEditor
          label="Pain points"
          items={draft.audience.pain_points}
          onChange={(items) => setAudience("pain_points", items)}
        />
        <ChipEditor
          label="Outcomes"
          items={draft.audience.outcomes}
          onChange={(items) => setAudience("outcomes", items)}
        />
      </EditSection>

      <ChipEditor
        label="Topics"
        items={draft.topics}
        onChange={(items) => setField("topics", items)}
      />

      <EditField label="Positioning">
        <Textarea
          value={draft.positioning}
          onChange={(e) => setField("positioning", e.target.value)}
          rows={2}
          placeholder="Your distinct angle / what sets you apart"
        />
      </EditField>

      <ChipEditor
        label="Tone"
        items={draft.tone}
        onChange={(items) => setField("tone", items)}
      />

      <EditSection title="Format patterns">
        <ChipEditor
          label="Hook styles"
          items={draft.format_patterns.hook_styles}
          onChange={(items) => setFormat("hook_styles", items)}
        />
        <EditField label="Structure">
          <Textarea
            value={draft.format_patterns.structure}
            onChange={(e) => setFormat("structure", e.target.value)}
            rows={2}
            placeholder="How you build a post"
          />
        </EditField>
        <EditField label="Length">
          <Input
            value={draft.format_patterns.length}
            onChange={(e) => setFormat("length", e.target.value)}
            placeholder="Typical length tendency"
          />
        </EditField>
        <EditField label="Sentence rhythm">
          <Textarea
            value={draft.format_patterns.sentence_rhythm}
            onChange={(e) => setFormat("sentence_rhythm", e.target.value)}
            rows={2}
            placeholder="Sentence lengths, cadence, fragments, and transitions"
          />
        </EditField>
        <EditField label="Paragraphing">
          <Textarea
            value={draft.format_patterns.paragraphing}
            onChange={(e) => setFormat("paragraphing", e.target.value)}
            rows={2}
            placeholder="Paragraph length, line breaks, and whitespace habits"
          />
        </EditField>
        <ChipEditor
          label="Vocabulary"
          items={draft.format_patterns.vocabulary}
          onChange={(items) => setFormat("vocabulary", items)}
        />
        <EditField label="Punctuation">
          <Textarea
            value={draft.format_patterns.punctuation}
            onChange={(e) => setFormat("punctuation", e.target.value)}
            rows={2}
            placeholder="Punctuation and capitalization habits"
          />
        </EditField>
        <ChipEditor
          label="Rhetorical devices"
          items={draft.format_patterns.rhetorical_devices}
          onChange={(items) => setFormat("rhetorical_devices", items)}
        />
      </EditSection>

      <ChipEditor
        label="Signature moves"
        items={draft.signature_moves}
        onChange={(items) => setField("signature_moves", items)}
      />
      <ChipEditor
        label="Do"
        items={draft.do}
        onChange={(items) => setField("do", items)}
      />
      <ChipEditor
        label="Don't"
        items={draft.dont}
        onChange={(items) => setField("dont", items)}
      />

      <EditSection title="Style exemplars">
        <p className="text-xs text-muted-foreground">
          Up to 3 of your own posts, used as anchors when drafting in your voice.
        </p>
        <ExemplarEditor
          items={draft.exemplars}
          onChange={(items) => setField("exemplars", items)}
        />
      </EditSection>

      {(draft.interview_context?.length ?? 0) > 0 ? (
        <EditSection title="Interview context">
          <p className="text-xs text-muted-foreground">
            Context distilled from your interview answers — used in every draft.
            Edit or remove any line. (Re-answer the interview below to regenerate.)
          </p>
          <ExemplarEditor
            items={draft.interview_context ?? []}
            onChange={(items) => setField("interview_context", items)}
          />
        </EditSection>
      ) : null}

      {draft.lead_magnet_style ? (
        <EditSection title="Lead magnet style">
          <p className="text-xs text-muted-foreground">
            How you run promotional / giveaway posts — kept separate from your
            regular voice. Clear every field to remove this section on save.
          </p>
          <ChipEditor
            label="Hook styles"
            items={draft.lead_magnet_style.hook_styles}
            onChange={(items) => setLeadMagnet("hook_styles", items)}
          />
          <ChipEditor
            label="CTA patterns"
            items={draft.lead_magnet_style.cta_patterns}
            onChange={(items) => setLeadMagnet("cta_patterns", items)}
          />
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wide">
              Lead magnet exemplars
            </Label>
            <ExemplarEditor
              items={draft.lead_magnet_style.exemplars}
              onChange={(items) => setLeadMagnet("exemplars", items)}
            />
          </div>
        </EditSection>
      ) : null}
    </div>
  );
}

// A labeled wrapper for a single editable field.
function EditField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wide">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
    </div>
  );
}

// A titled group in the edit form (mirror of read-mode Section).
function EditSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2.5 rounded-lg border border-border/60 p-3">
      <div className="text-xs font-semibold text-foreground uppercase tracking-wide">
        {title}
      </div>
      {children}
    </div>
  );
}

// Add/remove editor for a string[] field. Type + Enter (or click +) to add;
// each chip has an × to remove. Caps mirror the server (6, except exemplars).
function ChipEditor({
  label,
  items,
  onChange,
  cap = 6,
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  cap?: number;
}) {
  const [value, setValue] = useState("");
  const add = () => {
    const v = value.trim();
    if (!v || items.length >= cap) return;
    // Skip a case-insensitive duplicate — adding "Founders" when "founders" is
    // already a chip just clutters the field. Clear the input either way so the
    // add still feels handled.
    if (items.some((it) => it.toLowerCase() === v.toLowerCase())) {
      setValue("");
      return;
    }
    onChange([...items, v]);
    setValue("");
  };
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground/80 uppercase tracking-wide">
        {label}
      </Label>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-secondary pl-2.5 pr-1.5 py-0.5 text-xs text-secondary-foreground"
            >
              {it}
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${it}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {items.length < cap ? (
        <div className="flex gap-2">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder={`Add ${label.toLowerCase()}…`}
            className="h-8 text-sm"
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={add}
            disabled={!value.trim()}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Max {cap} reached.</p>
      )}
    </div>
  );
}

// Exemplars are full post bodies, so each gets its own textarea (not a chip).
function ExemplarEditor({
  items,
  onChange,
  cap = 3,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  cap?: number;
}) {
  const update = (i: number, v: string) =>
    onChange(items.map((it, idx) => (idx === i ? v : it)));
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  const addBlank = () => {
    if (items.length >= cap) return;
    onChange([...items, ""]);
  };

  return (
    <div className="space-y-2">
      {items.map((ex, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Exemplar {i + 1}</span>
            <button
              type="button"
              onClick={() => remove(i)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
            >
              <X className="h-3 w-3" /> Remove
            </button>
          </div>
          <Textarea
            value={ex}
            onChange={(e) => update(i, e.target.value)}
            rows={4}
            className="text-sm"
            placeholder="Paste one of your own posts verbatim."
          />
        </div>
      ))}
      {items.length < cap ? (
        <Button type="button" size="sm" variant="outline" onClick={addBlank}>
          <Plus className="h-4 w-4" /> Add exemplar
        </Button>
      ) : null}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide">
        {title}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function ChipSection({ title, items }: { title: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <Section title={title}>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it, i) => (
          <Badge key={i} variant="secondary" className="font-normal">
            {it}
          </Badge>
        ))}
      </div>
    </Section>
  );
}

function ChipList({ label, items }: { label: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it, i) => (
          <Badge key={i} variant="secondary" className="font-normal">
            {it}
          </Badge>
        ))}
      </div>
    </div>
  );
}
