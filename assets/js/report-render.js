/* AutoClarity — shared inspection-report renderer.
   Renders a published report-version payload (the immutable snapshot) into
   the premium report document. Used by BOTH the customer report page and the
   inspector preview, so what the inspector approves is what the customer sees.
   window.ReportRender.render(payload, { photoUrl: fn(photoId) -> url|null }) */
(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function money(cents) {
    return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  }
  function costRange(low, high) {
    if (low == null && high == null) return "";
    if (low != null && high != null && low !== high) return money(low) + "–" + money(high);
    return money(low != null ? low : high);
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return esc(iso);
    return d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  }

  var RESULT_LABELS = { pass: "Pass", attention: "Attention", fail: "Fail", not_inspected: "Not inspected", not_applicable: "N/A" };
  var RESULT_SEV = { pass: "sev-green", attention: "sev-amber", fail: "sev-red", not_inspected: "sev-grey", not_applicable: "sev-grey" };
  var REASON_LABELS = {
    not_accessible: "Not accessible", unsafe_to_test: "Unsafe to test", seller_declined: "Seller declined",
    equipment_unavailable: "Equipment unavailable", not_supported: "Not supported on this vehicle", not_applicable: "Not applicable"
  };
  var PRIORITY_LABELS = { immediate: "Immediate", soon: "Soon", monitor: "Monitor", informational: "Informational" };

  function findingHtml(it, sevLabel, sevClass, photoUrl) {
    var parts = [];
    if (it.measurement && it.measurement.value) {
      parts.push(esc((it.measurement.label || "Measured") + ": " + it.measurement.value + (it.measurement.unit ? " " + it.measurement.unit : "")));
    }
    if (it.note) parts.push(esc(it.note));
    if (it.result === "not_inspected" && it.notInspectedReason) parts.push("Reason: " + esc(REASON_LABELS[it.notInspectedReason] || it.notInspectedReason));
    if (it.priority && it.result !== "pass") parts.push("Priority: " + esc(PRIORITY_LABELS[it.priority] || it.priority));
    var photos = "";
    if (photoUrl && it.photos && it.photos.length) {
      var figs = it.photos.map(function (p) {
        var u = photoUrl(p.id);
        if (!u) return "";
        return '<figure><img loading="lazy" src="' + esc(u) + '" alt="' + esc(p.caption || it.label) + '" />' +
          (p.caption ? "<figcaption>" + esc(p.caption) + "</figcaption>" : "") + "</figure>";
      }).join("");
      if (figs) photos = '<div class="rphoto-grid">' + figs + "</div>";
    }
    var cost = costRange(it.costLowCents, it.costHighCents);
    return '<div class="finding"><div class="sev ' + sevClass + '">' + esc(sevLabel) + '</div>' +
      '<div class="body"><div class="t">' + esc(it.label) + "</div>" +
      (parts.length ? '<div class="d">' + parts.join(" · ") + "</div>" : "") + photos + "</div>" +
      (cost ? '<div class="cost">' + esc(cost) + "</div>" : "") + "</div>";
  }

  function render(v, opts) {
    opts = opts || {};
    var photoUrl = opts.photoUrl || null;
    var veh = v.vehicle || {};
    var overall = v.overall || {};
    var rollups = v.rollups || {};
    var counts = rollups.counts || {};
    var vehicleTitle = [veh.year, veh.make, veh.model, veh.trim].filter(Boolean).join(" ");

    var itemsByKey = {};
    (v.sections || []).forEach(function (sec) { (sec.items || []).forEach(function (it) { itemsByKey[it.key] = it; }); });

    var html = "";

    // header
    html += '<div class="report-head"><div class="brand"><img src="/assets/img/icon-64.png" alt="" />AutoClarity</div>' +
      '<div class="report-meta">Pre-Purchase Inspection Report<br />Report: ' + esc(v.ref || "") +
      "<br />Version " + esc(v.version || 1) + (v.kind === "amendment" ? " (amended)" : "") +
      "<br />Published " + fmtDate(v.publishedAt) + "<br />Inspector: " + esc(v.inspector || "") + "</div></div>";

    if (v.kind === "amendment") {
      html += '<div class="amend-note">Updated report — version ' + esc(v.version) + ". It replaces all earlier versions." +
        (v.amendmentReason ? " Reason: " + esc(v.amendmentReason) : "") + "</div>";
    }

    // verdict
    html += '<div class="verdict-banner" data-verdict="' + esc(overall.verdict || "") + '">' +
      '<div class="score">' + esc(overall.score != null ? overall.score : "—") + "<span>/10</span></div>" +
      '<div class="rec">Overall recommendation<strong>' + esc(overall.verdictLabel || "—") + "</strong></div></div>";

    // executive summary
    html += '<div class="report-section"><h2>Executive summary</h2><p>' + esc(overall.executiveSummary || "") + "</p>";
    if (overall.positiveFindings) html += "<h3>What presents well</h3><p>" + esc(overall.positiveFindings) + "</p>";
    html += "</div>";

    // vehicle details
    function kv(label, value) { return "<div><dt>" + esc(label) + "</dt><dd>" + esc(value || "—") + "</dd></div>"; }
    html += '<div class="report-section"><h2>Vehicle &amp; inspection details</h2><dl class="kv-grid">' +
      kv("Vehicle", vehicleTitle) +
      kv("VIN", veh.vin) +
      (veh.vinCheck === "matches" ? kv("VIN check", "Matches paperwork") : "") +
      (veh.vinCheck === "mismatch" ? kv("VIN check", "MISMATCH — see summary") : "") +
      kv("Odometer", veh.odometerMiles ? Number(veh.odometerMiles).toLocaleString("en-US") + " mi" : "") +
      (veh.plate ? kv("Plate", veh.plate + (veh.plateState ? " (" + veh.plateState + ")" : "")) : "") +
      kv("Title status (reported)", veh.titleStatus === "clean" ? "Clean (as reported)" : veh.titleStatus === "salvage_rebuilt" ? "Salvage / rebuilt (as reported)" : "Unknown") +
      ((v.seller && (v.seller.name || v.seller.type)) ? kv("Seller", [(v.seller.name || ""), v.seller.type ? "(" + v.seller.type + ")" : ""].filter(Boolean).join(" ")) : "") +
      kv("Location", [v.location && v.location.city, v.location && v.location.state].filter(Boolean).join(", ")) +
      kv("Inspected", fmtDate(v.inspectedAt || (v.appointment && v.appointment.startsAt))) +
      kv("Prepared for", v.customer && v.customer.name) +
      "</dl>" +
      (veh.titleDisclosureNotes ? "<h3>Title / disclosure notes</h3><p>" + esc(veh.titleDisclosureNotes) + "</p>" : "") +
      (v.seller && v.seller.notes ? "<h3>Seller notes</h3><p>" + esc(v.seller.notes) + "</p>" : "") +
      "</div>";

    // glance
    html += '<div class="report-section"><h2>Results at a glance</h2><div class="glance">' +
      '<div class="g" data-k="pass"><b>' + (counts.pass || 0) + "</b><span>Pass</span></div>" +
      '<div class="g" data-k="attention"><b>' + (counts.attention || 0) + "</b><span>Attention</span></div>" +
      '<div class="g" data-k="fail"><b>' + (counts.fail || 0) + "</b><span>Fail</span></div>" +
      '<div class="g"><b>' + (counts.notInspected || 0) + "</b><span>Not inspected</span></div>" +
      '<div class="g"><b>' + (counts.notApplicable || 0) + "</b><span>N/A</span></div></div>";
    var est = costRange(rollups.estimatedCostLowCents, rollups.estimatedCostHighCents);
    if (est) html += '<p style="margin-top:10px;">Estimated repair costs across findings: <strong>' + esc(est) + "</strong> (good-faith estimate, not a repair quote).</p>";
    html += "</div>";

    // rollup sections
    function rollupBlock(title, keys, sevLabel, sevClass, emptyGood) {
      var out = '<div class="report-section"><h2>' + esc(title) + "</h2>";
      if (!keys || !keys.length) {
        out += emptyGood
          ? '<p style="color:var(--green);font-weight:600;">None observed at the time of inspection.</p>'
          : '<p style="color:var(--text-3);">None noted.</p>';
      } else {
        keys.forEach(function (k) { var it = itemsByKey[k]; if (it) out += findingHtml(it, sevLabel, sevClass, photoUrl); });
      }
      return out + "</div>";
    }
    html += rollupBlock("Immediate safety concerns", rollups.safetyItems, "Safety", "sev-red", true);
    if ((rollups.immediateItems || []).length) html += rollupBlock("High-priority repairs", rollups.immediateItems, "Priority", "sev-red", false);
    if ((rollups.soonItems || []).length) html += rollupBlock("Repairs expected soon", rollups.soonItems, "Soon", "sev-amber", false);
    if ((rollups.monitorItems || []).length) html += rollupBlock("Monitor", rollups.monitorItems, "Monitor", "sev-grey", false);

    if ((rollups.negotiationItems || []).length || overall.negotiationSummary) {
      html += '<div class="report-section"><h2>Negotiation considerations</h2>';
      if (overall.negotiationSummary) html += "<p>" + esc(overall.negotiationSummary) + "</p>";
      (rollups.negotiationItems || []).forEach(function (k) {
        var it = itemsByKey[k];
        if (it) html += findingHtml(it, "Negotiate", "sev-info", photoUrl);
      });
      html += "</div>";
    }

    // full detail
    html += '<div class="report-section"><h2>Findings by section</h2>' +
      '<p class="sec-note">Every checklist area with its result. Anything not inspected is identified with the reason.</p></div>';
    (v.sections || []).forEach(function (sec) {
      html += '<div class="report-section"><h3 style="font-size:15.5px;">' + esc(sec.title) + "</h3>";
      if (sec.performed === "not_performed") {
        html += '<p class="sec-note">Not performed — ' + esc(REASON_LABELS[sec.notPerformedReason] || "see notes") + "." +
          (sec.summary ? " " + esc(sec.summary) : "") + "</p></div>";
        return;
      }
      if (sec.summary) html += '<p class="sec-note">' + esc(sec.summary) + "</p>";
      (sec.items || []).forEach(function (it) {
        html += findingHtml(it, RESULT_LABELS[it.result] || it.result, RESULT_SEV[it.result] || "sev-grey", photoUrl);
      });
      html += "</div>";
    });

    // general photos
    if (photoUrl && (v.generalPhotos || []).length) {
      var figs = v.generalPhotos.map(function (p) {
        var u = photoUrl(p.id);
        if (!u) return "";
        return '<figure><img loading="lazy" src="' + esc(u) + '" alt="' + esc(p.caption || "Inspection photo") + '" />' +
          (p.caption ? "<figcaption>" + esc(p.caption) + "</figcaption>" : "") + "</figure>";
      }).join("");
      if (figs) html += '<div class="report-section"><h2>Additional photographs</h2><div class="rphoto-grid">' + figs + "</div></div>";
    }

    // limitations
    html += '<div class="report-section"><h2>Inspection limitations &amp; disclosures</h2><p class="report-limits">' +
      esc((v.limitations && v.limitations.standard) || "") +
      ((v.limitations && v.limitations.additional) ? "<br /><br />" + esc(v.limitations.additional) : "") + "</p></div>";

    html += '<div class="report-section" style="margin-bottom:0;"><h2>Inspector</h2><p>' + esc(v.inspector || "") +
      ". Questions about this report: support@getautoclarity.com</p></div>";

    return '<article class="report-doc">' + html + "</article>";
  }

  window.ReportRender = { render: render, esc: esc };
})();
