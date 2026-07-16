import { describe, test, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AvatarImg, selectAvatarCandidate } from "@/components/avatar-img";

// ---------------------------------------------------------------------------
// Unit tests for AvatarImg — the fix for the disappearing draft profile pic.
// LinkedIn CDN avatar URLs expire; without a fallback an expired URL renders the
// browser's broken-image icon instead of degrading. AvatarImg shows the fallback
// when there's no src, and (via onError at runtime) when the src fails to load.
//
// Rendered with renderToStaticMarkup (no DOM needed, works in the hermetic
// node env). onError is an event handler so it isn't in static HTML — the
// runtime onError → fallback swap is covered by the component's own logic;
// here we lock down the src-presence branching that the bug got wrong.
// ---------------------------------------------------------------------------

const fallback = createElement("div", { id: "fb" }, "DN");
const html = (props: Parameters<typeof AvatarImg>[0]) =>
  renderToStaticMarkup(createElement(AvatarImg, props));

describe("AvatarImg", () => {
  test("a newly supplied photo is tried after every previous candidate failed", () => {
    const failed = [
      "https://media.licdn.com/expired.jpg",
      "https://img.clerk.com/old.jpg",
    ];

    expect(
      selectAvatarCandidate(
        "https://media.licdn.com/fresh.jpg",
        "https://img.clerk.com/new.jpg",
        failed,
      ),
    ).toBe("https://media.licdn.com/fresh.jpg");
  });

  test("the durable backup is selected after the primary URL fails", () => {
    expect(
      selectAvatarCandidate(
        "https://media.licdn.com/expired.jpg",
        "https://img.clerk.com/durable.jpg",
        ["https://media.licdn.com/expired.jpg"],
      ),
    ).toBe("https://img.clerk.com/durable.jpg");
  });

  test("the placeholder is selected only after every current URL failed", () => {
    expect(
      selectAvatarCandidate(
        "https://media.licdn.com/expired.jpg",
        "https://img.clerk.com/expired.jpg",
        [
          "https://media.licdn.com/expired.jpg",
          "https://img.clerk.com/expired.jpg",
        ],
      ),
    ).toBeUndefined();
  });

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

  test("with a fallbackSrc, the primary src is still shown FIRST", () => {
    // The fallbackSrc only takes over on the primary's runtime onError (the
    // LinkedIn URL expiring); on first paint we show the primary.
    const out = html({
      src: "https://media.licdn.com/expiring.jpg",
      fallbackSrc: "https://img.clerk.com/durable.jpg",
      fallback,
    });
    expect(out).toContain('src="https://media.licdn.com/expiring.jpg"');
    expect(out).not.toContain("img.clerk.com");
  });

  test("no primary src but a fallbackSrc → renders the fallbackSrc <img>, not initials", () => {
    // e.g. voice.avatar_url is null but the Clerk photo exists.
    const out = html({
      src: null,
      fallbackSrc: "https://img.clerk.com/durable.jpg",
      fallback,
    });
    expect(out).toContain("<img");
    expect(out).toContain('src="https://img.clerk.com/durable.jpg"');
    expect(out).not.toContain('id="fb"');
  });

  test("neither src nor fallbackSrc → the node fallback (initials)", () => {
    expect(html({ src: null, fallbackSrc: null, fallback })).toContain('id="fb"');
    expect(html({ src: "", fallbackSrc: undefined, fallback })).toContain('id="fb"');
  });
});
