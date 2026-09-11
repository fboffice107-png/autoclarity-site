/* AutoClarity — customer portal. Token comes from the magic link (?t=...).
   All rendering is data-driven from GET /api/portal; every mutation goes
   through POST /api/portal/action. */
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var token = params.get("t") || "";
  var checkoutFlag = params.get("checkout") || "";

  var elLoading = document.getElementById("portalLoading");
  var elError = document.getElementById("portalError");
  var elErrorMsg = document.getElementById("portalErrorMsg");
  var elContent = document.getElementById("portalContent");
  var elNotice = document.getElementById("portalNotice");

  if (!token) {
    try { token = sessionStorage.getItem("ppi-portal-token") || ""; } catch (e) {}
  } else {
    try { sessionStorage.setItem("ppi-portal-token", token); } catch (e) {}
    // The bearer link is needed only long enough to move it into this tab's
    // session storage. Remove it from the address bar and browser history so
    // screenshots, copied URLs and later history inspection do not expose it.
    try {
      params.delete("t");
      var safeQuery = params.toString();
      history.replaceState(null, "", location.pathname + (safeQuery ? "?" + safeQuery : "") + location.hash);
    } catch (e) {}
  }

  if (!token) {
    showError("This page needs the secure link from your AutoClarity email.");
    return;
  }

  var view = null;
  var pollTimer = null;

  load();
  if (checkoutFlag === "success") {
    notice("info", "Finalizing your payment with Stripe… this page will update automatically.");
    pollTimer = setInterval(function () { load(true); }, 4000);
    setTimeout(function () { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }, 120000);
  } else if (checkoutFlag === "cancelled") {
    notice("warn", "Checkout was cancelled — your held time is kept for a limited window if you’d like to try again.");
  }

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({ authorization: "Bearer " + token }, options.headers || {});
    options.cache = "no-store";
    return fetch(path, options).then(function (res) {
      return res.json().then(function (body) { return { status: res.status, ok: res.ok, body: body }; });
    });
  }

  function load(quiet) {
    api("/api/portal").then(function (r) {
      if (!r.ok) {
        if (!quiet) showError((r.body.error && r.body.error.message) || "This link could not be verified.");
        return;
      }
      view = r.body;
      if (pollTimer && view.payment && view.payment.status === "succeeded") {
        clearInterval(pollTimer); pollTimer = null;
        if (view.status === "confirmed" && view.booking && view.booking.status === "confirmed") {
          notice("good", "Payment confirmed — your appointment is booked. Check your email for confirmation details.");
        } else {
          notice("warn", "Payment received, but no appointment time was booked. Choose another available time below; you will not be charged again.");
        }
      }
      render();
    }).catch(function () {
      if (!quiet) showError("Network problem — please refresh.");
    });
  }

  function showError(msg) {
    if (reportPhotoDispose) { reportPhotoDispose(); reportPhotoDispose = null; }
    elLoading.hidden = true;
    elContent.hidden = true;
    elError.hidden = false;
    elErrorMsg.textContent = msg;
  }

  function notice(kind, msg) {
    elNotice.innerHTML = '<div class="notice ' + kind + '" role="status">' + esc(msg) + "</div>";
  }

  function esc(s) {
    // Escapes &<> AND quotes so attribute interpolation cannot break out.
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Agreement source is controlled, immutable Markdown. Render only the small
  // subset used by those documents, after escaping every source character, so
  // headings, lists and emphasis are readable without admitting raw HTML.
  function renderAgreementMarkdown(source) {
    var lines = String(source == null ? "" : source).split(/\r?\n/);
    var html = [];
    var paragraph = [];
    var inList = false;

    function inline(text) {
      return esc(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    }
    function flushParagraph() {
      if (!paragraph.length) return;
      html.push("<p>" + inline(paragraph.join(" ")) + "</p>");
      paragraph = [];
    }
    function closeList() {
      if (!inList) return;
      html.push("</ul>");
      inList = false;
    }

    lines.forEach(function (line) {
      var heading = line.match(/^##\s+(.+)$/);
      var item = line.match(/^-\s+(.+)$/);
      if (heading) {
        flushParagraph();
        closeList();
        html.push("<h3>" + inline(heading[1]) + "</h3>");
      } else if (item) {
        flushParagraph();
        if (!inList) { html.push("<ul>"); inList = true; }
        html.push("<li>" + inline(item[1]) + "</li>");
      } else if (!line.trim()) {
        flushParagraph();
        closeList();
      } else {
        closeList();
        paragraph.push(line.trim());
      }
    });
    flushParagraph();
    closeList();
    return html.join("");
  }

  function money(cents) {
    return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  }

  function fmtWhen(iso) {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short"
    });
  }

  var reportPhotoDispose = null;
  function renderPublishedReport(report) {
    return '<div class="report-print-actions"><button type="button" class="btn btn-ghost" id="printReport">Print / save report as PDF</button><p class="field-hint" id="reportPrintStatus" role="status">Your private report stays in this secure portal. Keep printed or downloaded copies private.</p></div>' +
      window.AutoClarityReportView.render(report);
  }
  var STATUS_KIND = {
    submitted: "", needs_info: "warn", seller_access_pending: "warn", ready_for_review: "",
    quote_prepared: "", quote_sent: "good", awaiting_time_selection: "good",
    awaiting_agreement: "warn", awaiting_payment: "warn", confirmed: "good",
    inspection_in_progress: "good", report_in_progress: "good", completed: "good",
    customer_cancelled: "bad", admin_cancelled: "bad", expired: "bad", refunded: "",
    refund_reconciliation_needed: "bad", disputed: "bad"
  };

  function render() {
    elLoading.hidden = true;
    elError.hidden = true;
    elContent.hidden = false;

    var v = view;
    var html = "";
    var paidReselection = v.status === "awaiting_time_selection" && v.payment && ["succeeded", "partially_refunded"].indexOf(v.payment.status) !== -1;
    var acceptedAgreementIds = new Set(v.agreements.accepted || []);
    var needsCurrentAgreements = v.agreements.required.length > 0 && v.agreements.required.some(function (doc) {
      return !acceptedAgreementIds.has(doc.id);
    });
    var hasHeldSlot = v.slots.some(function (slot) { return slot.status === "held"; });
    var currentQuoteAndHold = Boolean(v.quote && !v.quote.expired && hasHeldSlot);
    var canAcceptCurrentAgreements = needsCurrentAgreements && currentQuoteAndHold;

    html += '<div class="portal-topbar">' +
      "<h1>Request " + esc(v.ref) + "</h1>" +
      '<span class="status-pill ' + (STATUS_KIND[v.status] || "") + '">' + esc(v.statusLabel) + "</span>" +
      "</div>";

    // ---------- summary ----------
    html += '<section class="portal-card"><h2>Vehicle &amp; location</h2><dl class="kv">' +
      "<dt>Vehicle</dt><dd>" + esc([v.vehicle.year, v.vehicle.make, v.vehicle.model, v.vehicle.trim].filter(Boolean).join(" ")) + "</dd>" +
      "<dt>VIN</dt><dd>" + esc(v.vehicle.vin || "Not provided yet — share it with AutoClarity before the inspection when available") + "</dd>" +
      "<dt>Inspection area</dt><dd>" + esc([v.location.street, v.location.city, v.location.state, v.location.zip].filter(Boolean).join(", ")) + "</dd>" +
      "</dl></section>";

    // ---------- status-specific guidance ----------
    var guidance = {
      submitted: "AutoClarity will review the vehicle, location, access, and requested timing, then follow up by email with next steps.",
      needs_info: "AutoClarity needs a little more information — check the messages below and reply there.",
      seller_access_pending: "Waiting on the seller to confirm access to the vehicle. You’ll be notified the moment it’s cleared.",
      ready_for_review: "Your request is in review — your exact quote is on its way.",
      quote_prepared: "Your quote is being finalized.",
      quote_sent: "Your exact price is ready below. Choose an appointment window to continue.",
      awaiting_time_selection: "Choose one of the offered appointment windows below.",
      awaiting_agreement: canAcceptCurrentAgreements
        ? "Almost there — review and accept the service agreements below."
        : "The quote or held appointment needs to be refreshed before agreement acceptance. AutoClarity will provide the next available step.",
      awaiting_payment: canAcceptCurrentAgreements
        ? "Before payment, review and accept the current service agreements for this exact quote and appointment."
        : (!needsCurrentAgreements && currentQuoteAndHold && v.paymentsEnabled
          ? "Last step: pay the exact approved quote through Stripe. Successful payment confirms your appointment."
          : "Payment is not available until the current quote, appointment hold and agreements are ready. AutoClarity will provide the next step."),
      confirmed: "You’re booked. The technician will meet the vehicle at the scheduled time.",
      inspection_in_progress: "Your inspection is underway.",
      report_in_progress: v.report
        ? "Your published written report is available below while AutoClarity finalizes this request."
        : "The inspection is done — your written results are being prepared.",
      completed: v.report
        ? "Your inspection is complete. Your published written report is available below."
        : "Your inspection is marked complete, but no published report is available in this secure portal. Contact AutoClarity support for help.",
      customer_cancelled: "This request was cancelled.",
      admin_cancelled: "This request was cancelled by AutoClarity.",
      expired: "This request expired. Submit a new one whenever you’re ready.",
      refunded: "This request was refunded.",
      refund_reconciliation_needed: "Stripe changed the status of a previously completed refund. Your appointment remains closed while AutoClarity reconciles the payment record; you do not need to pay again.",
      disputed: "This payment is under dispute review. Your original appointment remains closed even if the payment provider later resolves the dispute; AutoClarity will contact you before any new scheduling step."
    };
    if (guidance[v.status]) {
      html += '<div class="notice info">' + esc(guidance[v.status]) + "</div>";
    }

    // ---------- exact published report snapshot ----------
    if (v.report) html += renderPublishedReport(v.report);

    // ---------- quote ----------
    if (v.quote) {
      html += '<section class="portal-card"><h2>Your quote</h2>';
      if (v.quote.expired && v.status !== "confirmed" && v.status !== "completed") {
        html += paidReselection
          ? '<div class="notice info">Your payment is already recorded. The old quote date does not block choosing a replacement time, and you will not be charged again.</div>'
          : '<div class="notice warn">This quote expired ' + esc(fmtWhen(v.quote.expiresAt)) + ". AutoClarity will refresh it — no action needed.</div>";
      }
      html += '<table class="line-items">';
      v.quote.lines.forEach(function (l) {
        html += "<tr><td>" + esc(l.label) + "</td><td>" + (l.kind === "discount" ? "−" : "") + money(Math.abs(l.amountCents)) + "</td></tr>";
      });
      html += '<tr class="total"><td>Total</td><td>' + money(v.quote.totalCents) + "</td></tr></table>";
      if (v.quote.customerNote) html += '<p style="margin-top:12px;color:var(--text-2);font-size:14.5px;">' + esc(v.quote.customerNote) + "</p>";
      if (!v.quote.expired && !paidReselection && (v.status === "quote_sent" || v.status === "awaiting_time_selection")) {
        html += '<p class="field-hint">Quote valid until ' + esc(fmtWhen(v.quote.expiresAt)) + ".</p>";
      }
      html += "</section>";
    }

    // ---------- slots ----------
    var offered = v.slots.filter(function (s) { return s.status === "offered"; });
    var held = v.slots.filter(function (s) { return s.status === "held"; })[0];
    var confirmedSlot = v.slots.filter(function (s) { return s.status === "confirmed"; })[0];

    if ((v.status === "quote_sent" || v.status === "awaiting_time_selection") && offered.length > 0 && v.quote && (!v.quote.expired || paidReselection)) {
      html += '<section class="portal-card"><h2>Choose your appointment</h2><div class="slot-list">';
      offered.forEach(function (s) {
        html += '<button type="button" class="slot-btn" data-slot="' + esc(s.id) + '">' + esc(fmtWhen(s.startsAt)) +
          '<span class="slot-sub">' + (paidReselection ? "Choose this replacement time — no additional charge" : "Selecting holds this time for you while you finish booking") + "</span></button>";
      });
      html += "</div></section>";
    }

    if (held && (v.status === "awaiting_agreement" || v.status === "awaiting_payment")) {
      html += '<div class="notice good">Held for you: ' + esc(fmtWhen(held.startsAt)) +
        (held.holdExpiresAt ? " — complete booking by " + esc(fmtWhen(held.holdExpiresAt)) : "") + "</div>";
    }

    // ---------- agreements ----------
    if ((v.status === "awaiting_agreement" || v.status === "awaiting_payment") && canAcceptCurrentAgreements) {
      html += '<section class="portal-card"><h2>Service agreements</h2>' +
        '<p style="color:var(--text-2);font-size:14.5px;margin-bottom:12px;">These are the current agreements for the exact quote and appointment time shown above. Please open and accept each document. One typed signature covers all of them.</p>' +
        '<form id="agreeForm">';
      v.agreements.required.forEach(function (doc) {
        html += '<details class="agree-doc"><summary>' + esc(doc.title) + ' <span class="opt">(v' + doc.version + ')</span></summary>' +
          '<div class="agree-body">' + renderAgreementMarkdown(doc.bodyMd) + "</div></details>" +
          '<div class="agree-check"><input type="checkbox" id="agree_' + esc(doc.id) + '" data-agree="' + esc(doc.id) + '" />' +
          '<label for="agree_' + esc(doc.id) + '">I have read and accept the ' + esc(doc.title) + "</label></div>";
      });
      html += '<div class="field" style="margin-top:14px;"><label for="typedName">Type your full legal name to sign</label>' +
        '<input id="typedName" type="text" maxlength="120" autocomplete="name" /></div>' +
        '<button class="btn btn-primary btn-lg" type="submit" style="width:100%;">Accept and continue</button>' +
        '<p class="form-status" id="agreeStatus" role="status" aria-live="polite"></p></form></section>';
    }

    // ---------- payment ----------
    if (v.status === "awaiting_payment" && !needsCurrentAgreements && currentQuoteAndHold && v.paymentsEnabled) {
      html += '<section class="portal-card"><h2>Payment</h2>' +
        '<p style="color:var(--text-2);font-size:15px;">Stripe will charge the exact server-approved quote total shown above. Your appointment is confirmed only after payment succeeds.</p>' +
        '<p class="field-hint">The cancellation, rescheduling, vehicle-transfer, mobile-service, and refund terms you accepted apply to this booking. A transfer to a replacement vehicle has no transfer fee, but AutoClarity re-reviews and re-quotes that vehicle: you pay any increase before the replacement booking is confirmed, receive a refund of any decrease, or carry the same payment forward when the approved totals match.</p>' +
        '<button class="btn btn-primary btn-lg" id="checkoutBtn" style="width:100%;margin-top:14px;">Pay exact quote securely with Stripe' +
        (v.quote ? " — " + money(v.quote.totalCents) : "") + "</button>" +
        '<p class="form-status" id="checkoutStatus" role="status" aria-live="polite"></p></section>';
    } else if (v.status === "awaiting_payment" && !canAcceptCurrentAgreements) {
      html += '<section class="portal-card"><h2>Payment unavailable</h2>' +
        '<div class="notice warn">Online payment cannot start until the current quote, held appointment, current agreements, and payment service are all ready. Contact AutoClarity to finish scheduling. No charge has been started, and your appointment is not confirmed.</div></section>';
    }

    // ---------- confirmed booking ----------
    if (v.booking && v.booking.status === "confirmed" && confirmedSlot && ["confirmed", "inspection_in_progress", "report_in_progress", "completed"].indexOf(v.status) !== -1) {
      html += '<section class="portal-card"><h2>Your appointment</h2><dl class="kv">' +
        "<dt>When</dt><dd>" + esc(fmtWhen(confirmedSlot.startsAt)) + "</dd>" +
        "<dt>Where</dt><dd>" + esc([v.location.street, v.location.city].filter(Boolean).join(", ")) + "</dd></dl>" +
        '<p style="margin-top:14px;"><button class="btn btn-ghost" id="calendarBtn" type="button">Add to calendar (.ics)</button></p>' +
        '<p class="form-status" id="calendarStatus" role="status" aria-live="polite"></p></section>';
    }

    // ---------- uploads ----------
    if (v.uploads.length > 0) {
      html += '<section class="portal-card"><h2>Your photos</h2><ul class="upload-list">';
      v.uploads.forEach(function (u) { html += '<li class="ok">' + esc(u.name) + "</li>"; });
      html += "</ul></section>";
    }

    // ---------- messages ----------
    html += '<section class="portal-card"><h2>Messages</h2>';
    if (v.messages.length === 0) {
      html += '<p style="color:var(--text-3);font-size:14.5px;">No messages yet — updates about your request will appear here.</p>';
    } else {
      html += '<ul class="msg-list">';
      v.messages.forEach(function (m) {
        html += '<li class="' + (m.direction === "inbound" ? "inbound" : "") + '">' + esc(m.body) +
          '<span class="msg-meta">' + (m.direction === "inbound" ? "You" : "AutoClarity") + " · " + esc(fmtWhen(m.createdAt)) + "</span></li>";
      });
      html += "</ul>";
    }
    html += '<form id="msgForm" style="margin-top:14px;"><div class="field"><label for="msgText">Send a message</label>' +
      '<textarea id="msgText" rows="2" maxlength="2000"></textarea></div>' +
      '<button class="btn btn-ghost" type="submit">Send</button>' +
      '<p class="form-status" id="msgStatus" role="status" aria-live="polite"></p></form></section>';

    // ---------- cancel ----------
    var terminal = ["customer_cancelled", "admin_cancelled", "expired", "refunded", "refund_reconciliation_needed", "completed", "disputed"];
    if (terminal.indexOf(v.status) === -1) {
      html += '<section class="portal-card"><h2>Need to cancel or reschedule?</h2>' +
        '<p style="color:var(--text-2);font-size:14.5px;">Before payment, cancelling is instant and free. After payment, requests are reviewed personally under the cancellation policy you accepted — nothing is forfeited automatically. Your approved quote shows any separate mobile-service charge relevant to that review.</p>' +
        '<button class="btn btn-ghost" id="cancelBtn" style="margin-top:12px;">Request cancellation / reschedule</button>' +
        '<p class="form-status" id="cancelStatus" role="status" aria-live="polite"></p></section>';
    }

    if (reportPhotoDispose) reportPhotoDispose();
    elContent.innerHTML = html;
    if (v.report) {
      reportPhotoDispose = window.AutoClarityReportView.hydrate(elContent, function (id, signal) {
        return fetch("/api/portal/report-photo?id=" + encodeURIComponent(id) + "&versionId=" + encodeURIComponent(v.report.versionId), {
          headers: { authorization: "Bearer " + token }, cache: "no-store", signal: signal
        }).then(function (response) { if (!response.ok) throw new Error("Private photo unavailable"); return response.blob(); });
      });
    }
    bindActions();
  }

  function bindActions() {
    var printReport = document.getElementById("printReport");
    if (printReport) printReport.addEventListener("click", async function () {
      printReport.disabled = true;
      var printStatus = document.getElementById("reportPrintStatus");
      printStatus.textContent = "Preparing the full report and private photos…";
      var photos = reportPhotoDispose ? await reportPhotoDispose.loadAll() : { failed: 0 };
      if (photos.failed) {
        printReport.disabled = false;
        printStatus.textContent = photos.failed + " private photo(s) could not load. Refresh the portal and retry before printing a complete report.";
        return;
      }
      var decoded = await Promise.allSettled(Array.from(elContent.querySelectorAll("[data-report-photo]")).filter(function (img) { return img.src && !img.hidden; }).map(function (img) { return img.decode ? img.decode() : Promise.resolve(); }));
      if (!printReport.isConnected) return;
      if (decoded.some(function (result) { return result.status === "rejected"; })) {
        printReport.disabled = false;
        printStatus.textContent = "A report photo could not be decoded. Refresh and retry, or contact AutoClarity before printing an incomplete report.";
        return;
      }
      document.body.classList.add("printing-report");
      window.print();
      printReport.disabled = false;
      printStatus.textContent = "Use your browser’s print menu to save as PDF. Keep your private report secure.";
    });
    elContent.querySelectorAll(".slot-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        btn.disabled = true;
        action({ action: "select_slot", slotId: btn.getAttribute("data-slot") }, function (r) {
          if (r.ok) { track("ppi_slot_selected"); load(); }
          else {
            btn.disabled = false;
            notice("warn", (r.body.error && r.body.error.message) || "That time is unavailable.");
            load();
          }
        });
      });
    });

    var agreeForm = document.getElementById("agreeForm");
    if (agreeForm) {
      agreeForm.addEventListener("submit", function (e) {
        e.preventDefault();
        var status = document.getElementById("agreeStatus");
        var boxes = agreeForm.querySelectorAll("[data-agree]");
        var ids = [];
        var allChecked = true;
        boxes.forEach(function (b) { if (b.checked) ids.push(b.getAttribute("data-agree")); else allChecked = false; });
        var name = document.getElementById("typedName").value.trim();
        if (!allChecked) { status.textContent = "Please check every document to continue."; return; }
        if (name.length < 2) { status.textContent = "Please type your full name to sign."; return; }
        status.textContent = "Recording your acceptance…";
        action({ action: "accept_agreements", typedName: name, versionIds: ids }, function (r) {
          if (r.ok) { track("ppi_agreement_accepted"); load(); }
          else status.textContent = (r.body.error && r.body.error.message) || "Something went wrong.";
        });
      });
    }

    var checkoutBtn = document.getElementById("checkoutBtn");
    if (checkoutBtn) {
      checkoutBtn.addEventListener("click", function () {
        var status = document.getElementById("checkoutStatus");
        checkoutBtn.disabled = true;
        status.textContent = "Opening secure checkout…";
        track("ppi_checkout_started");
        action({ action: "checkout" }, function (r) {
          if (r.ok && r.body.checkoutUrl) { location.href = r.body.checkoutUrl; return; }
          checkoutBtn.disabled = false;
          if (r.body.paymentsDisabled) { status.textContent = r.body.message; return; }
          status.textContent = (r.body.error && r.body.error.message) || "Payment couldn’t start — please try again.";
          load();
        });
      });
    }

    var msgForm = document.getElementById("msgForm");
    if (msgForm) {
      msgForm.addEventListener("submit", function (e) {
        e.preventDefault();
        var text = document.getElementById("msgText").value.trim();
        var status = document.getElementById("msgStatus");
        if (!text) return;
        status.textContent = "Sending…";
        action({ action: "message", message: text }, function (r) {
          if (r.ok) { status.textContent = ""; load(); }
          else status.textContent = (r.body.error && r.body.error.message) || "Couldn’t send — try again.";
        });
      });
    }

    var calendarBtn = document.getElementById("calendarBtn");
    if (calendarBtn) {
      calendarBtn.addEventListener("click", function () {
        var status = document.getElementById("calendarStatus");
        calendarBtn.disabled = true;
        status.textContent = "Preparing calendar file…";
        fetch("/api/portal/calendar", {
          headers: { authorization: "Bearer " + token },
          cache: "no-store"
        }).then(function (response) {
          if (!response.ok) {
            return response.json().catch(function () { return {}; }).then(function (body) {
              throw new Error((body.error && body.error.message) || "Calendar file is unavailable.");
            });
          }
          return response.blob();
        }).then(function (blob) {
          var href = URL.createObjectURL(blob);
          var download = document.createElement("a");
          download.href = href;
          download.download = "autoclarity-ppi-appointment.ics";
          document.body.appendChild(download);
          download.click();
          download.remove();
          setTimeout(function () { URL.revokeObjectURL(href); }, 0);
          status.textContent = "Calendar file downloaded.";
        }).catch(function (error) {
          status.textContent = error.message || "Calendar file is unavailable.";
        }).finally(function () {
          calendarBtn.disabled = false;
        });
      });
    }

    var cancelBtn = document.getElementById("cancelBtn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", function () {
        var reason = prompt("Optional: tell us why (helps with rescheduling)") || "";
        var status = document.getElementById("cancelStatus");
        status.textContent = "Sending…";
        action({ action: "cancel", reason: reason }, function (r) {
          if (r.ok) {
            track("ppi_cancelled");
            if (r.body.underReview) notice("info", r.body.message);
            load();
          } else {
            status.textContent = (r.body.error && r.body.error.message) || "Couldn’t process — contact support.";
          }
        });
      });
    }
  }

  function action(payload, cb) {
    api("/api/portal/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).then(cb).catch(function () { cb({ ok: false, body: { error: { message: "Network problem — please retry." } } }); });
  }

  function track(event) {
    try {
      var body = JSON.stringify({ event: event, step: "", source: "portal" });
      if (navigator.sendBeacon) navigator.sendBeacon("/api/ppi/events", new Blob([body], { type: "application/json" }));
    } catch (e) {}
  }
  window.addEventListener("afterprint", function () { document.body.classList.remove("printing-report"); });
  window.addEventListener("pagehide", function () { if (reportPhotoDispose) reportPhotoDispose(); });
})();
