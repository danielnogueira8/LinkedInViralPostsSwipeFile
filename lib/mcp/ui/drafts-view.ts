// Renders list_drafts results as Posts-board cards inside MCP Apps hosts —
// mirrors DraftCard in app/(app)/dashboard/posts/drafts-list.tsx: title (with
// first-line fallback), 2-line body preview, status dot + label, Hook/Lead
// Magnet kind badges, and planned/scheduled/published date chips.

import { BRIDGE_JS } from "./bridge";
import { VIEW_CSS } from "./styles";

const RENDER_JS = String.raw`
(function () {
  "use strict";

  var DOT_CLASS = {
    idea: "dot-idea",
    drafting: "dot-drafting",
    ready: "dot-ready",
    scheduled: "dot-scheduled",
    posted: "dot-posted"
  };

  function formatDate(value) {
    if (!value) return null;
    var date = new Date(String(value).indexOf("T") === -1 ? value + "T00:00:00" : value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function firstLine(text) {
    if (!text) return "";
    var line = String(text).split("\n")[0] || "";
    return line.slice(0, 80).trim();
  }

  function renderDraftCard(d) {
    var ui = window.swipeinUi;
    var esc = ui.esc;
    var snippet = typeof d.body_snippet === "string" ? d.body_snippet : "";
    var title = (d.title && String(d.title).trim()) || firstLine(snippet) || "Untitled post";

    var status = d.schedule_status === "scheduled" ? "scheduled" : d.status || "idea";
    var dotClass = DOT_CLASS[status] || "dot-idea";

    var badge = "";
    if (d.kind === "hook") badge = '<span class="badge-kind badge-hook">Hook</span>';
    else if (d.kind === "lead_magnet") badge = '<span class="badge-kind badge-lead">Lead Magnet</span>';

    var chips = "";
    var scheduled = formatDate(d.scheduled_at);
    var planned = formatDate(d.plan_to_post_on);
    var published = formatDate(d.published_at);
    var created = formatDate(d.created_at);
    if (d.schedule_status === "scheduled" && scheduled) {
      chips += '<span class="date-chip">Scheduled ' + esc(scheduled) + "</span>";
    } else if (planned) {
      chips += '<span class="date-chip">Planned ' + esc(planned) + "</span>";
    }
    if (d.schedule_status === "failed") {
      chips += '<span class="date-chip">Publish failed</span>';
    }
    if (published) {
      chips += '<span class="date-chip">Posted ' + esc(published) + "</span>";
    } else if (created) {
      chips += '<span class="date-chip">Created ' + esc(created) + "</span>";
    }

    return (
      '<div class="card"><div class="card-body">' +
      '<div class="draft-title">' + esc(title) + "</div>" +
      (snippet ? '<div class="draft-preview">' + esc(snippet) + "</div>" : "") +
      '<div class="draft-foot">' +
      '<span class="status-label"><span class="dot ' + dotClass + '"></span>' + esc(status) + "</span>" +
      badge + chips +
      "</div></div></div>"
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
    var drafts = Array.isArray(data.drafts) ? data.drafts : [];
    if (!drafts.length) {
      root.innerHTML = '<div class="empty">No drafts on the board.</div>';
      return;
    }
    var html = "";
    for (var i = 0; i < drafts.length; i++) html += renderDraftCard(drafts[i] || {});
    root.innerHTML = html;
  };
})();
`;

export const DRAFTS_VIEW_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>SwipeIn Drafts</title>
    <style>${VIEW_CSS}</style>
  </head>
  <body>
    <div id="root" class="list"></div>
    <script>${RENDER_JS}</script>
    <script>${BRIDGE_JS}</script>
  </body>
</html>
`;
