import { describe, test, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AvatarImg } from "@/components/avatar-img";

// ---------------------------------------------------------------------------
// Unit tests for AvatarImg — the fix for the disappearing draft profile pic.
// LinkedIn CDN avatar URLs expire; without a fallback an expired URL renders the
// browser's broken-image icon instead of degrading. AvatarImg shows the fallback
// when there's no src, and (via onError at runtime) when the src fails to load.
//
// Rendered with renderToStaticMarkup (no DOM needed, works in the hermetic
// node env). onError is an event handler so it isn't in static HTML — the
// runtime onError → fallback swap, and the src-change reset (a new url after a
// broken one recovers without a reload, keyed on brokenSrc===src), need a DOM to
// exercise and aren't covered here; this suite locks down the src-presence
// branching that the original bug got wrong.
// ---------------------------------------------------------------------------

const fallback = createElement("div", { id: "fb" }, "DN");
const html = (props: Parameters<typeof AvatarImg>[0]) =>
  renderToStaticMarkup(createElement(AvatarImg, props));

describe("AvatarImg", () => {
  test("no src → renders the fallback, never an <img> (no broken-image icon)", () => {
    const out = html({ src: null, fallback });
    expect(out).toContain('id="fb"');
    expect(out).not.toContain("<img");
  });

  test("empty-string src → treated as absent → fallback", () => {
    expect(html({ src: "", fallback })).toContain('id="fb"');
  });

  test("undefined src → fallback", () => {
    expect(html({ src: undefined, fallback })).toContain('id="fb"');
  });

  test("present src → renders the <img> with that src + className", () => {
    const out = html({
      src: "https://media.licdn.com/expiring.jpg",
      className: "h-10 w-10 rounded-full",
      fallback,
    });
    expect(out).toContain("<img");
    expect(out).toContain('src="https://media.licdn.com/expiring.jpg"');
    expect(out).toContain('class="h-10 w-10 rounded-full"');
    // The fallback is NOT rendered while the image is showing.
    expect(out).not.toContain('id="fb"');
  });
});
