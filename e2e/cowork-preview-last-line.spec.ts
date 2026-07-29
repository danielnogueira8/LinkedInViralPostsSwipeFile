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
  await page.goto("/dashboard");
  const chat = await createChat(page, "Cowork last-line geometry");
  const switcher = await createChat(page, "Cowork geometry switcher");

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
            id: "assistant-last-line-geometry",
            role: "assistant",
            content: "Here is the post.",
            tool_calls: null,
            tool_call_id: null,
            artifacts: [
              {
                id: "artifact-last-line-geometry",
                kind: "post",
                title: "Last-line geometry",
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

  try {
    await page.goto(`/dashboard?chat=${switcher.id}`);
    await page.getByText(chat.title, { exact: true }).locator("..").click();
    const textarea = page.getByLabel("Post body");
    await expect(textarea).toBeVisible();

    const widen = page.getByRole("button", {
      name: "Widen drafts panel for writing",
    });
    if (await widen.isVisible()) await widen.click();

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
    await page.request.delete(`/api/chats/${chat.id}`);
    await page.request.delete(`/api/chats/${switcher.id}`);
  }
});

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
