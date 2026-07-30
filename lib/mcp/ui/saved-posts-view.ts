// Renders list_saved_posts results as bookmark cards inside MCP Apps hosts —
// mirrors components/saved-post-card.tsx: post card + category chip + amber
// note bar, with the same degraded "couldn't load this post" state when the
// native scrape failed (only the oEmbed snippet is available).

import { BRIDGE_JS } from "./bridge";
import { VIEW_CSS } from "./styles";

const RENDER_JS = String.raw`
(function () {
  "use strict";

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var linkEl = target.closest("[data-open-link]");
    if (linkEl) {
      event.preventDefault();
      window.swipeinUi.openLink(linkEl.getAttribute("data-open-link"));
      return;
    }
    var toggle = target.closest("[data-show-more]");
    if (toggle) {
      var el = document.getElementById(toggle.getAttribute("data-show-more"));
      if (!el) return;
      var clamped = el.classList.toggle("clamped");
      toggle.textContent = clamped ? "Show more" : "Show less";
    }
  });

  function formatCount(n) {
    return Number(n).toLocaleString("en-US");
  }

  function categoryLabel(categoryId) {
    if (!categoryId) return null;
    return String(categoryId).replace(/[-_]+/g, " ");
  }

  function avatarHtml(row, name) {
    var ui = window.swipeinUi;
    var tint = ui.tintFor(name);
    var url = row.profile_pic_url;
    return (
      '<span class="avatar" style="background:' + tint[0] + ";color:" + tint[1] + '">' +
      "<span>" + ui.esc(ui.initialsForName(name) || "?") + "</span>" +
      (url
        ? '<img src="' + ui.esc(url) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />'
        : "") +
      "</span>"
    );
  }

  function mediaHtml(row) {
    var ui = window.swipeinUi;
    var urls = Array.isArray(row.media_urls) ? row.media_urls : [];
    var url = urls[0];
    if (!url) return "";
    var type = row.media_type;
    if (type !== "image" && type !== "video") return "";
    var fallback =
      '<div class="media-fallback" style="display:none"><div class="inner">' +
      ui.icon("imgoff", 22) + "<span>Image unavailable</span></div></div>";
    var img =
      '<img src="' + ui.esc(url) + '" alt="" loading="lazy" referrerpolicy="no-referrer" ' +
      "onerror=\"this.style.display='none';var f=this.parentNode.querySelector('.media-fallback');if(f)f.style.display='grid'\" />";
    if (type === "video") {
      return (
        '<div class="media">' + fallback + img +
        '<button type="button" class="play-overlay" ' +
        (row.post_url ? 'data-open-link="' + ui.esc(row.post_url) + '" ' : "") +
        'title="Watch on LinkedIn"><span class="play-disc">' + ui.icon("play", 20) +
        "</span></button></div>"
      );
    }
    return '<div class="media">' + fallback + img + "</div>";
  }

  function engagementHtml(row) {
    var ui = window.swipeinUi;
    var parts = "";
    if (typeof row.reactions === "number") {
      parts +=
        '<span class="pill"><span class="react-dot">' + ui.icon("thumb", 10) +
        '</span><span class="count">' + formatCount(row.reactions) + "</span></span>";
    }
    if (typeof row.comments === "number") {
      parts += '<span class="pill">' + ui.icon("comment", 12) + formatCount(row.comments) + "</span>";
    }
    return parts ? '<div class="engagement">' + parts + "</div>" : "";
  }

  function renderSavedCard(row, index) {
    var ui = window.swipeinUi;
    var esc = ui.esc;
    var name = row.author_name || "Unknown creator";
    var category = categoryLabel(row.category_id) || "LinkedIn Content";
    var ago = ui.timeAgo(row.posted_at);
    var body = typeof row.text === "string" && row.text ? row.text : row.text_snippet;
    var hasNative = typeof row.text === "string" && row.text.length > 0;

    var head =
      '<div class="card-head"><div class="head-main">' +
      (hasNative ? avatarHtml(row, name) : "") +
      '<div class="head-text"><div class="name">' + esc(name) + "</div>" +
      '<div class="meta">' + esc(category) + (ago ? " · " + esc(ago) : "") + "</div></div></div>" +
      (row.post_url
        ? '<button type="button" class="icon-btn" data-open-link="' + esc(row.post_url) +
          '" title="Open on LinkedIn" aria-label="Open on LinkedIn">' + ui.icon("external", 14) + "</button>"
        : "") +
      "</div>";

    var bodyInner = "";
    if (hasNative) {
      if (body) {
        var isLong = body.length > 480 || body.split("\n").length > 12;
        var textId = "saved-text-" + index;
        bodyInner +=
          "<div><div id=\"" + textId + '" class="post-text' + (isLong ? " clamped" : "") + '">' +
          esc(body) + "</div>" +
          (isLong
            ? '<button type="button" class="show-more" data-show-more="' + textId + '">Show more</button>'
            : "") +
          "</div>";
      }
      bodyInner += mediaHtml(row);
      bodyInner += engagementHtml(row);
    } else {
      bodyInner +=
        '<div class="degraded">' +
        (body
          ? '<div class="snippet">' + esc(body) + "</div>"
          : '<div class="hint">We couldn\'t load this post\'s content. Open it on LinkedIn to read it.</div>') +
        (row.post_url
          ? '<button type="button" class="open-link" data-open-link="' + esc(row.post_url) +
            '">Open on LinkedIn ' + ui.icon("external", 12) + "</button>"
          : "") +
        "</div>";
    }

    var note = typeof row.note === "string" && row.note.trim() ? row.note : null;
    var noteBar = note
      ? '<div class="note-bar">' + ui.icon("note", 14) + "<span>" + esc(note) + "</span></div>"
      : "";

    return (
      '<div class="card">' + head +
      '<div class="card-body">' + bodyInner + "</div>" +
      noteBar +
      "</div>"
    );
  }

  window.renderSwipeIn = function (data) {
    var ui = window.swipeinUi;
    var root = document.getElementById("root");
    if (!data || data.ok === false) {
      root.innerHTML =
        '<div class="error">' + ui.esc((data && data.error) || "Something went wrong.") + "</div>";
      return;
    }
    var saved = Array.isArray(data.saved) ? data.saved : [];
    if (!saved.length) {
      root.innerHTML = '<div class="empty">No saved posts yet.</div>';
      return;
    }
    var html = "";
    for (var i = 0; i < saved.length; i++) html += renderSavedCard(saved[i] || {}, i);
    root.innerHTML = html;
  };
})();
`;

export const SAVED_POSTS_VIEW_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>SwipeIn Saved Posts</title>
    <style>${VIEW_CSS}</style>
  </head>
  <body>
    <div id="root" class="list"></div>
    <script>${RENDER_JS}</script>
    <script>${BRIDGE_JS}</script>
  </body>
</html>
`;
