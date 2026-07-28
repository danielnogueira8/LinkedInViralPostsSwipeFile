"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bold,
  Italic,
  Strikethrough,
  List,
  ListOrdered,
  Smile,
  Loader2,
  ArrowUp,
  Undo2,
  Redo2,
  RemoveFormatting,
  ImageIcon,
} from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { clipboardHasText, clipboardImageFiles } from "@/lib/clipboard-images";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  toggleStyle,
  toggleBulletList,
  toggleNumberedList,
  toggleStrikethrough,
  clearFormatting,
  SPECIAL_CHARS,
  applyRewriteBoundary,
  EMOJI_GROUPS,
  LINKEDIN_MAX_CHARS,
  LINKEDIN_SEE_MORE_CHARS,
  type FormatStyle,
} from "@/lib/linkedin-format";
import { getSelectionAnchor } from "@/lib/textarea-caret";
import { IMAGE_ACCEPT_ATTR } from "@/lib/post-media";
import {
  emptyHistory,
  pushHistory,
  undo as undoHistory,
  redo as redoHistory,
  snapshot as snapshotHistory,
} from "@/lib/edit-history";

// In-card editor for a draft post. Operates on a plain-text value and emits
// changes upward — the formatting is Unicode-based (see lib/linkedin-format)
// so what's typed here pastes into LinkedIn with bold/italic/lists intact.
export function DraftEditor({
  value,
  onChange,
  rows = 10,
  className,
  textareaClassName,
  onMediaFiles,
  allowImagePaste = false,
  toolbar = "floating",
  onBlur,
  showCounter = true,
  footer,
}: {
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  className?: string;
  textareaClassName?: string;
  onMediaFiles?: (files: File[]) => void;
  // Image paste belongs to the New Post flow. Drag/drop and the Attach control
  // remain available wherever this editor is used.
  allowImagePaste?: boolean;
  // "floating" (default) keeps the original minimal bar — a selection pops the
  // format toolbar. "full" adds a persistent toolbar for the Cowork draft
  // workspace, where the editor is the primary surface rather than a card
  // detail and the controls should be visible without hunting for them.
  // Defaulted so every existing caller is untouched.
  toolbar?: "floating" | "full";
  // Fired when the textarea loses focus. The Cowork draft uses this to
  // persist the body, now that there is no "Done" button to save on.
  onBlur?: () => void;
  // Hide the editor's own counter when the surrounding surface already shows
  // one — otherwise the same "1,661 / 3,000" renders twice, one line apart.
  showCounter?: boolean;
  // Rendered INSIDE the editor's bordered box, below the textarea, and
  // scrolling with it. A textarea cannot contain elements, so attached media
  // can't literally live in the text — but putting it in the same scroll
  // container is what makes the draft read as one card: the text keeps its
  // full height and you scroll down to the image, instead of the image
  // stealing height from the text box as a sibling.
  footer?: React.ReactNode;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Hidden picker behind the toolbar's image button (LinkedIn-style). Uses
  // the same onMediaFiles channel as drag/drop and paste, so every route to
  // attaching an image lands on one upload path.
  const fileRef = useRef<HTMLInputElement>(null);
  // Emoji picker (the always-visible bar above the textarea). Emoji needs a
  // cursor, not a selection, so it lives on its own bar rather than the
  // selection-only floating toolbar.
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [draggingMedia, setDraggingMedia] = useState(false);
  // Undo/redo stack. A ref (not state) because it must be read and written
  // synchronously inside the same event as the edit it records — going through
  // a state update would race the next keystroke.
  const historyRef = useRef(emptyHistory());
  // Availability lives in STATE, not derived from the ref at render time:
  // reading a ref during render is neither safe nor allowed, and the toolbar
  // needs to re-render when the stack changes.
  const [{ canUndo, canRedo }, setHistoryAvail] = useState({
    canUndo: false,
    canRedo: false,
  });
  const syncHistoryAvail = useCallback(() => {
    setHistoryAvail({
      canUndo: historyRef.current.past.length > 0,
      canRedo: historyRef.current.future.length > 0,
    });
  }, []);
  // Floating toolbar position (viewport coords), shown only while a non-empty
  // selection exists inside the textarea — the ChatGPT/Notion "highlight to
  // format" affordance.
  const [floatPos, setFloatPos] = useState<{ top: number; left: number } | null>(
    null,
  );


  // Auto-size the textarea to its content when it lives inside a scrolling card
  // (footer mode). The card owns the scroll, so a fixed-height textarea with
  // overflow-hidden would CLIP long drafts invisibly — the user would type past
  // the bottom and simply not see it. Writing the height directly to the DOM
  // (rather than into state) keeps this out of the render cycle entirely.
  useEffect(() => {
    if (!footer) return;
    const ta = taRef.current;
    if (!ta) return;
    const fit = () => {
      ta.style.height = "auto";
      // scrollHeight rounds to whole pixels, which can land a fraction of a
      // line short — the last line of the draft renders visibly clipped at
      // the bottom of the Cowork card. The small buffer guarantees the final
      // line always gets its full height.
      ta.style.height = `${ta.scrollHeight + 4}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(ta);
    return () => ro.disconnect();
  }, [value, footer]);

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
  // Where to anchor the "Rewriting…" indicator. The prompt box (askState) closes
  // the instant a rewrite starts so the edit can stream into the textarea, but
  // the request has real latency before the first token — without this the user
  // sees nothing at all during that window. We keep the last anchor here so a
  // small working indicator can sit over the selection for the whole in-flight
  // period (including the pre-first-token wait).
  const [askBusyPos, setAskBusyPos] = useState<{ top: number; left: number } | null>(null);

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
    // Snapshot the document + range at submit time. The rewrite streams in as
    // SSE text deltas; we splice the accumulated rewrite into the ORIGINAL text
    // at the ORIGINAL range on every tick (not against the live value, which is
    // itself changing as we type the rewrite in), so the replacement grows in
    // place and the rest of the draft stays untouched.
    const before = value.slice(0, askState.start);
    const after = value.slice(askState.end);
    const start = askState.start;
    // Snapshot the original selection so we can preserve the line breaks it
    // carried at its edges when we settle the rewrite (see applyRewriteBoundary).
    const originalSelection = askState.selected;
    // The prompt box closes immediately; the edit happens live in the textarea.
    // Keep its anchor so the "Rewriting…" indicator can sit there until the
    // request resolves (covers the latency before the first streamed token).
    setAskBusyPos({ top: askState.top, left: askState.left });
    setAskState(null);
    // One undo point for the whole rewrite. The stream below calls onChange
    // directly (dozens of times) rather than commit(), so the undo stack holds
    // the pre-rewrite draft instead of every intermediate token.
    historyRef.current = snapshotHistory(historyRef.current, value);
    syncHistoryAvail();
    let rewritten = "";
    let errored: string | null = null;
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
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Rewrite failed (${res.status})`);
      }
      await consumeSSE(res.body, (event, data) => {
        if (event === "text") {
          rewritten += (data.delta as string) ?? "";
          // Grow the replacement span in place. Keep the selection over the
          // rewritten text so the user sees exactly what changed as it streams.
          onChange(before + rewritten + after);
          requestAnimationFrame(() => {
            const ta = taRef.current;
            if (!ta) return;
            ta.setSelectionRange(start, start + rewritten.length);
          });
        } else if (event === "replace") {
          // The server's deterministic em-dash net cleaned the full rewrite
          // (streamed raw for responsiveness, then swapped clean at the end).
          // Replace the accumulated text with the cleaned version so an em dash
          // can't survive into the draft. Only sent when stripping changed
          // something, so a clean rewrite never triggers this swap.
          const clean = (data.text as string) ?? rewritten;
          rewritten = clean;
          onChange(before + clean + after);
          requestAnimationFrame(() => {
            const ta = taRef.current;
            if (!ta) return;
            ta.setSelectionRange(start, start + clean.length);
          });
        } else if (event === "error") {
          errored = (data.message as string) || "Rewrite failed";
        }
      });
      if (errored) throw new Error(errored);
      // Settle the rewrite, preserving the line breaks the original selection
      // carried at its edges (a "\n\n" paragraph break in the selection used to
      // get trimmed away, merging two paragraphs). Only re-render if it changed.
      const finalText = applyRewriteBoundary(rewritten, originalSelection);
      if (finalText !== rewritten) onChange(before + finalText + after);
      // Final focus + re-select so the user can immediately act on the result.
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(start, start + finalText.length);
      });
    } catch (e) {
      // Roll back to the original selection so a mid-stream failure never
      // leaves the draft with a half-written rewrite.
      onChange(before + askState.selected + after);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(start, start + askState.selected.length);
      });
      toast.error((e as Error).message);
    } finally {
      setAskBusy(false);
      setAskBusyPos(null);
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
    commit(next);

    // Restore selection over the transformed text on the next tick (after the
    // controlled re-render), then re-anchor the floating toolbar since the text
    // (and so the selection geometry) shifted.
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(start, start + replaced.length);
      refreshFloat();
    });
  }

  // Insert text right AFTER the current selection, leaving the selected text
  // Insert text at the caret (replacing any selection). Used by the always-
  // visible emoji bar — emoji drops where the cursor is, the natural behavior.
  function insertAtCursor(text: string) {
    const ta = taRef.current;
    if (!ta) {
      commit(value + text);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = value.slice(0, start) + text + value.slice(end);
    commit(next);
    requestAnimationFrame(() => {
      ta.focus();
      const caret = start + text.length;
      ta.setSelectionRange(caret, caret);
    });
  }

  const onStyle = (style: FormatStyle) =>
    applyToSelection((s) => toggleStyle(s, style));

  // Every edit routes through here so it lands on the undo stack — including
  // formatting and AI rewrites, which is precisely what the browser's native
  // undo loses once a controlled value is set programmatically.
  function commit(next: string) {
    historyRef.current = pushHistory(historyRef.current, value, next);
    syncHistoryAvail();
    onChange(next);
  }

  // Restore a history state and put the caret at the end of it — the textarea's
  // own selection is meaningless against text it never held.
  function restore(next: string) {
    onChange(next);
    syncHistoryAvail();
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(next.length, next.length);
      setFloatPos(null);
    });
  }

  function doUndo() {
    const step = undoHistory(historyRef.current, value);
    if (!step) return;
    historyRef.current = step.history;
    restore(step.value);
  }

  function doRedo() {
    const step = redoHistory(historyRef.current, value);
    if (!step) return;
    historyRef.current = step.history;
    restore(step.value);
  }


  const count = value.length;
  const over = count > LINKEDIN_MAX_CHARS;

  // Editor shortcuts. Undo/redo must be intercepted: the browser's native stack
  // is meaningless here (every toolbar action replaces the controlled value
  // programmatically), so ⌘Z would otherwise restore stale text or nothing.
  // Bound to the textarea, so they never hijack the key outside the editor.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (!(ev.metaKey || ev.ctrlKey)) return;
      const key = ev.key.toLowerCase();
      if (key === "z") {
        ev.preventDefault();
        if (ev.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if (key === "y") {
        // Windows/Linux redo.
        ev.preventDefault();
        doRedo();
        return;
      }
      if (key === "b") {
        ev.preventDefault();
        applyToSelection((s) => toggleStyle(s, "bold"), { wholeLineWhenEmpty: true });
        return;
      }
      if (key === "i") {
        ev.preventDefault();
        applyToSelection((s) => toggleStyle(s, "italic"), { wholeLineWhenEmpty: true });
      }
    };
    ta.addEventListener("keydown", onKey);
    return () => ta.removeEventListener("keydown", onKey);
    // Re-bound on value change so the handlers close over current text.
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    // Bold/lists/Ask-AI live in the floating toolbar that pops over a
    // selection. Emoji needs a cursor (not a selection), so it sits on a small
    // always-visible bar above the textarea.
    <div
      className={cn(
        "flex flex-col gap-2",
        // In the full-toolbar (Cowork) layout the editor owns the column, so
        // on desktop (lg+) it flexes to fill it and scrolls internally. Below lg
        // the whole draft card scrolls in the mobile bottom sheet, so the editor
        // stays content-sized — otherwise a fixed-height editor + appended blocks
        // (e.g. the lead-magnet resource card) would fight for a short column and
        // spill over the pinned toolbar. Elsewhere it stays content-sized as before.
        toolbar === "full" && "lg:min-h-0 lg:flex-1",
        className,
      )}
    >
      {/* Persistent toolbar (Cowork draft workspace). Every transform acts on
          the selection, or on the CURRENT LINE when nothing is selected — so no
          button is ever a no-op, and undo makes that safe to explore. */}
      {toolbar === "full" && (
        <div className="relative flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-card px-1 py-1">
          <ToolbarButton
            label="Undo"
            shortcut="⌘Z"
            disabled={!canUndo}
            onClick={doUndo}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            label="Redo"
            shortcut="⇧⌘Z"
            disabled={!canRedo}
            onClick={doRedo}
          >
            <Redo2 className="h-3.5 w-3.5" />
          </ToolbarButton>

          <ToolbarDivider />

          <ToolbarButton
            label="Bold"
            shortcut="⌘B"
            onClick={() => applyToSelection((s) => toggleStyle(s, "bold"), { wholeLineWhenEmpty: true })}
          >
            <Bold className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            label="Italic"
            shortcut="⌘I"
            onClick={() =>
              applyToSelection((s) => toggleStyle(s, "italic"), { wholeLineWhenEmpty: true })
            }
          >
            <Italic className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            label="Strikethrough"
            onClick={() => applyToSelection(toggleStrikethrough, { wholeLineWhenEmpty: true })}
          >
            <Strikethrough className="h-3.5 w-3.5" />
          </ToolbarButton>

          <ToolbarDivider />

          <ToolbarButton
            label="Bulleted list"
            onClick={() => applyToSelection(toggleBulletList, { wholeLineWhenEmpty: true })}
          >
            <List className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            label="Numbered list"
            onClick={() => applyToSelection(toggleNumberedList, { wholeLineWhenEmpty: true })}
          >
            <ListOrdered className="h-3.5 w-3.5" />
          </ToolbarButton>

          <ToolbarDivider />

          {/* The glyphs people actually paste into LinkedIn posts. */}
          {SPECIAL_CHARS.map(({ char, label }) => (
            <ToolbarButton
              key={char}
              label={label}
              onClick={() => insertAtCursor(char)}
            >
              <span aria-hidden className="text-[13px] leading-none">
                {char}
              </span>
            </ToolbarButton>
          ))}

          <ToolbarDivider />

          {onMediaFiles && (
            <ToolbarButton
              label="Add image"
              onClick={() => fileRef.current?.click()}
            >
              <ImageIcon className="h-3.5 w-3.5" />
            </ToolbarButton>
          )}
          <ToolbarButton
            label="Emoji"
            onClick={() => setEmojiOpen((o) => !o)}
            active={emojiOpen}
          >
            <Smile className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            label="Clear formatting"
            onClick={() => applyToSelection(clearFormatting, { wholeLineWhenEmpty: true })}
          >
            <RemoveFormatting className="h-3.5 w-3.5" />
          </ToolbarButton>

          <input
            ref={fileRef}
            type="file"
            accept={IMAGE_ACCEPT_ATTR}
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) onMediaFiles?.(files);
              // Reset so picking the SAME file again still fires onChange.
              e.target.value = "";
            }}
          />

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
      )}
      {toolbar === "floating" && (
      <div className="relative flex items-center">
        <button
          type="button"
          title="Emoji"
          aria-label="Emoji"
          // onMouseDown + preventDefault so clicking the button doesn't blur the
          // textarea / move the caret before the emoji is inserted.
          onMouseDown={(e) => {
            e.preventDefault();
            setEmojiOpen((o) => !o);
          }}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            emojiOpen && "bg-muted text-foreground",
          )}
        >
          <Smile className="h-3.5 w-3.5" />
        </button>
        {emojiOpen && (
          <EmojiPicker
            onPick={(e) => {
              insertAtCursor(e);
              setEmojiOpen(false);
            }}
            onClose={() => setEmojiOpen(false)}
          />
        )}
        {/* Discovery hint: the AI-edit toolbar only appears on a text selection,
            so it's easy to miss. Surface it here, to the right of the emoji
            button. Hidden on very narrow widths to avoid crowding the bar. */}
        <span className="ml-2 hidden items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex">
          <AiIcon className="h-3 w-3" aria-hidden />
          Select any text to edit it with AI
        </span>
      </div>
      )}

      {/* One bordered, scrolling card holding the textarea AND any footer
          (attached media). The textarea itself is borderless and auto-sized;
          this box is what scrolls, so text + image read as a single surface. */}
      <div
        className={cn(
          "relative flex min-h-0 w-full min-w-0 flex-1 flex-col bg-white",
          // The border/radius only earns its place when this box floats inside
          // something else. In the Cowork layout (toolbar="full") the panel is
          // already the surface, so a bordered box here is a third nested
          // outline around the same draft. Everywhere else (the Posts-board
          // editor) it still needs its own edge.
          toolbar === "full"
            ? "max-lg:rounded-lg max-lg:border max-lg:border-border"
            : "rounded-lg border border-border",
          // Desktop: the editor box owns the scroll. Below lg the whole draft
          // card scrolls in the mobile bottom sheet, so this box must not be a
          // second (touch-capturing) scroll container — keep overflow visible.
          footer ? "lg:overflow-y-auto" : "",
        )}
      >
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => commit(e.target.value)}
        onSelect={refreshFloat}
        onBlur={() => {
          setFloatPos(null);
          onBlur?.();
        }}
        onPaste={(event) => {
          // Keep this on the editor rather than the document: image pastes are
          // only meaningful while this post editor is mounted, and a nested
          // image-aware control can opt out with preventDefault().
          if (event.defaultPrevented || !allowImagePaste || !onMediaFiles) return;
          const files = clipboardImageFiles(event.clipboardData);
          if (files.length === 0) return;
          // Image-only paste has no useful textarea default. If text arrived
          // alongside the image, preserve the user's normal text paste while
          // the same upload flow starts in the background.
          if (!clipboardHasText(event.clipboardData)) event.preventDefault();
          onMediaFiles(files);
        }}
        onDragEnter={(event) => {
          if (!Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          setDraggingMedia(true);
        }}
        onDragOver={(event) => {
          if (!Array.from(event.dataTransfer.types).includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDraggingMedia(false);
        }}
        onDrop={(event) => {
          setDraggingMedia(false);
          const files = Array.from(event.dataTransfer.files);
          if (files.length === 0) return;
          event.preventDefault();
          onMediaFiles?.(files);
        }}
        rows={rows}
        aria-label="Post body"
        className={cn(
          "w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-foreground outline-none",
          // With a footer the card owns the border and the scroll, so the
          // textarea is a plain transparent surface that grows to its content.
          footer
            ? "flex-none overflow-hidden"
            : "rounded-lg border border-border bg-white focus-visible:border-border focus-visible:ring-2 focus-visible:ring-border",
          draggingMedia && "bg-primary/[0.04]",
          textareaClassName,
        )}
        placeholder="Write your post…"
      />
        {footer ? <div className="px-3 pb-3">{footer}</div> : null}
      </div>
      {draggingMedia && (
        <p className="-mt-1 text-xs font-medium text-primary">Drop image to attach it</p>
      )}

      {/* Highlight-to-format: a floating toolbar over the current selection.
          Shown only while text is selected. Emoji is NOT here — it's on the bar
          above (it needs a cursor, not a selection). */}
      {floatPos && !askState && (
        <FloatingToolbar
          top={floatPos.top}
          left={floatPos.left}
          onAsk={openAsk}
          onBold={() => onStyle("bold")}
          onBullet={() => applyToSelection(toggleBulletList)}
          onNumber={() => applyToSelection(toggleNumberedList)}
          showFormatting={toolbar !== "full"}
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

      {/* Working indicator: once the prompt closes and the rewrite is in flight,
          show a spinner over the selection so it's clear the AI is running —
          even during the latency before the first streamed token arrives. */}
      {askBusy && askBusyPos && !askState && (
        <div
          className="fixed z-30 -translate-x-1/2 -translate-y-full"
          style={{ top: askBusyPos.top - 8, left: askBusyPos.left }}
          aria-live="polite"
        >
          <div className="flex items-center gap-1.5 rounded-lg border border-border bg-white px-2.5 py-1.5 text-xs font-medium text-muted-foreground shadow-lg">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Rewriting…
          </div>
        </div>
      )}

      {/* Character counter — LinkedIn truncates the preview at ~210 and caps at
          3,000. Show both so the user knows where the hook gets cut. Suppressed
          when the host renders its own counter (see showCounter). */}
      <div className={cn(
        "flex items-center justify-between text-[11px] text-muted-foreground",
        !showCounter && "hidden",
      )}>
        <span>
          {count <= LINKEDIN_SEE_MORE_CHARS ? (
            <span className="text-muted-foreground">
              {LINKEDIN_SEE_MORE_CHARS - count} chars before “…see more”
            </span>
          ) : null}
        </span>
        <span className={cn("tabular-nums", over && "text-state-danger font-medium")}>
          {count.toLocaleString()} / {LINKEDIN_MAX_CHARS.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

// Floating format toolbar anchored above the current text selection. Positioned
// with `fixed` (viewport coords from getSelectionAnchor) and nudged up so it
// sits just above the highlighted line. Every button uses onMouseDown +
// preventDefault so the textarea keeps focus and the selection survives the
// click (a plain onClick would blur first and collapse the selection).
// A compact icon button for the persistent toolbar. onMouseDown+preventDefault
// keeps the textarea focused and the caret/selection intact — without it,
// clicking a format button would blur the textarea and collapse the very
// selection the button is meant to transform.
function ToolbarButton({
  label,
  shortcut,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => {
        e.preventDefault();
        if (!disabled) onClick();
      }}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
        "hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />;
}

function FloatingToolbar({
  top,
  left,
  onAsk,
  onBold,
  onBullet,
  onNumber,
  showFormatting = true,
}: {
  top: number;
  left: number;
  onAsk: () => void;
  onBold: () => void;
  onBullet: () => void;
  onNumber: () => void;
  // When a persistent toolbar is already on screen (toolbar="full"), the
  // selection popover would be duplicating controls the user can already see.
  // Ask AI is the exception: it is the only action that NEEDS a selection, so
  // it has nowhere else to live.
  showFormatting?: boolean;
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
      <div className="relative flex items-center gap-0.5 rounded-lg border border-border bg-white px-1 py-1 shadow-lg">
        {/* AI rewrite — leads the toolbar, like ChatGPT's "Ask for changes". */}
        <button
          type="button"
          title="Ask AI to change this (⌘K)"
          aria-label="Ask AI to change this"
          onMouseDown={press(onAsk)}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          <AiIcon className="h-3.5 w-3.5" />
          Ask AI
        </button>
        {showFormatting && (
          <>
            <div className="mx-0.5 h-4 w-px bg-muted" />
            <FloatButton label="Bold" onMouseDown={press(onBold)}>
              <Bold className="h-3.5 w-3.5" />
            </FloatButton>
            <div className="mx-0.5 h-4 w-px bg-muted" />
            <FloatButton label="Bulleted list" onMouseDown={press(onBullet)}>
              <List className="h-3.5 w-3.5" />
            </FloatButton>
            <FloatButton label="Numbered list" onMouseDown={press(onNumber)}>
              <ListOrdered className="h-3.5 w-3.5" />
            </FloatButton>
          </>
        )}
      </div>
    </div>
  );
}

function FloatButton({
  label,
  onMouseDown,
  active,
  children,
}: {
  label: string;
  onMouseDown: (e: React.MouseEvent) => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={onMouseDown}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground",
      )}
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
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // CAPTURE phase + stopPropagation: the dialog's own Escape dismiss
      // (Base UI useDismiss) listens on document in the BUBBLE phase and
      // ignores defaultPrevented, so a plain bubble listener here would close
      // the prompt AND the whole editor dialog on one keypress.
      e.stopPropagation();
      onClose();
    };
    // Dismiss on a click anywhere outside the prompt. Escape alone left the box
    // stranded over the draft when the user simply clicked away — the usual way
    // people abandon a popover.
    //
    // Bound on MOUSEDOWN, not click: the box already stops propagation of
    // mousedown (so clicking inside can't blur the textarea), which means a
    // mousedown listener is dismissed correctly by that same guard. A click
    // listener would also fire after a text selection drag that ENDS outside
    // the box, closing the prompt mid-gesture.
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const submit = () => {
    const t = text.trim();
    if (t && !busy) onSubmit(t);
  };

  return (
    <div
      ref={boxRef}
      className="fixed z-30 -translate-x-1/2 -translate-y-full"
      style={{ top: top - 8, left }}
      // Don't let a click inside the box blur/collapse anything unexpectedly.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 rounded-xl border border-border bg-white px-2 py-1.5 shadow-lg w-72">
        {busy ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <AiIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
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
          className="flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />
        <button
          type="button"
          aria-label="Submit changes"
          onClick={submit}
          disabled={busy || !text.trim()}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground text-white transition-colors hover:bg-foreground/85 disabled:opacity-40"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

// Minimal SSE reader: parse `event:`/`data:` frames and invoke cb per frame.
// Local to the editor (the rewrite stream is its only consumer here) so it
// doesn't depend on the chat workspace's copy.
async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  cb: (event: string, data: Record<string, unknown>) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      let dataStr = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;
      try {
        cb(event, JSON.parse(dataStr));
      } catch {
        // ignore malformed frame
      }
    }
  }
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
      if (e.key !== "Escape") return;
      // CAPTURE phase + stopPropagation: the dialog's own Escape dismiss
      // (Base UI useDismiss) listens on document in the BUBBLE phase and
      // ignores defaultPrevented, so a plain bubble listener here would close
      // the picker AND the whole editor dialog on one keypress. Focus stays on
      // the textarea while the picker is open, so an element-level handler
      // can't intercept it — the picker isn't an ancestor of the textarea.
      e.stopPropagation();
      onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute left-0 top-9 z-20 w-64 rounded-xl border border-border bg-white p-2 shadow-lg"
    >
      {EMOJI_GROUPS.map((group) => (
        <div key={group.label} className="mb-1.5 last:mb-0">
          <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {group.label}
          </div>
          <div className="grid grid-cols-6 gap-0.5">
            {group.emojis.map((e) => (
              <button
                key={e}
                type="button"
                // onMouseDown + preventDefault keeps the textarea focused and
                // its selection intact, so insertAfterSelection lands the emoji
                // at the right offset (a plain onClick would blur+collapse it
                // first). The floating toolbar only exists with a selection, so
                // preserving it matters here in a way it didn't on the old bar.
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  onPick(e);
                }}
                className="flex h-8 w-8 items-center justify-center rounded-md text-lg transition-colors hover:bg-muted"
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
