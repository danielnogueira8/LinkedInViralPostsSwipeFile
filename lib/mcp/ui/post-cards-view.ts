// Renders get_post / get_top_from_batch results as Swipe File cards inside
// MCP Apps hosts — a server-rendered mirror of components/post-card.tsx
// (avatar w/ initials+tint fallback, name + niche · date, clamped body with
// Show more, media thumb with PDF/play badges, engagement pills, virality
// chip). Read-only: external links go through ui/open-link.

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

  function avatarHtml(account, name) {
    var ui = window.swipeinUi;
    var tint = ui.tintFor(name);
    var fallback = ui.avatarFallbackUrl(name);
    var url = account.profile_pic_url || fallback;
    return (
      '<span class="avatar" style="background:' + tint[0] + ";color:" + tint[1] + '">' +
      "<span>" + ui.esc(ui.initialsForName(name) || "?") + "</span>" +
      '<img src="' + ui.esc(url) + '" data-fallback="' + ui.esc(fallback) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="window.swipeinUi.avatarError(this)" />' +
      "</span>"
    );
  }

  function mediaHtml(p) {
    var ui = window.swipeinUi;
    var urls = Array.isArray(p.media_urls) ? p.media_urls : [];
    var url = urls[0];
    if (!url) return "";
    var type = p.media_type;
    if (type !== "image" && type !== "document" && type !== "video") return "";
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
        (p.post_url ? 'data-open-link="' + ui.esc(p.post_url) + '" ' : "") +
        'title="Watch on LinkedIn"><span class="play-disc">' + ui.icon("play", 20) +
        "</span></button></div>"
      );
    }
    return (
      '<div class="media">' + fallback + img +
      (type === "document"
        ? '<span class="badge-overlay">' + ui.icon("file", 12) + " PDF</span>"
        : "") +
      "</div>"
    );
  }

  function engagementHtml(p) {
    var ui = window.swipeinUi;
    var parts = "";
    if (typeof p.reactions === "number") {
      parts +=
        '<span class="pill"><span class="react-dot">' + ui.icon("thumb", 10) +
        '</span><span class="count">' + formatCount(p.reactions) + "</span></span>";
    }
    if (typeof p.comments === "number") {
      parts += '<span class="pill">' + ui.icon("comment", 12) + formatCount(p.comments) + "</span>";
    }
    if (typeof p.reposts === "number") {
      parts += '<span class="pill">' + ui.icon("repost", 12) + formatCount(p.reposts) + "</span>";
    }
    var extras = "";
    if (p.visual_kind) {
      extras += '<span class="chip">' + ui.esc(p.visual_kind) + "</span>";
    }
    if (typeof p.viral_score === "number") {
      var score = p.viral_score >= 100 ? String(Math.round(p.viral_score)) : p.viral_score.toFixed(1);
      extras +=
        '<span class="chip-viral" title="Composite viral score">' +
        ui.icon("trending", 12) + " Viral " + score + "</span>";
    }
    if (extras) parts += '<span class="spacer">' + extras + "</span>";
    return parts ? '<div class="engagement">' + parts + "</div>" : "";
  }

  function renderPostCard(p, index) {
    var ui = window.swipeinUi;
    var esc = ui.esc;
    var account = p.accounts || {};
    var name = account.name || "Unknown";
    var niche = account.niche || "Unknown niche";
    var ago = ui.timeAgo(p.posted_at);

    var head =
      '<div class="card-head"><div class="head-main">' +
      avatarHtml(account, name) +
      '<div class="head-text"><div class="name">' + esc(name) + "</div>" +
      '<div class="meta">' + esc(niche) + (ago ? " · " + esc(ago) : "") + "</div></div></div>" +
      (p.post_url
        ? '<button type="button" class="icon-btn" data-open-link="' + esc(p.post_url) +
          '" title="View on LinkedIn" aria-label="View on LinkedIn">' + ui.icon("external", 14) + "</button>"
        : "") +
      "</div>";

    var bodyInner = "";
    var text = typeof p.text === "string" ? p.text : "";
    if (text) {
      var isLong = text.length > 480 || text.split("\n").length > 12;
      var textId = "post-text-" + index;
      bodyInner +=
        "<div><div id=\"" + textId + '" class="post-text' + (isLong ? " clamped" : "") + '">' +
        esc(text) + "</div>" +
        (isLong
          ? '<button type="button" class="show-more" data-show-more="' + textId + '">Show more</button>'
          : "") +
        "</div>";
    }
    bodyInner += mediaHtml(p);
    bodyInner += engagementHtml(p);

    return '<div class="card">' + head + '<div class="card-body">' + bodyInner + "</div></div>";
  }

  window.renderSwipeIn = function (data) {
    var ui = window.swipeinUi;
    var root = document.getElementById("root");
    if (!data || data.ok === false) {
      root.innerHTML =
        '<div class="error">' + ui.esc((data && data.error) || "Something went wrong.") + "</div>";
      return;
    }
    var posts = Array.isArray(data.posts) ? data.posts : data.post ? [data.post] : [];
    if (!posts.length) {
      root.innerHTML = '<div class="empty">No posts to show.</div>';
      return;
    }
    var html = "";
    for (var i = 0; i < posts.length; i++) html += renderPostCard(posts[i] || {}, i);
    root.innerHTML = html;
  };
})();
`;

export const POST_CARDS_VIEW_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>SwipeIn Posts</title>
    <style>${VIEW_CSS}</style>
  </head>
  <body>
    <div id="root" class="list"></div>
    <script>${RENDER_JS}</script>
    <script>${BRIDGE_JS}</script>
  </body>
</html>
`;
