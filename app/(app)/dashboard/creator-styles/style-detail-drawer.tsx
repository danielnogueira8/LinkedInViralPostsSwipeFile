"use client";

import { useEffect, useState } from "react";
import {
  Fingerprint,
  X,
  MessageSquare,
  ExternalLink,
  Loader2,
  ShieldCheck,
  AlertCircle,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AvatarImg } from "@/components/avatar-img";
import { fetchJson } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";
import {
  sanitizeCreatorStyleProfile,
  type CreatorStyleRow,
  type CreatorStyleProfile,
} from "@/lib/creator-styles";

type SourceRef = {
  id: string;
  source_first_line: string | null;
  source_url: string | null;
};

// A read-only slide-over that surfaces the FULL distilled profile (the card only
// shows a few tags) plus the source posts it was built from. Fetches the heavy
// detail (profile_json + sources) lazily when it opens — the list endpoint omits
// those to keep card payloads small.
export function StyleDetailDrawer({
  styleId,
  open,
  onOpenChange,
  onUse,
}: {
  styleId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onUse: (id: string) => void;
}) {
  const [row, setRow] = useState<CreatorStyleRow | null>(null);
  const [sources, setSources] = useState<SourceRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !styleId) return;
    let cancelled = false;
    // Reset to the loading state for the newly-opened style. This is the
    // "sync to an external system (the fetch)" case — the lint's cascading-render
    // concern doesn't apply to a one-shot reset guarded on open/styleId.
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setError(null);
    setRow(null);
    setSources([]);
    /* eslint-enable react-hooks/set-state-in-effect */
    (async () => {
      try {
        const data = await fetchJson<{
          ok: boolean;
          style?: CreatorStyleRow;
          sources?: SourceRef[];
          error?: string;
        }>(`/api/creator-styles/${styleId}`, { cache: "no-store" });
        if (cancelled) return;
        if (!data?.ok || !data.style) throw new Error(data?.error || "Couldn't load this style");
        setRow(data.style);
        setSources(Array.isArray(data.sources) ? data.sources : []);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, styleId]);

  const profile = row?.profile_json ? sanitizeCreatorStyleProfile(row.profile_json) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Right-anchored slide-over: override the centered dialog positioning. */}
      <DialogContent
        showCloseButton={false}
        className="fixed inset-y-0 right-0 left-auto top-0 flex h-full max-h-none w-full max-w-md translate-x-0 translate-y-0 flex-col gap-0 rounded-none rounded-l-xl p-0 sm:max-w-md data-open:slide-in-from-right-4 data-closed:slide-out-to-right-4 duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:animate-none"
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-border px-4 py-3.5">
          <AvatarImg
            src={row?.creator_avatar_url ?? null}
            className="h-10 w-10 shrink-0 rounded-lg object-cover ring-1 ring-border/60"
            fallback={
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Fingerprint className="h-5 w-5" />
              </div>
            }
          />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-base font-medium">
              {row?.name ?? "Creator style"}
            </DialogTitle>
            <div className="truncate text-xs text-muted-foreground">
              {[
                row?.creator_name || row?.creator_handle || null,
                row?.creator_handle ? `@${row.creator_handle}` : null,
                row && row.sample_count > 0 ? `built from ${row.sample_count} posts` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {loading ? (
            <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading style…
            </div>
          ) : error ? (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : profile ? (
            <div className="space-y-5">
              {profile.summary && (
                <p className="text-sm leading-relaxed text-muted-foreground">{profile.summary}</p>
              )}

              {profile.voice_traits.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {profile.voice_traits.map((t, i) => (
                    <span
                      key={`${t}-${i}`}
                      className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}

              {profile.hook_patterns.length > 0 && (
                <Section label="Hook patterns">
                  <div className="space-y-1.5">
                    {profile.hook_patterns.map((h, i) => (
                      <div key={`${h.name}-${i}`} className="rounded-lg border border-border px-3 py-2.5">
                        <div className="text-sm font-medium">{h.name}</div>
                        {h.description && (
                          <div className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
                            {h.description}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {profile.structure_patterns.length > 0 && (
                <Section label="Structure patterns">
                  <div className="space-y-1.5">
                    {profile.structure_patterns.map((s, i) => (
                      <div key={`${s.name}-${i}`} className="rounded-lg border border-border px-3 py-2.5">
                        <div className="text-sm font-medium">{s.name}</div>
                        {s.sequence.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            {s.sequence.map((step, j) => (
                              <span
                                key={j}
                                className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                              >
                                {j + 1} · {step}
                              </span>
                            ))}
                          </div>
                        )}
                        {s.when_to_use && (
                          <div className="mt-1.5 text-[12px] italic text-muted-foreground">
                            {s.when_to_use}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              <div className="grid grid-cols-2 gap-4">
                {profile.formatting_rules.length > 0 && (
                  <Section label="Formatting">
                    <RuleList items={profile.formatting_rules} />
                  </Section>
                )}
                {profile.rhythm_rules.length > 0 && (
                  <Section label="Rhythm">
                    <RuleList items={profile.rhythm_rules} />
                  </Section>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                {profile.cta_patterns.length > 0 && (
                  <Section label="CTA habits">
                    <RuleList items={profile.cta_patterns} />
                  </Section>
                )}
                {profile.post_format_preferences.length > 0 && (
                  <Section label="Favored formats">
                    <RuleList items={profile.post_format_preferences} />
                  </Section>
                )}
              </div>

              {profile.avoid_copying.length > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-500">
                    <ShieldCheck className="h-3.5 w-3.5" /> Never copied into your posts
                  </div>
                  <div className="mt-1 text-[13px] leading-snug text-amber-700/90 dark:text-amber-500/90">
                    Only the mechanics above transfer — never {joinList(profile.avoid_copying)}.
                  </div>
                </div>
              )}

              {sources.length > 0 && (
                <Section label={`Built from ${row?.sample_count || sources.length} posts`}>
                  <div className="overflow-hidden rounded-lg border border-border">
                    {sources.slice(0, 8).map((s, i) => {
                      const line = s.source_first_line?.trim() || "Source post";
                      const inner = (
                        <>
                          <span className="flex-1 truncate text-[13px]">{line}</span>
                          {s.source_url && (
                            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                        </>
                      );
                      const cls = cn(
                        "flex items-center gap-2 px-3 py-2.5",
                        i < Math.min(sources.length, 8) - 1 && "border-b border-border",
                      );
                      return s.source_url ? (
                        <a
                          key={s.id}
                          href={s.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className={cn(cls, "text-foreground hover:bg-muted")}
                        >
                          {inner}
                        </a>
                      ) : (
                        <div key={s.id} className={cls}>
                          {inner}
                        </div>
                      );
                    })}
                  </div>
                  {sources.length > 8 && (
                    <div className="mt-1.5 text-xs text-muted-foreground">
                      + {sources.length - 8} more
                    </div>
                  )}
                </Section>
              )}
            </div>
          ) : (
            <div className="py-10 text-sm text-muted-foreground">
              This style has no distilled profile yet.
            </div>
          )}
        </div>

        {/* Footer */}
        {row && profile && (
          <div className="border-t border-border px-4 py-3">
            <Button
              className="w-full gap-1.5"
              onClick={() => {
                onOpenChange(false);
                onUse(row.id);
              }}
              title="Take this style into the chat and write in it"
            >
              <MessageSquare className="h-4 w-4" /> Model with Cowork
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function RuleList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1 text-[13px] leading-snug text-muted-foreground">
      {items.map((it, i) => (
        <li key={`${it}-${i}`} className="flex gap-1.5">
          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/40" />
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

// "a, b, and c" — used in the anti-copying sentence.
function joinList(items: string[]): string {
  const clean = items.map((i) => i.trim()).filter(Boolean).slice(0, 6);
  if (clean.length === 0) return "their topics or words";
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(", ")}, or ${clean[clean.length - 1]}`;
}

export type { CreatorStyleProfile };
