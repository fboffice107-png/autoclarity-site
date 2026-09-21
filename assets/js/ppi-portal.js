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

  // The customer never needs to know the word "awaiting_time_selection". These
  // are the same saved states, said in a sentence, with the one thing to do
  // next named explicitly.
  var CUSTOMER_STAGE = {
    submitted: "AutoClarity is reviewing your request",
    needs_info: "AutoClarity needs one more detail from you",
    seller_access_pending: "Waiting on the seller to confirm access",
    ready_for_review: "AutoClarity is preparing your price and times",
    quote_prepared: "AutoClarity is preparing your price and times",
    quote_sent: "Choose your appointment",
    awaiting_time_selection: "Choose your appointment",
    awaiting_agreement: "Review and accept the agreements",
    awaiting_payment: "Pay to confirm your appointment",
    confirmed: "Your appointment is confirmed",
    inspection_in_progress: "Your inspection is underway",
    report_in_progress: "Your report is being written",
    completed: "Your inspection is complete",
    customer_cancelled: "This request was cancelled",
    admin_cancelled: "This request was cancelled by AutoClarity",
    expired: "This request expired",
    refunded: "This request was refunded",
    refund_reconciliation_needed: "AutoClarity is reconciling your refund",
    disputed: "This payment is under dispute review"
  };

  var BOOKING_STEPS = ["Choose a time", "Review & accept", "Pay & confirm"];

  /* Which of the three booking steps the customer is on, from saved state.
     0 means the booking journey has not started or is already finished. */
  function bookingStep(v) {
    if (v.status === "quote_sent" || v.status === "awaiting_time_selection") return 1;
    if (v.status === "awaiting_agreement") return 2;
    if (v.status === "awaiting_payment") return 3;
    return 0;
  }

  function renderStepper(current) {
    var html = '<ol class="booking-steps" aria-label="Booking steps">';
    BOOKING_STEPS.forEach(function (label, i) {
      var n = i + 1;
      var state = n < current ? "done" : n === current ? "current" : "todo";
      html += '<li class="booking-step ' + state + '"' + (state === "current" ? ' aria-current="step"' : "") + '>' +
        '<span class="booking-step-num" aria-hidden="true">' + (state === "done" ? "✓" : n) + "</span>" +
        '<span class="booking-step-label">' + esc(label) + "</span>" +
        (state === "done" ? '<span class="sr-only"> (done)</span>' : "") + "</li>";
    });
    return html + "</ol>";
  }

  /* Weekday, date and an unmistakable AM/PM, in Las Vegas time, on both
     sides of the conversation. */
  function fmtSlotLong(iso) {
    var d = new Date(iso);
    var day = d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric" });
    var time = d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", hour12: true });
    return { day: day, time: time };
  }

  function renderQuoteTable(quote) {
    var html = '<table class="line-items">';
    var hasTravel = false;
    quote.lines.forEach(function (l) {
      if (l.kind === "travel") hasTravel = true;
      // A zero-amount charge line is information, not an empty cell.
      var amount = l.kind !== "discount" && l.amountCents === 0
        ? "Included"
        : (l.kind === "discount" ? "−" : "") + money(Math.abs(l.amountCents));
      html += "<tr><td>" + esc(l.label) + "</td><td>" + esc(amount) + "</td></tr>";
    });
    // No travel line means no travel charge. Say so, rather than leaving the
    // customer to wonder whether a mobile-service fee is coming later.
    if (!hasTravel) {
      html += '<tr><td>Mobile-service charge</td><td>Included</td></tr>';
    }
    html += '<tr class="total"><td>Total</td><td>' + money(quote.totalCents) + "</td></tr></table>";
    return html;
  }

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

    var offered = v.slots.filter(function (s) { return s.status === "offered"; });
    var held = v.slots.filter(function (s) { return s.status === "held"; })[0];
    var confirmedSlot = v.slots.filter(function (s) { return s.status === "confirmed"; })[0];
    var step = bookingStep(v);
    // A price with no times to pick is the dead end this page used to show.
    // It is now named out loud instead of leaving the customer guessing.
    var awaitingTimes = step === 1 && offered.length === 0;
    // An offer whose quote has lapsed is the other way to reach a page with
    // nothing to press. Say so, and give them one button that fixes it.
    var offerStale = step === 1 && Boolean(v.quote && v.quote.expired) && !paidReselection;

    html += '<div class="portal-topbar">' +
      "<h1>Request " + esc(v.ref) + "</h1>" +
      '<span class="status-pill ' + (STATUS_KIND[v.status] || "") + '">' + esc(CUSTOMER_STAGE[v.status] || v.statusLabel) + "</span>" +
      "</div>";

    // ---------- what happens next, in one line ----------
    var nextLine = {
      submitted: "Nothing to do right now — AutoClarity reviews your vehicle, location and timing, then emails your price and available times.",
      needs_info: "Check the messages below and reply there.",
      seller_access_pending: "You'll be notified the moment the seller confirms access.",
      ready_for_review: "Nothing to do right now — your exact price and appointment times are on the way by email.",
      quote_prepared: "Nothing to do right now — your exact price and appointment times are on the way by email.",
      quote_sent: offerStale
        ? "This offer has passed its valid-until date, so it can't be booked as it stands. Ask AutoClarity for a refreshed quote below — it only takes a moment and you have not been charged anything."
        : awaitingTimes
          ? "Your price is confirmed below. AutoClarity is finalising which appointment times to offer you and will email them shortly — you don't need to do anything yet."
          : "Pick the appointment that suits you. Nothing is charged until you accept the agreements and pay.",
      awaiting_time_selection: paidReselection
        ? "Your payment is already recorded. Choose a replacement time below — you will not be charged again."
        : offerStale
          ? "This offer has passed its valid-until date, so it can't be booked as it stands. Ask AutoClarity for a refreshed quote below — you have not been charged anything."
          : awaitingTimes
            ? "Your price is confirmed below. AutoClarity is finalising which appointment times to offer you and will email them shortly."
            : "Pick the appointment that suits you. Nothing is charged until you accept the agreements and pay.",
      awaiting_agreement: canAcceptCurrentAgreements
        ? "Your time is held. Read and accept the agreements below to continue to payment."
        : "Your held time or quote needs refreshing before you can accept the agreements. AutoClarity will send the next step.",
      awaiting_payment: canAcceptCurrentAgreements
        ? "Before payment, accept the current agreements for this exact price and time."
        : (!needsCurrentAgreements && currentQuoteAndHold && v.paymentsEnabled
          ? "Last step — pay the exact total shown. Successful payment confirms your appointment."
          : "Payment isn't available until your quote, held time and agreements are all current. AutoClarity will send the next step."),
      confirmed: "You're booked. The technician meets the vehicle at the scheduled time.",
      inspection_in_progress: "Your inspection is underway.",
      report_in_progress: v.report ? "Your published report is available below while AutoClarity finalises this request." : "The inspection is done — your written results are being prepared.",
      completed: v.report ? "Your inspection is complete and your report is below." : "Your inspection is marked complete, but no published report is in this portal. Contact AutoClarity for help.",
      customer_cancelled: "This request was cancelled.",
      admin_cancelled: "This request was cancelled by AutoClarity.",
      expired: "This request expired. Submit a new one whenever you're ready.",
      refunded: "This request was refunded.",
      refund_reconciliation_needed: "Stripe changed the status of a completed refund. Your appointment stays closed while AutoClarity reconciles the record; you do not need to pay again.",
      disputed: "This payment is under dispute review. Your original appointment stays closed even if the provider later resolves it; AutoClarity will contact you before any new scheduling step."
    }[v.status];

    if (step > 0) html += renderStepper(step);
    if (nextLine) {
      html += '<div class="notice ' + (awaitingTimes ? "info" : step > 0 ? "good" : "info") + '"><strong>Next: </strong>' + esc(nextLine) + "</div>";
    }

    // ---------- price, high on the page and always itemized ----------
    if (v.quote) {
      html += '<section class="portal-card portal-price"><h2>Your price</h2>';
      if (v.quote.expired && v.status !== "confirmed" && v.status !== "completed") {
        html += paidReselection
          ? '<div class="notice info">Your payment is already recorded. The old quote date does not block choosing a replacement time, and you will not be charged again.</div>'
          : '<div class="notice warn">This quote expired ' + esc(fmtWhen(v.quote.expiresAt)) + ". AutoClarity will refresh it — no action needed.</div>";
      }
      html += renderQuoteTable(v.quote);
      if (v.quote.customerNote) html += '<p class="portal-quote-note">' + esc(v.quote.customerNote) + "</p>";
      if (!v.quote.expired && !paidReselection && (v.status === "quote_sent" || v.status === "awaiting_time_selection" || v.status === "awaiting_agreement" || v.status === "awaiting_payment")) {
        html += '<p class="field-hint">This is the exact amount you will be charged. Held until ' + esc(fmtWhen(v.quote.expiresAt)) + ".</p>";
      }
      html += "</section>";
    }

    // ---------- summary ----------
    html += '<section class="portal-card"><h2>Vehicle &amp; location</h2><dl class="kv">' +
      "<dt>Vehicle</dt><dd>" + esc([v.vehicle.year, v.vehicle.make, v.vehicle.model, v.vehicle.trim].filter(Boolean).join(" ")) + "</dd>" +
      "<dt>VIN</dt><dd>" + esc(v.vehicle.vin || "Not provided yet — share it with AutoClarity before the inspection when available") + "</dd>" +
      "<dt>Inspection area</dt><dd>" + esc([v.location.street, v.location.city, v.location.state, v.location.zip].filter(Boolean).join(", ")) + "</dd>" +
      "</dl></section>";

    // ---------- exact published report snapshot ----------
    if (v.report) html += renderPublishedReport(v.report);

    // ---------- step 1: choose a time ----------
    if (step === 1 && offered.length > 0 && v.quote && (!v.quote.expired || paidReselection)) {
      html += '<section class="portal-card"><h2>Choose your appointment</h2>' +
        '<p class="field-hint">' + esc(paidReselection
          ? "Pick a replacement time. There is no additional charge."
          : "These are alternatives for one inspection — pick the one that works. Selecting holds it for you while you finish booking.") + "</p>" +
        '<div class="slot-list">';
      offered.forEach(function (s) {
        var when = fmtSlotLong(s.startsAt);
        html += '<button type="button" class="slot-btn" data-slot="' + esc(s.id) + '">' +
          '<span class="slot-day">' + esc(when.day) + "</span>" +
          '<span class="slot-time">' + esc(when.time) + ' <span class="slot-tz">Las Vegas time</span></span>' +
          '<span class="slot-sub">' + esc(paidReselection ? "Choose this time" : "Select and continue") + "</span></button>";
      });
      html += "</div>";
      html += '<p class="field-hint slot-none">None of these work? <button type="button" class="linklike" id="requestNewTimes">Ask AutoClarity for different times</button></p>';
      html += "</section>";
    } else if (offerStale) {
      html += '<section class="portal-card"><h2>This offer has expired</h2>' +
        '<div class="notice warn">Quotes are held for a limited time. This one passed its valid-until date, so it can\u2019t be booked as it stands. Nothing has been charged, and asking for a fresh one does not put you back at the start.</div>' +
        '<button class="btn btn-primary" id="requestNewTimes" style="margin-top:12px;">Ask AutoClarity for a refreshed quote</button>' +
        '<p class="form-status" id="requestTimesStatus" role="status" aria-live="polite"></p></section>';
    } else if (awaitingTimes && v.quote) {
      html += '<section class="portal-card"><h2>Choose your appointment</h2>' +
        '<div class="notice info">Appointment times for this request haven’t been published yet. AutoClarity sends them by email as soon as they’re set — usually the same day. Your price above is already confirmed and will not change.</div>' +
        '<button class="btn btn-ghost" id="requestNewTimes" style="margin-top:12px;">Ask AutoClarity for times</button>' +
        '<p class="form-status" id="requestTimesStatus" role="status" aria-live="polite"></p></section>';
    }

    if (held && (v.status === "awaiting_agreement" || v.status === "awaiting_payment")) {
      var heldWhen = fmtSlotLong(held.startsAt);
      html += '<section class="portal-card portal-held"><h2>Your chosen time</h2>' +
        '<p class="held-when"><strong>' + esc(heldWhen.day) + "</strong> at <strong>" + esc(heldWhen.time) + "</strong> <span class=\"slot-tz\">Las Vegas time</span></p>" +
        (held.holdExpiresAt ? '<p class="field-hint">Held for you until ' + esc(fmtWhen(held.holdExpiresAt)) + ". It isn’t confirmed until payment succeeds.</p>" : "") +
        '<p class="field-hint"><button type="button" class="linklike" id="changeTimeBtn">Choose a different time instead</button></p>' +
        "</section>";
    }

    // ---------- step 2: agreements ----------
    if ((v.status === "awaiting_agreement" || v.status === "awaiting_payment") && canAcceptCurrentAgreements) {
      html += '<section class="portal-card"><h2>Service agreements</h2>' +
        '<p class="field-hint" style="margin-bottom:12px;">These are the current agreements for the exact price and time above. Open and accept each one — a single typed signature covers all of them.</p>' +
        '<form id="agreeForm">';
      v.agreements.required.forEach(function (doc) {
        html += '<details class="agree-doc"><summary>' + esc(doc.title) + ' <span class="opt">(v' + doc.version + ')</span></summary>' +
          '<div class="agree-body">' + renderAgreementMarkdown(doc.bodyMd) + "</div></details>" +
          '<div class="agree-check"><input type="checkbox" id="agree_' + esc(doc.id) + '" data-agree="' + esc(doc.id) + '" />' +
          '<label for="agree_' + esc(doc.id) + '">I have read and accept the ' + esc(doc.title) + "</label></div>";
      });
      html += '<div class="field" style="margin-top:14px;"><label for="typedName">Type your full legal name to sign</label>' +
        '<input id="typedName" type="text" maxlength="120" autocomplete="name" /></div>' +
        '<button class="btn btn-primary btn-lg" type="submit" style="width:100%;">Accept and continue to payment</button>' +
        '<p class="form-status" id="agreeStatus" role="status" aria-live="polite"></p></form></section>';
    }

    // ---------- step 3: payment ----------
    if (v.status === "awaiting_payment" && !needsCurrentAgreements && currentQuoteAndHold && v.paymentsEnabled) {
      html += '<section class="portal-card"><h2>Pay &amp; confirm</h2>' +
        '<p class="field-hint">Stripe charges the exact total shown above. Your appointment is confirmed only after payment succeeds.</p>' +
        '<button class="btn btn-primary btn-lg" id="checkoutBtn" style="width:100%;margin-top:14px;">Pay ' +
        (v.quote ? money(v.quote.totalCents) : "") + " securely with Stripe</button>" +
        '<p class="form-status" id="checkoutStatus" role="status" aria-live="polite"></p>' +
        '<details class="portal-fineprint"><summary>Cancellation, rescheduling and vehicle-transfer terms</summary>' +
        '<p>The cancellation, rescheduling, vehicle-transfer, mobile-service and refund terms you accepted apply to this booking. A transfer to a replacement vehicle has no transfer fee, but AutoClarity re-reviews and re-quotes that vehicle: you pay any increase before the replacement booking is confirmed, receive a refund of any decrease, or carry the same payment forward when the approved totals match.</p></details>' +
        "</section>";
    } else if (v.status === "awaiting_payment" && !canAcceptCurrentAgreements) {
      html += '<section class="portal-card"><h2>Payment unavailable</h2>' +
        '<div class="notice warn">Online payment cannot start until the current quote, held appointment, current agreements, and payment service are all ready. Contact AutoClarity to finish scheduling. No charge has been started, and your appointment is not confirmed.</div></section>';
    }

    // ---------- confirmed booking ----------
    if (v.booking && v.booking.status === "confirmed" && confirmedSlot && ["confirmed", "inspection_in_progress", "report_in_progress", "completed"].indexOf(v.status) !== -1) {
      var cWhen = fmtSlotLong(confirmedSlot.startsAt);
      html += '<section class="portal-card portal-confirmed"><h2>Your appointment</h2><dl class="kv">' +
        "<dt>When</dt><dd><strong>" + esc(cWhen.day) + "</strong> at <strong>" + esc(cWhen.time) + '</strong> <span class="slot-tz">Las Vegas time</span></dd>' +
        "<dt>Where</dt><dd>" + esc([v.location.street, v.location.city].filter(Boolean).join(", ")) + "</dd>" +
        "<dt>Vehicle</dt><dd>" + esc([v.vehicle.year, v.vehicle.make, v.vehicle.model].filter(Boolean).join(" ")) + "</dd>" +
        (v.payment && v.payment.amountCents ? "<dt>Amount paid</dt><dd>" + money(v.payment.amountCents) + "</dd>" : "") +
        "</dl>" +
        '<p class="field-hint">What happens next: AutoClarity arrives at the vehicle at the scheduled time, performs the inspection, then publishes your written report to this page and emails you when it’s ready.</p>' +
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

    // ---------- cancel (secondary, at the bottom) ----------
    var terminal = ["customer_cancelled", "admin_cancelled", "expired", "refunded", "refund_reconciliation_needed", "completed", "disputed"];
    if (terminal.indexOf(v.status) === -1) {
      html += '<details class="portal-card portal-secondary"><summary>Need to cancel or reschedule?</summary>' +
        '<p style="color:var(--text-2);font-size:14.5px;">Before payment, cancelling is instant and free. After payment, requests are reviewed personally under the cancellation policy you accepted — nothing is forfeited automatically. Your approved quote shows any separate mobile-service charge relevant to that review.</p>' +
        '<button class="btn btn-ghost" id="cancelBtn" style="margin-top:12px;">Request cancellation / reschedule</button>' +
        '<p class="form-status" id="cancelStatus" role="status" aria-live="polite"></p></details>';
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

    var requestTimes = document.getElementById("requestNewTimes");
    if (requestTimes) {
      requestTimes.addEventListener("click", function () {
        var status = document.getElementById("requestTimesStatus");
        requestTimes.disabled = true;
        if (status) status.textContent = "Sending…";
        // Deliberately the ordinary message channel: it reaches the owner in
        // the same place as everything else, and leaves a visible record.
        var ask = view && view.quote && view.quote.expired
          ? "My quote has expired before I could book. Could you send a refreshed quote and appointment times?"
          : "None of the offered times work for me (or no times are showing yet) — could you send other appointment options?";
        action({ action: "message", message: ask }, function (r) {
          requestTimes.disabled = false;
          if (r.ok) {
            notice("good", "Message sent — AutoClarity will email you a refreshed offer with appointment times.");
            load();
          } else if (status) {
            status.textContent = (r.body.error && r.body.error.message) || "Couldn’t send — please email support.";
          }
        });
      });
    }

    var changeTime = document.getElementById("changeTimeBtn");
    if (changeTime) {
      changeTime.addEventListener("click", function () {
        action({ action: "message", message: "I'd like to choose a different appointment time for this inspection." }, function (r) {
          if (r.ok) { notice("good", "Message sent — AutoClarity will release your hold and send fresh times."); load(); }
          else notice("warn", (r.body.error && r.body.error.message) || "Couldn’t send — please email support.");
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
