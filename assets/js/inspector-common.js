/* AutoClarity — inspector workspace shared helpers.
   Auth mirrors the admin dashboard: transparent Cloudflare Access in
   production; ADMIN_DEV_KEY (sessionStorage, same key store as the admin UI)
   in preview. Exposes window.Inspector: api(), esc(), money(), when(),
   requireAuth(cb) with a built-in login panel. */
(function () {
  "use strict";

  var KEY_STORE = "ppi-admin-key"; // shared with the admin dashboard on purpose

  function adminKey() {
    try { return sessionStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; }
  }

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers || {});
    var key = adminKey();
    if (key) options.headers["authorization"] = "Bearer " + key;
    if (options.body && typeof options.body === "object" && !(options.body instanceof FormData)) {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    return fetch(path, options).then(function (res) {
      var ct = res.headers.get("content-type") || "";
      if (ct.indexOf("application/json") === -1) {
        return { status: res.status, ok: res.ok, body: {}, raw: res };
      }
      return res.json().then(function (body) { return { status: res.status, ok: res.ok, body: body }; });
    });
  }

  function apiBlob(path) {
    var headers = {};
    var key = adminKey();
    if (key) headers["authorization"] = "Bearer " + key;
    return fetch(path, { headers: headers }).then(function (res) {
      if (!res.ok) throw new Error("blob " + res.status);
      return res.blob();
    });
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function money(cents) { return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }); }
  function when(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function showLogin(container, onSuccess) {
    container.innerHTML =
      '<div class="portal-card"><h2>Inspector access</h2>' +
      '<p style="color:var(--text-2);font-size:14.5px;margin-bottom:14px;">This is the preview environment. Enter the admin key for this deployment. In production this workspace sits behind Cloudflare Access instead.</p>' +
      '<form id="inspLoginForm"><div class="field"><label for="inspKey">Admin key</label>' +
      '<input id="inspKey" type="password" autocomplete="off" /></div>' +
      '<button class="btn btn-primary" type="submit">Unlock</button>' +
      '<p class="form-status" id="inspLoginStatus" role="status"></p></form></div>';
    var form = document.getElementById("inspLoginForm");
    function submit(e) {
      if (e) e.preventDefault();
      var key = document.getElementById("inspKey").value.trim();
      try { sessionStorage.setItem(KEY_STORE, key); } catch (err) {}
      document.getElementById("inspLoginStatus").textContent = "Checking…";
      onSuccess();
    }
    form.addEventListener("submit", submit);
    form.querySelector("button[type=submit]").addEventListener("click", submit);
  }

  /** Verify access (via a cheap API call), show login on 401, then run cb. */
  function requireAuth(container, cb) {
    api("/api/inspector/overview").then(function (r) {
      if (r.status === 401) { showLogin(container, function () { requireAuth(container, cb); }); return; }
      if (!r.ok) {
        container.innerHTML = '<div class="portal-card"><p style="color:var(--red);">Workspace unavailable (' + r.status + "). " + esc((r.body.error && r.body.error.message) || "") + "</p></div>";
        return;
      }
      cb(r.body);
    }).catch(function (e) {
      container.innerHTML = '<div class="portal-card"><p style="color:var(--red);">Network error — reload to retry. ' + esc(e && e.message) + "</p></div>";
    });
  }

  window.Inspector = { api: api, apiBlob: apiBlob, esc: esc, money: money, when: when, requireAuth: requireAuth };
})();
