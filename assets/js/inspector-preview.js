/* AutoClarity — pre-publication preview + confirmed publish.
   URL: /inspector/inspections/:requestId/report/preview
   Renders the report EXACTLY as the customer will see it (same renderer),
   shows the readiness checklist, and gates publishing behind an explicit
   typed confirmation of the request reference. */
(function () {
  "use strict";

  var I = window.Inspector;
  var app = document.getElementById("app");
  var bottomBar = document.getElementById("bottomBar");
  var publishBtn = document.getElementById("publishBtn");
  var modal = document.getElementById("publishModal");

  var match = location.pathname.match(/\/inspector\/inspections\/([^/]+)\/report\/preview/);
  var requestId = match ? decodeURIComponent(match[1]) : null;
  if (!requestId) { app.innerHTML = '<div class="portal-card"><p>Bad URL.</p></div>'; return; }
  document.getElementById("backBtn").href = "/inspector/inspections/" + encodeURIComponent(requestId) + "/report";

  var P = null; // preview payload response
  var photoCache = {};

  I.requireAuth(app, load);

  function load() {
    I.api("/api/inspector/reports/" + encodeURIComponent(requestId) + "/preview").then(function (r) {
      if (!r.ok) {
        app.innerHTML = '<div class="portal-card"><p style="color:var(--red);">' + I.esc((r.body.error && r.body.error.message) || "Could not build the preview.") + "</p></div>";
        return;
      }
      P = r.body;
      render();
    });
  }

  function render() {
    document.getElementById("headRef").textContent = P.payload.ref + " — preview";
    bottomBar.hidden = false;

    var html = "";

    // status + readiness
    var ready = P.readiness && P.readiness.ok;
    var isAmendment = P.versionCount > 0;
    html += '<section class="portal-card"><h2>' + (isAmendment ? "Amendment preview (would publish as version " + (P.versionCount + 1) + ")" : "Publication preview") + "</h2>";
    html += '<p class="insp-sub" style="margin-bottom:10px;">State: <strong>' + I.esc(String(P.state).replace(/_/g, " ")) + "</strong>" +
      (isAmendment ? " · customers currently see version " + P.versionCount : " · not visible to the customer yet") + "</p>";

    if (P.readiness.problems.length) {
      html += '<h3 style="font-size:14px;color:var(--red);">Blocking issues</h3><ul class="readiness">' +
        P.readiness.problems.map(function (p) { return '<li class="problem">' + I.esc(p) + "</li>"; }).join("") + "</ul>";
    }
    if (P.readiness.warnings.length) {
      html += '<h3 style="font-size:14px;color:var(--amber);margin-top:8px;">Warnings (review before publishing)</h3><ul class="readiness">' +
        P.readiness.warnings.map(function (w) { return '<li class="warning">' + I.esc(w) + "</li>"; }).join("") + "</ul>";
    }
    if (ready && !P.readiness.warnings.length) {
      html += '<p style="color:var(--green);font-weight:650;">All readiness checks pass.</p>';
    }
    if (P.state !== "ready_for_review" && P.state !== "published") {
      html += '<p style="margin-top:10px;"><button class="btn btn-sm btn-ghost" id="markReady" type="button"' + (ready ? "" : " disabled") + ">Move to Ready for review</button>" +
        (ready ? "" : ' <span class="insp-sub">(resolve blocking issues first)</span>') + "</p>";
    }
    html += "</section>";

    html += '<p class="insp-sub" style="margin:0 0 10px;">Below is exactly what the customer will see.</p>';
    html += window.ReportRender.render(P.payload, { photoUrl: photoUrl });

    app.innerHTML = html;

    // hydrate photos (inspector endpoints need the auth header → blob URLs)
    hydratePhotos();

    var markReady = document.getElementById("markReady");
    if (markReady) {
      markReady.addEventListener("click", function () {
        var chain = P.state === "in_progress" ? ["draft_complete", "ready_for_review"] : ["ready_for_review"];
        var step = function () {
          var to = chain.shift();
          if (!to) { load(); return; }
          I.api("/api/inspector/reports/" + encodeURIComponent(requestId) + "/state", { method: "POST", body: { to: to } }).then(function (r) {
            if (r.ok) step();
            else { alert((r.body.error && r.body.error.message) || "Could not move the state."); load(); }
          });
        };
        step();
      });
    }

    // publish button
    if (P.state === "ready_for_review" && ready) {
      publishBtn.hidden = false;
      publishBtn.textContent = isAmendment ? "Publish amendment…" : "Publish report…";
      publishBtn.onclick = openModal;
    } else if (P.state === "published") {
      publishBtn.hidden = false;
      publishBtn.textContent = "Published ✓";
      publishBtn.disabled = true;
    } else {
      publishBtn.hidden = true;
    }
  }

  var pendingPhotoIds = [];
  function photoUrl(id) {
    if (photoCache[id]) return photoCache[id];
    pendingPhotoIds.push(id);
    return "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="; // placeholder, replaced after fetch
  }
  function hydratePhotos() {
    var ids = pendingPhotoIds.slice();
    pendingPhotoIds = [];
    if (!ids.length) return;
    Promise.all(ids.map(function (id) {
      return I.apiBlob("/api/inspector/reports/" + encodeURIComponent(requestId) + "/photos/" + encodeURIComponent(id))
        .then(function (blob) { photoCache[id] = URL.createObjectURL(blob); })
        .catch(function () { photoCache[id] = null; });
    })).then(function () {
      // Re-render the document once with real photo URLs.
      var scroll = window.scrollY;
      var doc = app.querySelector(".report-doc");
      if (doc) {
        doc.outerHTML = window.ReportRender.render(P.payload, { photoUrl: function (pid) { return photoCache[pid] || null; } });
        window.scrollTo(0, scroll);
      }
    });
  }

  /* -------- publish modal -------- */
  var confirmInput = document.getElementById("confirmRef");
  var confirmBtn = document.getElementById("confirmPublish");
  var statusEl = document.getElementById("publishStatus");
  var amendField = document.getElementById("amendReasonField");

  function openModal() {
    modal.hidden = false;
    statusEl.textContent = "";
    confirmInput.value = "";
    confirmBtn.disabled = true;
    amendField.hidden = P.versionCount === 0;
    document.getElementById("publishTitle").textContent =
      P.versionCount > 0 ? "Publish amendment (version " + (P.versionCount + 1) + ")?" : "Publish this report?";
    confirmInput.focus();
  }
  document.getElementById("cancelPublish").addEventListener("click", function () { modal.hidden = true; });
  confirmInput.addEventListener("input", function () {
    confirmBtn.disabled = confirmInput.value.trim().toUpperCase() !== String(P.confirmPhrase).toUpperCase();
  });
  confirmBtn.addEventListener("click", function () {
    confirmBtn.disabled = true;
    statusEl.textContent = "Publishing…";
    var body = { confirm: confirmInput.value.trim() };
    var reason = document.getElementById("amendReason").value.trim();
    if (!amendField.hidden) body.amendmentReason = reason;
    I.api("/api/inspector/reports/" + encodeURIComponent(requestId) + "/publish", { method: "POST", body: body }).then(function (r) {
      if (r.ok) {
        statusEl.textContent = "Published version " + r.body.version + ". The customer portal now shows this report.";
        setTimeout(function () { modal.hidden = true; load(); }, 1200);
      } else {
        confirmBtn.disabled = false;
        var msg = (r.body.error && r.body.error.message) || "Publish failed.";
        var problems = r.body.error && r.body.error.problems;
        statusEl.textContent = msg + (problems && problems.length ? " — " + problems.join(" · ") : "");
      }
    });
  });
})();
