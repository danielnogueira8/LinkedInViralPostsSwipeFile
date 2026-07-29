import { expect, test } from "@playwright/test";

const LONG_POST = `Your offer can get copied. Your pricing can get undercut. Your product can get cloned by someone with a bigger team and more money.

Nobody can copy 18 months of you showing up and telling people exactly how you think.

I've watched founders with a worse product win the deal because the buyer had been reading their posts for 3 months before the sales call ever happened. The call was a formality. The brand already did the selling.

That's the lever. Not likes, not impressions, not follower count. Trust that compounds every time you post something true and specific instead of safe.

The hard part isn't writing posts. It's writing them for 6 months with almost nobody watching, before the compounding shows up.

Most people stop right there.

The ones who don't are the ones whose DMs eventually fill up with people who already decided to buy before they asked the price.

You don't need a personal life on display to build this. You need proof, opinions, and reps. That's a format problem, not a personality problem.

Start posting like the next 12 months are already decided by what you write this week.
Because they are.`;

test("the Cowork post preview leaves breathing room below the final line", async ({
  page,
}) => {
  const { textarea, cleanup } = await openLongCoworkPost(
    page,
    "Cowork last-line geometry",
  );

  try {
    const geometry = await textarea.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      const styles = getComputedStyle(textarea);
      const lineHeight = Number.parseFloat(styles.lineHeight);
      const editorScroller = textarea.parentElement;
      if (!editorScroller) throw new Error("Editor scroller not found");
      editorScroller.scrollTop = editorScroller.scrollHeight;

      const mirror = document.createElement("div");
      Object.assign(mirror.style, {
        position: "absolute",
        visibility: "hidden",
        boxSizing: styles.boxSizing,
        width: `${textarea.clientWidth}px`,
        padding: styles.padding,
        border: "0",
        fontFamily: styles.fontFamily,
        fontSize: styles.fontSize,
        fontStyle: styles.fontStyle,
        fontWeight: styles.fontWeight,
        letterSpacing: styles.letterSpacing,
        lineHeight: styles.lineHeight,
        overflowWrap: styles.overflowWrap,
        whiteSpace: "pre-wrap",
      });
      mirror.append(document.createTextNode(textarea.value.slice(0, -1)));
      const finalGlyph = document.createElement("span");
      finalGlyph.textContent = textarea.value.slice(-1);
      mirror.append(finalGlyph);
      document.body.append(mirror);
      const mirrorTop = mirror.getBoundingClientRect().top;
      const finalGlyphBottom = finalGlyph.getBoundingClientRect().bottom;
      mirror.remove();

      return {
        lineHeight,
        finalLineClearance:
          textarea.clientHeight - (finalGlyphBottom - mirrorTop),
        inlineHeight: textarea.style.height,
        editorClientHeight: editorScroller.clientHeight,
        editorScrollHeight: editorScroller.scrollHeight,
        editorScrollTop: editorScroller.scrollTop,
      };
    });

    expect(
      geometry.finalLineClearance,
      JSON.stringify(geometry),
    ).toBeGreaterThanOrEqual(Math.ceil(geometry.lineHeight));
  } finally {
    await cleanup();
  }
});

test("typing in a scrolled Cowork post keeps the caret in view", async ({
  page,
}) => {
  const { textarea, cleanup } = await openLongCoworkPost(
    page,
    "Cowork typing scroll",
  );

  try {
    const initialEditorState = await textarea.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      const editorScroller = textarea.parentElement;
      if (!editorScroller) throw new Error("Editor scroller not found");
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      editorScroller.scrollTop = editorScroller.scrollHeight;
      return {
        scrollTop: editorScroller.scrollTop,
        textareaHeight: textarea.clientHeight,
      };
    });
    expect(initialEditorState.scrollTop).toBeGreaterThan(0);

    await textarea.press("Enter");
    await textarea.pressSequentially("New final line");

    const readEditorState = () =>
      textarea.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement;
        const editorScroller = textarea.parentElement;
        if (!editorScroller) throw new Error("Editor scroller not found");
        const textareaRect = textarea.getBoundingClientRect();
        const scrollerRect = editorScroller.getBoundingClientRect();
        const styles = getComputedStyle(textarea);
        const caretBottom =
          textareaRect.bottom - Number.parseFloat(styles.paddingBottom);
        return {
          caretIsVisible: caretBottom <= scrollerRect.bottom + 1,
          scrollTop: editorScroller.scrollTop,
          textareaHeight: textarea.clientHeight,
        };
      });

    await expect.poll(async () => (await readEditorState()).caretIsVisible).toBe(
      true,
    );
    const finalEditorState = await readEditorState();
    expect(finalEditorState.scrollTop).toBeGreaterThanOrEqual(
      initialEditorState.scrollTop - 8,
    );
    expect(finalEditorState.textareaHeight).toBeGreaterThan(
      initialEditorState.textareaHeight,
    );
  } finally {
    await cleanup();
  }
});

async function openLongCoworkPost(
  page: import("@playwright/test").Page,
  title: string,
) {
  await page.goto("/dashboard");
  const chat = await createChat(page, title);
  const switcher = await createChat(page, `${title} switcher`);
  const fixtureId = title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");

  await page.route(`**/api/chats/${chat.id}`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        chat: { ...chat, running: false },
        messages: [
          {
            id: `assistant-${fixtureId}`,
            role: "assistant",
            content: "Here is the post.",
            tool_calls: null,
            tool_call_id: null,
            artifacts: [
              {
                id: `artifact-${fixtureId}`,
                kind: "post",
                title,
                body: LONG_POST,
                meta: {},
              },
            ],
            created_at: "2026-07-29T13:55:00.000Z",
          },
        ],
      }),
    });
  });

  await page.goto(`/dashboard?chat=${switcher.id}`);
  await page.getByText(chat.title, { exact: true }).locator("..").click();
  const textarea = page.getByLabel("Post body");
  await expect(textarea).toBeVisible();

  const widen = page.getByRole("button", {
    name: "Widen drafts panel for writing",
  });
  if (await widen.isVisible()) await widen.click();

  return {
    textarea,
    cleanup: async () => {
      await page.request.delete(`/api/chats/${chat.id}`);
      await page.request.delete(`/api/chats/${switcher.id}`);
    },
  };
}

async function createChat(
  page: import("@playwright/test").Page,
  title: string,
): Promise<{ id: string; title: string }> {
  return page.evaluate(async (chatTitle) => {
    const response = await fetch("/api/chats", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: chatTitle }),
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      error?: string;
      chat?: { id: string; title: string };
    };
    if (!payload.ok || !payload.chat) {
      throw new Error(payload.error || "Chat creation failed");
    }
    return payload.chat;
  }, title);
}
