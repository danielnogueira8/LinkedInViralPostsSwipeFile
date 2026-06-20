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

// Convenience: the viewport-relative midpoint above a selection range, used to
// center a floating toolbar over the highlighted text.
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
  return {
    top: rect.top + a.top,
    left: rect.left + left,
  };
}
