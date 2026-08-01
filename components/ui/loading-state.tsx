import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import styles from "./loading-state.module.css";

type LoadingVariant = "drive" | "dots";

type LoadingStateProps = Omit<React.ComponentProps<"div">, "children"> & {
  elapsedLabel?: string;
  label?: string;
  variant?: LoadingVariant;
};

const CHEVRON_DELAYS = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

function LoadingPixels({
  variant = "drive",
  className,
}: {
  variant?: LoadingVariant;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]",
        className,
      )}
    >
      {CHEVRON_DELAYS.map((delay, index) => (
        <span
          key={index}
          data-loading-pixel
          className={cn(
            styles.pixel,
            "size-1 bg-foreground",
            variant === "dots" ? "rounded-full" : "rounded-[1px]",
          )}
          style={
            {
              opacity: 0.16,
              "--loading-pixel-duration": "650ms",
              "--loading-pixel-delay": `${delay}ms`,
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}

function LoadingState({
  elapsedLabel,
  label = "Loading",
  variant = "drive",
  className,
  ...props
}: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn(
        "inline-flex min-h-6 w-fit items-center gap-2.5 text-sm",
        className,
      )}
      {...props}
    >
      <LoadingPixels variant={variant} />
      <span
        className={cn(
          styles.label,
          "font-medium text-transparent",
        )}
      >
        {label}
      </span>
      {elapsedLabel ? (
        <span className="font-mono text-xs tabular-nums text-muted-foreground/75">
          {elapsedLabel}
        </span>
      ) : null}
    </div>
  );
}

export {
  LoadingPixels,
  LoadingState,
  type LoadingStateProps,
  type LoadingVariant,
};
