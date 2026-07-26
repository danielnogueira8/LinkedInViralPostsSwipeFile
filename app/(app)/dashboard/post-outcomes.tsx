"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Pencil, Plus, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { fetchJson } from "@/lib/api-fetch";
import type {
  ContentOutcome,
  ContentOutcomeKind,
} from "@/lib/content-learning/contracts";

const OUTCOME_OPTIONS: Array<{
  value: ContentOutcomeKind;
  label: string;
}> = [
  { value: "qualified_conversation", label: "Qualified conversation" },
  { value: "qualified_dm", label: "Qualified DM" },
  { value: "lead_magnet_conversion", label: "Lead magnet conversion" },
  { value: "lead", label: "Lead" },
  { value: "booked_call", label: "Booked call" },
  { value: "pipeline", label: "Pipeline" },
  { value: "revenue", label: "Revenue" },
];
const MONEY_KINDS = new Set<ContentOutcomeKind>(["pipeline", "revenue"]);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function outcomeLabel(kind: ContentOutcomeKind): string {
  return OUTCOME_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

function outcomeValue(outcome: ContentOutcome): string {
  const quantity = `${outcome.quantity} ${outcomeLabel(outcome.kind).toLowerCase()}${
    outcome.quantity === 1 ? "" : "s"
  }`;
  if (outcome.amountMinor === null || !outcome.currency) return quantity;
  const money = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: outcome.currency,
  }).format(outcome.amountMinor / 100);
  return `${quantity} · ${money}`;
}

export function PostOutcomes({ draftId }: { draftId: string }) {
  const [outcomes, setOutcomes] = useState<ContentOutcome[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ContentOutcome | null>(null);
  const [kind, setKind] = useState<ContentOutcomeKind>("qualified_conversation");
  const [quantity, setQuantity] = useState("1");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [occurredOn, setOccurredOn] = useState(today());
  const [reason, setReason] = useState("");
  const requestId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchJson<{ ok: boolean; outcomes?: ContentOutcome[]; error?: string }>(
      `/api/drafts/${encodeURIComponent(draftId)}/outcomes`,
    )
      .then((response) => {
        if (!cancelled && response.ok) setOutcomes(response.outcomes ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadFailed(true);
          toast.error("Couldn't load business outcomes.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  function resetForm() {
    setEditing(null);
    setKind("qualified_conversation");
    setQuantity("1");
    setAmount("");
    setCurrency("USD");
    setOccurredOn(today());
    setReason("");
    requestId.current = null;
  }

  function startCorrection(outcome: ContentOutcome) {
    setEditing(outcome);
    setKind(outcome.kind);
    setQuantity(String(outcome.quantity));
    setAmount(
      outcome.amountMinor === null ? "" : String(outcome.amountMinor / 100),
    );
    setCurrency(outcome.currency ?? "USD");
    setOccurredOn(outcome.occurredAt.slice(0, 10));
    setReason("");
    requestId.current = null;
    setOpen(true);
  }

  async function save() {
    const parsedQuantity = Number.parseInt(quantity, 10);
    const monetary = MONEY_KINDS.has(kind);
    const parsedAmount = monetary && amount.trim()
      ? Math.round(Number(amount) * 100)
      : null;
    if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1) {
      toast.error("Quantity must be at least 1.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn)) {
      toast.error("Choose when this outcome happened.");
      return;
    }
    if (
      monetary &&
      amount.trim() &&
      (!Number.isFinite(parsedAmount) || (parsedAmount ?? -1) < 0)
    ) {
      toast.error("Enter a valid amount.");
      return;
    }
    if (editing && !reason.trim()) {
      toast.error("Add a short reason for the correction.");
      return;
    }

    requestId.current ??= crypto.randomUUID();
    setSaving(true);
    try {
      const payload = {
        kind,
        quantity: parsedQuantity,
        amountMinor: parsedAmount,
        currency: parsedAmount === null ? null : currency.toUpperCase(),
        occurredAt: new Date(`${occurredOn}T12:00:00`).toISOString(),
        requestId: requestId.current,
        ...(editing
          ? {
              expectedUpdatedAt: editing.updatedAt,
              reason: reason.trim(),
            }
          : {}),
      };
      const url = editing
        ? `/api/drafts/${encodeURIComponent(draftId)}/outcomes/${encodeURIComponent(editing.id)}`
        : `/api/drafts/${encodeURIComponent(draftId)}/outcomes`;
      const response = await fetchJson<{
        ok: boolean;
        outcome?: ContentOutcome;
        error?: string;
      }>(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok || !response.outcome) {
        throw new Error(response.error || "Couldn't save this outcome.");
      }
      setOutcomes((current) => [
        response.outcome!,
        ...current.filter((outcome) => outcome.id !== editing?.id),
      ]);
      toast.success(editing ? "Outcome corrected." : "Outcome reported.");
      resetForm();
      setOpen(false);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-background/72 p-3 shadow-soft">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2.5">
          <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold tracking-tight">
              Business outcomes
            </h3>
            <p className="text-xs text-muted-foreground">
              Report leads, calls, pipeline, or revenue this post influenced.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 gap-1"
          onClick={() => {
            if (open) resetForm();
            setOpen((value) => !value);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          Report
        </Button>
      </div>

      {open ? (
        <div className="mt-3 space-y-2.5 rounded-lg border border-border/70 bg-card p-3">
          <label className="block text-xs font-medium text-muted-foreground">
            Outcome
            <select
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as ContentOutcomeKind)
              }
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
            >
              {OUTCOME_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs font-medium text-muted-foreground">
              Quantity
              <input
                type="number"
                min="1"
                step="1"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              />
            </label>
            <label className="block text-xs font-medium text-muted-foreground">
              Date
              <input
                type="date"
                value={occurredOn}
                onChange={(event) => setOccurredOn(event.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              />
            </label>
          </div>
          {MONEY_KINDS.has(kind) ? (
            <div className="grid grid-cols-[1fr_88px] gap-2">
              <label className="block text-xs font-medium text-muted-foreground">
                Amount (optional)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00"
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
                />
              </label>
              <label className="block text-xs font-medium text-muted-foreground">
                Currency
                <input
                  value={currency}
                  maxLength={3}
                  onChange={(event) => setCurrency(event.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm uppercase text-foreground"
                />
              </label>
            </div>
          ) : null}
          {editing ? (
            <label className="block text-xs font-medium text-muted-foreground">
              Why are you correcting it?
              <input
                value={reason}
                maxLength={1000}
                onChange={(event) => setReason(event.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
              />
            </label>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                resetForm();
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={saving} onClick={save}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {editing ? "Save correction" : "Save outcome"}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-3 space-y-2" aria-live="polite">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading outcomes…
          </div>
        ) : loadFailed ? (
          <p className="text-xs text-state-danger">
            Couldn&apos;t load outcomes. Reopen this post to try again.
          </p>
        ) : outcomes.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No business outcomes reported yet.
          </p>
        ) : (
          outcomes.map((outcome) => (
            <div
              key={outcome.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2.5 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {outcomeValue(outcome)}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {new Date(outcome.occurredAt).toLocaleDateString()} ·{" "}
                  {outcome.source === "manual" ? "Reported by you" : "LeadShark"}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Correct ${outcomeLabel(outcome.kind)}`}
                onClick={() => startCorrection(outcome)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
