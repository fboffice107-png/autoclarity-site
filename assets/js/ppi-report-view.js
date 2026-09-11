/* One escaped, customer-only report presentation for the secure portal and
   owner preview. Image bytes are obtained separately with authorization;
   bearer credentials and object keys are never included in image URLs. */
(function () {
  "use strict";

  function esc(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  function list(value) { return Array.isArray(value) ? value : []; }
  function label(value) {
    return ({ pass: "Pass", attention: "Attention", fail: "Fail", not_inspected: "Not inspected", not_accessible: "Not accessible", not_applicable: "Not applicable",
      proceed: "Proceed", negotiate_repair_first: "Negotiate / Repair First", do_not_proceed: "Do Not Proceed" })[value] || String(value || "Not recorded").replace(/_/g, " ");
  }
  function date(value) {
    if (!value || !Number.isFinite(new Date(value).getTime())) return "Not recorded";
    return new Date(value).toLocaleString("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  }
  function prose(title, value) {
    return value ? "<h3>" + esc(title) + '</h3><p class="report-prose">' + esc(value) + "</p>" : "";
  }
  function photos(items) {
    if (!list(items).length) return "";
    return '<div class="report-photo-grid">' + items.map(function (raw) {
      var photo = object(raw);
      return '<figure class="report-photo">' + (photo.id ? '<img data-report-photo="' + esc(photo.id) + '" alt="' + esc(photo.caption || "Inspection photograph") + '" loading="lazy" decoding="async" />' : "") +
        '<figcaption>' + esc(photo.caption || "Inspection photograph") + '</figcaption>' + (photo.id ? '<span class="report-photo-state" role="status">Loading private photo…</span>' : '') + '</figure>';
    }).join("") + "</div>";
  }
  function render(report, options) {
    report = object(report); options = options || {};
    var payload = object(report.payload), overall = object(payload.overall), vehicle = object(payload.vehicle);
    var vehicleLabel = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ");
    var html = '<article class="portal-card customer-report" aria-label="AutoClarity inspection report">' +
      '<div class="report-masthead"><p class="report-brand">AUTOCLARITY</p><h2>Pre-purchase inspection report</h2>' +
      '<p>Comprehensive multi-point pre-purchase inspection</p></div>';
    if (options.preview) html += '<p class="notice warn report-preview-notice">Owner preview — unpublished draft. Internal notes are excluded. Review all findings before publication.</p>';
    html += '<dl class="kv report-identity">' +
      '<dt>Vehicle</dt><dd>' + esc(vehicleLabel || "See request vehicle information") + '</dd>' +
      (vehicle.vin ? '<dt>VIN</dt><dd class="mono">' + esc(vehicle.vin) + '</dd>' : '') +
      '<dt>Inspection date</dt><dd>' + esc(date(payload.inspectedAt)) + '</dd>' +
      '<dt>Report version</dt><dd>' + esc(options.preview ? "Draft" : report.version) + (report.amended ? " · amendment" : "") + '</dd>' +
      '<dt>Published</dt><dd>' + esc(options.preview ? "Not published" : date(report.publishedAt)) + '</dd>' +
      (payload.inspector ? '<dt>Inspector</dt><dd>' + esc(payload.inspector) + '</dd>' : '') + '</dl>';
    html += '<section class="report-guidance"><h3>Buyer guidance</h3><p class="report-verdict">' + esc(label(overall.verdict)) + '</p>' +
      '<p class="field-hint">The inspector’s judgment is based on the accessible vehicle condition at inspection, not a guarantee of future performance.</p>' +
      (overall.score != null && overall.score !== "" ? '<p>Inspector-assigned condition score: <strong>' + esc(overall.score) + ' / 10</strong></p>' : '') + '</section>';
    html += prose("Executive summary", overall.executiveSummary) + prose("Positive findings", overall.positiveFindings) + prose("Negotiation considerations", overall.negotiationSummary);
    list(payload.sections).forEach(function (raw) {
      var section = object(raw);
      html += '<section class="report-category"><h3>' + esc(section.title || "Inspection category") + '</h3>';
      if (section.performed !== "performed") html += '<p class="report-scope"><strong>Scope:</strong> ' + esc(label(section.performed)) + (section.notPerformedReason ? ' — ' + esc(label(section.notPerformedReason)) : '') + '</p>';
      if (section.summary) html += '<p class="report-prose">' + esc(section.summary) + '</p>';
      list(section.items).forEach(function (rawItem) {
        var item = object(rawItem), measurement = object(item.measurement);
        var safeResult = ["pass", "attention", "fail", "not_inspected", "not_accessible", "not_applicable"].indexOf(item.result) >= 0 ? item.result : "unset";
        html += '<div class="report-finding"><div class="report-finding-title"><h4>' + esc(item.label || "Inspection finding") + '</h4><span class="report-result result-' + safeResult + '">' + esc(label(item.result)) + '</span></div>';
        if (item.notInspectedReason) html += '<p><strong>Limitation:</strong> ' + esc(label(item.notInspectedReason)) + '</p>';
        if (item.note) html += '<p class="report-prose">' + esc(item.note) + '</p>';
        if (measurement.value) html += '<p>' + esc([measurement.label, measurement.value, measurement.unit].filter(Boolean).join(" ")) + '</p>';
        if (item.priority) html += '<p><strong>Priority:</strong> ' + esc(label(item.priority)) + '</p>';
        if (Number.isFinite(item.costLowCents) || Number.isFinite(item.costHighCents)) {
          var money = function (cents) { return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }); };
          html += '<p>Estimated cost: ' + esc([item.costLowCents, item.costHighCents].filter(Number.isFinite).map(money).join("–")) + '</p>';
        }
        html += photos(item.photos) + '</div>';
      });
      html += '</section>';
    });
    var limitations = object(payload.limitations);
    if (list(limitations.standard).length || limitations.additional) {
      html += '<section class="report-category"><h3>Limitations &amp; important notes</h3><ul>' + list(limitations.standard).map(function (item) { return '<li>' + esc(item) + '</li>'; }).join("") + '</ul>' +
        (limitations.additional ? '<p class="report-prose">' + esc(limitations.additional) + '</p>' : '') + '</section>';
    }
    html += '<p class="report-private-note">Private customer report. The secure AutoClarity portal is the canonical delivery location. Keep downloaded or printed copies private.</p>';
    return html + '</article>';
  }

  // Returns a disposer: keep private blob URLs only for the lifetime of this view.
  function hydrate(root, fetchPhoto) {
    var urls = [], disposed = false, active = 0, queue = [], observer = null, controller = new AbortController();
    var entries = Array.from(root.querySelectorAll("[data-report-photo]")).map(function (img) {
      var resolve;
      var done = new Promise(function (finish) { resolve = finish; });
      return { img: img, state: "idle", failed: false, done: done, resolve: resolve };
    });
    function enqueue(entry) { if (disposed || entry.state !== "idle") return; entry.state = "queued"; queue.push(entry); pump(); }
    function pump() {
      while (!disposed && active < 2 && queue.length) {
        var entry = queue.shift(); active += 1; entry.state = "loading"; load(entry);
      }
    }
    function load(entry) {
      var img = entry.img;
      Promise.resolve().then(function () { return fetchPhoto(img.getAttribute("data-report-photo"), controller.signal); }).then(function (blob) {
        if (disposed || !img.isConnected) return;
        if (!(blob instanceof Blob)) throw new Error("Photo unavailable");
        var url = URL.createObjectURL(blob); urls.push(url); img.src = url;
        var state = img.parentElement.querySelector(".report-photo-state");
        if (state) state.textContent = "";
      }).catch(function () {
        entry.failed = true;
        if (disposed) return;
        img.hidden = true;
        var state = img.parentElement && img.parentElement.querySelector(".report-photo-state");
        if (state) state.textContent = "Private photo could not load. Refresh this secure page to retry.";
      }).finally(function () { entry.state = "done"; active -= 1; entry.resolve(); pump(); });
    }
    // Authenticated bytes are fetched only near the viewport, not merely lazy
    // decoded after all full-size blobs have already consumed phone memory.
    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver(function (intersections) {
        intersections.forEach(function (intersection) {
          if (!intersection.isIntersecting) return;
          var entry = entries.find(function (value) { return value.img === intersection.target; });
          if (entry) enqueue(entry);
          observer.unobserve(intersection.target);
        });
      }, { rootMargin: "300px" });
      entries.forEach(function (entry) { observer.observe(entry.img); });
    } else entries.forEach(enqueue);
    var dispose = function () {
      disposed = true; controller.abort(); if (observer) observer.disconnect();
      queue = []; entries.forEach(function (entry) { entry.resolve(); });
      urls.forEach(function (url) { URL.revokeObjectURL(url); }); urls = [];
    };
    dispose.ready = Promise.all(entries.map(function (entry) { return entry.done; })).then(function () {
      return { total: entries.length, failed: entries.filter(function (entry) { return entry.failed; }).length };
    });
    dispose.loadAll = function () { entries.forEach(enqueue); return dispose.ready; };
    return dispose;
  }
  window.AutoClarityReportView = { render: render, hydrate: hydrate, escape: esc, resultLabel: label };
})();
