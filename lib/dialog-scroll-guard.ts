export type DialogScrollTarget =
  | "activation"
  | "media"
  | "range"
  | "text-input"
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

export function shouldPreventDialogKeyScroll({
  canScrollInsideDialog,
  key,
  target,
}: {
  canScrollInsideDialog: boolean;
  key: string;
  target: DialogScrollTarget;
}) {
  if (!PAGE_SCROLL_KEYS.has(key)) return false;
  if (target === "range") return false;
  if (
    target === "text-input" &&
    [" ", "ArrowDown", "ArrowUp", "End", "Home"].includes(key)
  ) {
    return false;
  }
  if (key === " " && (target === "activation" || target === "media")) {
    return false;
  }
  if (
    target === "media" &&
    ["ArrowDown", "ArrowUp", "End", "Home"].includes(key)
  ) {
    return false;
  }
  return !canScrollInsideDialog;
}

export function dialogScrollDirection(key: string, shiftKey = false) {
  if (["ArrowUp", "Home", "PageUp"].includes(key)) return -1;
  if (key === " " && shiftKey) return -1;
  return 1;
}

export function shouldPreventDialogTouchMove({
  canScrollInsideDialog,
  deltaX,
  deltaY,
  target,
  touchCount,
}: {
  canScrollInsideDialog: boolean;
  deltaX: number;
  deltaY: number;
  target: DialogScrollTarget;
  touchCount: number;
}) {
  if (touchCount > 1 || target === "range") return false;
  if (target === "media" && Math.abs(deltaX) >= Math.abs(deltaY)) return false;
  return !canScrollInsideDialog;
}
