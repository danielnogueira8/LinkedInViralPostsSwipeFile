import { describe, test, expect } from "vitest";
import {
  clientShouldApplyLeadMagnet,
  classifyFile,
  dataTransferHasFiles,
  leadMagnetPickerDisabledForSource,
  prettyBytes,
  suggestedLeadMagnetPromptForPost,
} from "@/lib/chat-ui-policy";
import {
  hydrate,
  stripAskQuestionFromText,
  type RawDbMessage,
} from "@/lib/chat-hydration";

// ---------------------------------------------------------------------------
// Chat I/O helpers: file-attachment classification (text vs parseable file vs
// image vs rejected), byte formatting, and DB-row → display-message hydration.
// All pure.
// ---------------------------------------------------------------------------

// Build a File with a given name + MIME (content is irrelevant to classifyFile).
function file(name: string, type: string): File {
  return new File(["x"], name, { type });
}

describe("classifyFile", () => {
  test("images are accepted for vision description", () => {
    expect(classifyFile(file("photo.png", "image/png"))).toBe("image");
    expect(classifyFile(file("pic.jpg", "image/jpeg"))).toBe("image");
    expect(classifyFile(file("mock.webp", ""))).toBe("image");
  });

  test("video / audio are rejected", () => {
    expect(classifyFile(file("clip.mp4", "video/mp4"))).toBe("reject-other");
    expect(classifyFile(file("note.mp3", "audio/mpeg"))).toBe("reject-other");
  });

  test("plain-text types are read as text", () => {
    expect(classifyFile(file("notes.txt", "text/plain"))).toBe("text");
    expect(classifyFile(file("readme.md", "text/markdown"))).toBe("text");
    expect(classifyFile(file("tone.skills", ""))).toBe("text");
    expect(classifyFile(file("data.csv", "text/csv"))).toBe("text");
  });

  test("text-ish files with an empty MIME are classified by extension", () => {
    expect(classifyFile(file("notes.md", ""))).toBe("text");
    expect(classifyFile(file("log.log", ""))).toBe("text");
    expect(classifyFile(file("data.json", ""))).toBe("text");
  });

  test("PDF and Word docs are sent as parseable files", () => {
    expect(classifyFile(file("brief.pdf", "application/pdf"))).toBe("file");
    expect(classifyFile(file("doc.docx", ""))).toBe("file");
    expect(classifyFile(file("old.doc", ""))).toBe("file");
  });

  test("an unknown type with no recognizable extension is rejected", () => {
    expect(classifyFile(file("mystery.xyz", ""))).toBe("reject-other");
    expect(classifyFile(file("archive.zip", "application/zip"))).toBe("reject-other");
  });
});

describe("dataTransferHasFiles — drag-drop guard", () => {
  test("true when the drag payload lists Files", () => {
    expect(dataTransferHasFiles({ types: ["Files"] })).toBe(true);
    // Mixed payloads (some browsers include text/plain alongside files) still
    // count as a file drag.
    expect(dataTransferHasFiles({ types: ["Files", "text/plain"] })).toBe(true);
  });

  test("false for a non-file drag (selected text, a dragged link)", () => {
    expect(dataTransferHasFiles({ types: ["text/plain"] })).toBe(false);
    expect(dataTransferHasFiles({ types: ["text/uri-list", "text/plain"] })).toBe(
      false,
    );
    expect(dataTransferHasFiles({ types: [] })).toBe(false);
  });

  test("false when the DataTransfer is missing or malformed", () => {
    expect(dataTransferHasFiles(null)).toBe(false);
    expect(dataTransferHasFiles(undefined)).toBe(false);
    expect(dataTransferHasFiles({})).toBe(false);
  });

  test("accepts a DOMStringList-like (array-from-able) types value", () => {
    // Real DataTransfer.types is a DOMStringList, not an array; Array.from
    // handles both. Simulate the iterable-but-not-array shape.
    const domStringListLike = {
      0: "Files",
      length: 1,
      [Symbol.iterator]: function* () {
        yield "Files";
      },
    } as unknown as readonly string[];
    expect(dataTransferHasFiles({ types: domStringListLike })).toBe(true);
  });
});

describe("clientShouldApplyLeadMagnet", () => {
  test("applies a selected lead magnet to search/adapt lead-magnet prompts", () => {
    expect(
      clientShouldApplyLeadMagnet(
        "Find the most recent high-performing lead-magnet post and adapt it in my voice.",
        false,
        null,
        false,
      ),
    ).toBe(true);
  });

  test("applies a selected lead magnet when the topic is itself a giveaway asset", () => {
    // "checklist" reads as a lead-magnet asset, so this is a giveaway post.
    expect(
      clientShouldApplyLeadMagnet("Write a post about my onboarding checklist.", false, null, true),
    ).toBe(true);
  });

  test("THE MISUSE FIX: a selected lead magnet does NOT hijack a neutral post request", () => {
    // The core bug — a leftover / accidental lead-magnet selection turned a
    // plain "write a post about X" into a giveaway post. Now it stays regular.
    expect(
      clientShouldApplyLeadMagnet(
        "Write a post about remote work productivity.",
        false,
        null,
        true,
      ),
    ).toBe(false);
  });

  test("does not apply an explicitly selected lead magnet to explicitly regular posts", () => {
    expect(
      clientShouldApplyLeadMagnet(
        "Write a regular post about founder-led sales.",
        false,
        null,
        true,
      ),
    ).toBe(false);
  });

  test("a lead-magnet source preserves lead-magnet mode for a broad model request", () => {
    expect(
      clientShouldApplyLeadMagnet(
        "Model an original post in my voice after the attached post.",
        true,
        null,
        false,
        "lead_magnet",
      ),
    ).toBe(true);
  });

  test("a lead-magnet source DOES apply when the message asks for a giveaway post", () => {
    expect(
      clientShouldApplyLeadMagnet(
        "Model this into a lead magnet post in my voice.",
        true,
        null,
        false,
        "lead_magnet",
      ),
    ).toBe(true);
  });

  test("does not auto-apply for modeled source posts classified as regular", () => {
    expect(
      clientShouldApplyLeadMagnet(
        "Model an original post in my voice after the attached post.",
        true,
        null,
        false,
        "regular",
      ),
    ).toBe(false);
  });

  test("an explicitly selected lead magnet applies to a broad modeled post request", () => {
    expect(
      clientShouldApplyLeadMagnet(
        "Model an original post in my voice after the attached post.",
        true,
        null,
        true,
        "regular",
      ),
    ).toBe(true);
  });

  test("a forced lead-magnet format applies even when prompt copy is broad", () => {
    expect(
      clientShouldApplyLeadMagnet(
        "Write about my onboarding checklist.",
        false,
        "lead_magnet_resource_inventory",
        false,
      ),
    ).toBe(true);
  });
});

describe("leadMagnetPickerDisabledForSource", () => {
  test("keeps the picker available so users can create or select a giveaway intentionally", () => {
    expect(leadMagnetPickerDisabledForSource("lead_magnet")).toBe(false);
    expect(leadMagnetPickerDisabledForSource("regular")).toBe(false);
    expect(leadMagnetPickerDisabledForSource(null)).toBe(false);
  });
});

describe("suggestedLeadMagnetPromptForPost", () => {
  test("seeds a specific resource brief from the composer prompt and modeled source", () => {
    const prompt = suggestedLeadMagnetPromptForPost(
      "Model this into a lead magnet post about founder onboarding.",
      {
        postType: "lead_magnet",
        postText: "Comment ONBOARDING and I will send the checklist I use with clients.",
      },
    );

    expect(prompt).toContain("founder onboarding");
    expect(prompt).toContain("Use this modeled source angle");
    expect(prompt).toContain("concrete enough to give away");
    expect(prompt.length).toBeLessThanOrEqual(1200);
  });

  test("falls back to a generic giveaway resource brief when there is no source", () => {
    expect(suggestedLeadMagnetPromptForPost("", null)).toContain(
      "Create a practical lead magnet",
    );
  });
});

describe("prettyBytes", () => {
  test("bytes below 1KB", () => {
    expect(prettyBytes(0)).toBe("0 B");
    expect(prettyBytes(512)).toBe("512 B");
    expect(prettyBytes(1023)).toBe("1023 B");
  });
  test("kilobytes (rounded), at the boundary", () => {
    expect(prettyBytes(1024)).toBe("1 KB");
    expect(prettyBytes(1536)).toBe("2 KB"); // rounds
    expect(prettyBytes(1024 * 1023)).toBe("1023 KB");
  });
  test("megabytes (1 decimal)", () => {
    expect(prettyBytes(1024 * 1024)).toBe("1.0 MB");
    expect(prettyBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });
});

describe("hydrate — DB rows → display messages", () => {
  const row = (over: Partial<RawDbMessage>): RawDbMessage => ({
    id: "id",
    role: "user",
    content: "",
    artifacts: null,
    ...over,
  });

  test("drops 'tool' rows (internal, not shown)", () => {
    const out = hydrate([
      row({ id: "u", role: "user", content: "hi" }),
      row({ id: "t", role: "tool", content: '{"ok":true}' }),
      row({ id: "a", role: "assistant", content: "hello" }),
    ]);
    expect(out.map((m) => m.id)).toEqual(["u", "a"]);
  });

  test("strips post/hook/cite fences from assistant content (they become cards)", () => {
    const out = hydrate([
      row({
        id: "a",
        role: "assistant",
        content: "Here you go:\n\n```post\nThe body\n```\n\nDone.",
      }),
    ]);
    expect(out[0].text).not.toContain("```");
    expect(out[0].text).toContain("Here you go:");
    expect(out[0].text).toContain("Done.");
  });

  test("user content is kept LITERAL (a user post with '- ' lines isn't restyled)", () => {
    const userText = "My framework:\n```post\nnot a real fence in user text\n```";
    const out = hydrate([row({ id: "u", role: "user", content: userText })]);
    // User content is passed through verbatim (only assistant text is stripped).
    expect(out[0].text).toBe(userText);
  });

  test("artifacts are carried through (null → undefined)", () => {
    const arts = [{ id: "p", kind: "post" as const, title: "T", body: "b" }];
    const out = hydrate([row({ id: "a", role: "assistant", content: "x", artifacts: arts })]);
    expect(out[0].artifacts).toEqual(arts);
    const out2 = hydrate([row({ id: "u", role: "user", content: "x", artifacts: null })]);
    expect(out2[0].artifacts).toBeUndefined();
  });

  test("preserves order", () => {
    const out = hydrate([
      row({ id: "1", role: "user", content: "a" }),
      row({ id: "2", role: "assistant", content: "b" }),
      row({ id: "3", role: "user", content: "c" }),
    ]);
    expect(out.map((m) => m.id)).toEqual(["1", "2", "3"]);
  });

  test("assistant ask rows do not duplicate the question as prose", () => {
    const question = "Which angle should I draft?";
    const out = hydrate([
      row({
        id: "a",
        role: "assistant",
        content: question,
        tool_calls: [
          {
            id: "tc",
            type: "function",
            function: {
              name: "ask_user",
              arguments: JSON.stringify({
                question,
                options: ["Before/after", "Contrarian"],
              }),
            },
          },
        ],
      }),
    ]);

    expect(out[0].ask?.question).toBe(question);
    expect(out[0].text).toBe("");
  });

  test("assistant ask rows keep prior prose but trim the repeated trailing question", () => {
    expect(
      stripAskQuestionFromText(
        "Here are the angles:\n- One\n- Two\n\nWhich angle should I draft?",
        "Which angle should I draft?",
      ),
    ).toBe("Here are the angles:\n- One\n- Two");
  });

  test("rehydrates selected lead magnet badges from user tool calls", () => {
    const out = hydrate([
      row({
        id: "u",
        role: "user",
        content: "Write a lead magnet post",
        tool_calls: [
          {
            id: "_lead_magnet_selected",
            type: "function",
            function: {
              name: "_lead_magnet_selected",
              arguments: JSON.stringify({
                id: "55555555-5555-5555-5555-555555555555",
                title: "Founder Content Checklist",
                selection: "auto",
                publicSlug: "founder-content-checklist-abcd1234",
                selectionSummary: "A practical checklist for turning one call into five posts.",
                deliverables: ["Call notes checklist", "Post angle map"],
                resourceType: "checklist",
                estimatedMinutes: 15,
              }),
            },
          },
        ],
      }),
    ]);

    expect(out[0].leadMagnet).toEqual({
      id: "55555555-5555-5555-5555-555555555555",
      title: "Founder Content Checklist",
      selection: "auto",
      publicSlug: "founder-content-checklist-abcd1234",
      selectionSummary: "A practical checklist for turning one call into five posts.",
      deliverables: ["Call notes checklist", "Post angle map"],
      resourceType: "checklist",
      estimatedMinutes: 15,
    });
  });
});
