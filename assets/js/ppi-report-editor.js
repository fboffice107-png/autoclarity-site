/* Integrated single-owner fulfillment tool. Drafts are kept in memory until
   acknowledged by the server, never in localStorage. Optimistic sequence checks
   refuse conflicting saves; a conflict never silently replaces another draft. */
(function () {
  "use strict";
  var view = window.AutoClarityReportView;
  var esc = view.escape;
  var RESULTS = [["", "Choose result…"], ["pass", "Pass"], ["attention", "Attention"], ["fail", "Fail"], ["not_inspected", "Not inspected"], ["not_accessible", "Not accessible"], ["not_applicable", "Not applicable"]];
  var REASONS = [["", "Choose when applicable…"], ["not_accessible", "Not accessible"], ["unsafe_to_test", "Unsafe to test"], ["seller_declined", "Seller declined"], ["equipment_unavailable", "Equipment unavailable"], ["not_supported", "Not supported"], ["not_applicable", "Not applicable"]];
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function options(choices, value) { return choices.map(function (choice) { return '<option value="' + esc(choice[0]) + '"' + (choice[0] === (value || "") ? ' selected' : '') + '>' + esc(choice[1]) + '</option>'; }).join(""); }
  function localDate(value) { if (!value) return ""; var date = new Date(value); if (!Number.isFinite(date.getTime())) return ""; return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
  function notificationStatus(result) {
    var status = result.emailStatus || (result.notification && result.notification.emailStatus);
    var labels = {
      sent: "Report is available in the secure portal. Report Ready email sent to the email provider.",
      recorded: "Report is available in the secure portal. Report Ready email is recorded, but sending is not yet confirmed. Refresh Messages to verify.",
      pending: "Report is available in the secure portal. Its notification is pending. Use Verify delivery / retry notification, then check Messages before completion.",
      failed: "Report is available in the secure portal, but its Report Ready email failed. Open Messages to review and retry the existing email. Do not assume email delivery."
    };
    return { text: (labels[status] || "Report is available in the secure portal. Email status is not confirmed; refresh Messages to verify.") + (result.warning ? " " + String(result.warning) : ""), attention: status !== "sent" || !!result.warning };
  }
  function confirmation(options) {
    var dialog = document.createElement("dialog"), previousFocus = document.activeElement, settled = false, resolve;
    var answer = new Promise(function (finish) { resolve = finish; });
    dialog.className = "report-confirm-dialog";
    dialog.setAttribute("aria-labelledby", "reportConfirmTitle");
    dialog.setAttribute("aria-describedby", "reportConfirmDescription");
    dialog.innerHTML = '<form method="dialog"><h2 id="reportConfirmTitle">' + esc(options.title) + '</h2><p id="reportConfirmDescription">' + esc(options.text) + '</p>' +
      (options.reason ? '<div class="field"><label for="reportAmendReason">Reason for amendment — retained in version history</label><textarea id="reportAmendReason" rows="3" minlength="5" maxlength="2000" required></textarea><p id="reportConfirmError" class="report-error" role="alert"></p></div>' : '') +
      '<div class="report-actions"><button type="button" class="btn btn-ghost" data-confirm-cancel>Cancel</button><button type="submit" class="btn btn-primary">' + esc(options.label) + '</button></div></form>';
    function finish(value) {
      if (settled) return; settled = true;
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      dialog.remove();
      if (options.restoreFocus !== false && previousFocus && previousFocus.isConnected && !previousFocus.disabled && typeof previousFocus.focus === "function") previousFocus.focus();
      resolve(value);
    }
    dialog.querySelector("[data-confirm-cancel]").addEventListener("click", function () { finish(null); });
    dialog.querySelector("form").addEventListener("submit", function (event) {
      event.preventDefault();
      var reason = options.reason ? dialog.querySelector("textarea").value.trim() : null;
      if (options.reason && reason.length < 5) { dialog.querySelector("#reportConfirmError").textContent = "Enter at least five characters explaining the amendment."; dialog.querySelector("textarea").focus(); return; }
      finish(options.reason ? reason : true);
    });
    dialog.addEventListener("cancel", function (event) { event.preventDefault(); finish(null); });
    dialog.addEventListener("close", function () { finish(null); });
    dialog.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { event.preventDefault(); finish(null); }
      if (event.key === "Tab") {
        var controls = Array.from(dialog.querySelectorAll("button, textarea")), first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    document.body.appendChild(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else { dialog.setAttribute("open", ""); dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); }
    dialog.querySelector(options.reason ? "textarea" : "[data-confirm-cancel]").focus();
    return { answer: answer, cancel: function () { finish(null); } };
  }

  function mount(root, config) {
    var data = null, draft = null, seq = 0, dirty = 0, saved = 0, pending = null, timer = null, conflict = false, saveIssue = false, disposed = false, busy = false, photoDispose = null;
    var path = "/api/admin/reports/" + encodeURIComponent(config.requestId);
    var status = null;
    var previewOpen = false;
    var pendingConfirmation = null;
    async function ask(options) {
      if (pendingConfirmation) return null;
      // The caller restores its explicit trigger after re-enabling controls.
      // Capturing activeElement here can be too late: disabling moves focus.
      var modal = confirmation(Object.assign({}, options, { restoreFocus: false })); pendingConfirmation = modal.cancel;
      try { return await modal.answer; } finally { pendingConfirmation = null; }
    }
    function focusAfterAction(origin) {
      if (disposed) return;
      if (origin && origin.isConnected && !origin.disabled && !(origin.matches && origin.matches(":disabled")) && typeof origin.focus === "function") origin.focus();
      else { var heading = root.querySelector("#reportHeading"); if (heading) heading.focus(); }
    }
    function message(text, isError) { if (status) { status.textContent = text; status.classList.toggle("report-error", !!isError); } }
    function request(payload) {
      return config.api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).then(function (response) {
        if (!response.ok) {
          var error = new Error((response.body.error && response.body.error.message) || "Report action was not confirmed.");
          error.status = response.status; throw error;
        }
        return response.body;
      });
    }
    function accept(next, replaceDraft) {
      data = next; seq = next.report ? next.report.seq : 0;
      if (replaceDraft) { draft = copy(next.report ? next.report.draft : next.defaultDraft); dirty = 0; saved = 0; }
      if (config.onState) config.onState(next);
    }
    function updateControls() {
      root.querySelectorAll("[data-report-action], [data-add-finding], #reportUpload").forEach(function (button) { button.disabled = busy || conflict; });
      root.querySelectorAll("[data-remove-report-photo]").forEach(function (button) { button.disabled = busy || conflict; });
      var fields = root.querySelector("#reportFields");
      if (fields) fields.disabled = busy || conflict || (data && data.report && data.report.state !== "in_progress");
      root.querySelectorAll("#reportPhotoItem, #reportPhotoCaption, #reportPhotoFile").forEach(function (field) { field.disabled = busy || conflict; });
      var reload = root.querySelector("#reportReload"); if (reload) reload.hidden = !conflict;
      var recovery = root.querySelector("#reportRecovery"); if (recovery) recovery.hidden = !saveIssue;
    }
    function save() {
      clearTimeout(timer);
      if (disposed || conflict || !data || !data.report || dirty === saved) return Promise.resolve(!conflict);
      if (pending) return pending.then(function (ok) { return ok ? save() : false; });
      var saving = dirty, snapshot = copy(draft);
      message("Saving draft…");
      pending = request({ action: "save", seq: seq, draft: snapshot }).then(function (next) {
        if (disposed) return false;
        accept(next, false); saved = saving; saveIssue = false; updateControls();
        message(dirty === saved ? "All changes saved securely." : "Saving your latest changes…");
        return true;
      }).catch(function (error) {
        conflict = error.status === 409; saveIssue = true;
        message(conflict ? "Another session changed this report. Your edits are still on this screen. Download your recovery copy before reloading; no changes were overwritten." :
          error.status === 401 || error.status === 403 ? "Authorization expired. Your draft remains on this screen. Sign in to admin in another tab, then retry Save draft, or download a private recovery copy." :
          (error.message || "Connection lost. Your edits remain on this screen. Use Save draft to retry."), true);
        updateControls(); return false;
      }).finally(function () { pending = null; });
      return pending.then(function (ok) { return ok && dirty !== saved ? save() : ok; });
    }
    function changed() {
      dirty += 1; message("Unsaved changes — saving shortly…");
      if (previewOpen) { previewOpen = false; var preview = root.querySelector("#reportPreview"); if (preview) preview.hidden = true; }
      clearTimeout(timer); timer = setTimeout(save, 1000);
    }
    function setValue(element) {
      var sectionIndex = element.getAttribute("data-section"), itemIndex = element.getAttribute("data-item"), key = element.getAttribute("data-field");
      var target = sectionIndex === null ? draft : draft.sections[Number(sectionIndex)];
      if (itemIndex !== null) target = target.items[Number(itemIndex)];
      var value = element.type === "checkbox" ? element.checked : element.value;
      if (element.getAttribute("data-number") !== null) value = value === "" ? null : Number(value);
      if (key === "inspectedAt") value = value ? new Date(value).toISOString() : "";
      target[key] = value; changed();
    }
    function field(label, key, value, settings) {
      settings = settings || {}; var id = "report_" + (settings.section == null ? "" : settings.section + "_") + (settings.item == null ? "" : settings.item + "_") + key;
      var attributes = ' id="' + id + '" data-field="' + key + '"' + (settings.section == null ? '' : ' data-section="' + settings.section + '"') + (settings.item == null ? '' : ' data-item="' + settings.item + '"');
      var input;
      if (settings.choices) input = '<select' + attributes + '>' + options(settings.choices, value) + '</select>';
      else if (settings.checkbox) input = '<input type="checkbox"' + attributes + (value ? ' checked' : '') + ' />';
      else if (settings.type) input = '<input type="' + settings.type + '"' + attributes + ' value="' + esc(value) + '"' + (settings.type === "number" ? ' data-number inputmode="decimal"' + (settings.min == null ? '' : ' min="' + settings.min + '"') + (settings.max == null ? '' : ' max="' + settings.max + '"') + ' step="' + (settings.step || "1") + '"' : '') + ' />';
      else input = '<textarea' + attributes + ' rows="' + (settings.rows || 2) + '" maxlength="' + (settings.maxlength || 8000) + '">' + esc(value) + '</textarea>';
      return '<div class="field' + (settings.checkbox ? ' report-check' : '') + '">' + (settings.checkbox ? input : '') + '<label for="' + id + '">' + esc(label) + '</label>' + (settings.checkbox ? '' : input) + (settings.hint ? '<p class="field-hint">' + esc(settings.hint) + '</p>' : '') + '</div>';
    }
    function render() {
      if (photoDispose) photoDispose();
      var report = data.report, editable = report && report.state === "in_progress", reviewReady = report && report.state === "ready_for_review";
      var html = '<div class="report-workflow-head"><div><p class="report-eyebrow">Inspection fulfillment</p><h2 id="reportHeading" tabindex="-1">Inspection report</h2></div><span class="status-pill">' + esc(!report ? 'Not started' : report.state === 'in_progress' ? 'Draft' : report.state.replace(/_/g, ' ')) + '</span></div>';
      if (!report) {
        html += '<p>Create a report only for a confirmed, paid booking. Findings stay private until reviewed and published.</p><button class="btn btn-primary" type="button" data-report-action="start">Start inspection &amp; create draft</button><p class="form-status" id="reportSaveStatus" role="status" aria-live="polite"></p>';
        root.innerHTML = html; status = root.querySelector("#reportSaveStatus"); bind(); return;
      }
      html += '<p class="field-hint">Draft → review-ready → immutable publication &amp; secure delivery → completed. The customer continues seeing the previous published version while an amendment is prepared.</p>';
      if (report.publishedVersionId) html += '<p class="notice good">Published evidence is preserved. Current version: ' + esc((report.versions || []).find(function (v) { return v.id === report.publishedVersionId; })?.version || 'available') + '. Delivery uses the existing secure customer portal.</p>';
      if (report.publishedVersionId) {
        var delivery = notificationStatus({ emailStatus: report.delivery && report.delivery.emailStatus });
        html += '<p class="notice ' + (delivery.attention ? 'warn' : 'good') + '">' + esc(delivery.text) + '</p>';
      }
      html += '<div class="report-command-bar"><p class="form-status" id="reportSaveStatus" role="status" aria-live="polite">All changes saved securely.</p><div class="report-actions">' +
        (editable ? '<button class="btn btn-ghost btn-sm" type="button" data-report-action="save">Save draft</button>' : '') +
        '<button class="btn btn-ghost btn-sm" type="button" data-report-action="preview">Review customer preview</button>' +
        (editable ? '<button class="btn btn-primary btn-sm" type="button" data-report-action="review">Mark review-ready</button>' : '') +
        (reviewReady ? '<button class="btn btn-ghost btn-sm" type="button" data-report-action="reopen">Return to editing</button><button class="btn btn-primary btn-sm" type="button" data-report-action="publish">Publish &amp; deliver report</button>' : '') +
        (report.state === 'published' ? '<button class="btn btn-ghost btn-sm" type="button" data-report-action="amend">Create amendment</button><button class="btn btn-ghost btn-sm" type="button" data-report-action="deliver">Verify delivery / retry notification</button>' : '') +
        '</div><div class="report-actions"><button class="btn btn-ghost btn-sm" type="button" id="reportRecovery" hidden>Download unsaved recovery copy</button><button class="btn btn-ghost btn-sm" type="button" id="reportReload" hidden>Reload server draft</button></div></div>';
      html += '<div id="reportPreview" hidden tabindex="-1"></div><fieldset id="reportFields" class="report-fields"' + (!editable ? ' disabled' : '') + '><legend class="sr-only">Inspection report draft</legend>';
      html += '<details class="report-editor-section" open><summary>Inspector &amp; buyer guidance</summary><div class="report-form-grid">' +
        field("Inspector name", "inspectorName", draft.inspectorName, { type: "text" }) +
        field("Inspection time (this device’s local time)", "inspectedAt", localDate(draft.inspectedAt), { type: "datetime-local" }) +
        field("Observed odometer (miles)", "odometerMiles", draft.odometerMiles, { type: "number", min: 0, max: 9999999 }) +
        field("Inspector-assigned condition score (1–10)", "score", draft.score, { type: "number", min: 1, max: 10, step: 0.1 }) +
        field("Human-selected buyer guidance", "verdict", draft.verdict, { choices: [["", "Choose your recommendation…"], ["proceed", "Proceed"], ["negotiate_repair_first", "Negotiate / Repair First"], ["do_not_proceed", "Do Not Proceed"]], hint: "Never calculated from scores. Apply your professional judgment." }) + '</div>' +
        field("Executive summary & major concerns", "executiveSummary", draft.executiveSummary, { rows: 4, maxlength: 12000 }) +
        field("Positive findings", "positiveFindings", draft.positiveFindings, { maxlength: 12000 }) +
        field("Negotiation / repair / additional diagnostic considerations", "negotiationSummary", draft.negotiationSummary, { maxlength: 12000 }) +
        field("Access limitations & important notes", "limitationsNotes", draft.limitationsNotes, { hint: "Describe access, seller, scan and road-test restrictions honestly. Do not imply unperformed checks occurred." }) + '</details>';
      (draft.sections || []).forEach(function (section, s) {
        html += '<details class="report-editor-section"><summary>' + esc(section.title) + ' <span class="report-count">' + section.items.length + ' finding' + (section.items.length === 1 ? '' : 's') + '</span></summary><div class="report-form-grid">' +
          field("Category scope", "performed", section.performed, { section: s, choices: [["performed", "Performed"], ["partial", "Partially performed"], ["not_performed", "Not performed"]] }) +
          field("Scope limitation", "notPerformedReason", section.notPerformedReason, { section: s, choices: REASONS }) + '</div>' +
          field("Customer-visible category summary", "summary", section.summary, { section: s });
        section.items.forEach(function (item, i) {
          var at = { section: s, item: i };
          html += '<fieldset class="report-item"><legend>Finding ' + (i + 1) + '</legend>' +
            field("Finding / component", "label", item.label, Object.assign({}, at, { type: "text" })) + '<div class="report-form-grid">' +
            field("Inspection result", "result", item.result, Object.assign({}, at, { choices: RESULTS })) +
            field("Not-inspected / access reason", "notInspectedReason", item.notInspectedReason, Object.assign({}, at, { choices: REASONS })) +
            field("Priority", "priority", item.priority, Object.assign({}, at, { choices: [["", "Not specified"], ["immediate", "Immediate"], ["soon", "Soon"], ["monitor", "Monitor"], ["informational", "Informational"]] })) + '</div>' +
            field("Customer-visible findings", "customerNote", item.customerNote, at) +
            field("Private inspector notes — never included in the customer report", "internalNotes", item.internalNotes, at) + '<div class="report-form-grid">' +
            field("Safety-critical concern", "safetyCritical", item.safetyCritical, Object.assign({}, at, { checkbox: true })) +
            field("Negotiation consideration", "negotiationItem", item.negotiationItem, Object.assign({}, at, { checkbox: true })) + '</div></fieldset>';
        });
        html += '<button class="btn btn-ghost btn-sm" type="button" data-add-finding="' + s + '">Add finding to ' + esc(section.title) + '</button></details>';
      });
      html += '</fieldset><details class="report-editor-section" open><summary>Private inspection photos</summary><p class="field-hint">Only upload authorized vehicle photos. JPEG, PNG or WebP, up to 8 MiB each. Export HEIC as JPEG first. Published evidence cannot be replaced or deleted.</p>';
      if (editable) {
        var choices = [];
        (draft.sections || []).forEach(function (section) { section.items.forEach(function (item) { choices.push([item.key, section.title + ' · ' + (item.label || 'Untitled finding')]); }); });
        html += '<div class="report-form-grid"><div class="field"><label for="reportPhotoItem">Attach to finding</label><select id="reportPhotoItem">' + options(choices, '') + '</select></div><div class="field"><label for="reportPhotoCaption">Customer-visible photo caption</label><input id="reportPhotoCaption" type="text" maxlength="1000" /></div><div class="field"><label for="reportPhotoFile">Inspection photo</label><input id="reportPhotoFile" type="file" accept="image/jpeg,image/png,image/webp" /></div></div><button class="btn btn-ghost" id="reportUpload" type="button">Upload private photo</button>';
      }
      html += '<div class="report-photo-grid">' + (report.photos || []).map(function (photo) {
        return '<figure class="report-photo"><img data-report-photo="' + esc(photo.id) + '" alt="' + esc(photo.caption || 'Inspection photograph') + '" loading="lazy" /><figcaption>' + esc(photo.caption || 'Inspection photograph') + '</figcaption><span class="report-photo-state" role="status">Loading private photo…</span>' +
          (editable && photo.referenced === false ? '<button type="button" class="btn btn-ghost btn-sm" data-remove-report-photo="' + esc(photo.id) + '" aria-label="Remove unpublished photo: ' + esc(photo.caption || 'inspection photograph') + '">Remove unpublished photo</button>' : '<p class="field-hint">' + (photo.referenced ? 'Preserved published evidence — removal is not allowed.' : 'Return to editing to remove an unpublished photo.') + '</p>') + '</figure>';
      }).join('') + '</div></details>';
      if ((report.versions || []).length) html += '<details class="report-editor-section"><summary>Immutable version history</summary><ul class="msg-list">' + report.versions.map(function (version) { return '<li><strong>Version ' + esc(version.version) + '</strong> · ' + esc(version.status) + ' · ' + esc(version.publishedAt) + (version.amendmentReason ? '<p class="report-prose">' + esc(version.amendmentReason) + '</p>' : '') + '</li>'; }).join('') + '</ul></details>';
      root.innerHTML = html; status = root.querySelector("#reportSaveStatus"); bind();
      if (dirty !== saved) message("Unsaved changes — saving shortly…");
      photoDispose = view.hydrate(root, fetchPhoto);
    }
    function fetchPhoto(id, signal) { return config.fetchPhoto("/api/admin/report-photos?requestId=" + encodeURIComponent(config.requestId) + "&id=" + encodeURIComponent(id), signal); }
    async function run(action, origin) {
      if (busy || conflict) return;
      if (action === "save") { await save(); return; }
      origin = origin || document.activeElement;
      busy = true; updateControls();
      try {
        if (!(await save())) return;
        if (action === "preview") {
          if (!data.report.preview) { message("Complete the required findings, inspector details, score, recommendation and summary to generate the server-validated customer preview.", true); return; }
          var preview = root.querySelector("#reportPreview");
          preview.innerHTML = view.render({ payload: data.report.preview }, { preview: data.report.state !== "published" });
          if (data.report.state === "published") preview.innerHTML = view.render({ payload: data.report.preview, version: (data.report.versions || []).find(function (v) { return v.id === data.report.publishedVersionId; })?.version, publishedAt: data.report.publishedAt });
          preview.hidden = false; previewOpen = true;
          if (photoDispose) photoDispose(); photoDispose = view.hydrate(root, fetchPhoto);
          preview.focus(); preview.scrollIntoView({ behavior: "auto", block: "start" }); return;
        }
        if (action === "publish" && !(await ask({ title: "Publish this reviewed report?", text: "This permanently preserves this version and its photos, delivers the report through the secure customer portal, and sends the transactional Report Ready notification.", label: "Confirm publication" }))) return;
        if (action === "deliver" && !(await ask({ title: "Verify report delivery?", text: "Verify delivery of the current published report and retry its Report Ready notification if needed. A customer email may be sent.", label: "Confirm delivery check" }))) return;
        var payload = { action: action, seq: seq };
        if (action === "amend") { var reason = await ask({ title: "Create a report amendment", text: "The previous published version remains available to the customer while you prepare and review a new version. Explain the correction below.", label: "Create amendment draft", reason: true }); if (!reason) return; payload.amendmentReason = reason; }
        message("Applying report action…");
        var result = await request(payload);
        accept(result, true); render();
        if (action === "publish" || action === "deliver") { var notice = notificationStatus(result); message(notice.text, notice.attention); }
        else message("Report updated securely.");
      } catch (error) { message(error.message || "Report action failed. Your draft remains on this screen.", true); }
      finally { busy = false; updateControls(); if (action !== "preview" || !previewOpen) focusAfterAction(origin); }
    }
    async function upload() {
      var fileInput = root.querySelector("#reportPhotoFile"), file = fileInput.files[0];
      if (!file) { message("Choose an inspection photo first.", true); return; }
      if (["image/jpeg", "image/png", "image/webp"].indexOf(file.type) < 0 || file.size > 8 * 1024 * 1024) { message("Choose a JPEG, PNG or WebP image up to 8 MiB. Export HEIC as JPEG before uploading.", true); return; }
      busy = true; updateControls();
      try {
        if (!(await save())) return;
        var form = new FormData(); form.append("file", file); form.append("itemKey", root.querySelector("#reportPhotoItem").value); form.append("caption", root.querySelector("#reportPhotoCaption").value); form.append("seq", String(seq));
        message("Uploading private inspection photo…");
        var response = await config.api("/api/admin/report-photos?requestId=" + encodeURIComponent(config.requestId), { method: "POST", body: form });
        if (!response.ok) throw new Error((response.body.error && response.body.error.message) || "Photo upload failed. No photo was confirmed.");
        accept(response.body, true); render(); message("Private photo saved.");
      } catch (error) { message(error.message || "Photo upload failed. Your file selection remains available to retry.", true); }
      finally { busy = false; updateControls(); }
    }
    async function removePhoto(id, origin) {
      if (busy || conflict) return;
      origin = origin || document.activeElement;
      var photo = (data.report.photos || []).find(function (value) { return value.id === id; });
      if (!photo || photo.referenced !== false || data.report.state !== "in_progress") { message("Only an unpublished photo in an editable draft can be removed. Published evidence is preserved.", true); return; }
      busy = true; updateControls();
      try {
        if (!(await ask({ title: "Remove unpublished photo?", text: "This photo will not appear in the customer report. The private file and audit record are retained; published evidence is never deleted.", label: "Confirm photo removal" }))) return;
        if (!(await save())) return;
        message("Removing unpublished photo from draft…");
        accept(await request({ action: "remove_photo", seq: seq, photoId: id }), true); render();
        message("Unpublished photo removed from the draft. Its private file and audit record are retained. Published evidence is unchanged.");
      } catch (error) { message(error.message || "Photo removal was not confirmed. Refresh to check the saved draft before retrying.", true); }
      finally { busy = false; updateControls(); focusAfterAction(origin); }
    }
    function bind() {
      root.querySelectorAll("[data-field]").forEach(function (element) { element.addEventListener("input", function () { setValue(element); }); });
      root.querySelectorAll("[data-report-action]").forEach(function (button) { button.addEventListener("click", function () { run(button.getAttribute("data-report-action"), button); }); });
      root.querySelectorAll("[data-add-finding]").forEach(function (button) { button.addEventListener("click", function () {
        var sectionIndex = Number(button.getAttribute("data-add-finding")), open = Array.from(root.querySelectorAll(".report-editor-section")).map(function (el) { return el.open; });
        draft.sections[sectionIndex].items.push({ key: "finding_" + crypto.randomUUID().replace(/-/g, ""), label: "Additional finding", result: "", notInspectedReason: "", customerNote: "", internalNotes: "", priority: "", safetyCritical: false, negotiationItem: false });
        changed(); render(); Array.from(root.querySelectorAll(".report-editor-section")).forEach(function (el, i) { el.open = !!open[i]; });
        var inputs = root.querySelectorAll('[data-section="' + sectionIndex + '"][data-field="label"]'); if (inputs.length) inputs[inputs.length - 1].focus();
      }); });
      var uploadButton = root.querySelector("#reportUpload"); if (uploadButton) uploadButton.addEventListener("click", upload);
      root.querySelectorAll("[data-remove-report-photo]").forEach(function (button) { button.addEventListener("click", function () { removePhoto(button.getAttribute("data-remove-report-photo"), button); }); });
      var recovery = root.querySelector("#reportRecovery"); if (recovery) recovery.addEventListener("click", function () {
        var blob = new Blob([JSON.stringify({ requestId: config.requestId, recoveredAt: new Date().toISOString(), baseSequence: seq, draft: draft }, null, 2)], { type: "application/json" });
        var url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = "autoclarity-private-report-recovery.json"; document.body.appendChild(link); link.click(); link.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        message("Recovery copy downloaded. It includes private inspector notes: store it securely. Reloading will replace only this screen’s unsaved copy.", true);
      });
      var reload = root.querySelector("#reportReload"); if (reload) reload.addEventListener("click", async function () {
        try { if (await ask({ title: "Reload the server draft?", text: "This replaces the unsaved draft on this screen. Download the private recovery copy first if you need these edits.", label: "Replace with saved draft" })) { conflict = false; await load(); } }
        finally { updateControls(); focusAfterAction(reload); }
      });
      updateControls();
    }
    function load() {
      root.innerHTML = '<p role="status">Loading inspection report…</p>';
      return config.api(path).then(function (response) {
        if (disposed) return;
        if (!response.ok) throw new Error((response.body.error && response.body.error.message) || "The report could not be loaded.");
        accept(response.body, true); render();
      }).catch(function (error) { if (!disposed) { root.innerHTML = '<h2>Inspection report unavailable</h2><p class="notice warn" role="status">' + esc(error.message) + '</p><button type="button" class="btn btn-ghost" id="reportRetryLoad">Retry loading report</button>'; root.querySelector("#reportRetryLoad").addEventListener("click", load); } });
    }
    function beforeUnload(event) { if (dirty !== saved || pending || busy) { event.preventDefault(); event.returnValue = ""; } }
    window.addEventListener("beforeunload", beforeUnload);
    load();
    return {
      canLeave: function () { return (dirty === saved && !pending && !busy) || window.confirm("This report has unsaved changes or an action in progress. Stay here and save first to avoid losing work. Leave anyway?"); },
      dispose: function () { disposed = true; clearTimeout(timer); if (pendingConfirmation) pendingConfirmation(); window.removeEventListener("beforeunload", beforeUnload); if (photoDispose) photoDispose(); }
    };
  }
  window.AutoClarityReportEditor = { mount: mount, notificationStatus: notificationStatus, confirmation: confirmation };
})();
