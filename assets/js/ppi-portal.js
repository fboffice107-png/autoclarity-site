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
        notice("good", "Payment confirmed — your appointment is booked. A confirmation email is on its way.");
      }
      render();
    }).catch(function () {
      if (!quiet) showError("Network problem — please refresh.");
    });
  }

  function showError(msg) {
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

  var STATUS_KIND = {
    submitted: "", needs_info: "warn", seller_access_pending: "warn", ready_for_review: "",
    quote_prepared: "", quote_sent: "good", awaiting_time_selection: "good",
    awaiting_agreement: "warn", awaiting_payment: "warn", confirmed: "good",
    inspection_in_progress: "good", report_in_progress: "good", completed: "good",
    customer_cancelled: "bad", admin_cancelled: "bad", expired: "bad", refunded: "", disputed: "bad"
  };

  function render() {
    elLoading.hidden = true;
    elError.hidden = true;
    elContent.hidden = false;

    var v = view;
    var html = "";

    html += '<div class="portal-topbar">' +
      "<h1>Request " + esc(v.ref) + "</h1>" +
      '<span class="status-pill ' + (STATUS_KIND[v.status] || "") + '">' + esc(v.statusLabel) + "</span>" +
      "</div>";

    // ---------- summary ----------
    html += '<section class="portal-card"><h2>Vehicle &amp; location</h2><dl class="kv">' +
      "<dt>Vehicle</dt><dd>" + esc([v.vehicle.year, v.vehicle.make, v.vehicle.model, v.vehicle.trim].filter(Boolean).join(" ")) + "</dd>" +
      "<dt>VIN</dt><dd>" + esc(v.vehicle.vin || "Not provided yet — required before the appointment is finalized") + "</dd>" +
      "<dt>Inspection area</dt><dd>" + esc([v.location.street, v.location.city, v.location.state, v.location.zip].filter(Boolean).join(", ")) + "</dd>" +
      "</dl></section>";

    // ---------- status-specific guidance ----------
    var guidance = {
      submitted: "AutoClarity is reviewing your request. You’ll normally hear back the same day, and never later than 24 hours.",
      needs_info: "AutoClarity needs a little more information — check the messages below and reply there.",
      seller_access_pending: "Waiting on the seller to confirm access to the vehicle. You’ll be notified the moment it’s cleared.",
      ready_for_review: "Your request is in review — your exact quote is on its way.",
      quote_prepared: "Your quote is being finalized.",
      quote_sent: "Your exact price is ready below. Choose an appointment window to continue.",
      awaiting_time_selection: "Choose one of the offered appointment windows below.",
      awaiting_agreement: "Almost there — review and accept the service agreements below.",
      awaiting_payment: "Last step: secure payment reserves your appointment time.",
      confirmed: "You’re booked. The technician will meet the vehicle at the scheduled time.",
      inspection_in_progress: "Your inspection is underway.",
      report_in_progress: "The inspection is done — your written results are being prepared.",
      completed: "Your inspection is complete. Your results are in the messages below.",
      customer_cancelled: "This request was cancelled.",
      admin_cancelled: "This request was cancelled by AutoClarity.",
      expired: "This request expired. Submit a new one whenever you’re ready.",
      refunded: "This request was refunded.",
      disputed: "This payment is under dispute review."
    };
    if (guidance[v.status]) {
      html += '<div class="notice info">' + esc(guidance[v.status]) + "</div>";
    }

    // ---------- quote ----------
    if (v.quote) {
      html += '<section class="portal-card"><h2>Your quote</h2>';
      if (v.quote.expired && v.status !== "confirmed" && v.status !== "completed") {
        html += '<div class="notice warn">This quote expired ' + esc(fmtWhen(v.quote.expiresAt)) + ". AutoClarity will refresh it — no action needed.</div>";
      }
      html += '<table class="line-items">';
      v.quote.lines.forEach(function (l) {
        html += "<tr><td>" + esc(l.label) + "</td><td>" + (l.kind === "discount" ? "−" : "") + money(Math.abs(l.amountCents)) + "</td></tr>";
      });
      html += '<tr class="total"><td>Total</td><td>' + money(v.quote.totalCents) + "</td></tr></table>";
      if (v.quote.customerNote) html += '<p style="margin-top:12px;color:var(--text-2);font-size:14.5px;">' + esc(v.quote.customerNote) + "</p>";
      if (!v.quote.expired && (v.status === "quote_sent" || v.status === "awaiting_time_selection")) {
        html += '<p class="field-hint">Quote valid until ' + esc(fmtWhen(v.quote.expiresAt)) + ".</p>";
      }
      html += "</section>";
    }

    // ---------- slots ----------
    var offered = v.slots.filter(function (s) { return s.status === "offered"; });
    var held = v.slots.filter(function (s) { return s.status === "held"; })[0];
    var confirmedSlot = v.slots.filter(function (s) { return s.status === "confirmed"; })[0];

    if ((v.status === "quote_sent" || v.status === "awaiting_time_selection") && offered.length > 0 && v.quote && !v.quote.expired) {
      html += '<section class="portal-card"><h2>Choose your appointment</h2><div class="slot-list">';
      offered.forEach(function (s) {
        html += '<button type="button" class="slot-btn" data-slot="' + esc(s.id) + '">' + esc(fmtWhen(s.startsAt)) +
          '<span class="slot-sub">Selecting holds this time for you while you finish booking</span></button>';
      });
      html += "</div></section>";
    }

    if (held && (v.status === "awaiting_agreement" || v.status === "awaiting_payment")) {
      html += '<div class="notice good">Held for you: ' + esc(fmtWhen(held.startsAt)) +
        (held.holdExpiresAt ? " — complete booking by " + esc(fmtWhen(held.holdExpiresAt)) : "") + "</div>";
    }

    // ---------- agreements ----------
    if (v.status === "awaiting_agreement") {
      html += '<section class="portal-card"><h2>Service agreements</h2>' +
        '<p style="color:var(--text-2);font-size:14.5px;margin-bottom:12px;">Please open and accept each document. One typed signature covers all of them.</p>' +
        '<form id="agreeForm">';
      v.agreements.required.forEach(function (doc) {
        html += '<details class="agree-doc"><summary>' + esc(doc.title) + ' <span class="opt">(v' + doc.version + ')</span></summary>' +
          '<div class="agree-body">' + esc(doc.bodyMd) + "</div></details>" +
          '<div class="agree-check"><input type="checkbox" id="agree_' + esc(doc.id) + '" data-agree="' + esc(doc.id) + '" />' +
          '<label for="agree_' + esc(doc.id) + '">I have read and accept the ' + esc(doc.title) + "</label></div>";
      });
      html += '<div class="field" style="margin-top:14px;"><label for="typedName">Type your full legal name to sign</label>' +
        '<input id="typedName" type="text" maxlength="120" autocomplete="name" /></div>' +
        '<button class="btn btn-primary btn-lg" type="submit" style="width:100%;">Accept and continue</button>' +
        '<p class="form-status" id="agreeStatus" role="status" aria-live="polite"></p></form></section>';
    }

    // ---------- payment ----------
    if (v.status === "awaiting_payment") {
      html += '<section class="portal-card"><h2>Payment</h2>' +
        '<p style="color:var(--text-2);font-size:15px;">Full payment reserves the approved appointment time. Your appointment is not confirmed until payment is successfully completed.</p>' +
        '<button class="btn btn-primary btn-lg" id="checkoutBtn" style="width:100%;margin-top:14px;">Pay securely with Stripe' +
        (v.quote ? " — " + money(v.quote.totalCents) : "") + "</button>" +
        '<p class="form-status" id="checkoutStatus" role="status" aria-live="polite"></p></section>';
    }

    // ---------- confirmed booking ----------
    if (v.booking && v.booking.status === "confirmed" && confirmedSlot) {
      html += '<section class="portal-card"><h2>Your appointment</h2><dl class="kv">' +
        "<dt>When</dt><dd>" + esc(fmtWhen(confirmedSlot.startsAt)) + "</dd>" +
        "<dt>Where</dt><dd>" + esc([v.location.street, v.location.city].filter(Boolean).join(", ")) + "</dd></dl>" +
        '<p style="margin-top:14px;"><a class="btn btn-ghost" href="/api/portal/calendar?t=' + encodeURIComponent(token) + '">Add to calendar (.ics)</a></p></section>';
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
    var terminal = ["customer_cancelled", "admin_cancelled", "expired", "refunded", "completed", "disputed"];
    if (terminal.indexOf(v.status) === -1) {
      html += '<section class="portal-card"><h2>Need to cancel or reschedule?</h2>' +
        '<p style="color:var(--text-2);font-size:14.5px;">Before payment, cancelling is instant and free. After payment, requests are reviewed personally under the cancellation policy you accepted — nothing is forfeited automatically.</p>' +
        '<button class="btn btn-ghost" id="cancelBtn" style="margin-top:12px;">Request cancellation / reschedule</button>' +
        '<p class="form-status" id="cancelStatus" role="status" aria-live="polite"></p></section>';
    }

    elContent.innerHTML = html;
    bindActions();
  }

  function bindActions() {
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
})();
