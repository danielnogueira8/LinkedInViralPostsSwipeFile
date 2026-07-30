// MCP Apps (SEP-1865) iframe bridge, hand-rolled over window.postMessage
// JSON-RPC — no SDK, no build step. Inlined into every ui://swipein/* view
// HTML (see register-ui.ts). Implements the view side of the lifecycle:
//
//   view → ui/initialize (request)           → host returns hostContext
//   view → ui/notifications/initialized      → host starts pushing results
//   host → ui/notifications/tool-result      → view renders the payload
//   view → ui/notifications/size-changed     → host sizes the iframe
//   host → ui/resource-teardown (request)    → view replies {}
//   view → ui/open-link (request)            → host opens external URLs
//
// It also exposes window.swipeinUi — the small presentation helpers every
// card renderer shares (html escaping, avatar tints/initials, dates, and the
// inline SVG icon set) — and calls the view's window.renderSwipeIn(data)
// whenever a tool result arrives.
//
// Keep this dependency-free ES5-ish JavaScript: it ships verbatim inside an
// HTML <script> tag. No backticks, no ${, and never the literal "</script".

export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

export const BRIDGE_JS = String.raw`
(function () {
  "use strict";
  var pending = {};
  var nextId = 1;

  function postToHost(message) {
    window.parent.postMessage(message, "*");
  }

  function sendRequest(method, params) {
    return new Promise(function (resolve, reject) {
      var id = "swipein-" + nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      postToHost({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }

  function sendNotification(method, params) {
    postToHost({ jsonrpc: "2.0", method: method, params: params || {} });
  }

  // ---------------------------------------------------------------------
  // Shared view helpers (window.swipeinUi)
  // ---------------------------------------------------------------------

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[ch];
    });
  }

  // Warm palette ported from lib/post-card-helpers.ts (tintFor) so a creator's
  // avatar tint in the MCP card matches their avatar in the app.
  var AVATAR_TINTS = [
    ["#fef3c7", "#92400e"],
    ["#ffedd5", "#9a3412"],
    ["#ffe4e6", "#9f1239"],
    ["#e7e5e4", "#44403c"],
    ["#fef9c3", "#854d0e"],
    ["#fee2e2", "#991b1b"],
    ["#ecfccb", "#3f6212"],
    ["#fae8ff", "#86198f"]
  ];

  function tintFor(name) {
    var h = 0;
    var s = String(name || "");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return AVATAR_TINTS[Math.abs(h) % AVATAR_TINTS.length];
  }

  function initialsForName(name) {
    var parts = String(name || "").trim().split(/\s+/);
    var out = "";
    for (var i = 0; i < parts.length && out.length < 2; i++) {
      if (parts[i]) out += Array.from(parts[i])[0];
    }
    return out.toUpperCase();
  }

  // DiceBear "glyphs" fallback for creators without a usable profile photo
  // (LinkedIn CDN URLs expire). Seeded by name: stable per creator, different
  // across creators. Mirrors creatorAvatarFallback in lib/post-card-helpers.ts.
  function avatarFallbackUrl(name) {
    return (
      "https://api.dicebear.com/9.x/glyphs/svg?seed=" +
      encodeURIComponent(String(name || "").trim() || "?")
    );
  }

  // <img onerror> handler for creator avatars: the first failure swaps the
  // (missing/expired) photo for the glyphs fallback carried in data-fallback;
  // if that CDN also fails, drop the img and keep the initials tile beneath.
  function avatarError(img) {
    var fallback = img.getAttribute("data-fallback");
    if (fallback && img.getAttribute("src") !== fallback) {
      img.setAttribute("src", fallback);
      return;
    }
    img.remove();
  }

  function timeAgo(iso) {
    if (!iso) return null;
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function openLink(url) {
    if (!url) return;
    sendRequest("ui/open-link", { url: url }).catch(function () {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  }

  // Lucide-style inline SVGs (stroke=currentColor) matching the app icons.
  var ICONS = {
    thumb: '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
    comment: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    repost: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    trending: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    note: '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/>',
    imgoff: '<line x1="2" x2="22" y1="2" y2="22"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><line x1="13.5" x2="6" y1="13.5" y2="21"/><line x1="18" x2="21" y1="12" y2="15"/><path d="M3.59 3.59A2 2 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/>'
  };

  function icon(name, size) {
    var body = ICONS[name] || "";
    var filled = name === "play";
    if (name === "play") {
      body = '<polygon points="6 3 20 12 6 21 6 3"/>';
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + (size || 14) + '" height="' + (size || 14) +
      '" viewBox="0 0 24 24" fill="' + (filled ? "currentColor" : "none") +
      '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      body + "</svg>"
    );
  }

  window.swipeinUi = {
    esc: esc,
    tintFor: tintFor,
    initialsForName: initialsForName,
    avatarFallbackUrl: avatarFallbackUrl,
    avatarError: avatarError,
    timeAgo: timeAgo,
    openLink: openLink,
    icon: icon
  };

  // ---------------------------------------------------------------------
  // Host context (theme + CSS variables)
  // ---------------------------------------------------------------------

  function applyHostContext(ctx) {
    if (!ctx) return;
    var root = document.documentElement;
    if (ctx.theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    var vars = ctx.styles && ctx.styles.variables;
    if (vars) {
      for (var key in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, key)) {
          root.style.setProperty(key, vars[key]);
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;

    // A response to one of our requests (has id, no method).
    if (msg.method === undefined && msg.id !== undefined) {
      var entry = pending[msg.id];
      if (entry) {
        delete pending[msg.id];
        if (msg.error) entry.reject(new Error(msg.error.message || "MCP Apps request failed"));
        else entry.resolve(msg.result);
      }
      return;
    }

    if (msg.method === "ui/notifications/tool-result") {
      var params = msg.params || {};
      var data = params.structuredContent;
      if (data === undefined && Array.isArray(params.content)) {
        for (var i = 0; i < params.content.length; i++) {
          var block = params.content[i];
          if (block && block.type === "text" && typeof block.text === "string") {
            try {
              data = JSON.parse(block.text);
            } catch (parseError) {
              data = undefined;
            }
            break;
          }
        }
      }
      if (data !== undefined && typeof window.renderSwipeIn === "function") {
        window.renderSwipeIn(data);
      }
      return;
    }

    if (msg.method === "ui/notifications/host-context-changed") {
      applyHostContext(msg.params);
      return;
    }

    if (msg.method === "ui/resource-teardown" && msg.id !== undefined) {
      postToHost({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  });

  // Keep the host informed of our rendered height so it can size the iframe.
  function reportSize() {
    sendNotification("ui/notifications/size-changed", {
      width: Math.ceil(document.body.scrollWidth),
      height: Math.ceil(document.body.scrollHeight)
    });
  }
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(function () {
      reportSize();
    }).observe(document.body);
  }

  sendRequest("ui/initialize", {
    protocolVersion: "` + MCP_APPS_PROTOCOL_VERSION + String.raw`",
    capabilities: {},
    clientInfo: { name: "swipein-card-view", version: "1.0.0" },
    appCapabilities: { availableDisplayModes: ["inline"] }
  })
    .then(function (result) {
      applyHostContext(result && result.hostContext);
    })
    .catch(function () {
      // Host without MCP Apps context — render with our own defaults.
    })
    .then(function () {
      sendNotification("ui/notifications/initialized");
    });
})();
`;
