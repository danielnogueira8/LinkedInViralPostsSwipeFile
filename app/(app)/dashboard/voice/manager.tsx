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
import {
  Loader2,
  Sparkles,
  RefreshCw,
  AlertCircle,
  Pencil,
  X,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";
import type { VoiceProfile } from "@/lib/claude";

// The persisted voice_profiles row, as returned by GET/POST /api/voice. The
// `profile` jsonb is null while pending or after a failed run.
export type VoiceRow = {
  id: string;
  linkedin_handle: string | null;
  profile_url: string | null;
  profile: VoiceProfile | null;
  summary: string | null;
  source_post_count: number;
  status: "pending" | "ready" | "failed";
  error: string | null;
  model: string | null;
  generated_at: string | null;
  created_at: string;
};

type VoiceResponse = {
  ok: true;
  voice: VoiceRow | null;
  canRegenerate?: boolean;
  regenAvailableAt?: string | null;
  daysUntilRegen?: number;
};

export function VoiceManager({
  initialRow,
  canRegenerate,
  regenAvailableAt,
  daysUntilRegen,
}: {
  initialRow: VoiceRow | null;
  canRegenerate: boolean;
  regenAvailableAt: string | null;
  daysUntilRegen: number;
}) {
  const [row, setRow] = useState<VoiceRow | null>(initialRow);
  const [cooldown, setCooldown] = useState({
    canRegenerate,
    regenAvailableAt,
    daysUntilRegen,
  });
  const [url, setUrl] = useState(initialRow?.profile_url ?? "");
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // If we ever land on a `pending` row (e.g. an onboarding fire-and-forget run
  // is still in flight), poll the GET endpoint until it settles. The POST below
  // is synchronous, so this is mostly a safety net for cross-tab/onboarding.
  const refresh = useCallback(async () => {
    try {
      const data = await fetchJson<VoiceResponse>("/api/voice");
      if (!data.ok) return;
      setRow(data.voice);
      setCooldown({
        canRegenerate: data.canRegenerate ?? true,
        regenAvailableAt: data.regenAvailableAt ?? null,
        daysUntilRegen: data.daysUntilRegen ?? 0,
      });
      if (data.voice?.status !== "pending") stopPolling();
    } catch {
      // Transient — keep polling; the next tick may succeed.
    }
  }, [stopPolling]);

  useEffect(() => {
    if (row?.status === "pending" && !pollRef.current) {
      pollRef.current = setInterval(refresh, 3000);
    }
    return stopPolling;
  }, [row?.status, refresh, stopPolling]);

  async function generate() {
    setBusy(true);
    // Optimistically reflect the pending state so the user sees progress
    // immediately (the POST takes ~15-25s end to end).
    setRow((r) =>
      r
        ? { ...r, status: "pending", error: null }
        : null,
    );
    try {
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
      toast.success("Voice profile ready");
    } catch (e) {
      toast.error((e as Error).message);
      // Pull the real row back (the route flips it to `failed` on error).
      await refresh();
    }
    setBusy(false);
  }

  const profile = row?.profile;
  const isReady = row?.status === "ready" && profile;
  const isPending = row?.status === "pending" || busy;
  const isFailed = row?.status === "failed" && !busy;

  return (
    <div className="space-y-4 max-w-2xl">
      {/* Source / generate control. Always shown so the user can (re)point at a
          profile, subject to the cooldown once a profile exists. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your LinkedIn profile</CardTitle>
          <CardDescription>
            We&apos;ll read your last 50 posts to learn your voice. Paste your
            profile URL (e.g. https://www.linkedin.com/in/your-handle/).
          </CardDescription>
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

          {row && !cooldown.canRegenerate ? (
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
          ) : null}

          <Button
            onClick={generate}
            disabled={isPending || (Boolean(row) && !cooldown.canRegenerate)}
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isReady ? (
              <RefreshCw className="h-4 w-4" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {isPending
              ? "Analyzing your posts…"
              : isReady
                ? "Regenerate voice"
                : "Generate voice"}
          </Button>
        </CardContent>
      </Card>

      {isFailed ? (
        <Card className="border-destructive/40">
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
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-base">Voice summary</CardTitle>
              <CardDescription>
                {row.source_post_count > 0
                  ? `Synthesized from ${row.source_post_count} of your recent posts`
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
        <Card>
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
                className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm whitespace-pre-wrap leading-relaxed text-foreground"
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
        {profile.format_patterns.structure ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Structure:</span>{" "}
            {profile.format_patterns.structure}
          </p>
        ) : null}
        {profile.format_patterns.length ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Length:</span>{" "}
            {profile.format_patterns.length}
          </p>
        ) : null}
      </Section>

      <ChipSection title="Signature moves" items={profile.signature_moves} />
      <ChipSection title="Do" items={profile.do} />
      <ChipSection title="Don't" items={profile.dont} />
    </>
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
              className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
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
