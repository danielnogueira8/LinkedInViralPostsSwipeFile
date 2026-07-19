import type { ReactNode } from "react";
import { contentBodyForFormat } from "@/lib/markdown/mode";
import { PLACEHOLDER_RE } from "@/lib/chat-composer-policy";

const INLINE_RE =
  /(\*\*|__)(?=\S)(.+?)(?<=\S)\1|(?<![A-Za-z0-9])_(?=\S)(.+?)(?<=\S)_(?![A-Za-z0-9])|\*(?=\S)([^*\n]+?)(?<=\S)\*/g;

// Split a plain-text segment (already past the bold/italic pass) on any
// unfilled [bracket] placeholder, highlighting each one the same way the
// composer nudges the user to fill "[topic]" before sending — a draft can
// legitimately ship one (e.g. "The turning point was [insert the specific
// moment...]") when the model didn't have enough grounding to fill it in,
// and it should read as obviously unfinished rather than blend into the
// post's prose. `nextKey` is a shared counter (not a fresh 0 per call) so
// keys stay unique across every segment renderInline hands it, including
// bold/italic bodies rendered on later loop iterations.
function renderPlaceholderSpans(text: string, nextKey: () => number): ReactNode {
  if (!text) return text;
  PLACEHOLDER_RE.lastIndex = 0;
  if (!PLACEHOLDER_RE.test(text)) return text;
  PLACEHOLDER_RE.lastIndex = 0;
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <mark key={nextKey()} className="rounded bg-amber-100 px-0.5 text-amber-900">
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function renderInline(text: string): ReactNode {
  if (!text) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  const nextKey = () => key++;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) {
      parts.push(renderPlaceholderSpans(text.slice(last, m.index), nextKey));
    }
    if (m[2] !== undefined) {
      // **bold** / __bold__
      parts.push(<strong key={nextKey()}>{renderPlaceholderSpans(m[2], nextKey)}</strong>);
    } else {
      // _italic_ (m[3]) or *italic* (m[4])
      const body = m[3] ?? m[4];
      parts.push(<em key={nextKey()}>{renderPlaceholderSpans(body, nextKey)}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parts.push(renderPlaceholderSpans(text.slice(last), nextKey));
  }
  return parts.length ? parts : text;
}

// Render mode. "draft" is the byte-for-byte legacy behavior (blockquotes +
// inline only) and is the DEFAULT — so the draft-body surfaces (the saved-posts
// list, the in-chat post preview) keep rendering a real LinkedIn post literally:
// a post that starts a line with "- " or "1." must NOT be restyled as a list.
// "chat" mode additionally turns contiguous "- "/"• "/"* " and "1. " runs into
// proper <ul>/<ol>, and is used ONLY for the assistant's conversational prose.
export type RichTextMode = "draft" | "chat";

// A chat-prose line is a list item: "- ", "• ", "* " (unordered) or "1. "
// (ordered). The marker must be followed by a space + content. Capture group 1 =
// the ordered number (undefined for unordered).
const LIST_ITEM_RE = /^(?:[-•*]|(\d{1,3})\.)\s+(?=\S)/;
const ORDERED_RE = /^\d{1,3}\.\s+/;

// `streaming` = the assistant message is still arriving token-by-token. While
// true, the LAST buffer line is held back from list promotion (see
// isCompleteListLine) to avoid a mid-stream text→<li> reclassification flicker.
// Once the turn finishes it MUST be false, or a list whose final item is the
// message's last line renders that item as raw "- **…**" markdown forever (the
// newline that would have "committed" it never arrives). Non-chat callers and
// the saved-drafts surface pass neither arg → default false, so a completed
// message always promotes its final list item.
// `markdown` opt-in (4th arg): only for text written by a markdown-EMITTING
// model (GPT-5.6 Luna), gated by the caller's durable content format. When true we
// first run the text through markdownToLinkedIn — the SAME converter the
// publish/copy paths use — so the on-screen preview is WYSIWYG-identical to what
// ships to LinkedIn: `**bold**`/`## heading` → Unicode bold, `- ` → "• ",
// `[t](u)` → "t (u)". The result is plain text with NO markdown metacharacters,
// so the block/inline passes below only ever see clean text — the "untrusted
// text is a React text child, never an href/attribute" invariant is preserved
// (no [text](url) case is ever added to the renderer itself; links are flattened
// to plain text upstream). When `markdown` is false (Haiku / GLM / Gemini — the
// DEFAULT), this is a no-op and the code path below is byte-for-byte legacy.
export function renderRichText(
  rawText: string,
  mode: RichTextMode = "draft",
  streaming = false,
  markdown = false,
): ReactNode {
  if (!rawText) return rawText;
  const text = contentBodyForFormat(rawText, markdown ? "markdown" : "plain");
  const chat = mode === "chat";
  // Fast path: nothing block-level → just inline formatting. In chat mode we
  // also early-out only when there's no list marker at a line start.
  const hasQuote = text.includes("\n> ") || text.startsWith("> ");
  const hasList = chat && /(?:^|\n)(?:[-•*]|\d{1,3}\.)\s/.test(text);
  if (!hasQuote && !hasList) {
    return renderInline(text);
  }

  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let key = 0;
  let i = 0;
  // Streaming guard: a list item is only "complete" once a newline proves the
  // line is fully streamed. The LAST line of the buffer may still be arriving,
  // so WHILE STREAMING we don't promote it to a list item (avoids a per-token
  // text→<li> reclassification flicker). It renders as plain text until the
  // newline commits, then snaps into the list on the next frame. Once the turn
  // has finished (streaming === false) the final line is settled, so it IS
  // eligible — otherwise a list ending on the message's last line leaves that
  // item as raw "- **…**" text permanently.
  const lastIdx = lines.length - 1;
  const isCompleteListLine = (idx: number) =>
    (!streaming || idx < lastIdx) && LIST_ITEM_RE.test(lines[idx]);

  while (i < lines.length) {
    const line = lines[i];
    if (/^>\s?/.test(line)) {
      // Contiguous run of blockquote lines.
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote
          key={`bq${key++}`}
          className="border-l-2 border-border pl-3 my-1 text-foreground/80 italic"
        >
          {renderInline(quoted.join("\n"))}
        </blockquote>,
      );
    } else if (chat && isCompleteListLine(i)) {
      // Contiguous run of (complete) list items → one <ul> or <ol>. The list's
      // ordered-ness is decided by its first item. We render the model's LITERAL
      // number for ordered lists (not a CSS counter) so a half-streamed list
      // never renumbers items already painted.
      const ordered = ORDERED_RE.test(line);
      const items: { num: string | null; body: string }[] = [];
      while (i < lines.length && isCompleteListLine(i)) {
        const m = lines[i].match(LIST_ITEM_RE)!;
        items.push({ num: m[1] ?? null, body: lines[i].slice(m[0].length) });
        i++;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={`ls${key++}`} className="my-1 flex flex-col gap-0.5">
          {items.map((it, n) => (
            <li key={n} className="flex gap-2">
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {ordered ? `${it.num ?? n + 1}.` : "•"}
              </span>
              {/* min-w-0 + break-words: a long unbroken token (a pasted
                  URL-as-text, a kebab-handle) wraps instead of forcing
                  horizontal scroll on mobile. */}
              <span className="min-w-0 break-words">{renderInline(it.body)}</span>
            </li>
          ))}
        </Tag>,
      );
    } else {
      // Contiguous run of normal lines → one text node (whitespace-pre-wrap
      // keeps the line breaks between them). Stops at the next blockquote or
      // (in chat mode) the next complete list item.
      const normal: string[] = [];
      while (
        i < lines.length &&
        !/^>\s?/.test(lines[i]) &&
        !(chat && isCompleteListLine(i))
      ) {
        normal.push(lines[i]);
        i++;
      }
      // Trim a single trailing blank line before a following block, so the
      // pre-wrap newline + the block's own margin don't double the gap.
      if (
        normal.length > 1 &&
        normal[normal.length - 1] === "" &&
        i < lines.length
      ) {
        normal.pop();
      }
      blocks.push(<span key={`tx${key++}`}>{renderInline(normal.join("\n"))}</span>);
    }
  }
  return blocks;
}
