import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { MarkdownDocument } from "@/components/markdown-document";
import {
  firstNameFromDisplayName,
  leadMagnetDisplayMarkdown,
  renderLeadMagnetCreatorContext,
  renderLeadMagnetQualityRequirements,
  renderLeadMagnetStructureRequirements,
  prepareGeneratedLeadMagnetMarkdown,
  assessGeneratedLeadMagnetMarkdown,
  sanitizeGeneratedLeadMagnetMarkdown,
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
    expect(requirements).toContain("How to use this resource");
    expect(requirements).toContain("worked example");
    expect(requirements).toContain("exactly three numbered actions");
    expect(requirements).toContain("> **Prefer to skip the DIY?**");
    expect(requirements).toContain(
      "[Book a 30-min call → https://calendly.com/danielhenriquesnogueira/30min](https://calendly.com/danielhenriquesnogueira/30min)",
    );
  });

  test("pushes dense Notion-style utility without generic AI tells", () => {
    const requirements = renderLeadMagnetQualityRequirements();

    expect(requirements).toContain("Notion-style resource");
    expect(requirements).toContain("copy/paste prompts");
    expect(requirements).toContain("usable asset");
    expect(requirements).toContain("instructions, not a lecture");
    expect(requirements).toContain("Include examples only when they make the resource clearer");
    expect(requirements).toContain("no em dashes");
    expect(requirements).toContain("no 'game-changer'");
    expect(requirements).toContain("Expert and concise beats broad and generic");
  });

  test("sanitizes em dashes from generated lead magnet markdown", () => {
    expect(
      sanitizeGeneratedLeadMagnetMarkdown("# Kit\n\nUse this — then ship it.\n\n- Step 1 — audit the hook"),
    ).toBe("# Kit\n\nUse this - then ship it.\n\n- Step 1 - audit the hook");
  });

  test("preserves indentation and em dashes inside a fenced code block", () => {
    const markdown = [
      "Run this:",
      "",
      "```yaml",
      "steps:",
      "  - name: setup",
      "    run: pip  install requests  # note — see docs",
      "```",
      "",
      "Then ship it — that's it.",
    ].join("\n");

    expect(sanitizeGeneratedLeadMagnetMarkdown(markdown)).toBe(
      [
        "Run this:",
        "",
        "```yaml",
        "steps:",
        "  - name: setup",
        "    run: pip  install requests  # note — see docs",
        "```",
        "",
        "Then ship it - that's it.",
      ].join("\n"),
    );
  });

  test("leaves a table-shaped example line untouched inside a fence", () => {
    const markdown = [
      "Example table syntax:",
      "",
      "```markdown",
      "| a | b |c|",
      "```",
    ].join("\n");

    expect(sanitizeGeneratedLeadMagnetMarkdown(markdown)).toBe(
      ["Example table syntax:", "", "```markdown", "| a | b |c|", "```"].join("\n"),
    );
  });

  test("repairs collapsed one-line markdown tables from generated resources", () => {
    const markdown = sanitizeGeneratedLeadMagnetMarkdown(
      "| Step | Agent | Input | Output | Time | |---|---|---|---|---| | 1 | You | Topic idea | Topic brief | 5 min | | 2 | Hook Creator | Brief | Hooks | 3 min |",
    );

    expect(markdown).toBe(
      [
        "| Step | Agent | Input | Output | Time |",
        "|---|---|---|---|---|",
        "| 1 | You | Topic idea | Topic brief | 5 min |",
        "| 2 | Hook Creator | Brief | Hooks | 3 min |",
      ].join("\n"),
    );
  });

  test("prepares a complete guide without repeating the public page title", () => {
    const markdown = prepareGeneratedLeadMagnetMarkdown({
      title: "The Founder Content Guide",
      markdown: [
        "# The Founder Content Guide",
        "",
        "Turn one customer conversation into five useful posts.",
        "",
        "## Step 1: Capture the raw material",
        "",
        "Use this checklist before you leave the call.",
        "",
        "## Quick implementation plan",
        "",
        "1. Choose one call.",
        "2. Extract the strongest customer phrase.",
      ].join("\n"),
    });

    expect(markdown).not.toContain("# The Founder Content Guide");
    expect(markdown).toContain("Turn one customer conversation");
    expect(markdown).toContain("## Quick implementation plan");
  });

  test("removes a near-duplicate leading heading from the displayed document", () => {
    const markdown = leadMagnetDisplayMarkdown({
      title: "The Claude LinkedIn Department: Agent Prompts & Workflow System",
      markdown: [
        "## The Claude LinkedIn Department: Agent Prompts & Workflow",
        "",
        "Everything you need to build the system.",
        "",
        "## How to use this resource",
        "",
        "Start with the first prompt.",
      ].join("\n"),
    });

    expect(markdown).not.toContain("## The Claude LinkedIn Department");
    expect(markdown).toContain("## How to use this resource");
  });

  test("reports guide output that is too thin or contains unfinished placeholders", () => {
    const assessment = assessGeneratedLeadMagnetMarkdown(
      "Start here.\n\n## Step 1\n\n[Add examples here]\n\n## Conclusion\n\nYou are ready.",
    );

    expect(assessment.passed).toBe(false);
    expect(assessment.issues).toContain("The guide is too short to be genuinely useful.");
    expect(assessment.issues).toContain("The guide contains unfinished placeholder text.");
    expect(assessment.issues).toContain("Replace the generic conclusion with a quick implementation plan.");
  });

  test("keeps intentional fill-in fields while rejecting editorial placeholders", () => {
    const template = assessGeneratedLeadMagnetMarkdown(
      `${"Useful guide content. ".repeat(60)}\n\n## Step one\n\nHi [Your name], here is [Your offer].\n\n## Step two\n\nApply it.\n\n## Quick implementation plan\n\nStart today.`,
    );
    expect(template.issues).not.toContain("The guide contains unfinished placeholder text.");

    const unfinished = assessGeneratedLeadMagnetMarkdown(
      `${"Useful guide content. ".repeat(60)}\n\n## Step one\n\n[Add example here]\n\n## Step two\n\nApply it.\n\n## Quick implementation plan\n\nStart today.`,
    );
    expect(unfinished.issues).toContain("The guide contains unfinished placeholder text.");
  });

  test("reports repeated paragraphs and unfinished markdown structures", () => {
    const repeated = "Use this exact process before publishing.";
    const assessment = assessGeneratedLeadMagnetMarkdown(
      `${"Practical context. ".repeat(60)}\n\n## Step one\n\n${repeated}\n\n## Step two\n\n${repeated}\n\n## Quick implementation plan\n\n\`\`\`text\nStart with:`,
    );

    expect(assessment.issues).toContain("The guide repeats the same paragraph.");
    expect(assessment.issues).toContain("The guide contains an unclosed markdown code block.");
    expect(assessment.issues).toContain("The guide ends abruptly.");
  });

  test("reports a long but passive guide with no orientation, usable asset, or worked example", () => {
    const assessment = assessGeneratedLeadMagnetMarkdown(
      [
        "Useful context. ".repeat(80),
        "## Principle one",
        "This section explains an idea without giving the reader a tool.",
        "## Principle two",
        "This section adds more educational background.",
        "## Quick implementation plan",
        "1. Think about the topic.",
        "2. Consider what you learned.",
        "3. Revisit it later.",
      ].join("\n\n"),
    );

    expect(assessment.issues).toContain("The guide is missing a short 'How to use this resource' section.");
    expect(assessment.issues).toContain("The guide needs at least one copy-ready tool, template, checklist, script, prompt, scorecard, or decision rule.");
    expect(assessment.issues).toContain("The guide needs a concrete worked example or before-and-after demonstration.");
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
    expect(split.image).toEqual({
      alt: "Daniel Nogueira",
      src: "https://media.licdn.com/dms/image/profile-displayphoto.jpg",
    });
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

  test("renders repaired collapsed markdown tables as table markup", () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownDocument, {
        markdown:
          "| Step | Agent | Input | Output | Time | |---|---|---|---|---| | 1 | You | Topic idea | Topic brief | 5 min | | 2 | Hook Creator | Brief | Hooks | 3 min |",
      }),
    );

    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("Hook Creator");
    expect(html).not.toContain("|---|---|---|---|---| | 1 |");
  });
});
