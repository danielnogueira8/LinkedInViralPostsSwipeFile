"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Smile,
  Sparkles,
  Loader2,
  ArrowUp,
} from "lucide-react";
import { toast } from "sonner";
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
import { getSelectionAnchor } from "@/lib/textarea-caret";

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
  // Floating toolbar position (viewport coords), shown only while a non-empty
  // selection exists inside the textarea — the ChatGPT/Notion "highlight to
  // format" affordance.
  const [floatPos, setFloatPos] = useState<{ top: number; left: number } | null>(
    null,
  );

  // Recompute the floating toolbar position from the current selection. Hidden
  // when the selection is collapsed (nothing highlighted).
  const refreshFloat = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    // Only when our textarea owns the selection — `selectionchange` fires for
    // selections anywhere in the document, where ta's offsets would be stale.
    if (ta.ownerDocument.activeElement !== ta) {
      setFloatPos(null);
      return;
    }
    const { selectionStart: s, selectionEnd: e } = ta;
    if (s === e) {
      setFloatPos(null);
      return;
    }
    setFloatPos(getSelectionAnchor(ta, s, e));
  }, []);

  // Keep the toolbar glued to the selection as the user selects, and dismiss it
  // on blur / scroll / resize (where the anchor would otherwise go stale).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const onSelect = () => refreshFloat();
    const hide = () => setFloatPos(null);
    document.addEventListener("selectionchange", onSelect);
    window.addEventListener("resize", hide);
    // Capture-phase scroll catches the chat panel scrolling, not just window.
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("selectionchange", onSelect);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [refreshFloat]);

  // --- AI "Ask for changes" on the highlighted span -----------------------
  // When the user opens the prompt, we freeze the selection range + text so it
  // survives the textarea losing focus to the input box. anchor positions the
  // prompt box; busy disables submit while the rewrite is in flight.
  const [askState, setAskState] = useState<{
    start: number;
    end: number;
    selected: string;
    top: number;
    left: number;
  } | null>(null);
  const [askBusy, setAskBusy] = useState(false);

  const openAsk = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    if (s === e) return; // need a selection
    const pos = floatPos ?? getSelectionAnchor(ta, s, e);
    setFloatPos(null); // hide the format toolbar while the prompt is open
    setAskState({ start: s, end: e, selected: value.slice(s, e), ...pos });
  }, [floatPos, value]);

  // ⌘K / Ctrl+K opens the prompt when there's a selection.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
        if (ta.selectionStart !== ta.selectionEnd) {
          ev.preventDefault();
          openAsk();
        }
      }
    };
    ta.addEventListener("keydown", onKey);
    return () => ta.removeEventListener("keydown", onKey);
  }, [openAsk]);

  async function submitAsk(instruction: string) {
    if (!askState || askBusy) return;
    setAskBusy(true);
    try {
      const res = await fetch("/api/rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selection: askState.selected,
          instruction,
          fullDraft: value,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Rewrite failed");
      // Replace exactly the captured range (not the live selection, which may
      // have changed). The rest of the draft is untouched.
      const next =
        value.slice(0, askState.start) +
        data.text +
        value.slice(askState.end);
      onChange(next);
      setAskState(null);
      // Re-select the rewritten span so the user can immediately act on it.
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(
          askState.start,
          askState.start + data.text.length,
        );
      });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAskBusy(false);
    }
  }

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
    // controlled re-render), then re-anchor the floating toolbar since the text
    // (and so the selection geometry) shifted.
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start, start + replaced.length);
      refreshFloat();
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
        onSelect={refreshFloat}
        onBlur={() => setFloatPos(null)}
        rows={10}
        className="w-full resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-[13px] leading-relaxed text-zinc-900 outline-none focus-visible:border-zinc-300 focus-visible:ring-2 focus-visible:ring-zinc-200"
        placeholder="Write your post…"
      />

      {/* Highlight-to-format: a floating toolbar over the current selection,
          mirroring the always-visible toolbar's actions. Shown only while text
          is selected. */}
      {floatPos && !askState && (
        <FloatingToolbar
          top={floatPos.top}
          left={floatPos.left}
          onAsk={openAsk}
          onBold={() => onStyle("bold")}
          onItalic={() => onStyle("italic")}
          onBullet={() => applyToSelection(toggleBulletList)}
          onNumber={() => applyToSelection(toggleNumberedList)}
        />
      )}

      {/* "Ask for changes": describe an edit; AI rewrites just the selection. */}
      {askState && (
        <AskPrompt
          top={askState.top}
          left={askState.left}
          busy={askBusy}
          onSubmit={submitAsk}
          onClose={() => setAskState(null)}
        />
      )}

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

// Floating format toolbar anchored above the current text selection. Positioned
// with `fixed` (viewport coords from getSelectionAnchor) and nudged up so it
// sits just above the highlighted line. Every button uses onMouseDown +
// preventDefault so the textarea keeps focus and the selection survives the
// click (a plain onClick would blur first and collapse the selection).
function FloatingToolbar({
  top,
  left,
  onAsk,
  onBold,
  onItalic,
  onBullet,
  onNumber,
}: {
  top: number;
  left: number;
  onAsk: () => void;
  onBold: () => void;
  onItalic: () => void;
  onBullet: () => void;
  onNumber: () => void;
}) {
  const press = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault(); // keep textarea focus + selection
    fn();
  };
  return (
    <div
      role="toolbar"
      aria-label="Format selection"
      // -translate centers horizontally on the anchor and lifts the bar above
      // the selected line. The wrapper is fixed; left/top are viewport coords.
      className="fixed z-30 -translate-x-1/2 -translate-y-full"
      style={{ top: top - 8, left }}
    >
      <div className="flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white px-1 py-1 shadow-lg">
        {/* AI rewrite — leads the toolbar, like ChatGPT's "Ask for changes". */}
        <button
          type="button"
          title="Ask AI to change this (⌘K)"
          aria-label="Ask AI to change this"
          onMouseDown={press(onAsk)}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Ask AI
        </button>
        <div className="mx-0.5 h-4 w-px bg-zinc-200" />
        <FloatButton label="Bold" onMouseDown={press(onBold)}>
          <Bold className="h-3.5 w-3.5" />
        </FloatButton>
        <FloatButton label="Italic" onMouseDown={press(onItalic)}>
          <Italic className="h-3.5 w-3.5" />
        </FloatButton>
        <div className="mx-0.5 h-4 w-px bg-zinc-200" />
        <FloatButton label="Bulleted list" onMouseDown={press(onBullet)}>
          <List className="h-3.5 w-3.5" />
        </FloatButton>
        <FloatButton label="Numbered list" onMouseDown={press(onNumber)}>
          <ListOrdered className="h-3.5 w-3.5" />
        </FloatButton>
      </div>
    </div>
  );
}

function FloatButton({
  label,
  onMouseDown,
  children,
}: {
  label: string;
  onMouseDown: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={onMouseDown}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
    >
      {children}
    </button>
  );
}

// "Describe changes" prompt anchored over the selection. Submitting sends the
// instruction to /api/rewrite; the parent replaces the selected span with the
// result. Autofocuses, submits on Enter, closes on Escape.
function AskPrompt({
  top,
  left,
  busy,
  onSubmit,
  onClose,
}: {
  top: number;
  left: number;
  busy: boolean;
  onSubmit: (instruction: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    const t = text.trim();
    if (t && !busy) onSubmit(t);
  };

  return (
    <div
      className="fixed z-30 -translate-x-1/2 -translate-y-full"
      style={{ top: top - 8, left }}
      // Don't let a click inside the box blur/collapse anything unexpectedly.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-white px-2 py-1.5 shadow-lg w-72">
        {busy ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-zinc-400" />
        ) : (
          <Sparkles className="h-4 w-4 shrink-0 text-zinc-400" />
        )}
        <input
          ref={inputRef}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Describe changes"
          className="flex-1 bg-transparent text-[13px] text-zinc-900 outline-none placeholder:text-zinc-400 disabled:opacity-60"
        />
        <button
          type="button"
          aria-label="Submit changes"
          onClick={submit}
          disabled={busy || !text.trim()}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white transition-colors hover:bg-zinc-700 disabled:opacity-40"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
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
