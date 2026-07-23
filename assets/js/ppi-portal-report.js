/* AutoClarity — customer inspection-report page (/ppi/portal/report/?t=…).
   Magic-token authorized; renders the immutable PUBLISHED snapshot with the
   shared renderer; photos and the PDF download carry the same token. */
(function () {
  "use strict";

  var token = new URLSearchParams(window.location.search).get("t") || "";
  var loading = document.getElementById("reportLoading");
  var errorBox = document.getElementById("reportError");
  var errorMsg = document.getElementById("reportErrorMsg");
  var content = document.getElementById("reportContent");

  function fail(msg) {
    loading.hidden = true;
    content.hidden = true;
    errorBox.hidden = false;
    errorMsg.textContent = msg;
  }

  if (!token) {
    fail("This page needs the secure link from your AutoClarity email. Open the most recent email and tap the report link again.");
    return;
  }

  fetch("/api/portal/report", { headers: { authorization: "Bearer " + token } })
    .then(function (res) { return res.json().then(function (body) { return { status: res.status, body: body }; }); })
    .then(function (r) {
      if (r.status === 404) { fail("Your inspection report has not been published yet. You will get an email the moment it is ready."); return; }
      if (r.status !== 200) { fail((r.body.error && r.body.error.message) || "This link is not valid or has expired."); return; }

      var payload = r.body.payload;
      loading.hidden = true;
      content.hidden = false;

      document.getElementById("pdfLink").href = "/api/portal/report-pdf?t=" + encodeURIComponent(token);
      document.getElementById("portalLink").href = "/ppi/portal/?t=" + encodeURIComponent(token);

      document.getElementById("reportDoc").innerHTML = window.ReportRender.render(payload, {
        photoUrl: function (id) { return "/api/portal/report-photo?id=" + encodeURIComponent(id) + "&t=" + encodeURIComponent(token); }
      });

      var history = r.body.history || [];
      if (history.length > 1) {
        var esc = window.ReportRender.esc;
        var rows = history.map(function (h) {
          var when = new Date(h.published_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
          return "<p style=\"font-size:14px;color:var(--text-2);margin:6px 0;\">Version " + esc(h.version) +
            (h.status === "published" ? " (current)" : " (superseded)") +
            " — published " + esc(when) +
            (h.amendment_reason ? " — " + esc(h.amendment_reason) : "") + "</p>";
        }).join("");
        document.getElementById("historyBody").innerHTML = rows;
        document.getElementById("historyCard").hidden = false;
      }
    })
    .catch(function () { fail("Network problem loading your report. Check your connection and reload."); });
})();
