// Measure the pixel position of a character offset inside a <textarea>.
//
// Textareas don't expose selection geometry (the DOM Selection/Range API only
// works on contentEditable). The standard technique is a "mirror div": clone
// the textarea's text and box styling into an off-screen div, drop a marker
// <span> at the target offset, and read the span's offset position. That gives
// us coordinates to anchor a floating toolbar over the selection.
//
// Adapted from the well-known textarea-caret-position approach (component/
// textarea-caret-position), trimmed to what we need.

// The textarea style properties that affect text wrapping/metrics and so must
// be copied to the mirror for an accurate measurement.
const MIRRORED_PROPS = [
  "boxSizing",
  "width",
  // NOTE: height is intentionally NOT mirrored — the mirror must grow to the
  // full content height so a marker past the visible area still measures.
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontSizeAdjust",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textTransform",
  "textIndent",
  "textDecoration",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "whiteSpace",
  "wordWrap",
  "wordBreak",
] as const;

export type CaretCoords = { top: number; left: number; height: number };

// Returns the position of `offset` relative to the textarea's own box (i.e.
// already accounting for its scroll). Add the textarea's bounding rect to get
// viewport coordinates.
export function getCaretCoordinates(
  el: HTMLTextAreaElement,
  offset: number,
): CaretCoords {
  const doc = el.ownerDocument;
  const mirror = doc.createElement("div");
  mirror.id = "__caret-mirror__";
  const style = mirror.style;
  const computed = getComputedStyle(el);

  // Copy the textarea's box/text metrics first…
  for (const prop of MIRRORED_PROPS) {
    const kebab = prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    style.setProperty(kebab, computed.getPropertyValue(kebab));
  }
  // …then apply the mirror-specific overrides last so they win regardless of
  // what was copied: off-screen, hidden, and forced to wrap like a textarea.
  style.position = "absolute";
  style.visibility = "hidden";
  style.top = "0";
  style.left = "-9999px";
  style.whiteSpace = "pre-wrap";
  style.wordWrap = "break-word";
  style.overflow = "hidden";

  mirror.textContent = el.value.slice(0, offset);
  // The marker span sits exactly at the offset; its position is the caret.
  const marker = doc.createElement("span");
  // A non-empty content gives the span a measurable box at the caret.
  marker.textContent = el.value.slice(offset) || ".";
  mirror.appendChild(marker);

  doc.body.appendChild(mirror);
  const coords: CaretCoords = {
    top: marker.offsetTop - el.scrollTop,
    left: marker.offsetLeft - el.scrollLeft,
    height: parseInt(computed.lineHeight) || parseInt(computed.fontSize) || 16,
  };
  doc.body.removeChild(mirror);
  return coords;
}

// ---------------------------------------------------------------------------
// `position: fixed` is not always relative to the viewport.
//
// Any ancestor with a transform (or translate/rotate/scale/filter/perspective,
// and a few others) becomes the CONTAINING BLOCK for its fixed descendants, so
// `left: 400px` then means 400px from that ancestor's edge instead of the
// window's. The draft editor renders inside a Dialog whose content carries
// `translate-*` utilities and slide-in animations, and that dialog is a
// RIGHT-ALIGNED drawer — so the selection toolbar was drawn hundreds of pixels
// to the right of the highlighted word, while looking vertically correct
// because the drawer is full-height at top: 0.
//
// The fix is arithmetic rather than a portal: moving the toolbar to
// document.body would also move the "Describe changes" input out of the modal,
// where the dialog's focus trap can pull focus straight back out of it.
// ---------------------------------------------------------------------------

/** The subset of computed style that decides the question. Plain data so the
 *  rule is testable without a DOM. */
export type ContainingBlockStyle = {
  transform?: string | null;
  translate?: string | null;
  rotate?: string | null;
  scale?: string | null;
  perspective?: string | null;
  filter?: string | null;
  backdropFilter?: string | null;
  contain?: string | null;
  willChange?: string | null;
};

/**
 * Does an element with this style establish a containing block for `fixed`
 * descendants?
 *
 * NOTE `translate: 0px 0px` counts. Tailwind's `translate-x-0` still emits a
 * translate, so an element that visually moves nothing still captures fixed
 * positioning — which is exactly how this shipped unnoticed.
 */
export function establishesFixedContainingBlock(
  style: ContainingBlockStyle,
): boolean {
  const set = (value: string | null | undefined): boolean =>
    Boolean(value) && value !== "none";
  if (set(style.transform)) return true;
  if (set(style.translate)) return true;
  if (set(style.rotate)) return true;
  if (set(style.scale)) return true;
  if (set(style.perspective)) return true;
  if (set(style.filter)) return true;
  if (set(style.backdropFilter)) return true;
  if (style.contain && /\b(paint|layout|strict|content)\b/.test(style.contain)) {
    return true;
  }
  if (style.willChange && /\b(transform|filter|perspective)\b/.test(style.willChange)) {
    return true;
  }
  return false;
}

/**
 * Viewport offset of the nearest ancestor that captures fixed positioning, or
 * {0,0} when nothing does (the normal case outside a dialog).
 *
 * Degrades safely: if the walk misses a property that captures fixed
 * positioning, the result is {0,0} — today's behaviour — rather than a new
 * kind of wrong.
 */
export function fixedContainingBlockOffset(el: Element): {
  top: number;
  left: number;
} {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const computed = getComputedStyle(node);
    if (
      establishesFixedContainingBlock({
        transform: computed.transform,
        translate: computed.translate,
        rotate: computed.rotate,
        scale: computed.scale,
        perspective: computed.perspective,
        filter: computed.filter,
        backdropFilter: computed.backdropFilter,
        contain: computed.contain,
        willChange: computed.willChange,
      })
    ) {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, left: rect.left };
    }
  }
  return { top: 0, left: 0 };
}

// Convenience: the midpoint above a selection range, used to center a floating
// toolbar over the highlighted text. Returns coordinates for a `fixed` element
// — viewport-relative, minus any ancestor that captured fixed positioning.
export function getSelectionAnchor(
  el: HTMLTextAreaElement,
  start: number,
  end: number,
): { top: number; left: number } {
  const rect = el.getBoundingClientRect();
  const a = getCaretCoordinates(el, start);
  const b = getCaretCoordinates(el, end);
  // If the selection spans multiple lines, anchor to the first line's start;
  // otherwise center between start and end on the same line.
  const sameLine = Math.abs(a.top - b.top) < 2;
  const left = sameLine ? (a.left + b.left) / 2 : a.left;
  const origin = fixedContainingBlockOffset(el);
  return {
    top: rect.top + a.top - origin.top,
    left: rect.left + left - origin.left,
  };
}
