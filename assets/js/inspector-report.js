/* AutoClarity — inspection report EDITOR (mobile-first, autosave).
   URL: /inspector/inspections/:requestId/report
   - loads the working report + checklist template
   - segmented Pass/Attention/Fail/NI/NA controls, expandable details
   - debounced autosave with optimistic concurrency, offline retry,
     visible Saving/Saved/Failed/Offline state, unsaved-change warning
   - photos (feature-flagged on R2) with client-side JPEG downscale
   - published reports are locked; amendments reopen the draft */
(function () {
  "use strict";

  var I = window.Inspector;
  var app = document.getElementById("app");
  var saveStateEl = document.getElementById("saveState");
  var saveProgressEl = document.getElementById("saveProgress");
  var jumpSelect = document.getElementById("jumpSelect");
  var savebar = document.getElementById("savebar");
  var bottomBar = document.getElementById("bottomBar");
  var bottomState = document.getElementById("bottomState");
  var stateBtn = document.getElementById("stateBtn");
  var previewBtn = document.getElementById("previewBtn");

  var match = location.pathname.match(/\/inspector\/inspections\/([^/]+)\/report/);
  var requestId = match ? decodeURIComponent(match[1]) : null;
  if (!requestId) { app.innerHTML = '<div class="portal-card"><p>Bad URL.</p></div>'; return; }

  var D = null;              // full GET payload
  var itemsMap = {};         // itemKey -> row (local working copy)
  var sectionsMap = {};      // sectionKey -> row
  var photosByItem = {};     // itemKey|'' -> [photo]
  var baseSeq = 0;
  var locked = false;

  var dirty = { report: {}, sections: {}, items: {} };
  var saveTimer = null;
  var saving = false;
  var queued = false;
  var retryDelay = 2000;
  var retryTimer = null;

  /* ============================ boot ============================ */

  I.requireAuth(app, function () { load(); });

  function load() {
    I.api("/api/inspector/reports/" + encodeURIComponent(requestId)).then(function (r) {
      if (r.status === 404) { renderStartPanel(r.body.error && r.body.error.message); return; }
      if (!r.ok) { app.innerHTML = '<div class="portal-card"><p style="color:var(--red);">' + I.esc((r.body.error && r.body.error.message) || "Could not load.") + "</p></div>"; return; }
      D = r.body;
      baseSeq = D.report.autosave_seq;
      locked = D.report.state === "published";
      itemsMap = {};
      (D.items || []).forEach(function (it) { itemsMap[it.item_key] = it; });
      sectionsMap = {};
      (D.sections || []).forEach(function (s) { sectionsMap[s.section_key] = s; });
      photosByItem = {};
      (D.photos || []).forEach(function (p) {
        var k = p.itemKey || "";
        (photosByItem[k] = photosByItem[k] || []).push(p);
      });
      render();
    });
  }

  function renderStartPanel(message) {
    app.innerHTML = '<div class="portal-card"><h2>No report yet</h2>' +
      '<p style="color:var(--text-2);margin-bottom:14px;">' + I.esc(message || "Start the inspection to create the report draft.") + "</p>" +
      '<button class="btn btn-primary" id="startBtn" type="button">Start inspection</button>' +
      '<p class="form-status" id="startStatus" role="status"></p></div>';
    document.getElementById("startBtn").addEventListener("click", function () {
      var btn = this;
      btn.disabled = true;
      document.getElementById("startStatus").textContent = "Creating the report draft…";
      I.api("/api/inspector/inspections", { method: "POST", body: { requestId: requestId } }).then(function (r) {
        if (r.ok) { load(); return; }
        btn.disabled = false;
        document.getElementById("startStatus").textContent = (r.body.error && r.body.error.message) || "Could not start.";
      });
    });
  }

  /* ============================ save engine ============================ */

  function setSaveState(state, text) {
    saveStateEl.setAttribute("data-state", state);
    saveStateEl.textContent = text;
  }

  function hasDirty() {
    return Object.keys(dirty.report).length > 0 || Object.keys(dirty.sections).length > 0 || Object.keys(dirty.items).length > 0;
  }

  function markDirty(kind, key, patch) {
    if (locked) return;
    if (kind === "report") Object.assign(dirty.report, patch);
    else {
      dirty[kind][key] = Object.assign(dirty[kind][key] || {}, patch);
    }
    setSaveState("saving", "Saving…");
    scheduleSave();
    updateProgress();
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 1100);
  }

  function buildPayload() {
    var payload = { baseSeq: baseSeq };
    if (Object.keys(dirty.report).length) payload.report = dirty.report;
    var secs = Object.keys(dirty.sections);
    if (secs.length) {
      payload.sections = secs.map(function (k) {
        var s = sectionsMap[k] || {};
        return { sectionKey: k, performed: s.performed || "performed", notPerformedReason: s.not_performed_reason || null, summaryNote: s.summary_note || null };
      });
    }
    var keys = Object.keys(dirty.items).slice(0, 50);
    if (keys.length) {
      payload.items = keys.map(function (k) {
        var it = itemsMap[k];
        return {
          itemKey: k,
          result: it.result || null,
          notInspectedReason: it.not_inspected_reason || null,
          inspectorNotes: it.inspector_notes || null,
          customerNote: it.customer_note || null,
          measurementValue: it.measurement_value || null,
          measurementUnit: it.measurement_unit || null,
          costLowCents: it.cost_low_cents,
          costHighCents: it.cost_high_cents,
          priority: it.priority || null,
          safetyCritical: !!it.safety_critical,
          negotiationItem: !!it.negotiation_item
        };
      });
      payload._itemKeys = keys;
    }
    return payload;
  }

  function flushSave() {
    if (saving) { queued = true; return; }
    if (!hasDirty()) { setSaveState("saved", "Saved"); return; }
    saving = true;
    var payload = buildPayload();
    var sentReport = payload.report ? payload.report : null;
    var sentSections = payload.sections ? payload.sections.map(function (s) { return s.sectionKey; }) : [];
    var sentItems = payload._itemKeys || [];
    delete payload._itemKeys;

    setSaveState("saving", "Saving…");
    I.api("/api/inspector/reports/" + encodeURIComponent(requestId) + "/save", { method: "POST", body: payload })
      .then(function (r) {
        saving = false;
        if (r.ok) {
          baseSeq = r.body.seq;
          retryDelay = 2000;
          if (sentReport) dirty.report = {};
          sentSections.forEach(function (k) { delete dirty.sections[k]; });
          sentItems.forEach(function (k) { delete dirty.items[k]; });
          if (hasDirty() || queued) { queued = false; flushSave(); return; }
          setSaveState("saved", "Saved");
          return;
        }
        if (r.status === 409) {
          setSaveState("failed", "Save conflict");
          showConflict((r.body.error && r.body.error.message) || "Saved from another device — reload.");
          return;
        }
        if (r.status === 423) {
          locked = true;
          setSaveState("failed", "Locked");
          alert("This report is published. Create an amendment to edit it.");
          load();
          return;
        }
        setSaveState("failed", "Save failed");
        scheduleRetry();
      })
      .catch(function () {
        saving = false;
        setSaveState("offline", navigator.onLine === false ? "Offline — will retry" : "Retrying…");
        scheduleRetry();
      });
  }

  function scheduleRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(function () {
      retryDelay = Math.min(retryDelay * 1.8, 30000);
      flushSave();
    }, retryDelay);
  }

  window.addEventListener("online", function () { if (hasDirty()) flushSave(); });
  window.addEventListener("beforeunload", function (e) {
    if (hasDirty() || saving) { e.preventDefault(); e.returnValue = ""; }
  });

  function showConflict(msg) {
    var modal = document.createElement("div");
    modal.className = "publish-modal";
    modal.innerHTML = '<div class="box"><h2>Report changed elsewhere</h2><p style="color:var(--text-2);margin:12px 0;">' + I.esc(msg) + "</p>" +
      '<button class="btn btn-primary" type="button">Reload this report</button></div>';
    modal.querySelector("button").addEventListener("click", function () { location.reload(); });
    document.body.appendChild(modal);
  }

  /* ============================ rendering ============================ */

  function getItem(key, sectionKey) {
    if (!itemsMap[key]) {
      itemsMap[key] = {
        item_key: key, section_key: sectionKey || key.split(".")[0], result: null, not_inspected_reason: null,
        inspector_notes: null, customer_note: null, measurement_value: null, measurement_unit: null,
        cost_low_cents: null, cost_high_cents: null, priority: null, safety_critical: 0, negotiation_item: 0
      };
    }
    return itemsMap[key];
  }

  function sectionProgress(sec) {
    var s = sectionsMap[sec.key];
    if (s && s.performed === "not_performed") return { done: sec.items.length, total: sec.items.length, skipped: true, flags: 0 };
    var done = 0, flags = 0;
    sec.items.forEach(function (d) {
      var it = itemsMap[d.key];
      if (it && it.result) done++;
      if (it && (it.result === "fail" || it.result === "attention")) flags++;
    });
    return { done: done, total: sec.items.length, skipped: false, flags: flags };
  }

  function updateProgress() {
    var done = 0, total = 0;
    (D.template.sections || []).forEach(function (sec) {
      var p = sectionProgress(sec);
      total += p.total;
      done += p.done;
      var head = document.querySelector('[data-sec-head="' + sec.key + '"]');
      if (head) {
        head.innerHTML = p.skipped
          ? '<span class="rsec-flag">skipped</span>'
          : (p.flags ? '<span class="rsec-flag">' + p.flags + " ⚑</span> " : "") +
            '<span class="' + (p.done === p.total ? "rsec-done" : "") + '">' + p.done + "/" + p.total + "</span>";
      }
    });
    saveProgressEl.textContent = done + "/" + total + " items";
  }

  function fmtDollars(cents) { return cents == null ? "" : String(Math.round(cents / 100)); }

  function render() {
    var ctx = D.context;
    document.getElementById("headRef").textContent = ctx.ref;
    savebar.hidden = false;
    bottomBar.hidden = false;
    previewBtn.href = "/inspector/inspections/" + encodeURIComponent(requestId) + "/report/preview";

    var html = "";

    // state banner
    var versionCount = (D.versions || []).length;
    if (locked) {
      html += '<div class="state-banner" data-tone="published">Published (version ' + versionCount + ") — the customer can see this report. Create an amendment to make corrections." +
        ' <button class="btn btn-sm btn-ghost" id="amendBtn" type="button">Create amendment</button></div>';
    } else if (versionCount > 0) {
      html += '<div class="state-banner" data-tone="amending">Amending — the customer still sees version ' + versionCount + " until you publish the amendment.</div>";
    }

    // context card
    html += '<section class="portal-card"><h2 style="margin-bottom:6px;">' +
      I.esc([ctx.year, ctx.make, ctx.model, ctx.trim].filter(Boolean).join(" ")) + "</h2>" +
      '<p class="insp-sub">' + I.esc(ctx.ref) + " · " + I.esc(ctx.customer_name) +
      (ctx.starts_at ? " · " + I.esc(I.when(ctx.starts_at)) : "") +
      (ctx.vin ? " · VIN " + I.esc(ctx.vin) : "") + "</p></section>";

    // visit info
    html += renderVisitCard();

    // checklist sections
    (D.template.sections || []).forEach(function (sec) { html += renderSection(sec); });

    // overall
    html += renderOverallCard();

    // versions
    if (versionCount > 0) {
      html += '<section class="portal-card"><h2>Version history</h2><div class="table-scroll"><table class="version-table"><thead><tr><th>V</th><th>Type</th><th>Status</th><th>Published</th></tr></thead><tbody>';
      (D.versions || []).forEach(function (v) {
        html += "<tr><td>" + v.version + "</td><td>" + I.esc(v.kind) + (v.amendment_reason ? " — " + I.esc(v.amendment_reason) : "") + "</td><td>" + I.esc(v.status) + "</td><td>" + I.esc(I.when(v.published_at)) + "</td></tr>";
      });
      html += "</tbody></table></div>" +
        '<p style="margin-top:10px;"><a class="btn btn-sm btn-ghost" id="pdfBtn" href="#">Download latest PDF</a></p></section>';
    }

    app.innerHTML = html;
    bindAll();
    buildJump();
    updateProgress();
    updateBottom();
    if (!hasDirty()) setSaveState("saved", "Saved");
  }

  function renderVisitCard() {
    var r = D.report;
    var vinChecks = [["matches", "Matches paperwork"], ["mismatch", "MISMATCH"], ["not_checked", "Not checked"]];
    return '<section class="portal-card rsec-visit"><h2>Inspection visit</h2>' +
      '<div class="mini-row"><div class="field"><label for="vInspectedAt">Inspection date &amp; time</label>' +
      '<input id="vInspectedAt" type="datetime-local" data-rfield="inspectedAt" value="' + I.esc(toLocalDT(r.inspected_at)) + '"' + dis() + " /></div>" +
      '<div class="field"><label for="vOdo">Odometer (miles)</label><input id="vOdo" type="text" inputmode="numeric" data-rfield="odometerMiles" value="' + I.esc(r.odometer_miles == null ? "" : r.odometer_miles) + '"' + dis() + " /></div></div>" +
      '<div class="mini-row"><div class="field"><label for="vPlate">Plate</label><input id="vPlate" type="text" data-rfield="plate" value="' + I.esc(r.plate || "") + '"' + dis() + " /></div>" +
      '<div class="field"><label for="vPlateState">Plate state</label><input id="vPlateState" type="text" maxlength="2" data-rfield="plateState" value="' + I.esc(r.plate_state || "") + '"' + dis() + " /></div></div>" +
      '<div class="field"><span style="display:block;font-size:13.5px;margin-bottom:6px;color:var(--text-2);">VIN check against paperwork</span><div class="chips" role="group" aria-label="VIN check">' +
      vinChecks.map(function (v) {
        return '<button type="button" class="chip' + (v[0] === "mismatch" ? " chip-danger" : "") + '" data-vincheck="' + v[0] + '" aria-pressed="' + (r.vin_check === v[0]) + '"' + dis() + ">" + v[1] + "</button>";
      }).join("") + "</div></div>" +
      '<div class="field"><label for="vVinObs">VIN observed on vehicle (if different)</label><input id="vVinObs" type="text" data-rfield="vinObserved" value="' + I.esc(r.vin_observed || "") + '"' + dis() + " /></div>" +
      '<div class="field"><label for="vTitle">Title / disclosure info (as reported by customer or seller)</label><textarea id="vTitle" data-rfield="titleDisclosureNotes"' + dis() + ">" + I.esc(r.title_disclosure_notes || "") + "</textarea></div>" +
      '<div class="field"><label for="vSeller">Seller / dealer notes</label><textarea id="vSeller" data-rfield="sellerNotes"' + dis() + ">" + I.esc(r.seller_notes || "") + "</textarea></div>" +
      "</section>";
  }

  function dis() { return locked ? " disabled" : ""; }

  function toLocalDT(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  var NI_REASONS = [["not_accessible", "Not accessible"], ["unsafe_to_test", "Unsafe to test"], ["seller_declined", "Seller declined"], ["equipment_unavailable", "Equipment unavailable"], ["not_supported", "Not supported"]];
  var SEC_REASONS = NI_REASONS.concat([["not_applicable", "Not applicable"]]);
  var RESULTS = [["pass", "Pass"], ["attention", "Attn"], ["fail", "Fail"], ["not_inspected", "Not insp."], ["not_applicable", "N/A"]];
  var PRIORITIES = [["immediate", "Immediate"], ["soon", "Soon"], ["monitor", "Monitor"], ["informational", "Info"]];

  function renderSection(sec) {
    var s = sectionsMap[sec.key] || {};
    var performed = s.performed || "performed";
    var html = '<div class="rsec" id="sec-' + sec.key + '" data-open="false"><button type="button" class="rsec-head" data-sec="' + sec.key + '" aria-expanded="false">' +
      '<span class="t">' + I.esc(sec.title) + "</span>" +
      '<span class="st"><span data-sec-head="' + sec.key + '"></span><span class="chev" aria-hidden="true">▾</span></span></button>' +
      '<div class="rsec-body">';

    if (sec.conditional) {
      html += '<div class="rsec-tools"><div class="field" style="margin:0;flex:1;min-width:200px;">' +
        '<label for="perf-' + sec.key + '">Section status</label>' +
        '<select id="perf-' + sec.key + '" data-sec-perf="' + sec.key + '"' + dis() + ">" +
        '<option value="performed"' + (performed === "performed" ? " selected" : "") + ">Performed</option>" +
        '<option value="partial"' + (performed === "partial" ? " selected" : "") + ">Partially performed</option>" +
        '<option value="not_performed"' + (performed === "not_performed" ? " selected" : "") + ">Not performed</option></select></div>" +
        '<div class="field" style="margin:0;flex:1;min-width:200px;"' + (performed === "performed" ? " hidden" : "") + ' data-sec-reason-wrap="' + sec.key + '">' +
        '<label for="reason-' + sec.key + '">Reason</label>' +
        '<select id="reason-' + sec.key + '" data-sec-reason="' + sec.key + '"' + dis() + '><option value="">Choose…</option>' +
        SEC_REASONS.map(function (r) { return '<option value="' + r[0] + '"' + (s.not_performed_reason === r[0] ? " selected" : "") + ">" + r[1] + "</option>"; }).join("") +
        "</select></div></div>";
      if (sec.conditionNote) html += '<p class="ritem-hint" style="margin:6px 0 0;">' + I.esc(sec.conditionNote) + "</p>";
    }

    html += '<div class="field" style="margin-top:10px;"><label for="ssum-' + sec.key + '">Section summary for the customer (optional)</label>' +
      '<textarea id="ssum-' + sec.key + '" data-sec-sum="' + sec.key + '"' + dis() + ">" + I.esc(s.summary_note || "") + "</textarea></div>";

    if (!locked) {
      html += '<div class="rsec-tools"><span style="font-size:13px;color:var(--text-3);align-self:center;">Mark remaining:</span>' +
        '<button type="button" class="btn btn-sm btn-ghost" data-bulk="pass" data-bulk-sec="' + sec.key + '">Pass</button>' +
        '<button type="button" class="btn btn-sm btn-ghost" data-bulk="not_inspected" data-bulk-sec="' + sec.key + '">Not inspected…</button></div>';
    }

    sec.items.forEach(function (d) { html += renderItem(sec, d); });
    html += "</div></div>";
    return html;
  }

  function renderItem(sec, d) {
    var it = itemsMap[d.key] || {};
    var html = '<div class="ritem" data-item="' + d.key + '" data-result="' + (it.result || "") + '">' +
      '<div class="ritem-label">' + I.esc(d.label) + "</div>" +
      (d.hint ? '<div class="ritem-hint">' + I.esc(d.hint) + "</div>" : "") +
      '<div class="seg" role="group" aria-label="' + I.esc(d.label) + ' result">' +
      RESULTS.map(function (r) {
        return '<button type="button" class="seg-btn" data-val="' + r[0] + '" data-seg="' + d.key + '" aria-pressed="' + (it.result === r[0]) + '"' + dis() + ">" + r[1] + "</button>";
      }).join("") + "</div>";

    html += '<button type="button" class="ritem-more" data-more="' + d.key + '" aria-expanded="false">Details, notes &amp; photos ▾</button>';
    html += '<div class="ritem-detail">';

    // not-inspected reason
    html += '<div class="field" data-ni-wrap="' + d.key + '"' + (it.result === "not_inspected" ? "" : " hidden") + ">" +
      '<label for="ni-' + d.key + '">Why not inspected?</label><select id="ni-' + d.key + '" data-ni="' + d.key + '"' + dis() + '><option value="">Choose…</option>' +
      NI_REASONS.map(function (r) { return '<option value="' + r[0] + '"' + (it.not_inspected_reason === r[0] ? " selected" : "") + ">" + r[1] + "</option>"; }).join("") +
      "</select></div>";

    // measurement
    if (d.measurement) {
      html += '<div class="mini-row"><div class="field"><label for="mv-' + d.key + '">' + I.esc(d.measurement.label || "Measurement") + "</label>" +
        '<input id="mv-' + d.key + '" type="text" inputmode="decimal" data-meas="' + d.key + '" value="' + I.esc(it.measurement_value || "") + '"' + dis() + " /></div>" +
        '<div class="field"><label for="mu-' + d.key + '">Unit</label><input id="mu-' + d.key + '" type="text" data-measu="' + d.key + '" value="' + I.esc(it.measurement_unit || d.measurement.unit) + '"' + dis() + " /></div></div>";
    }

    // notes
    html += '<div class="field"><label for="cn-' + d.key + '">Customer-facing explanation</label><textarea id="cn-' + d.key + '" data-cnote="' + d.key + '"' + dis() + ">" + I.esc(it.customer_note || "") + "</textarea></div>" +
      '<div class="field"><label for="in-' + d.key + '">Inspector notes (internal only)</label><textarea id="in-' + d.key + '" data-inote="' + d.key + '"' + dis() + ">" + I.esc(it.inspector_notes || "") + "</textarea></div>";

    // costs
    html += '<div class="mini-row"><div class="field"><label for="cl-' + d.key + '">Est. repair cost low ($)</label>' +
      '<input id="cl-' + d.key + '" type="text" inputmode="numeric" data-clow="' + d.key + '" value="' + fmtDollars(it.cost_low_cents) + '"' + dis() + " /></div>" +
      '<div class="field"><label for="ch-' + d.key + '">Est. repair cost high ($)</label>' +
      '<input id="ch-' + d.key + '" type="text" inputmode="numeric" data-chigh="' + d.key + '" value="' + fmtDollars(it.cost_high_cents) + '"' + dis() + " /></div></div>";

    // priority + flags
    html += '<div class="field"><span style="display:block;font-size:13.5px;margin-bottom:6px;color:var(--text-2);">Repair priority</span><div class="chips" role="group">' +
      PRIORITIES.map(function (p) {
        return '<button type="button" class="chip" data-pri="' + p[0] + '" data-pri-item="' + d.key + '" aria-pressed="' + (it.priority === p[0]) + '"' + dis() + ">" + p[1] + "</button>";
      }).join("") + "</div></div>" +
      '<div class="flag-row"><button type="button" class="chip chip-danger" data-flag="safety_critical" data-flag-item="' + d.key + '" aria-pressed="' + !!it.safety_critical + '"' + dis() + ">⚠ Safety critical</button>" +
      '<button type="button" class="chip" data-flag="negotiation_item" data-flag-item="' + d.key + '" aria-pressed="' + !!it.negotiation_item + '"' + dis() + ">$ Negotiation item</button></div>";

    // photos
    html += '<div class="photo-row" data-photos="' + d.key + '"></div>';
    if (D.uploadsEnabled && !locked) {
      html += '<p style="margin-top:8px;"><label class="btn btn-sm btn-ghost photo-add">📷 Add photo<input type="file" accept="image/*" capture="environment" data-photo-input="' + d.key + '" hidden /></label></p>';
    } else if (!D.uploadsEnabled) {
      html += '<p class="ritem-hint" style="margin-top:6px;">Photo storage is off until R2 is enabled (report works without photos).</p>';
    }

    html += "</div></div>";
    return html;
  }

  function renderOverallCard() {
    var r = D.report;
    var verdicts = [["proceed", "Proceed"], ["negotiate_repair_first", "Negotiate / Repair First"], ["do_not_proceed", "Do Not Proceed"]];
    return '<section class="portal-card" id="sec-overall"><h2>Overall assessment</h2>' +
      '<div class="field"><label for="score">Overall condition score (1–10)</label>' +
      '<div class="score-input"><input id="score" type="range" min="1" max="10" step="0.5" value="' + (r.score == null ? 7 : r.score) + '"' + dis() + " />" +
      '<span class="score-val" id="scoreVal">' + (r.score == null ? "—" : r.score) + "</span></div></div>" +
      '<div class="field"><span style="display:block;font-size:13.5px;margin-bottom:6px;color:var(--text-2);">Verdict</span><div class="verdict-pick" role="group" aria-label="Verdict">' +
      verdicts.map(function (v) {
        return '<button type="button" class="verdict-btn" data-verdict="' + v[0] + '" data-val="' + v[0] + '" aria-pressed="' + (r.verdict === v[0]) + '"' + dis() + ">" + v[1] + "</button>";
      }).join("") + "</div>" +
      '<p class="ritem-hint" style="margin-top:6px;">The verdict is an opinion for the buyer’s decision — never a guarantee of condition.</p></div>' +
      '<div class="field"><label for="exec">Executive summary (customer-facing)</label><textarea id="exec" data-rfield="executiveSummary" style="min-height:110px;"' + dis() + ">" + I.esc(r.executive_summary || "") + "</textarea></div>" +
      '<div class="field"><label for="pos">Positive findings</label><textarea id="pos" data-rfield="positiveFindings"' + dis() + ">" + I.esc(r.positive_findings || "") + "</textarea></div>" +
      '<div class="field"><label for="neg">Negotiation summary</label><textarea id="neg" data-rfield="negotiationSummary"' + dis() + ">" + I.esc(r.negotiation_summary || "") + "</textarea></div>" +
      '<div class="field"><label for="lim">Additional limitations for this inspection (standard disclosures are always included)</label><textarea id="lim" data-rfield="limitationsNotes"' + dis() + ">" + I.esc(r.limitations_notes || "") + "</textarea></div>" +
      "</section>";
  }

  /* ============================ bindings ============================ */

  function bindAll() {
    // section collapse
    app.querySelectorAll(".rsec-head").forEach(function (head) {
      head.addEventListener("click", function () {
        var sec = head.closest(".rsec");
        var open = sec.getAttribute("data-open") === "true";
        sec.setAttribute("data-open", open ? "false" : "true");
        head.setAttribute("aria-expanded", open ? "false" : "true");
      });
    });

    // item detail toggle
    app.querySelectorAll("[data-more]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var item = btn.closest(".ritem");
        var open = item.getAttribute("data-detail") === "true";
        item.setAttribute("data-detail", open ? "false" : "true");
        btn.setAttribute("aria-expanded", open ? "false" : "true");
        if (!open) loadPhotoThumbs(btn.getAttribute("data-more"));
      });
    });

    // segmented results
    app.querySelectorAll("[data-seg]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-seg");
        var val = btn.getAttribute("data-val");
        var it = getItem(key, keySection(key));
        it.result = it.result === val ? null : val;
        var wrap = btn.closest(".ritem");
        wrap.setAttribute("data-result", it.result || "");
        wrap.querySelectorAll("[data-seg]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-val") === it.result)); });
        var niWrap = wrap.querySelector('[data-ni-wrap="' + cssEsc(key) + '"]');
        if (niWrap) niWrap.hidden = it.result !== "not_inspected";
        if (it.result !== "not_inspected") it.not_inspected_reason = null;
        markDirty("items", key, {});
      });
    });

    // per-item fields
    bindInput("[data-ni]", "change", function (el, key) { getItem(key).not_inspected_reason = el.value || null; });
    bindInput("[data-meas]", "input", function (el, key) { getItem(key).measurement_value = el.value; });
    bindInput("[data-measu]", "input", function (el, key) { getItem(key).measurement_unit = el.value; });
    bindInput("[data-cnote]", "input", function (el, key) { getItem(key).customer_note = el.value; });
    bindInput("[data-inote]", "input", function (el, key) { getItem(key).inspector_notes = el.value; });
    bindInput("[data-clow]", "input", function (el, key) { getItem(key).cost_low_cents = dollarsToCents(el.value); });
    bindInput("[data-chigh]", "input", function (el, key) { getItem(key).cost_high_cents = dollarsToCents(el.value); });

    // priority chips
    app.querySelectorAll("[data-pri-item]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-pri-item");
        var val = btn.getAttribute("data-pri");
        var it = getItem(key);
        it.priority = it.priority === val ? null : val;
        btn.closest(".chips").querySelectorAll("[data-pri-item]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-pri") === it.priority)); });
        markDirty("items", key, {});
      });
    });

    // flags
    app.querySelectorAll("[data-flag-item]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.getAttribute("data-flag-item");
        var flag = btn.getAttribute("data-flag");
        var it = getItem(key);
        it[flag] = it[flag] ? 0 : 1;
        btn.setAttribute("aria-pressed", String(!!it[flag]));
        markDirty("items", key, {});
      });
    });

    // report-level fields
    app.querySelectorAll("[data-rfield]").forEach(function (el) {
      el.addEventListener(el.tagName === "SELECT" ? "change" : "input", function () {
        var f = el.getAttribute("data-rfield");
        var v = el.value;
        if (f === "odometerMiles") v = v === "" ? null : Number(String(v).replace(/[^\d]/g, ""));
        if (f === "inspectedAt") v = v ? new Date(v).toISOString() : null;
        var patch = {};
        patch[f] = v;
        markDirty("report", null, patch);
      });
    });

    // VIN check chips
    app.querySelectorAll("[data-vincheck]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var val = btn.getAttribute("data-vincheck");
        app.querySelectorAll("[data-vincheck]").forEach(function (b) { b.setAttribute("aria-pressed", String(b === btn)); });
        markDirty("report", null, { vinCheck: val });
      });
    });

    // score + verdict
    var score = document.getElementById("score");
    if (score) {
      score.addEventListener("input", function () {
        document.getElementById("scoreVal").textContent = score.value;
        markDirty("report", null, { score: Number(score.value) });
      });
    }
    app.querySelectorAll("[data-verdict]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        app.querySelectorAll("[data-verdict]").forEach(function (b) { b.setAttribute("aria-pressed", String(b === btn)); });
        markDirty("report", null, { verdict: btn.getAttribute("data-verdict") });
      });
    });

    // section performed / reason / summary
    app.querySelectorAll("[data-sec-perf]").forEach(function (el) {
      el.addEventListener("change", function () {
        var key = el.getAttribute("data-sec-perf");
        var s = sectionsMap[key] = sectionsMap[key] || { section_key: key };
        s.performed = el.value;
        var wrap = app.querySelector('[data-sec-reason-wrap="' + cssEsc(key) + '"]');
        if (wrap) wrap.hidden = el.value === "performed";
        if (el.value === "performed") s.not_performed_reason = null;
        markDirty("sections", key, {});
        updateProgress();
      });
    });
    app.querySelectorAll("[data-sec-reason]").forEach(function (el) {
      el.addEventListener("change", function () {
        var key = el.getAttribute("data-sec-reason");
        var s = sectionsMap[key] = sectionsMap[key] || { section_key: key };
        s.not_performed_reason = el.value || null;
        markDirty("sections", key, {});
      });
    });
    app.querySelectorAll("[data-sec-sum]").forEach(function (el) {
      el.addEventListener("input", function () {
        var key = el.getAttribute("data-sec-sum");
        var s = sectionsMap[key] = sectionsMap[key] || { section_key: key };
        s.summary_note = el.value;
        markDirty("sections", key, {});
      });
    });

    // bulk actions
    app.querySelectorAll("[data-bulk]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var secKey = btn.getAttribute("data-bulk-sec");
        var mode = btn.getAttribute("data-bulk");
        var sec = findSection(secKey);
        if (!sec) return;
        var reason = null;
        if (mode === "not_inspected") {
          reason = prompt("Reason for the remaining items (type one):\nnot_accessible / unsafe_to_test / seller_declined / equipment_unavailable / not_supported", "not_accessible");
          var valid = ["not_accessible", "unsafe_to_test", "seller_declined", "equipment_unavailable", "not_supported"];
          if (!reason || valid.indexOf(reason.trim()) === -1) return;
          reason = reason.trim();
        }
        sec.items.forEach(function (d) {
          var it = getItem(d.key, secKey);
          if (!it.result) {
            it.result = mode;
            if (mode === "not_inspected") it.not_inspected_reason = reason;
            markDirty("items", d.key, {});
          }
        });
        rerenderSectionItems(secKey);
      });
    });

    // photo inputs
    app.querySelectorAll("[data-photo-input]").forEach(function (input) {
      input.addEventListener("change", function () {
        if (input.files && input.files[0]) uploadPhoto(input.getAttribute("data-photo-input"), input.files[0], input);
      });
    });

    // amend
    var amendBtn = document.getElementById("amendBtn");
    if (amendBtn) {
      amendBtn.addEventListener("click", function () {
        var reason = prompt("Reason for the amendment (shown in the version history):");
        if (!reason || reason.trim().length < 5) return;
        I.api("/api/inspector/reports/" + encodeURIComponent(requestId) + "/amend", { method: "POST", body: { reason: reason.trim() } }).then(function (r) {
          if (r.ok) load();
          else alert((r.body.error && r.body.error.message) || "Could not open the amendment.");
        });
      });
    }

    // PDF
    var pdfBtn = document.getElementById("pdfBtn");
    if (pdfBtn) {
      pdfBtn.addEventListener("click", function (e) {
        e.preventDefault();
        I.apiBlob("/api/inspector/reports/" + encodeURIComponent(requestId) + "/pdf").then(function (blob) {
          var a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "AutoClarity-Report-" + D.context.ref + ".pdf";
          a.click();
        }).catch(function () { alert("PDF not available yet."); });
      });
    }
  }

  function bindInput(selector, event, apply) {
    var attr = selector.slice(1, -1); // "[data-ni]" -> "data-ni"
    app.querySelectorAll(selector).forEach(function (el) {
      el.addEventListener(event, function () {
        var key = el.getAttribute(attr);
        apply(el, key);
        markDirty("items", key, {});
      });
    });
  }

  function keySection(itemKey) { return itemKey.split(".")[0]; }
  function cssEsc(s) { return s.replace(/"/g, '\\"'); }
  function dollarsToCents(v) {
    var n = Number(String(v || "").replace(/[^\d.]/g, ""));
    if (!isFinite(n) || v === "" || v == null) return null;
    return Math.round(n * 100);
  }
  function findSection(key) {
    var out = null;
    (D.template.sections || []).forEach(function (s) { if (s.key === key) out = s; });
    return out;
  }

  function rerenderSectionItems(secKey) {
    var sec = findSection(secKey);
    var wrap = document.getElementById("sec-" + secKey);
    if (!sec || !wrap) return;
    sec.items.forEach(function (d) {
      var it = itemsMap[d.key];
      var el = wrap.querySelector('.ritem[data-item="' + cssEsc(d.key) + '"]');
      if (!el || !it) return;
      el.setAttribute("data-result", it.result || "");
      el.querySelectorAll("[data-seg]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-val") === it.result)); });
      var ni = el.querySelector("[data-ni]");
      if (ni) ni.value = it.not_inspected_reason || "";
      var niWrap = el.querySelector('[data-ni-wrap="' + cssEsc(d.key) + '"]');
      if (niWrap) niWrap.hidden = it.result !== "not_inspected";
    });
    updateProgress();
  }

  /* ============================ photos ============================ */

  var thumbLoaded = {};
  function loadPhotoThumbs(itemKey) {
    var row = app.querySelector('[data-photos="' + cssEsc(itemKey) + '"]');
    if (!row) return;
    var photos = photosByItem[itemKey] || [];
    photos.forEach(function (p) {
      if (thumbLoaded[p.id]) return;
      thumbLoaded[p.id] = true;
      addThumb(row, itemKey, p);
    });
  }

  function addThumb(row, itemKey, p) {
    var fig = document.createElement("div");
    fig.className = "photo-thumb";
    fig.innerHTML = '<img alt="' + I.esc(p.caption || "Report photo") + '" />' +
      (!locked ? '<button type="button" class="del" aria-label="Remove photo">×</button>' : "") +
      '<div class="cap">' + I.esc(p.caption || "") + "</div>";
    row.appendChild(fig);
    I.apiBlob("/api/inspector/reports/" + encodeURIComponent(requestId) + "/photos/" + encodeURIComponent(p.id))
      .then(function (blob) { fig.querySelector("img").src = URL.createObjectURL(blob); })
      .catch(function () { fig.querySelector(".cap").textContent = "(photo unavailable)"; });
    var del = fig.querySelector(".del");
    if (del) {
      del.addEventListener("click", function () {
        if (!confirm("Remove this photo from the report?")) return;
        I.api("/api/inspector/reports/" + encodeURIComponent(requestId) + "/photos/" + encodeURIComponent(p.id), { method: "DELETE" }).then(function (r) {
          if (r.ok) {
            fig.remove();
            photosByItem[itemKey] = (photosByItem[itemKey] || []).filter(function (x) { return x.id !== p.id; });
          } else alert((r.body.error && r.body.error.message) || "Could not remove.");
        });
      });
    }
  }

  function uploadPhoto(itemKey, file, input) {
    setSaveState("saving", "Uploading photo…");
    downscaleJpeg(file).then(function (blob) {
      var fd = new FormData();
      fd.append("file", blob, "photo.jpg");
      fd.append("itemKey", itemKey);
      var caption = prompt("Caption for this photo (optional):") || "";
      if (caption) fd.append("caption", caption.slice(0, 200));
      return I.api("/api/inspector/reports/" + encodeURIComponent(requestId) + "/photos", { method: "POST", body: fd });
    }).then(function (r) {
      input.value = "";
      if (!r || !r.ok) {
        setSaveState("failed", "Photo failed");
        alert((r && r.body.error && r.body.error.message) || "Photo upload failed.");
        return;
      }
      setSaveState("saved", "Saved");
      var p = { id: r.body.id, itemKey: itemKey, caption: r.body.caption };
      (photosByItem[itemKey] = photosByItem[itemKey] || []).push(p);
      var row = app.querySelector('[data-photos="' + cssEsc(itemKey) + '"]');
      if (row) { thumbLoaded[p.id] = true; addThumb(row, itemKey, p); }
    }).catch(function () {
      input.value = "";
      setSaveState("failed", "Photo failed");
      alert("Photo upload failed — check the connection and retry.");
    });
  }

  /** Downscale to ≤1600px JPEG (~quality .82) client-side: sensible mobile
      upload sizes AND guarantees JPEG so the PDF can embed it. */
  function downscaleJpeg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var maxDim = 1600;
          var scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
          var canvas = document.createElement("canvas");
          canvas.width = Math.round(img.naturalWidth * scale);
          canvas.height = Math.round(img.naturalHeight * scale);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            if (blob) resolve(blob);
            else reject(new Error("encode failed"));
          }, "image/jpeg", 0.82);
        } catch (e) { reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); }; // fall back to the original
      img.src = url;
    });
  }

  /* ============================ jump + bottom bar ============================ */

  function buildJump() {
    var opts = '<option value="">Jump to section…</option><option value="sec-overall">Overall assessment</option>';
    (D.template.sections || []).forEach(function (sec) {
      opts += '<option value="sec-' + sec.key + '">' + I.esc(sec.title) + "</option>";
    });
    jumpSelect.innerHTML = opts;
    jumpSelect.addEventListener("change", function () {
      var el = document.getElementById(jumpSelect.value);
      if (el) {
        if (el.classList.contains("rsec")) {
          el.setAttribute("data-open", "true");
          var head = el.querySelector(".rsec-head");
          if (head) head.setAttribute("aria-expanded", "true");
        }
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      jumpSelect.value = "";
    });
  }

  function updateBottom() {
    var state = D.report.state;
    bottomState.innerHTML = '<span style="font-size:13px;color:var(--text-3);">State: <strong style="color:var(--text);">' +
      I.esc(String(D.displayState || state).replace(/_/g, " ")) + "</strong></span>";

    stateBtn.hidden = false;
    stateBtn.onclick = null;
    if (state === "in_progress") {
      stateBtn.textContent = "Mark draft complete";
      stateBtn.onclick = function () { moveState("draft_complete"); };
    } else if (state === "draft_complete") {
      stateBtn.textContent = "Ready for review";
      stateBtn.onclick = function () { moveState("ready_for_review"); };
    } else if (state === "ready_for_review") {
      stateBtn.textContent = "Reopen draft";
      stateBtn.onclick = function () { moveState("in_progress"); };
      previewBtn.textContent = "Preview & publish";
    } else {
      stateBtn.hidden = true;
      previewBtn.textContent = "View report";
    }
  }

  function moveState(to) {
    flushSave();
    I.api("/api/inspector/reports/" + encodeURIComponent(requestId) + "/state", { method: "POST", body: { to: to } }).then(function (r) {
      if (r.ok) { D.report.state = to; updateBottom(); }
      else alert((r.body.error && r.body.error.message) || "Could not change the state.");
    });
  }
})();
