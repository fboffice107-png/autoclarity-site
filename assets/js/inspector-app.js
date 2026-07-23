/* AutoClarity — inspector workspace list pages:
   dashboard (/inspector/), all requests (/inspector/requests/),
   reports (/inspector/inspections/). Editor lives in inspector-report.js. */
(function () {
  "use strict";

  var I = window.Inspector;
  var app = document.getElementById("app");
  var page = document.body.getAttribute("data-page") || "dashboard";

  I.requireAuth(app, function (overview) {
    if (page === "requests") renderRequests();
    else if (page === "inspections") renderInspections(overview);
    else renderDashboard(overview);
  });

  function vehicleLine(r) {
    return [r.year, r.make, r.model, r.trim].filter(Boolean).join(" ");
  }

  function reportUrl(requestId) {
    return "/inspector/inspections/" + encodeURIComponent(requestId) + "/report";
  }

  function startInspection(requestId, btn) {
    btn.disabled = true;
    btn.textContent = "Starting…";
    I.api("/api/inspector/inspections", { method: "POST", body: { requestId: requestId } }).then(function (r) {
      if (r.ok) { window.location.href = reportUrl(requestId); return; }
      btn.disabled = false;
      btn.textContent = "Start inspection";
      alert((r.body.error && r.body.error.message) || "Could not start the inspection.");
    });
  }

  function bindStartButtons(root) {
    root.querySelectorAll("[data-start]").forEach(function (btn) {
      btn.addEventListener("click", function () { startInspection(btn.getAttribute("data-start"), btn); });
    });
  }

  function queueCard(r, actionsHtml) {
    return '<div class="queue-card">' +
      '<div><div class="veh">' + I.esc(vehicleLine(r)) + "</div>" +
      '<div class="meta">' + I.esc(r.ref) + " · " + I.esc(r.customer_name || "") +
      (r.starts_at ? " · " + I.esc(I.when(r.starts_at)) : "") +
      (r.loc_city ? " · " + I.esc(r.loc_city) : "") + "</div></div>" +
      '<div class="actions">' + actionsHtml + "</div></div>";
  }

  /* ---------------- dashboard ---------------- */
  function renderDashboard(data) {
    var html = "";

    html += '<section class="portal-card"><h2>Ready to inspect</h2>';
    if (!data.ready.length) html += '<p style="color:var(--text-3);">No confirmed appointments waiting.</p>';
    data.ready.forEach(function (r) {
      html += queueCard(r, '<button class="btn btn-primary" data-start="' + I.esc(r.request_id) + '">Start inspection</button>');
    });
    html += "</section>";

    html += '<section class="portal-card"><h2>Reports in progress</h2>';
    if (!data.inProgress.length) html += '<p style="color:var(--text-3);">Nothing in progress.</p>';
    data.inProgress.forEach(function (r) {
      var stateLabel = (r.version_count > 0 ? "amending · " : "") + String(r.report_state || "").replace(/_/g, " ");
      html += queueCard(r,
        '<span class="status-pill">' + I.esc(stateLabel) + "</span>" +
        '<a class="btn btn-primary" href="' + reportUrl(r.request_id) + '">Resume</a>');
    });
    html += "</section>";

    html += '<section class="portal-card"><h2>Published</h2>';
    if (!data.published.length) html += '<p style="color:var(--text-3);">No published reports yet.</p>';
    data.published.forEach(function (r) {
      html += queueCard(r,
        '<span class="status-pill">v' + I.esc(r.version_count) + " published</span>" +
        '<a class="btn btn-ghost" href="' + reportUrl(r.request_id) + '/preview">View</a>');
    });
    html += "</section>";

    app.innerHTML = html;
    bindStartButtons(app);
  }

  /* ---------------- all requests ---------------- */
  function renderRequests() {
    I.api("/api/admin/requests?limit=100").then(function (r) {
      if (!r.ok) { app.innerHTML = '<div class="portal-card"><p style="color:var(--red);">Could not load requests.</p></div>'; return; }
      var rows = r.body.requests || [];
      var html = '<section class="portal-card" style="overflow-x:auto;"><table class="admin-table"><thead><tr>' +
        "<th>Ref</th><th>Vehicle</th><th>Customer</th><th>Status</th><th></th></tr></thead><tbody>";
      rows.forEach(function (row) {
        var inspectable = ["confirmed", "inspection_in_progress", "report_in_progress", "completed"].indexOf(row.status) !== -1;
        html += "<tr><td>" + I.esc(row.ref) + "</td><td>" + I.esc(vehicleLine(row)) + "</td><td>" + I.esc(row.full_name || "") +
          "</td><td><span class=\"status-pill\">" + I.esc(String(row.status).replace(/_/g, " ")) + "</span></td><td>" +
          (inspectable ? '<a class="btn btn-sm btn-ghost" href="' + reportUrl(row.id) + '">Report</a>' : "") +
          "</td></tr>";
      });
      html += "</tbody></table></section>";
      app.innerHTML = html;
    });
  }

  /* ---------------- reports list ---------------- */
  function renderInspections(data) {
    var all = [].concat(data.inProgress, data.published);
    var html = '<section class="portal-card"><h2>Reports</h2>';
    if (!all.length) html += '<p style="color:var(--text-3);">No reports yet. Start one from the dashboard.</p>';
    all.forEach(function (r) {
      var label = r.report_state === "published"
        ? "v" + r.version_count + " published"
        : (r.version_count > 0 ? "amending · " : "") + String(r.report_state || "").replace(/_/g, " ");
      html += queueCard(r,
        '<span class="status-pill">' + I.esc(label) + "</span>" +
        '<a class="btn btn-primary" href="' + reportUrl(r.request_id) + '">' + (r.report_state === "published" ? "Open" : "Resume") + "</a>");
    });
    html += "</section>";
    app.innerHTML = html;
  }
})();
