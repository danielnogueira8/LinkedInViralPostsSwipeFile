"use client";

import { useState } from "react";
import { VoiceManager, type VoiceRow } from "./manager";
// Voice is now only the profile and its writing mechanics. Standing rules and
// learned taste moved to Knowledge, where the rest of the workspace's durable
// context already lives — keeping "how it writes" in one place instead of
// split across two pages.
export function VoiceWorkspace({
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

  return (
    <div className="min-w-0 space-y-4">
      <VoiceManager
        row={row}
        setRow={setRow}
        canRegenerate={canRegenerate}
        regenAvailableAt={regenAvailableAt}
        daysUntilRegen={daysUntilRegen}
      />
    </div>
  );
}
