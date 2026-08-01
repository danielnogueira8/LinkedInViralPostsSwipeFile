import type { ReactNode } from "react";

export function VoiceMemoryList({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <ul
      aria-label={label}
      data-testid={testId}
      tabIndex={0}
      className="max-h-80 overflow-y-auto overscroll-contain rounded-lg border border-border/60 bg-background/45 [scrollbar-gutter:stable]"
    >
      {children}
    </ul>
  );
}
