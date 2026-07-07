import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { MarkdownDocument } from "@/components/markdown-document";
import {
  firstNameFromDisplayName,
  renderLeadMagnetCreatorContext,
  renderLeadMagnetStructureRequirements,
  splitLeadMagnetCreatorImage,
} from "@/lib/lead-magnet-generation";

describe("lead magnet generation guidance", () => {
  test("derives a first name for the resource intro", () => {
    expect(firstNameFromDisplayName("Daniel Nogueira")).toBe("Daniel");
    expect(firstNameFromDisplayName("")).toBeNull();
  });

  test("passes verified creator identity and image markdown to the model", () => {
    const context = renderLeadMagnetCreatorContext({
      displayName: "Daniel Nogueira",
      avatarUrl: "https://media.licdn.com/dms/image/profile-displayphoto.jpg",
      headline: "Co-founder of Scale Content Labs",
      summary: "Helps founders turn LinkedIn into booked calls.",
    });

    expect(context).toContain("Creator first name: Daniel");
    expect(context).toContain("Verified LinkedIn headline: Co-founder of Scale Content Labs");
    expect(context).toContain(
      "![Daniel Nogueira](https://media.licdn.com/dms/image/profile-displayphoto.jpg)",
    );
    expect(context).toContain("Do not invent credentials");
  });

  test("requires the hook, image, intro, outcome, and optional CTA block order", () => {
    const requirements = renderLeadMagnetStructureRequirements({
      url: "https://calendly.com/danielhenriquesnogueira/30min",
      label: "Book a 30-min call",
    });

    expect(requirements).toContain("place it immediately after the hook and before the intro");
    expect(requirements).toContain("Hey, I'm {first name}");
    expect(requirements).toContain("What you'll get out of it:");
    expect(requirements).toContain("> **Prefer to skip the DIY?**");
    expect(requirements).toContain(
      "[Book a 30-min call → https://calendly.com/danielhenriquesnogueira/30min](https://calendly.com/danielhenriquesnogueira/30min)",
    );
  });

  test("splits generated markdown at the creator profile image", () => {
    const split = splitLeadMagnetCreatorImage(
      [
        "# Audit Kit",
        "",
        "The fastest way to find the weak spots.",
        "",
        "![Daniel Nogueira](https://media.licdn.com/dms/image/profile-displayphoto.jpg)",
        "",
        "Hey, I'm Daniel.",
      ].join("\n"),
      {
        displayName: "Daniel Nogueira",
        avatarUrl: "https://media.licdn.com/dms/image/profile-displayphoto.jpg",
      },
    );

    expect(split.imageFound).toBe(true);
    expect(split.before).toContain("The fastest way");
    expect(split.before).not.toContain("profile-displayphoto");
    expect(split.after).toContain("Hey, I'm Daniel.");
  });
});

describe("MarkdownDocument image blocks", () => {
  test("renders markdown images as circular profile images", () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownDocument, {
        markdown:
          "# Audit Kit\n\nThe fastest way to find the weak spots.\n\n![Daniel Nogueira](https://media.licdn.com/dms/image/profile-displayphoto.jpg)\n\nHey, I'm Daniel.",
      }),
    );

    expect(html).toContain('src="https://media.licdn.com/dms/image/profile-displayphoto.jpg"');
    expect(html).toContain('alt="Daniel Nogueira"');
    expect(html).toContain("rounded-full");
  });
});
