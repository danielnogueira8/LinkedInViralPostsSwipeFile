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
import { Loader2, Sparkles, RefreshCw, AlertCircle } from "lucide-react";
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

      {isReady ? <ProfileView row={row} profile={profile} /> : null}
    </div>
  );
}

function ProfileView({
  row,
  profile,
}: {
  row: VoiceRow;
  profile: VoiceProfile;
}) {
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
          <CardTitle className="text-base">Voice summary</CardTitle>
          <CardDescription>
            {row.source_post_count > 0
              ? `Synthesized from ${row.source_post_count} of your recent posts`
              : "Synthesized from your recent posts"}
            {generatedOn ? ` · last updated ${generatedOn}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {profile.summary ? (
            <p className="text-sm text-foreground leading-relaxed">
              {profile.summary}
            </p>
          ) : null}

          <Section title="Audience">
            {profile.audience.primary ? (
              <p className="text-sm text-muted-foreground">
                {profile.audience.primary}
              </p>
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
        </CardContent>
      </Card>

      {profile.exemplars.length > 0 ? (
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
