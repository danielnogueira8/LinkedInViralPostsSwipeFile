export type MediaScrollTarget =
  | "activation"
  | "range"
  | "text-input"
  | "video"
  | "other";

const PAGE_SCROLL_KEYS = new Set([
  " ",
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

export function shouldPreventMediaWheel(ctrlKey: boolean) {
  return !ctrlKey;
}

export function shouldPreventMediaTouchMove({
  touchCount,
  target,
  deltaX,
  deltaY,
}: {
  touchCount: number;
  target: MediaScrollTarget;
  deltaX: number;
  deltaY: number;
}) {
  if (touchCount > 1 || target === "range") return false;
  if (target === "video" && Math.abs(deltaX) >= Math.abs(deltaY)) return false;
  return true;
}

export function shouldPreventMediaKeyScroll(
  key: string,
  target: MediaScrollTarget,
) {
  if (!PAGE_SCROLL_KEYS.has(key)) return false;
  if (target === "range" || target === "text-input") return false;
  if (key === " " && (target === "activation" || target === "video")) {
    return false;
  }
  if (
    target === "video" &&
    ["ArrowDown", "ArrowUp", "End", "Home"].includes(key)
  ) {
    return false;
  }
  return true;
}
