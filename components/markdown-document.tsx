import * as React from "react";
import { AvatarImg } from "@/components/avatar-img";
import { normalizeCollapsedMarkdownTables } from "@/lib/markdown-tables";
import { cn } from "@/lib/utils";

type MarkdownDocumentProps = {
  markdown: string;
  className?: string;
};

type InlinePart =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export function MarkdownDocument({ markdown, className }: MarkdownDocumentProps) {
  const blocks = parseBlocks(markdown);
  return (
    <article
      className={cn(
        "prose-none min-w-0 text-[15px] leading-7 text-foreground",
        "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4",
        className,
      )}
    >
      {blocks.map((block, index) => renderBlock(block, index))}
    </article>
  );
}

type Block =
  | { kind: "heading"; id: string; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "image"; alt: string; src: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "rule" }
  | {
      kind: "list";
      ordered: boolean;
      items: Array<{ checked: boolean | null; text: string }>;
    };

export type MarkdownTocItem = {
  id: string;
  level: 1 | 2 | 3;
  text: string;
};

export function markdownTableOfContents(markdown: string): MarkdownTocItem[] {
  return parseBlocks(markdown)
    .filter((block): block is Extract<Block, { kind: "heading" }> => block.kind === "heading")
    .map(({ id, level, text }) => ({ id, level, text }));
}

function parseBlocks(markdown: string): Block[] {
  const normalized = normalizeCollapsedMarkdownTables(markdown).trim();
  if (!normalized) return [];
  const blocks: Block[] = [];
  const lines = normalized.split("\n");
  const headingCounts = new Map<string, number>();
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const baseId = markdownHeadingId(heading[2]);
      const count = (headingCounts.get(baseId) ?? 0) + 1;
      headingCounts.set(baseId, count);
      blocks.push({
        kind: "heading",
        id: count === 1 ? baseId : `${baseId}-${count}`,
        level: Math.min(heading[1].length, 3) as 1 | 2 | 3,
        text: heading[2].trim(),
      });
      i += 1;
      continue;
    }

    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }

    const image = line.trim().match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)$/);
    if (image) {
      blocks.push({ kind: "image", alt: image[1].trim(), src: image[2].trim() });
      i += 1;
      continue;
    }

    if (isTableStart(lines, i)) {
      const headers = parseTableRow(lines[i]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(parseTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    const quoteLines: string[] = [];
    while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
      quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
      i += 1;
    }
    if (quoteLines.length) {
      blocks.push({ kind: "quote", text: quoteLines.join(" ") });
      continue;
    }

    const listMatch = line.trim().match(/^([-*])\s+(.+)$/) ?? line.trim().match(/^(\d+[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const items: Array<{ checked: boolean | null; text: string }> = [];
      while (i < lines.length) {
        const item = lines[i].trim().match(ordered ? /^\d+[.)]\s+(.+)$/ : /^[-*]\s+(.+)$/);
        if (!item) break;
        const task = item[1].trim().match(/^\[([ xX])\]\s+(.+)$/);
        items.push({
          checked: task ? task[1].toLowerCase() === "x" : null,
          text: task ? task[2].trim() : item[1].trim(),
        });
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      const next = lines[i].trim();
      if (
        next.startsWith("```") ||
        /^(#{1,3})\s+/.test(next) ||
        /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(next) ||
        /^!\[[^\]]*\]\(https?:\/\/[^)\s]+\)$/.test(next) ||
        isTableStart(lines, i) ||
        /^>\s?/.test(next) ||
        /^[-*]\s+/.test(next) ||
        /^\d+[.)]\s+/.test(next)
      ) {
        break;
      }
      para.push(next);
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: para.join(" ") });
  }

  return blocks;
}

function renderBlock(block: Block, index: number): React.ReactNode {
  if (block.kind === "heading") {
    const className =
      block.level === 1
        ? "mt-9 mb-4 break-words text-3xl font-semibold tracking-tight first:mt-0"
        : block.level === 2
          ? "mt-8 mb-3 break-words text-2xl font-semibold tracking-tight first:mt-0"
          : "mt-7 mb-2 break-words text-xl font-semibold tracking-tight first:mt-0";
    const children = renderInline(block.text);
    if (block.level === 1) return <h1 key={index} id={block.id} className={cn(className, "scroll-mt-8")}>{children}</h1>;
    if (block.level === 2) return <h2 key={index} id={block.id} className={cn(className, "scroll-mt-8")}>{children}</h2>;
    return <h3 key={index} id={block.id} className={cn(className, "scroll-mt-8")}>{children}</h3>;
  }
  if (block.kind === "paragraph") {
    return <p key={index} className="my-4 whitespace-pre-wrap break-words">{renderInline(block.text)}</p>;
  }
  if (block.kind === "image") {
    const fallbackLabel = initialsFromAlt(block.alt);
    return (
      <figure key={index} className="my-6">
        <AvatarImg
          src={block.src}
          alt={block.alt}
          className="h-20 w-20 rounded-full border border-border/70 object-cover shadow-sm"
          fallback={
            <span className="flex h-20 w-20 items-center justify-center rounded-full border border-border/70 bg-primary/10 text-base font-semibold text-primary shadow-sm">
              {fallbackLabel}
            </span>
          }
        />
      </figure>
    );
  }
  if (block.kind === "quote") {
    return (
      <blockquote key={index} className="my-6 break-words rounded-xl border border-border/70 bg-muted/45 px-4 py-3 text-foreground/80">
        {renderInline(block.text)}
      </blockquote>
    );
  }
  if (block.kind === "rule") {
    return <hr key={index} className="my-8 border-0 border-t border-border/70" />;
  }
  if (block.kind === "code") {
    return (
      <pre key={index} className="my-5 max-w-full overflow-x-auto rounded-xl border border-border/70 bg-muted/50 p-4 text-sm leading-6">
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.kind === "table") {
    return (
      <div key={index} className="my-5 max-w-full overflow-x-auto rounded-xl border border-border/70">
        <table className="w-full min-w-[560px] border-collapse text-left text-sm leading-6">
          <thead className="bg-muted/60">
            <tr>
              {block.headers.map((header, headerIndex) => (
                <th key={headerIndex} className="border-b border-border/70 px-3 py-2 font-semibold text-foreground">
                  {renderInline(header)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-border/50 last:border-b-0">
                {block.headers.map((_, cellIndex) => (
                  <td key={cellIndex} className="align-top px-3 py-2 text-muted-foreground">
                    {renderInline(row[cellIndex] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const List = block.ordered ? "ol" : "ul";
  const isTaskList = block.items.some((item) => item.checked !== null);
  return (
    <List
      key={index}
      className={cn(
        "my-5 min-w-0 space-y-2.5",
        isTaskList ? "list-none pl-0" : "pl-6",
        !isTaskList && (block.ordered ? "list-decimal" : "list-disc"),
      )}
    >
      {block.items.map((item, itemIndex) => (
        <li key={itemIndex} className={cn("break-words", isTaskList && "flex items-start gap-3")}>
          {item.checked !== null && (
            <span
              aria-hidden="true"
              className={cn(
                "mt-1.5 grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px] font-semibold leading-none",
                item.checked
                  ? "border-state-success-border bg-state-success-bg text-state-success"
                  : "border-input bg-background text-transparent",
              )}
            >
              ✓
            </span>
          )}
          <span>{renderInline(item.text)}</span>
        </li>
      ))}
    </List>
  );
}

function markdownHeadingId(text: string): string {
  const id = text
    .replace(/[`*_~]/g, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return id || "section";
}

function initialsFromAlt(alt: string): string {
  const words = alt
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  const initials = words.map((word) => word[0]?.toUpperCase()).join("");
  return initials || "SI";
}

function isTableStart(lines: string[], index: number): boolean {
  return isTableRow(lines[index]) && isTableSeparator(lines[index + 1]);
}

function isTableRow(line: string | undefined): boolean {
  const trimmed = line?.trim() ?? "";
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.split("|").length >= 4;
}

function isTableSeparator(line: string | undefined): boolean {
  const cells = parseTableRow(line ?? "");
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderInline(text: string): React.ReactNode[] {
  return tokenizeInline(text).map((part, index) => {
    if (part.kind === "strong") return <strong key={index}>{part.text}</strong>;
    if (part.kind === "code") {
      return (
        <code key={index} className="rounded-md bg-muted px-1.5 py-0.5 text-[0.92em]">
          {part.text}
        </code>
      );
    }
    if (part.kind === "link") {
      return (
        <a key={index} href={part.href} target="_blank" rel="noreferrer">
          {part.text}
        </a>
      );
    }
    return <React.Fragment key={index}>{part.text}</React.Fragment>;
  });
}

function tokenizeInline(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re = /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push({ kind: "text", text: text.slice(last, match.index) });
    if (match[2]) parts.push({ kind: "code", text: match[2] });
    else if (match[4]) parts.push({ kind: "strong", text: match[4] });
    else if (match[6] && match[7]) parts.push({ kind: "link", text: match[6], href: match[7] });
    else if (match[8]) {
      const { href, trailing } = splitTrailingUrlPunctuation(match[8]);
      parts.push({ kind: "link", text: href, href });
      if (trailing) parts.push({ kind: "text", text: trailing });
    }
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

function splitTrailingUrlPunctuation(value: string): { href: string; trailing: string } {
  const match = value.match(/^(.+?)([.,;:!?]+)?$/);
  return {
    href: match?.[1] ?? value,
    trailing: match?.[2] ?? "",
  };
}
