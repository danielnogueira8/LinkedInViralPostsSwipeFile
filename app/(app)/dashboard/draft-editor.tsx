"use client";

import { useEffect, useRef, useState } from "react";
import { Bold, Italic, List, ListOrdered, Smile } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  toggleStyle,
  toggleBulletList,
  toggleNumberedList,
  EMOJI_GROUPS,
  LINKEDIN_MAX_CHARS,
  LINKEDIN_SEE_MORE_CHARS,
  type FormatStyle,
} from "@/lib/linkedin-format";

// In-card editor for a draft post. Operates on a plain-text value and emits
// changes upward — the formatting is Unicode-based (see lib/linkedin-format)
// so what's typed here pastes into LinkedIn with bold/italic/lists intact.
export function DraftEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);

  // Apply a transform to the current selection (or, for list toggles with no
  // selection, the line the cursor is on) and restore the caret/selection so
  // the user can keep formatting without re-selecting.
  function applyToSelection(
    transform: (selected: string) => string,
    { wholeLineWhenEmpty = false }: { wholeLineWhenEmpty?: boolean } = {},
  ) {
    const ta = taRef.current;
    if (!ta) return;
    let start = ta.selectionStart;
    let end = ta.selectionEnd;

    // For list toggles with a collapsed selection, expand to the current line
    // so the user can toggle a bullet without selecting the whole line first.
    if (wholeLineWhenEmpty && start === end) {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const nextNl = value.indexOf("\n", end);
      const lineEnd = nextNl === -1 ? value.length : nextNl;
      start = lineStart;
      end = lineEnd;
    }
    if (start === end) return; // nothing to format

    const selected = value.slice(start, end);
    const replaced = transform(selected);
    const next = value.slice(0, start) + replaced + value.slice(end);
    onChange(next);

    // Restore selection over the transformed text on the next tick (after the
    // controlled re-render).
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start, start + replaced.length);
    });
  }

  function insertAtCursor(text: string) {
    const ta = taRef.current;
    if (!ta) {
      onChange(value + text);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      const caret = start + text.length;
      ta.setSelectionRange(caret, caret);
    });
  }

  const onStyle = (style: FormatStyle) =>
    applyToSelection((s) => toggleStyle(s, style));

  const count = value.length;
  const over = count > LINKEDIN_MAX_CHARS;

  return (
    <div className="flex flex-col gap-2">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 relative">
        <ToolbarButton label="Bold" onClick={() => onStyle("bold")}>
          <Bold className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Italic" onClick={() => onStyle("italic")}>
          <Italic className="h-3.5 w-3.5" />
        </ToolbarButton>
        <div className="mx-1 h-4 w-px bg-zinc-200" />
        <ToolbarButton
          label="Bulleted list"
          onClick={() =>
            applyToSelection(toggleBulletList, { wholeLineWhenEmpty: true })
          }
        >
          <List className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          label="Numbered list"
          onClick={() =>
            applyToSelection(toggleNumberedList, { wholeLineWhenEmpty: true })
          }
        >
          <ListOrdered className="h-3.5 w-3.5" />
        </ToolbarButton>
        <div className="mx-1 h-4 w-px bg-zinc-200" />
        <ToolbarButton
          label="Emoji"
          onClick={() => setEmojiOpen((o) => !o)}
          active={emojiOpen}
        >
          <Smile className="h-3.5 w-3.5" />
        </ToolbarButton>

        {emojiOpen && (
          <EmojiPicker
            onPick={(e) => {
              insertAtCursor(e);
              setEmojiOpen(false);
            }}
            onClose={() => setEmojiOpen(false)}
          />
        )}
      </div>

      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={10}
        className="w-full resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-[13px] leading-relaxed text-zinc-900 outline-none focus-visible:border-zinc-300 focus-visible:ring-2 focus-visible:ring-zinc-200"
        placeholder="Write your post…"
      />

      {/* Character counter — LinkedIn truncates the preview at ~210 and caps at
          3,000. Show both so the user knows where the hook gets cut. */}
      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span>
          {count <= LINKEDIN_SEE_MORE_CHARS ? (
            <span className="text-zinc-400">
              {LINKEDIN_SEE_MORE_CHARS - count} chars before “…see more”
            </span>
          ) : (
            <span className="text-zinc-400">
              hook cut at {LINKEDIN_SEE_MORE_CHARS} chars
            </span>
          )}
        </span>
        <span className={cn("tabular-nums", over && "text-red-600 font-medium")}>
          {count.toLocaleString()} / {LINKEDIN_MAX_CHARS.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900",
        active && "bg-zinc-100 text-zinc-900",
      )}
    >
      {children}
    </button>
  );
}

function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Close on outside click / Escape.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute left-0 top-9 z-20 w-64 rounded-xl border border-zinc-200 bg-white p-2 shadow-lg"
    >
      {EMOJI_GROUPS.map((group) => (
        <div key={group.label} className="mb-1.5 last:mb-0">
          <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
            {group.label}
          </div>
          <div className="grid grid-cols-6 gap-0.5">
            {group.emojis.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => onPick(e)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-lg transition-colors hover:bg-zinc-100"
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
