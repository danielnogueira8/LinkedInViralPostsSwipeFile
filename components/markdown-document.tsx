import * as React from "react";
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
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "image"; alt: string; src: string }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

function parseBlocks(markdown: string): Block[] {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const blocks: Block[] = [];
  const lines = normalized.split("\n");
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
      blocks.push({
        kind: "heading",
        level: Math.min(heading[1].length, 3) as 1 | 2 | 3,
        text: heading[2].trim(),
      });
      i += 1;
      continue;
    }

    const image = line.trim().match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)$/);
    if (image) {
      blocks.push({ kind: "image", alt: image[1].trim(), src: image[2].trim() });
      i += 1;
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
      const items: string[] = [];
      while (i < lines.length) {
        const item = lines[i].trim().match(ordered ? /^\d+[.)]\s+(.+)$/ : /^[-*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1].trim());
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
        /^!\[[^\]]*\]\(https?:\/\/[^)\s]+\)$/.test(next) ||
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
    if (block.level === 1) return <h1 key={index} className={className}>{children}</h1>;
    if (block.level === 2) return <h2 key={index} className={className}>{children}</h2>;
    return <h3 key={index} className={className}>{children}</h3>;
  }
  if (block.kind === "paragraph") {
    return <p key={index} className="my-4 whitespace-pre-wrap break-words">{renderInline(block.text)}</p>;
  }
  if (block.kind === "image") {
    return (
      <figure key={index} className="my-6">
        {/* eslint-disable-next-line @next/next/no-img-element -- Lead magnet markdown can reference arbitrary public image hosts. */}
        <img
          src={block.src}
          alt={block.alt}
          className="h-20 w-20 rounded-full border border-border/70 object-cover shadow-sm"
          loading="lazy"
        />
      </figure>
    );
  }
  if (block.kind === "quote") {
    return (
      <blockquote key={index} className="my-5 break-words border-l-2 border-primary/40 pl-4 text-muted-foreground">
        {renderInline(block.text)}
      </blockquote>
    );
  }
  if (block.kind === "code") {
    return (
      <pre key={index} className="my-5 max-w-full overflow-x-auto rounded-xl border border-border/70 bg-muted/50 p-4 text-sm leading-6">
        <code>{block.text}</code>
      </pre>
    );
  }
  const List = block.ordered ? "ol" : "ul";
  return (
    <List key={index} className={cn("my-4 min-w-0 space-y-2 pl-6", block.ordered ? "list-decimal" : "list-disc")}>
      {block.items.map((item, itemIndex) => (
        <li key={itemIndex} className="break-words">{renderInline(item)}</li>
      ))}
    </List>
  );
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
