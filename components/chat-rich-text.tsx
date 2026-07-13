import type { ReactNode } from "react";

const INLINE_RE =
  /(\*\*|__)(?=\S)(.+?)(?<=\S)\1|(?<![A-Za-z0-9])_(?=\S)(.+?)(?<=\S)_(?![A-Za-z0-9])|\*(?=\S)([^*\n]+?)(?<=\S)\*/g;

export function renderInline(text: string): ReactNode {
  if (!text) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      // **bold** / __bold__
      parts.push(<strong key={key++}>{m[2]}</strong>);
    } else {
      // _italic_ (m[3]) or *italic* (m[4])
      parts.push(<em key={key++}>{m[3] ?? m[4]}</em>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
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
const HEADING_RE = /^(#{1,3})\s+(\S.*)$/;
const CODE_FENCE_RE = /^```[^`\s]*\s*$/;
const CODE_FENCE_CLOSE_RE = /^```\s*$/;

export type RichTextOptions = {
  streaming?: boolean;
};

export function renderRichText(
  text: string,
  mode: RichTextMode = "draft",
  options: RichTextOptions = {},
): ReactNode {
  if (!text) return text;
  const chat = mode === "chat";
  const source = text;
  // Fast path: nothing block-level → just inline formatting. In chat mode we
  // also include the Markdown blocks supported for assistant prose.
  const hasQuote = source.includes("\n> ") || source.startsWith("> ");
  const hasList = chat && /(?:^|\n)(?:[-•*]|\d{1,3}\.)\s/.test(source);
  const hasChatBlock =
    chat && /(?:^|\n)(?:#{1,3}\s+|```|\|)/.test(source);
  if (!hasQuote && !hasList && !hasChatBlock) {
    return renderInline(source);
  }

  const lines = source.split("\n");
  const blocks: ReactNode[] = [];
  let key = 0;
  let i = 0;
  // Streaming guard: the LAST line of a live buffer may still be arriving, so
  // do not promote it into a structured block mid-token. Once the message is
  // complete, its final line is complete even without a trailing newline.
  const lastIdx = lines.length - 1;
  const isCompleteLine = (idx: number) =>
    idx >= 0 && idx < lines.length && (idx < lastIdx || options.streaming !== true);
  const isCompleteListLine = (idx: number) =>
    isCompleteLine(idx) && LIST_ITEM_RE.test(lines[idx]);
  const headingAt = (idx: number) =>
    isCompleteLine(idx) ? lines[idx].match(HEADING_RE) : null;
  const codeFenceEndAt = (idx: number): number => {
    if (!isCompleteLine(idx) || !CODE_FENCE_RE.test(lines[idx].trim())) {
      return -1;
    }
    for (let end = idx + 1; end < lines.length; end++) {
      if (
        isCompleteLine(end) &&
        CODE_FENCE_CLOSE_RE.test(lines[end].trim())
      ) {
        return end;
      }
    }
    return -1;
  };
  const isCompleteTableStart = (idx: number) =>
    isCompleteLine(idx) &&
    isCompleteLine(idx + 1) &&
    isTableRow(lines[idx]) &&
    isTableSeparator(lines[idx + 1]);
  const startsStructuredBlock = (idx: number) =>
    headingAt(idx) !== null ||
    codeFenceEndAt(idx) >= 0 ||
    isCompleteTableStart(idx);

  while (i < lines.length) {
    const line = lines[i];
    const heading = chat ? headingAt(i) : null;
    const codeFenceEnd = chat ? codeFenceEndAt(i) : -1;
    if (chat && heading) {
      const level = heading[1].length as 1 | 2 | 3;
      const Heading = `h${level}` as "h1" | "h2" | "h3";
      const className =
        level === 1
          ? "mt-3 mb-1.5 text-xl font-semibold leading-7 tracking-tight first:mt-0"
          : level === 2
            ? "mt-3 mb-1 text-lg font-semibold leading-7 tracking-tight first:mt-0"
            : "mt-2.5 mb-1 text-base font-semibold leading-7 first:mt-0";
      blocks.push(
        <Heading key={`hd${key++}`} className={className}>
          {renderInline(heading[2])}
        </Heading>,
      );
      i++;
    } else if (chat && codeFenceEnd >= 0) {
      const language = line.trim().slice(3).trim();
      const code = lines.slice(i + 1, codeFenceEnd).join("\n");
      blocks.push(
        <pre
          key={`cd${key++}`}
          className="my-2 max-w-full overflow-x-auto rounded-xl border border-border/70 bg-muted/55 p-3 text-[13px] leading-6"
        >
          <code data-language={language || undefined}>{code}</code>
        </pre>,
      );
      i = codeFenceEnd + 1;
    } else if (chat && isCompleteTableStart(i)) {
      const headers = parseTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isCompleteLine(i) && isTableRow(lines[i])) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      blocks.push(
        <div
          key={`tb${key++}`}
          className="my-2 max-w-full overflow-x-auto rounded-xl border border-border/70"
        >
          <table className="w-full min-w-[28rem] border-collapse text-left text-[13px] leading-6">
            <thead className="bg-muted/60">
              <tr>
                {headers.map((header, cellIndex) => (
                  <th
                    key={cellIndex}
                    className="border-b border-border/70 px-3 py-2 font-semibold text-foreground"
                  >
                    {renderInline(header)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  className="border-b border-border/50 last:border-b-0"
                >
                  {headers.map((_, cellIndex) => (
                    <td
                      key={cellIndex}
                      className="align-top px-3 py-2 text-muted-foreground"
                    >
                      {renderInline(row[cellIndex] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^>\s?/.test(line)) {
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
        !(chat && isCompleteListLine(i)) &&
        !(chat && startsStructuredBlock(i))
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

function isTableRow(line: string | undefined): boolean {
  const trimmed = line?.trim() ?? "";
  return (
    trimmed.startsWith("|") &&
    trimmed.endsWith("|") &&
    parseTableRow(trimmed).length >= 2
  );
}

function isTableSeparator(line: string | undefined): boolean {
  const cells = parseTableRow(line ?? "");
  return (
    cells.length >= 2 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
  );
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}
