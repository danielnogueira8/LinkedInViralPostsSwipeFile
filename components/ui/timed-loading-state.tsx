"use client";

import { useEffect, useState } from "react";

import {
  LoadingState,
  type LoadingStateProps,
} from "@/components/ui/loading-state";

function formatElapsed(deciseconds: number): string {
  const seconds = deciseconds / 10;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
}

function TimedLoadingState(
  props: Omit<LoadingStateProps, "elapsedLabel">,
) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(
      () => setElapsed((current) => current + 1),
      100,
    );
    return () => window.clearInterval(timer);
  }, []);

  return <LoadingState {...props} elapsedLabel={formatElapsed(elapsed)} />;
}

export { TimedLoadingState };
