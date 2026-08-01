// Shared CSS for every ui://swipein/* MCP Apps view, mirroring the app's own
// card surfaces (components/post-card.tsx, saved-post-card.tsx, DraftCard).
// Colors are the app tokens flattened to hex (see app/globals.css) through
// light-dark(), so a host that reports theme:"dark" (the bridge flips
// color-scheme via the .dark class) gets the dark card treatment for free.
//
// Ships verbatim inside an HTML <style> tag — no ${ or backticks.

export const VIEW_CSS = String.raw`
:root { color-scheme: light; }
:root.dark { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  padding: 8px;
  background: transparent;
  color: light-dark(#232019, #f2f0ec);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter,
    "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.list { display: flex; flex-direction: column; gap: 12px; max-width: 640px; margin: 0 auto; }
.empty, .error {
  padding: 28px 16px;
  text-align: center;
  font-size: 13px;
  color: light-dark(#6f6a60, #a9a49b);
}

/* --- card frame (mirrors Card/CardHeader/CardContent) --- */
.card {
  border: 1px solid light-dark(#e9e6e1, #3b3733);
  border-radius: 12px;
  background: light-dark(#ffffff, #221f1c);
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(20, 18, 14, 0.05);
}
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  background: light-dark(#f6f4f1, #2a2724);
  border-bottom: 1px solid light-dark(#edeae6, #383430);
}
.head-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
.avatar {
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 9999px;
  display: grid;
  place-items: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
  overflow: hidden;
}
.avatar img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.head-text { min-width: 0; }
.name {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta {
  font-size: 12px;
  color: light-dark(#6f6a60, #a9a49b);
  line-height: 1.3;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.icon-btn {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: light-dark(#6f6a60, #a9a49b);
  cursor: pointer;
  flex-shrink: 0;
}
.icon-btn:hover { background: light-dark(#edeae6, #3b3733); color: light-dark(#232019, #f2f0ec); }
.card-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 12px; }

/* --- post body with clamp + show more --- */
.post-text { font-size: 14px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: break-word; }
.post-text.clamped {
  display: -webkit-box;
  -webkit-line-clamp: 12;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.show-more {
  align-self: flex-start;
  margin-top: 4px;
  padding: 0;
  border: none;
  background: none;
  font-size: 12px;
  font-weight: 500;
  color: light-dark(#6f6a60, #a9a49b);
  cursor: pointer;
}
.show-more:hover { color: light-dark(#232019, #f2f0ec); text-decoration: underline; }

/* --- media --- */
.media {
  position: relative;
  border: 1px solid light-dark(#e9e6e1, #3b3733);
  border-radius: 12px;
  overflow: hidden;
  aspect-ratio: 16 / 10;
  background: light-dark(#f6f4f1, #2a2724);
}
.media img { width: 100%; height: 100%; object-fit: cover; display: block; }
.media-fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: light-dark(#6f6a60, #a9a49b);
  font-size: 11px;
}
.media-fallback .inner { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.badge-overlay {
  position: absolute;
  top: 8px;
  left: 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 9999px;
  background: rgba(0, 0, 0, 0.7);
  color: #ffffff;
  font-size: 10px;
  font-weight: 500;
  padding: 2px 8px;
}
.play-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.2);
  cursor: pointer;
  border: none;
  padding: 0;
}
.play-overlay .play-disc {
  width: 48px;
  height: 48px;
  border-radius: 9999px;
  background: rgba(0, 0, 0, 0.6);
  color: #ffffff;
  display: grid;
  place-items: center;
}

/* --- engagement row --- */
.engagement { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; padding-top: 4px; }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid light-dark(#e9e6e1, #3b3733);
  background: light-dark(rgba(255, 255, 255, 0.7), rgba(0, 0, 0, 0.2));
  border-radius: 9999px;
  padding: 3px 9px;
  color: light-dark(#6f6a60, #a9a49b);
  font-variant-numeric: tabular-nums;
}
.pill .count { font-weight: 500; color: light-dark(#232019, #f2f0ec); }
.react-dot {
  width: 16px;
  height: 16px;
  border-radius: 9999px;
  display: grid;
  place-items: center;
  background: light-dark(rgba(35, 32, 25, 0.08), rgba(242, 240, 236, 0.12));
  color: light-dark(#232019, #f2f0ec);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 500;
  border-radius: 9999px;
  padding: 2px 8px;
  border: 1px solid light-dark(#e9e6e1, #3b3733);
  color: light-dark(#6f6a60, #a9a49b);
  text-transform: capitalize;
}
.chip-viral {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 500;
  border-radius: 9999px;
  padding: 2px 8px;
  border: 1px solid light-dark(#c2e6d0, #1f5c3e);
  background: light-dark(#ecf7f0, #123a28);
  color: light-dark(#157347, #7fd6a4);
}
.engagement .spacer { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; }

/* --- saved-post extras --- */
.note-bar {
  border-top: 1px solid light-dark(#ecdfc0, #57481f);
  background: light-dark(#faf3e2, #302810);
  color: light-dark(#8a5a00, #e9c46c);
  font-size: 12px;
  line-height: 1.5;
  padding: 10px 16px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  white-space: pre-wrap;
}
.note-bar svg { flex-shrink: 0; margin-top: 2px; }
.degraded { padding: 32px 24px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.degraded .snippet { font-size: 14px; color: light-dark(#57534e, #b8b3ab); white-space: pre-wrap; }
.degraded .hint { font-size: 13px; color: light-dark(#6f6a60, #a9a49b); }
.open-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: none;
  padding: 0;
  font-size: 12px;
  font-weight: 500;
  color: light-dark(#232019, #f2f0ec);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* --- drafts --- */
.draft-title { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.35; }
.draft-preview {
  font-size: 13px;
  color: light-dark(#57534e, #b8b3ab);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: break-word;
}
.draft-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 11px; }
.status-label { display: inline-flex; align-items: center; gap: 6px; color: light-dark(#6f6a60, #a9a49b); font-size: 12px; text-transform: capitalize; }
.dot { width: 8px; height: 8px; border-radius: 9999px; flex-shrink: 0; }
.dot-idea { background: #b07818; }
.dot-drafting { background: #8b5cf6; }
.dot-ready { background: #1d9e6a; }
.dot-scheduled { background: #4a7fd4; }
.dot-posted { background: #8a8680; }
.badge-kind {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 500;
  border-radius: 9999px;
  padding: 1px 8px;
  border: 1px solid transparent;
}
.badge-hook {
  border-color: light-dark(#ecdfc0, #57481f);
  background: light-dark(#faf3e2, #302810);
  color: light-dark(#8a5a00, #e9c46c);
}
.badge-lead {
  border-color: light-dark(rgba(35, 32, 25, 0.15), rgba(242, 240, 236, 0.2));
  background: light-dark(rgba(35, 32, 25, 0.06), rgba(242, 240, 236, 0.08));
  color: light-dark(#232019, #f2f0ec);
}
.date-chip {
  display: inline-flex;
  align-items: center;
  border: 1px solid light-dark(#e9e6e1, #3b3733);
  border-radius: 9999px;
  padding: 1px 8px;
  color: light-dark(#6f6a60, #a9a49b);
  font-size: 10px;
}
`;
