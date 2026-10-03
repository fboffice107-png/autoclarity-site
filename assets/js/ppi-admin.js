/* AutoClarity — PPI admin dashboard (single-owner tool).
   Auth: Cloudflare Access in production (transparent), ADMIN_DEV_KEY in
   preview via sessionStorage. All data comes from /api/admin/*. */
(function () {
  "use strict";

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var KEY_STORE = "ppi-admin-key";
  var content = document.getElementById("adminContent");
  var nav = document.getElementById("adminNav");
  var loginPanel = document.getElementById("loginPanel");
  var currentView = "overview";
  var currentRequestId = null;
  var detailCache = null;
  var requestListNotice = "";
  var showTestRecords = (function () {
    try { return sessionStorage.getItem("ppi-show-test") === "1"; } catch (e) { return false; }
  })();
  var reportEditor = null;
  var uploadBlobUrls = [];
  function leaveDetail() {
    if (reportEditor && !reportEditor.canLeave()) return false;
    // An unsent proposal draft is kept, not discarded — say so rather than
    // letting typed work disappear on a back click.
    if (currentRequestId && document.getElementById("bookingProposal") && readDraft()) {
      requestListNotice = "Your unsent booking proposal draft was kept. Reopen the request to finish it.";
    }
    if (reportEditor) reportEditor.dispose();
    reportEditor = null;
    uploadBlobUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    uploadBlobUrls = [];
    return true;
  }
  var requestedRequestId = (function () {
    try {
      var value = new URL(window.location.href).searchParams.get("request") || "";
      return /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? value : "";
    } catch (e) { return ""; }
  })();

  function setRequestUrl(id) {
    try {
      var url = new URL(window.location.href);
      if (id) url.searchParams.set("request", id);
      else url.searchParams.delete("request");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch (e) {}
  }

  function adminKey() {
    try { return sessionStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; }
  }

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers || {});
    options.cache = "no-store";
    var key = adminKey();
    if (key) options.headers["authorization"] = "Bearer " + key;
    return fetch(path, options).then(function (res) {
      // An expired session must not erase an in-memory inspection draft.
      // The editor retains its controls and offers an explicit recovery copy.
      if (res.status === 401 && !reportEditor) { showLogin(); throw new Error("unauthorized"); }
      return res.json().then(function (body) { return { status: res.status, ok: res.ok, body: body }; });
    });
  }

  function showLogin() {
    loginPanel.hidden = false;
    nav.hidden = true;
    content.innerHTML = "";
  }

  function doLogin(e) {
    if (e) e.preventDefault();
    var key = document.getElementById("adminKey").value.trim();
    try { sessionStorage.setItem(KEY_STORE, key); } catch (err) {}
    document.getElementById("loginStatus").textContent = "Checking…";
    boot();
  }
  document.getElementById("loginForm").addEventListener("submit", doLogin);
  // Some embedded webviews swallow implicit form submission — cover both paths.
  document.querySelector("#loginForm button[type=submit]").addEventListener("click", doLogin);

  nav.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function (event) {
      if (!leaveDetail()) { event.preventDefault(); return; }
      if (btn.tagName === "A") return;
      nav.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      currentRequestId = null;
      setRequestUrl("");
      show(btn.getAttribute("data-view"));
    });
  });

  boot();

  function boot() {
    api("/api/admin/overview").then(function (r) {
      if (!r.ok) { showLogin(); return; }
      loginPanel.hidden = true;
      nav.hidden = false;
      if (requestedRequestId) {
        var id = requestedRequestId;
        requestedRequestId = "";
        nav.querySelectorAll(".tab-btn").forEach(function (b) {
          b.classList.toggle("active", b.getAttribute("data-view") === "requests");
        });
        openDetail(id);
      } else {
        show("overview", r.body);
      }
    }).catch(function () {});
  }

  function show(view, preloaded) {
    currentView = view;
    if (view === "overview") renderOverview(preloaded);
    if (view === "requests") renderRequests();
    if (view === "config") renderConfig();
  }

  function esc(s) {
    // Escapes &<> AND quotes, so values interpolated into attributes cannot
    // break out of them (textContent alone leaves " and ' intact).
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function money(cents) { return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }); }
  function when(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function safeListingUrl(value) {
    try { var url = new URL(value); return /^https?:$/.test(url.protocol) ? url.href : ""; }
    catch (e) { return ""; }
  }

  function refundStatusGuidance(status) {
    if (status === "requested" || status === "pending") return "Stripe is still processing this refund. Do not retry while it is pending.";
    if (status === "requires_action") return "Action required in Stripe. Review the refund there before retrying.";
    if (status === "failed") return "Failed in Stripe. Verify the failure, then use Refund… to explicitly retry this operation.";
    if (status === "canceled") return "Canceled in Stripe. Verify it was not paid out, then use Refund… to explicitly retry.";
    if (status === "reconciliation_required") return "Manual reconciliation required. Check Stripe before taking any further refund action.";
    if (status === "confirmed") return "Confirmed by Stripe. No further action is needed.";
    if (status === "provider_accepted") return "Accepted by Stripe; confirmation is still pending. Do not retry.";
    return "Unknown refund state. Review Stripe before taking further action.";
  }

  function attributionLabel(source) {
    var value = String(source || "ppi_unknown");
    if (value === "ppi_unknown") return "Unknown / unattributed";
    if (value === "ppi_direct") return "Direct";
    if (value === "ppi_ios_app") return "AutoClarity iOS app";
    return value.replace(/^ppi_/, "").replace(/_/g, " ");
  }

  function reportedRate(value, denominator) {
    if (Number(denominator || 0) < 20 || value == null) return "— (<20 sample)";
    return Number(value).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "%";
  }

  /* ============ Stage: what this request actually needs ============
     Derived only from saved state. Every label answers "who acts next",
     because that is the question being asked when the list is opened. */
  var STAGE_BY_STATUS = {
    submitted: { label: "Needs your review", kind: "act", who: "You" },
    needs_info: { label: "Needs your review — you asked the customer a question", kind: "wait", who: "Customer" },
    seller_access_pending: { label: "Waiting on seller access", kind: "wait", who: "Seller" },
    ready_for_review: { label: "Needs your review", kind: "act", who: "You" },
    quote_prepared: { label: "Draft saved — not sent yet", kind: "act", who: "You" },
    quote_sent: { label: "Waiting for customer to choose a time", kind: "wait", who: "Customer" },
    awaiting_time_selection: { label: "Waiting for customer to choose a time", kind: "wait", who: "Customer" },
    awaiting_agreement: { label: "Time selected — awaiting agreements", kind: "wait", who: "Customer" },
    awaiting_payment: { label: "Time selected — awaiting payment", kind: "wait", who: "Customer" },
    confirmed: { label: "Paid — appointment confirmed", kind: "good", who: "You, at the appointment" },
    inspection_in_progress: { label: "Inspection in progress", kind: "good", who: "You" },
    report_in_progress: { label: "Report in progress", kind: "act", who: "You" },
    completed: { label: "Completed", kind: "good", who: "Nobody — done" },
    customer_cancelled: { label: "Cancelled by customer", kind: "off", who: "Nobody" },
    admin_cancelled: { label: "Cancelled by you", kind: "off", who: "Nobody" },
    expired: { label: "Expired", kind: "off", who: "Nobody" },
    refunded: { label: "Refunded", kind: "off", who: "Nobody" },
    refund_reconciliation_needed: { label: "Refund needs reconciling", kind: "alert", who: "You" },
    disputed: { label: "Payment disputed", kind: "alert", who: "You" }
  };

  /* Two saved states deserve a louder label than their status alone gives:
     a proposal that was never delivered, and a payment whose time is gone. */
  function stageOf(row) {
    var base = STAGE_BY_STATUS[row.status] || { label: String(row.status || "").replace(/_/g, " "), kind: "", who: "—" };
    var stage = { label: base.label, kind: base.kind, who: base.who };
    if ((row.status === "quote_sent" || row.status === "awaiting_time_selection")
      && Number(row.offered_slot_count || 0) === 0
      && !row.paid_amount_cents) {
      stage.label = "Proposal sent without times — customer cannot book";
      stage.kind = "alert";
      stage.who = "You";
    }
    if (row.status === "awaiting_time_selection" && row.paid_amount_cents) {
      stage.label = "Paid — scheduling needs attention";
      stage.kind = "alert";
      stage.who = "You";
    }
    // An offer the customer can no longer act on is YOUR move, not theirs.
    // Saying "waiting for customer" here is what let a stale quote sit until
    // the customer gave up and cancelled.
    if (!row.paid_amount_cents && ["quote_sent", "awaiting_time_selection", "awaiting_agreement", "awaiting_payment"].indexOf(row.status) !== -1) {
      var expired = row.current_quote_expires_at && new Date(row.current_quote_expires_at).getTime() < Date.now();
      var noTimeLeft = Number(row.offered_slot_count || 0) === 0 && Number(row.held_slot_count || 0) === 0;
      if (expired || (noTimeLeft && row.current_total_cents)) {
        stage.label = expired ? "Offer expired — re-send to continue" : "Offer has no times left — re-send";
        stage.kind = "alert";
        stage.who = "You";
      }
    }
    if (row.proposal_notification_status === "failed") {
      stage.label = stage.label + " · email not delivered";
      stage.kind = "alert";
      stage.who = "You";
    }
    return stage;
  }

  var TIER_SHORT = {
    standard: "Standard $199",
    euro_luxury_performance: "Luxury & Performance $299",
    exotic_collector: "Exotic / Collector $399"
  };
  function tierLabel(key) { return TIER_SHORT[key] || "Package not set"; }


  /* Does this request carry a reason that needs a decision, as opposed to a
     note about how its tier was reached? Only the former is worth flagging. */
  function hasReviewReason(storedJson) {
    if (!storedJson || storedJson === "[]") return false;
    try {
      return JSON.parse(storedJson).some(function (r) { return String(r).indexOf("tier: ") !== 0; });
    } catch (e) { return false; }
  }

  function stagePill(stage) {
    return '<span class="stage-pill stage-' + esc(stage.kind || "none") + '">' + esc(stage.label) + "</span>";
  }

  /* Weekday + date + explicit AM/PM, Las Vegas time, on the admin side too. */
  function whenLong(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true
    });
  }

  function appointmentSummary(row) {
    if (row.confirmed_starts_at) return "Confirmed · " + whenLong(row.confirmed_starts_at);
    if (row.held_starts_at) return "Held (unpaid) · " + whenLong(row.held_starts_at);
    var n = Number(row.offered_slot_count || 0);
    if (n > 0) return n + " time" + (n === 1 ? "" : "s") + " offered";
    return "No times offered";
  }

  function paymentSummary(row) {
    if (row.paid_amount_cents) return money(row.paid_amount_cents) + " paid";
    if (row.payment_status) return String(row.payment_status).replace(/_/g, " ");
    return "Not paid";
  }

  /* ================= Overview ================= */
  function renderOverview(preloaded) {
    var proceed = function (data) {
      var counts = {};
      (data.statusCounts || []).forEach(function (row) { counts[row.status] = row.n; });
      function c(list) { return list.reduce(function (sum, s) { return sum + (counts[s] || 0); }, 0); }

      var html = '<div class="admin-grid">' +
        stat(c(["submitted"]), "New requests") +
        stat(c(["needs_info"]), "Needs info") +
        stat(c(["seller_access_pending"]), "Seller access") +
        stat(c(["quote_sent", "awaiting_time_selection"]), "Quotes out") +
        stat(c(["awaiting_agreement", "awaiting_payment"]), "Awaiting payment") +
        stat(c(["confirmed"]), "Confirmed") +
        stat(c(["completed"]), "Completed") +
        notificationStat(data.notificationIssues || 0) +
        "</div>";

      var revenueWindows = data.revenueWindows || [];
      html += '<section class="portal-card"><h2>Verified service and payment scoreboard</h2>' +
        '<p style="color:var(--text-2);">These windows report exact events present in this system, not AutoClarity’s all-time operating history. A zero does not prove that no real paid or completed PPI occurred. “Ready for review” is a workflow state, not an owner-verified genuine lead. Money columns are current outcomes for payments first confirmed in each window; “Post-refund/dispute collected” subtracts recorded refunds and conservatively excludes balances still latched as disputed. It is not profit. Lead labels never remove payment, booking, or completion evidence from these totals.</p>';
      if (!revenueWindows.length) {
        html += '<p style="color:var(--text-3);">No scoreboard data is available.</p>';
      } else {
        html += '<div style="overflow-x:auto;"><table class="admin-table"><thead><tr><th>Window</th><th>Saved</th><th>Ready for review</th><th>Quoted</th><th>Checkouts</th><th>Paid</th><th>Booked</th><th>Completed</th><th>Refunds</th><th>Dispute cases</th><th>Gross</th><th>Refunded</th><th>Disputed</th><th>Post-refund/dispute collected</th><th>Avg ticket</th><th>App Store clicks</th></tr></thead><tbody>';
        revenueWindows.forEach(function (window) {
          var s = window.operations || {};
          var p = window.paymentCohort || {};
          html += "<tr><td><strong>" + esc(window.days) + " days</strong></td><td>" + esc(s.saved_requests) +
            "</td><td>" + esc(s.ready_for_review_requests) + "</td><td>" + esc(s.quoted_requests) +
            "</td><td>" + esc(s.checkout_starts) + "</td><td>" + esc(s.successful_payments) +
            "</td><td>" + esc(s.confirmed_bookings) + "</td><td>" + esc(s.completed_inspections) +
            "</td><td>" + esc(s.successful_refunds) + "</td><td>" + esc(s.dispute_cases_opened) +
            "</td><td>" + esc(money(p.gross_collected_cents || 0)) + "</td><td>" + esc(money(p.refunded_cents || 0)) +
            "</td><td>" + esc(money(p.disputed_excluded_cents || 0)) + "</td><td>" + esc(money(p.recognized_net_cents || 0)) +
            "</td><td>" + esc(p.average_paid_ticket_cents == null ? "—" : money(p.average_paid_ticket_cents)) +
            "</td><td>" + esc(window.appStoreOutboundClicks || 0) + "</td></tr>";
        });
        html += "</tbody></table></div>";
        var missingPaymentTimes = revenueWindows.reduce(function (largest, window) {
          return Math.max(largest, Number((window.dataQuality || {}).capturedPaymentsMissingConfirmationEvent || 0));
        }, 0);
        if (missingPaymentTimes) {
          html += '<div class="notice warn">' + esc(missingPaymentTimes) +
            ' captured payment cohort record(s) lack a deterministic server confirmation event across these overlapping windows. They are excluded from time-based gross/net until reconciled.</div>';
        }
      }
      html += "</section>";

      html += '<section class="portal-card"><h2>Request cohorts by source</h2>' +
        '<p style="color:var(--text-2);">Each table follows requests first saved in its window through their current outcomes. First touch is client-derived and reduced to an exact allowlist; it is directional, not independently verified. Missing sources appear as “Unknown / unattributed,” while an observed direct visit appears as “Direct.”</p>';
      revenueWindows.forEach(function (window) {
        var rows = window.sources || [];
        html += '<details' + (window.days === 30 ? " open" : "") + '><summary><strong>' + esc(window.days) + '-day source cohorts</strong></summary>';
        if (!rows.length) {
          html += '<p style="color:var(--text-3);">No requests in this period.</p>';
        } else {
          html += '<div style="overflow-x:auto;"><table class="admin-table"><thead><tr><th>Source</th><th>Requests</th><th>Ready for review</th><th>Quoted</th><th>Checkouts</th><th>Paid</th><th>Paid rate</th><th>Booked</th><th>Completed</th><th>Complete rate</th><th>Refunds</th><th>Disputes</th><th>Gross</th><th>Refunded</th><th>Disputed</th><th>Post-refund/dispute collected</th><th>Avg ticket</th></tr></thead><tbody>';
          rows.forEach(function (row) {
            html += "<tr><td>" + esc(attributionLabel(row.source)) + "</td><td>" + esc(row.requests) +
              "</td><td>" + esc(row.ready_for_review) + "</td><td>" + esc(row.quoted) +
              "</td><td>" + esc(row.checkouts) + "</td><td>" + esc(row.paid) +
              "</td><td>" + esc(reportedRate(row.request_to_paid_rate, row.requests)) + "</td><td>" + esc(row.bookings) +
              "</td><td>" + esc(row.completed) + "</td><td>" + esc(reportedRate(row.request_to_completed_rate, row.requests)) +
              "</td><td>" + esc(row.refund_count) + "</td><td>" + esc(row.dispute_cases) +
              "</td><td>" + esc(money(row.gross_cents || 0)) +
              "</td><td>" + esc(money(row.refunded_cents || 0)) + "</td><td>" + esc(money(row.disputed_excluded_cents || 0)) +
              "</td><td>" + esc(money(row.recognized_net_cents || 0)) + "</td><td>" +
              esc(row.average_paid_ticket_cents == null ? "—" : money(row.average_paid_ticket_cents)) + "</td></tr>";
          });
          html += "</tbody></table></div>";
        }
        html += "</details>";
      });
      html += "</section>";

      var notificationRequests = data.notificationIssueRequests || [];
      if (notificationRequests.length) {
        html += '<section class="portal-card" id="notificationIssuesPanel" tabindex="-1">' +
          '<h2>Notifications needing attention</h2>' +
          '<p style="color:var(--text-2);">Open an affected request and review its Messages section to retry delivery. ' +
          'If no failed email row appears, the message or secure link was never queued; verify contact manually and send a fresh message from the request.</p>' +
          '<table class="admin-table"><thead><tr><th>Request</th><th>Issue</th><th>Source</th><th>Latest</th></tr></thead><tbody>';
        notificationRequests.forEach(function (issue) {
          var kinds = (issue.kinds || []).join(", ");
          var sources = (issue.sourceActions || []).map(function (source) { return String(source).replace(/_/g, " "); }).join(", ");
          html += '<tr data-req="' + esc(issue.requestId) + '"><td><strong>' + esc(issue.ref || issue.requestId) + '</strong></td>' +
            '<td>' + esc(kinds || "notification failure") + (issue.issueCount > 1 ? " · " + esc(issue.issueCount) + " signals" : "") + '</td>' +
            '<td>' + esc(sources || "email") + '</td><td class="mono">' + esc(when(issue.latestAt)) + "</td></tr>";
        });
        html += "</tbody></table></section>";
      }

      html += '<section class="portal-card"><h2>Upcoming appointments</h2>';
      if ((data.upcoming || []).length === 0) html += '<p style="color:var(--text-3);">None scheduled.</p>';
      else {
        html += '<table class="admin-table"><thead><tr><th>When</th><th>Ref</th><th>Vehicle</th></tr></thead><tbody>';
        data.upcoming.forEach(function (u) {
          html += '<tr data-req="' + esc(u.id) + '"><td>' + esc(when(u.starts_at)) + "</td><td>" + esc(u.ref) + "</td><td>" +
            esc([u.year, u.make, u.model].filter(Boolean).join(" ")) + "</td></tr>";
        });
        html += "</tbody></table>";
      }
      html += "</section>";

      html += '<section class="portal-card"><h2>Interaction counters (30 days)</h2>' +
        '<p style="color:var(--text-2);">Useful for diagnosing the page journey. These counters do not prove an install, purchase, or completed inspection.</p><div class="admin-grid">';
      var funnelOrder = ["ppi_page_view", "ppi_form_started", "ppi_form_completed", "ppi_request_submitted", "request_confirmation_viewed", "ppi_quote_sent", "ppi_slot_selected", "ppi_agreement_accepted", "ppi_checkout_started", "ppi_booking_confirmed"];
      var fmap = {};
      (data.funnel30d || []).forEach(function (f) { fmap[f.event] = f.n; });
      funnelOrder.forEach(function (ev) {
        html += stat(fmap[ev] || 0, ev.replace("ppi_", "").replace(/_/g, " "));
      });
      html += "</div></section>";

      html += '<section class="portal-card"><h2>Recent activity</h2><ul class="msg-list">';
      (data.activity || []).forEach(function (a) {
        html += "<li>" + esc(a.ref) + " → <strong>" + esc(a.to_status) + "</strong>" +
          (a.reason ? " — " + esc(a.reason) : "") +
          '<span class="msg-meta">' + esc(a.actor) + " · " + esc(when(a.created_at)) + "</span></li>";
      });
      html += "</ul></section>";

      html += '<section class="portal-card"><h2>Preview tools</h2>' +
        '<button class="btn btn-ghost" id="seedBtn">Seed preview fixtures</button>' +
        ' <span class="form-status" id="seedStatus"></span></section>';

      content.innerHTML = html;
      var notificationBtn = document.getElementById("notificationIssuesBtn");
      if (notificationBtn) notificationBtn.addEventListener("click", function () {
        var panel = document.getElementById("notificationIssuesPanel");
        if (panel) {
          panel.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "start" });
          panel.focus();
          return;
        }
        requestListNotice = (data.notificationIssues || 0) + " recent request " +
          ((data.notificationIssues || 0) === 1 ? "needs" : "need") +
          " notification attention. Open a recent request and review its Messages section to retry delivery.";
        nav.querySelectorAll(".tab-btn").forEach(function (b) {
          b.classList.toggle("active", b.getAttribute("data-view") === "requests");
        });
        currentRequestId = null;
        setRequestUrl("");
        show("requests");
      });
      content.querySelectorAll("[data-req]").forEach(function (tr) {
        tr.addEventListener("click", function () { openDetail(tr.getAttribute("data-req")); });
      });
      var seedBtn = document.getElementById("seedBtn");
      if (seedBtn) seedBtn.addEventListener("click", function () {
        document.getElementById("seedStatus").textContent = "Seeding…";
        api("/api/admin/seed", { method: "POST" }).then(function (r) {
          document.getElementById("seedStatus").textContent = r.ok ? "Created " + r.body.created.length + " fixtures." : (r.body.error && r.body.error.message) || "Failed.";
        }).catch(function () {});
      });
    };
    if (preloaded) proceed(preloaded);
    else api("/api/admin/overview").then(function (r) { if (r.ok) proceed(r.body); }).catch(function () {});
  }

  function stat(num, label) {
    return '<div class="stat-card"><div class="stat-num">' + esc(num) + '</div><div class="stat-label">' + esc(label) + "</div></div>";
  }

  function notificationStat(count) {
    if (!count) return stat(0, "Notification issues");
    return '<button class="stat-card stat-card-action stat-card-alert" id="notificationIssuesBtn" type="button" ' +
      'aria-label="Review ' + esc(count) + ' notification issues in recent requests">' +
      '<span class="stat-num">' + esc(count) + '</span><span class="stat-label">Notification issues</span>' +
      '<span class="stat-hint">Review recent requests →</span></button>';
  }

  /* ================= Requests list ================= */
  function renderRequests() {
    var html = requestListNotice ? '<div class="notice warn">' + esc(requestListNotice) + "</div>" : "";
    requestListNotice = "";
    html += '<div class="admin-toolbar"><label for="statusFilter" class="sr-only">Filter by status</label>' +
      '<select id="statusFilter"><option value="">All statuses</option>' +
      ["submitted", "needs_info", "seller_access_pending", "ready_for_review", "quote_prepared", "quote_sent", "awaiting_time_selection", "awaiting_agreement", "awaiting_payment", "confirmed", "inspection_in_progress", "report_in_progress", "completed", "customer_cancelled", "admin_cancelled", "expired", "refunded", "refund_reconciliation_needed", "disputed"]
        .map(function (s) { return '<option value="' + s + '">' + s.replace(/_/g, " ") + "</option>"; }).join("") +
      '</select>' +
      '<label class="chip' + (showTestRecords ? " on" : "") + '" id="testToggleChip">' +
      '<input type="checkbox" id="testToggle"' + (showTestRecords ? " checked" : "") + ' />Show test records</label>' +
      '</div><div id="requestsTable"></div>';
    content.innerHTML = html;
    document.getElementById("statusFilter").addEventListener("change", loadList);
    document.getElementById("testToggle").addEventListener("change", function (e) {
      showTestRecords = e.target.checked;
      try { sessionStorage.setItem("ppi-show-test", showTestRecords ? "1" : "0"); } catch (err) {}
      document.getElementById("testToggleChip").classList.toggle("on", showTestRecords);
      loadList();
    });
    loadList();

    function loadList() {
      var filter = document.getElementById("statusFilter").value;
      var params = [];
      if (filter) params.push("status=" + encodeURIComponent(filter));
      if (showTestRecords) params.push("include=test");
      api("/api/admin/requests" + (params.length ? "?" + params.join("&") : "")).then(function (r) {
        if (!r.ok) return;
        var rows = r.body.requests || [];
        var t = '<section class="admin-job-list" aria-label="Inspection requests">';
        rows.forEach(function (row) {
          var manual = hasReviewReason(row.manual_review_reasons);
          var stage = stageOf(row);
          var pkg = row.current_tier || row.customer_selected_tier || row.suggested_tier;
          var priceText = row.current_total_cents
            ? money(row.current_total_cents) + " offered"
            : tierLabel(pkg) + " (not quoted yet)";
          var isTest = row.record_kind === "test";
          // Green is reserved for money that actually arrived.
          var paidReal = !isTest && row.paid_amount_cents;
          var cls = "portal-card admin-job-card stage-edge-" + (stage.kind || "none")
            + (isTest ? " job-card-test" : "") + (paidReal ? " job-card-paid" : "");
          t += '<button type="button" class="' + esc(cls) + '" data-req="' + esc(row.id) + '">' +
            '<span class="job-card-top"><strong>' + esc([row.year, row.make, row.model].filter(Boolean).join(" ") || "Vehicle not set") + '</strong>' +
            (isTest ? '<span class="kind-chip kind-test">Test record</span>' : "") +
            (paidReal ? '<span class="kind-chip kind-paid">' + esc(money(row.paid_amount_cents)) + ' collected</span>' : "") +
            stagePill(stage) + '</span>' +
            '<span class="job-card-grid">' +
              '<span><span class="job-k">Customer</span>' + esc(row.full_name) + '</span>' +
              '<span><span class="job-k">Where</span>' + esc([row.loc_city, row.loc_zip].filter(Boolean).join(" ") || "—") + '</span>' +
              '<span><span class="job-k">Price</span>' + esc(priceText) + '</span>' +
              '<span><span class="job-k">Appointment</span>' + esc(appointmentSummary(row)) + '</span>' +
              '<span><span class="job-k">Payment</span>' + esc(paymentSummary(row)) + '</span>' +
              '<span><span class="job-k">Next move</span>' + esc(stage.who) + '</span>' +
            '</span>' +
            '<span class="msg-meta">' + esc(row.ref) + ' · created ' + esc(when(row.created_at)) +
              (manual ? ' · needs a look' : "") + (row.same_day_priority ? ' · same-day priority' : "") +
              (Number(row.tier_review_needed) === 1 ? ' · package to confirm' : "") + '</span></button>';
        });
        t += (rows.length === 0
          ? '<p style="color:var(--text-3);padding:12px 0 0;">No requests.</p>'
          : "") + "</section>";
        if (!r.body.includingTest && r.body.hiddenTestCount) {
          t += '<p class="field-hint" style="margin-top:12px;">' + esc(r.body.hiddenTestCount) +
            ' test record' + (r.body.hiddenTestCount === 1 ? "" : "s") +
            ' hidden — seeded fixtures and smoke tests. Nothing is deleted; tick “Show test records” to see them.</p>';
        }
        document.getElementById("requestsTable").innerHTML = t;
        document.querySelectorAll("#requestsTable [data-req]").forEach(function (tr) {
          tr.addEventListener("click", function () { openDetail(tr.getAttribute("data-req")); });
        });
      }).catch(function () {});
    }
  }

  /* ============ Booking proposal card ============
     One card, one primary button. The price shown here is calculated by the
     server (price_preview) using the same code that writes the quote, so the
     number on the button is the number that gets charged. */

  var PROPOSAL_DRAFT_PREFIX = "ppi-proposal-draft:";

  function draftKey() { return PROPOSAL_DRAFT_PREFIX + currentRequestId; }

  function readDraft() {
    try { return JSON.parse(sessionStorage.getItem(draftKey()) || "null") || null; }
    catch (e) { return null; }
  }
  function writeDraft(value) {
    try { sessionStorage.setItem(draftKey(), JSON.stringify(value)); } catch (e) {}
  }
  function clearDraft() {
    try { sessionStorage.removeItem(draftKey()); } catch (e) {}
  }

  /* datetime-local wants the operator's wall clock. The business runs on Las
     Vegas time, so quick-fill builds the instant from an America/Los_Angeles
     date and time and hands back a local-input string for that same instant. */
  function vegasOffsetMinutes(atUtcMs) {
    var probe = new Date(atUtcMs);
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).formatToParts(probe).reduce(function (acc, part) { acc[part.type] = part.value; return acc; }, {});
    var asUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
    );
    return (asUtc - probe.getTime()) / 60000;
  }

  /** ISO instant for a Las Vegas wall-clock date/time, DST-correct. */
  function vegasInstant(dateStr, hhmm) {
    var d = dateStr.split("-").map(Number);
    var t = hhmm.split(":").map(Number);
    var naive = Date.UTC(d[0], d[1] - 1, d[2], t[0], t[1], 0);
    // Two passes settle the offset across a DST boundary.
    var guess = naive - vegasOffsetMinutes(naive) * 60000;
    return new Date(naive - vegasOffsetMinutes(guess) * 60000).toISOString();
  }

  /** "YYYY-MM-DDTHH:MM" in the operator's own local time, for the input. */
  function toLocalInput(iso) {
    var d = new Date(iso);
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }




  /* A configured 0 is a real value, not "unset". Written out because
     a falsy-OR default would silently restore the old 18-hour rule. */
  function leadHours(draftCfg) {
    var v = Number(draftCfg && draftCfg.minLeadHours);
    return Number.isFinite(v) && v >= 0 ? v : 18;
  }

  /* Every hour the business will consider offering. The owner ticks a subset;
     nothing here is offered unless it is ticked. */
  var OFFER_HOURS = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];

  /* Must match MAX_OFFERED_SLOTS in functions/lib/booking-proposal.ts. */
  var MAX_OFFERED_PROPOSAL = 40;

  /* The days a proposal may legally offer: past the minimum notice, inside the
     advance window, and on a day the business operates. */
  function offerableDays(draftCfg) {
    var lead = leadHours(draftCfg);
    var maxAdvance = Number(draftCfg.maxAdvanceDays || 21);
    var operating = draftCfg.daysOfOperation || [1, 2, 3, 4, 5, 6];
    var out = [];
    for (var i = 0; i <= maxAdvance; i++) {
      var at = new Date(Date.now() + i * 86400000);
      var iso = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(at);
      // The latest hour on this day must still clear the lead time.
      var latest = vegasInstant(iso, OFFER_HOURS[OFFER_HOURS.length - 1]);
      if (new Date(latest).getTime() < Date.now() + lead * 3600000) continue;
      var weekday = new Date(iso + "T12:00:00Z").getUTCDay();
      if (operating.indexOf(weekday) === -1 || (draftCfg.blackoutDates || []).indexOf(iso) !== -1) continue;
      out.push({
        iso: iso,
        label: new Date(vegasInstant(iso, "12:00")).toLocaleDateString("en-US", {
          timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric"
        })
      });
      if (out.length >= 14) break;
    }
    return out;
  }

  /* Every ticked day x every ticked hour, as ISO instants, minus anything that
     no longer clears the lead time by the moment Send is pressed. */
  function slateInstants(section, draftCfg) {
    var lead = leadHours(draftCfg);
    var floor = Date.now() + lead * 3600000 - 60000;
    var days = [].slice.call(section.querySelectorAll("[data-day]")).filter(function (b) { return b.checked; });
    var hours = [].slice.call(section.querySelectorAll("[data-hour]")).filter(function (b) { return b.checked; });
    var out = [];
    var sundayHours = [].slice.call(section.querySelectorAll("[data-sunday-hour]")).filter(function (b) { return b.checked; });
    days.forEach(function (d) {
      var sunday = new Date(d.getAttribute("data-day") + "T12:00:00Z").getUTCDay() === 0;
      (sunday ? sundayHours : hours).forEach(function (h) {
        var iso = vegasInstant(d.getAttribute("data-day"), h.getAttribute(sunday ? "data-sunday-hour" : "data-hour"));
        if (new Date(iso).getTime() >= floor) out.push(iso);
      });
    });
    out.sort();
    return out;
  }

  function proposalCard(d) {
    var draftCfg = d.proposalDraft || {};
    var saved = readDraft() || {};
    var tier = saved.tier || draftCfg.tier || "standard";
    var proposal = d.proposal;

    var html = '<section class="portal-card proposal-card" id="bookingProposal"><h2>Review &amp; send booking proposal</h2>' +
      '<p class="field-hint">One action: confirm the package, pick times, send. The customer gets a single link that takes them from choosing a time to paying.</p>';

    // ---- what was already sent, and whether it actually went out ----
    if (proposal) {
      var noteKind = proposal.notificationStatus === "sent" ? "good"
        : proposal.notificationStatus === "failed" ? "warn" : "info";
      var noteText = proposal.notificationStatus === "sent"
        ? "Delivered to the customer " + when(proposal.sentAt)
        : proposal.notificationStatus === "queued"
          ? "Saved and queued — the provider has not confirmed delivery yet"
          : proposal.notificationStatus === "failed"
            ? "Saved, but the email was NOT delivered" + (proposal.notificationError ? " (" + proposal.notificationError + ")" : "")
            : "Saved — not sent";
      html += '<div class="notice ' + noteKind + '" id="proposalStatusNote"><strong>Last proposal · ' +
        esc(money(proposal.totalCents)) + '</strong><br />' + esc(noteText) + '<br />' +
        esc("Times offered: " + (proposal.slots.length ? proposal.slots.map(function (s) { return s.label; }).join(" · ") : "none")) +
        '<br /><span class="msg-meta">Saved ' + esc(when(proposal.createdAt)) + '</span></div>';
      if (proposal.notificationStatus !== "sent") {
        html += '<button class="btn btn-ghost btn-sm" data-retry-proposal="' + esc(proposal.id) + '">Retry sending this proposal</button> ' +
          '<span class="field-hint">Reuses the same proposal — it cannot create a second one.</span>';
      }
    }

    // ---- package ----
    html += '<h3>Package</h3>';
    if (draftCfg.customerSelectedTier) {
      html += '<p class="field-hint">Customer chose <strong>' + esc(tierLabel(draftCfg.customerSelectedTier)) + '</strong>.</p>';
    }
    if (draftCfg.tierMismatch) {
      html += '<div class="notice warn">' + esc(draftCfg.tierMismatch.note) + "</div>";
    }
    html += '<p class="field-hint">Suggested: <strong>' + esc(tierLabel(draftCfg.suggestedTier)) + '</strong> — ' + esc(draftCfg.customerReason || "") + "</p>";
    html += '<div class="tier-choice" role="radiogroup" aria-label="Inspection package">';
    (draftCfg.tierOptions || []).forEach(function (opt) {
      html += '<label class="tier-option' + (opt.key === tier ? " selected" : "") + '">' +
        '<input type="radio" name="pTier" value="' + esc(opt.key) + '"' + (opt.key === tier ? " checked" : "") + ' />' +
        '<span class="tier-option-name">' + esc(opt.label) + "</span>" +
        '<span class="tier-option-price">' + esc(money(opt.priceCents)) + "</span>" +
        (opt.key === draftCfg.suggestedTier ? '<span class="tier-option-flag">Suggested</span>' : "") +
        "</label>";
    });
    html += "</div>";

    if ((draftCfg.manualReasons || []).length) {
      html += '<div class="notice warn"><strong>Worth a look before you send</strong><ul>' +
        draftCfg.manualReasons.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul></div>";
    }

    // ---- same-day priority ----
    // Pre-ticked when the customer asked for it on the intake form, because
    // forgetting to charge it is the failure that actually happens. The server
    // drops the fee anyway unless one of the offered times is today, which is
    // what the intake page promises the customer.
    if (draftCfg.sameDayPriorityCents) {
      var sameDayOn = saved.sameDay === undefined
        ? Boolean(draftCfg.sameDayPriority)
        : Boolean(saved.sameDay);
      html += '<h3>Same-day priority</h3>' +
        '<label class="field field-check"><input type="checkbox" id="pSameDay"' + (sameDayOn ? " checked" : "") + ' /> ' +
        '<span>Add the ' + esc(money(draftCfg.sameDayPriorityCents)) + ' same-day priority fee</span></label>' +
        '<p class="field-hint">' +
        (draftCfg.sameDayRequested
          ? "The customer asked for same-day priority on their request."
          : "The customer did not ask for same-day priority.") +
        " Applied only if one of the times you offer below is today — otherwise it is dropped from the total automatically.</p>";
    }

    // ---- itemized price ----
    html += '<h3>Price</h3><div id="proposalPrice">' + priceTable(draftCfg.lines, draftCfg.totalCents) + "</div>" +
      '<p class="field-hint" id="proposalTravelNote">' + esc((draftCfg.travel && draftCfg.travel.basisLabel) || "") +
      " Measured from " + esc(draftCfg.travelOriginLabel || "the AutoClarity service base") + ".</p>" +
      '<div id="proposalReviewNotes">' + reviewNoteHtml(draftCfg.reviewNotes) + "</div>";

    // ---- advanced pricing ----
    html += '<details class="advanced-pricing"' + (saved.advancedOpen ? " open" : "") + '><summary>Advanced pricing</summary>' +
      '<div class="admin-toolbar">' +
      '<label class="field field-inline"><span>Base $ override</span><input id="pBase" inputmode="decimal" placeholder="tier price" value="' + esc(saved.base || "") + '" /></label>' +
      '<label class="field field-inline"><span>Travel $ override</span><input id="pTravel" inputmode="decimal" placeholder="banded" value="' + esc(saved.travel || "") + '" /></label>' +
      '<label class="field field-inline"><span>Add-on label</span><input id="pAddonLabel" value="' + esc(saved.addonLabel || "") + '" /></label>' +
      '<label class="field field-inline"><span>Add-on $</span><input id="pAddon" inputmode="decimal" value="' + esc(saved.addon || "") + '" /></label>' +
      '<label class="field field-inline"><span>Discount $</span><input id="pDiscount" inputmode="decimal" value="' + esc(saved.discount || "") + '" /></label>' +
      '<label class="field field-inline"><span>Discount label</span><input id="pDiscountLabel" value="' + esc(saved.discountLabel || "") + '" /></label>' +
      '<label class="field field-inline"><span>Offer valid (hours)</span><input id="pExpires" inputmode="numeric" placeholder="' + esc(draftCfg.quoteExpiryHours || 48) + '" value="' + esc(saved.expires || "") + '" /></label>' +
      "</div>" +
      '<div class="field"><label for="pInternal">Internal note — never shown to the customer</label>' +
      '<input id="pInternal" value="' + esc(saved.internal || "") + '" /></div></details>';

    // ---- times ----
    // Pick the days, pick the hours, and every combination is offered. The
    // customer chooses one and the rest are released the moment they pay.
    var days = offerableDays(draftCfg);
    var hours = OFFER_HOURS;
    var savedDays = saved.days || days.filter(function (d) { return new Date(d.iso + "T12:00:00Z").getUTCDay() !== 0; }).slice(0, 3).map(function (d) { return d.iso; });
    var savedHours = saved.hours || ["13:00", "15:00"];

    html += '<h3>When can he come?</h3>' +
      '<p class="field-hint">Tick the days and the times. He picks one; the rest are released automatically. ' +
      'Las Vegas time, earliest ' + esc(days.length ? days[0].label : "—") +
      (leadHours(draftCfg) > 0 ? ' (' + esc(leadHours(draftCfg)) + 'h notice)' : '') +
      ', latest ' + esc(days.length ? days[days.length - 1].label : "—") + '.</p>';

    html += '<div class="slate"><div class="slate-group"><span class="slate-label">Days</span><div class="slate-chips">';
    days.forEach(function (d) {
      var on = savedDays.indexOf(d.iso) !== -1;
      html += '<label class="chip' + (on ? " on" : "") + '"><input type="checkbox" data-day="' + esc(d.iso) + '"' + (on ? " checked" : "") + ' />' + esc(d.label) + "</label>";
    });
    html += '</div></div><div class="slate-group"><span class="slate-label">Times</span><div class="slate-chips">';
    hours.forEach(function (h) {
      var on = savedHours.indexOf(h) !== -1;
      html += '<label class="chip' + (on ? " on" : "") + '"><input type="checkbox" data-hour="' + esc(h) + '"' + (on ? " checked" : "") + ' />' + esc(pretty12(h)) + "</label>";
    });
    html += '</div></div>' +
      '<div class="slate-actions">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-slate="workday">Every hour 10\u201317</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-slate="afternoons">Afternoons only</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-slate="clear">Clear</button>' +
      "</div></div>";
    if (draftCfg.sundayEligible) {
      html += '<div class="slate-group"><span class="slate-label">Sunday times</span><div class="slate-chips">';
      (draftCfg.slotTemplates || []).forEach(function (h) {
        var on = (saved.sundayHours || []).indexOf(h) !== -1;
        html += '<label class="chip' + (on ? ' on' : '') + '"><input type="checkbox" data-sunday-hour="' + esc(h) + '"' + (on ? ' checked' : '') + ' />' + esc(pretty12(h)) + '</label>';
      });
      html += '</div></div><p class="field-hint">For Sunday, tick a Sunday date and the Sunday times you want to offer. Templates come from Configuration → scheduling.slotTemplates. You can also use the existing custom appointment fields below. Nothing is offered until you send the proposal.</p>';
    } else {
      html += '<p class="field-hint">Sunday requires a private-sale vehicle at a confirmed private residence with inspection permission. Review Seller and Location below.</p>';
    }
    html += '<p class="field-hint" id="slateSummary" role="status" aria-live="polite"></p>' +
      '<p class="form-status" id="slotHint" role="status" aria-live="polite"></p>';

    // ---- message preview ----
    html += '<h3>Message to the customer</h3>' +
      '<div class="field"><label for="pMessage" class="sr-only">Customer-facing message</label>' +
      '<textarea id="pMessage" rows="4" maxlength="2000" placeholder="Leave blank to send the standard message with the price and times filled in.">' +
      esc(saved.message || "") + "</textarea></div>";

    html += '<button class="btn btn-primary btn-lg" id="sendProposal" style="width:100%;margin-top:6px;">' +
      'Review &amp; Send Booking Proposal' + (draftCfg.totalCents ? " — " + esc(money(draftCfg.totalCents)) : "") + "</button>" +
      '<p class="form-status" id="proposalStatus" role="status" aria-live="polite"></p></section>';
    return html;
  }

  function pretty12(hhmm) {
    var p = hhmm.split(":").map(Number);
    var h = p[0] % 12 || 12;
    return h + ":" + String(p[1]).padStart(2, "0") + " " + (p[0] < 12 ? "AM" : "PM");
  }

  function priceTable(lines, totalCents) {
    var html = '<table class="line-items">';
    (lines || []).forEach(function (l) {
      html += "<tr><td>" + esc(l.label) + "</td><td>" + esc(l.display) + "</td></tr>";
    });
    html += '<tr class="total"><td>Total</td><td>' + esc(totalCents ? money(totalCents) : "Needs a travel amount") + "</td></tr></table>";
    return html;
  }

  function reviewNoteHtml(notes) {
    if (!notes || !notes.length) return "";
    return '<div class="notice warn"><ul>' + notes.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") + "</ul></div>";
  }


  /* A content hash of the composed proposal. Re-pressing Send for the exact
     same package, price and times reuses the key (so nothing is duplicated);
     changing anything produces a new key (so a corrected proposal can go out). */
  function proposalKeyFor(form, slots) {
    var basis = [
      currentRequestId, form.tier, form.base, form.travel, form.addonLabel, form.addon,
      form.discount, form.discountLabel, form.expires, form.message, slots.join("|")
    ].join("~");
    var h1 = 0x811c9dc5;
    var h2 = 0x01000193;
    for (var i = 0; i < basis.length; i++) {
      h1 = ((h1 ^ basis.charCodeAt(i)) >>> 0) * 0x01000193 >>> 0;
      h2 = ((h2 + basis.charCodeAt(i) * (i + 7)) >>> 0);
    }
    return "p" + h1.toString(36) + h2.toString(36) + basis.length.toString(36);
  }

  /* ================= Request detail ================= */
  function openDetail(id) {
    if (!leaveDetail()) return;
    currentRequestId = id;
    setRequestUrl(id);
    api("/api/admin/requests/" + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) {
        currentRequestId = null;
        setRequestUrl("");
        nav.querySelectorAll(".tab-btn").forEach(function (b) {
          b.classList.toggle("active", b.getAttribute("data-view") === "requests");
        });
        show("requests");
        return;
      }
      detailCache = r.body;
      renderDetail();
    }).catch(function () {
      content.innerHTML = '<div class="notice warn">We could not load this request. Refresh the page or return to the request list.</div>';
    });
  }

  function act(payload, cb) {
    api("/api/admin/requests/" + encodeURIComponent(currentRequestId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      var handled = cb ? cb(r) === true : false;
      if (r.ok) openDetail(currentRequestId);
      else if (!handled) alert((r.body.error && r.body.error.message) || "Action failed");
    }).catch(function () {
      var failure = { ok: false, body: { error: { message: "Network problem — the action was not confirmed. Please try again." } } };
      if (cb) cb(failure);
      alert(failure.body.error.message);
    });
  }

  function renderDetail() {
    var d = detailCache;
    var req = d.request;
    var html = '<div class="report-actions"><button class="btn btn-ghost btn-sm" id="backToList">← Back</button><button class="btn btn-ghost btn-sm" id="refreshJob">Refresh job status &amp; messages</button></div>';


    var confirmedSlot = (d.slots || []).filter(function (slot) { return slot.status === "confirmed"; })[0];
    var heldSlot = (d.slots || []).filter(function (slot) { return slot.status === "held"; })[0];
    var offeredSlots = (d.slots || []).filter(function (slot) { return slot.status === "offered"; });
    var paid = (d.payments || []).filter(function (payment) { return ["succeeded", "partially_refunded"].indexOf(payment.status) !== -1; });
    var activeQuoteRow = (d.quotes || []).filter(function (q) { return q.status === "sent" || q.status === "accepted"; })[0];

    // The same stage vocabulary as the list, computed from the same fields.
    var stage = stageOf({
      status: req.status,
      offered_slot_count: offeredSlots.length,
      paid_amount_cents: paid.length ? paid[0].amount_cents : null,
      proposal_notification_status: d.proposal ? d.proposal.notificationStatus : null
    });
    // The title bar says the stage, not the internal status name. The exact
    // saved status stays visible in Status and History below.
    html += '<div class="portal-topbar" style="margin-top:14px;"><h1 style="font-size:24px;">' + esc(req.ref) + "</h1>" +
      '<span id="requestStatusPill">' + stagePill(stage) + "</span></div>";

    html += '<section class="portal-card job-at-a-glance stage-edge-' + esc(stage.kind || "none") + '" aria-label="Job at a glance"><h2>At a glance</h2><dl class="kv">' +
      '<dt>Customer</dt><dd>' + esc(req.full_name) + ' · ' + esc(req.email) + ' · ' + esc(req.phone) + '</dd>' +
      '<dt>Vehicle</dt><dd>' + esc([req.year, req.make, req.model, req.vehicle_trim].filter(Boolean).join(" ") || "—") + '</dd>' +
      '<dt>Inspection location</dt><dd>' + esc([req.loc_street, req.loc_unit, req.loc_city, req.loc_state, req.loc_zip].filter(Boolean).join(", ") || "—") +
        (req.travel_miles == null
          ? ' · distance unknown'
          : Number(req.travel_miles) < 1
            ? ' · in your own service area'
            : ' · about ' + esc(req.travel_miles) + ' mi out') + '</dd>' +
      '<dt>Package</dt><dd>' + esc(tierLabel(activeQuoteRow ? activeQuoteRow.tier : (req.customer_selected_tier || req.suggested_tier))) +
        (req.customer_selected_tier ? ' · customer chose ' + esc(tierLabel(req.customer_selected_tier)) : "") + '</dd>' +
      '<dt>Price</dt><dd>' + esc(activeQuoteRow ? money(activeQuoteRow.total_cents) + " offered" : "Not quoted yet") + '</dd>' +
      '<dt>Appointment</dt><dd>' + esc(
        confirmedSlot ? "Confirmed · " + whenLong(confirmedSlot.starts_at)
          : heldSlot ? "Held (unpaid) · " + whenLong(heldSlot.starts_at)
          : offeredSlots.length ? offeredSlots.length + " option(s) offered: " + offeredSlots.map(function (s) { return whenLong(s.starts_at); }).join(" · ")
          : "No times offered"
      ) + '</dd>' +
      '<dt>Payment</dt><dd>' + esc(paid.length ? paid.map(function (p) { return money(p.amount_cents) + ' · ' + p.status.replace(/_/g, ' '); }).join('; ') : 'No successful payment recorded') + '</dd>' +
      '<dt>Who acts next</dt><dd><strong>' + esc(stage.who) + '</strong> — ' + esc(stage.label) + '</dd>' +
      '<dt>Agreement evidence</dt><dd>' + esc((d.acceptances || []).length) + ' acceptance record(s) — exact versions below</dd>' +
      '<dt>Report state</dt><dd id="jobReportState">Loading…</dd></dl>' +
      '<nav class="report-actions" aria-label="Job sections"><a class="btn btn-ghost btn-sm" href="#inspectionReport">Inspection report</a><a class="btn btn-ghost btn-sm" href="#jobMessages">Messages</a><a class="btn btn-ghost btn-sm" href="#jobScheduling">Scheduling</a><a class="btn btn-ghost btn-sm" href="#jobPayments">Payments / refunds</a></nav></section>';

    // What kind of record is this, and can the owner change it?
    var rk = d.recordKind || { kind: "real", autoReason: null };
    if (rk.kind === "test") {
      html += '<div class="notice warn"><strong>Test record.</strong> Hidden from the business view and excluded from the scoreboard.' +
        (rk.autoReason ? ' Classified automatically because ' + esc(rk.autoReason) + '.' : '') +
        ' <button type="button" class="linklike" data-set-kind="real">This is a real customer</button></div>';
    } else if (rk.autoReason) {
      html += '<div class="notice warn"><strong>This looks like a test record</strong> — ' + esc(rk.autoReason) +
        ' — but it is filed as real business and counts on your scoreboard.' +
        ' <button type="button" class="linklike" data-set-kind="test">File it as a test</button></div>';
    } else {
      html += '<p class="field-hint">Real customer record.' +
        ' <button type="button" class="linklike" data-set-kind="test">File as a test record</button></p>';
    }

    if (req.manual_review_reasons && req.manual_review_reasons !== "[]") {
      var stored = [];
      try { stored = JSON.parse(req.manual_review_reasons); } catch (e) {}
      // The stored list mixes how the tier was reached with what actually
      // needs a decision. Only the latter is worth a banner — a BMW being a
      // BMW is not something to review, and the proposal card below already
      // explains the classification.
      var reasons = stored.filter(function (r) { return String(r).indexOf("tier: ") !== 0; });
      if (reasons.length) html += '<div class="notice warn"><strong>Needs a look:</strong> ' + esc(reasons.join(" · ")) + "</div>";
    }

    // The primary action, before anything else, whenever this request is
    // still pre-booking. After confirmation the inspection work leads instead.
    var preBooking = ["submitted", "needs_info", "seller_access_pending", "ready_for_review",
      "quote_prepared", "quote_sent", "awaiting_time_selection"].indexOf(req.status) !== -1;
    if (preBooking && !paid.length) html += proposalCard(d);

    // ----- customer & vehicle -----
    html += '<section class="portal-card"><h2>Customer &amp; vehicle</h2><dl class="kv">' +
      "<dt>Customer</dt><dd>" + esc(req.full_name) + " · " + esc(req.email) + " · " + esc(req.phone) + " (prefers " + esc(req.preferred_contact) + ")</dd>" +
      "<dt>Vehicle</dt><dd>" + esc([req.year, req.make, req.model, req.vehicle_trim].filter(Boolean).join(" ")) + " · " + esc(req.mileage ? Number(req.mileage).toLocaleString() + " mi" : "mileage n/a") + "</dd>" +
      "<dt>VIN</dt><dd class=\"mono\">" + esc(req.vin || "not provided") + "</dd>" +
      "<dt>Prices</dt><dd>Asking " + (req.asking_price_cents ? money(req.asking_price_cents) : "—") + " · Expecting " + (req.expected_price_cents ? money(req.expected_price_cents) : "—") + "</dd>" +
      "<dt>Listing</dt><dd>" + (safeListingUrl(req.listing_url) ? '<a href="' + esc(safeListingUrl(req.listing_url)) + '" target="_blank" rel="noopener noreferrer">open listing ↗</a>' : "—") + "</dd>" +
      "<dt>Condition</dt><dd>Mods: " + esc(req.mod_status) + " · Title: " + esc(req.title_status) + " · Starts/drives: " + esc(req.starts_drives) + "</dd>" +
      "<dt>Warnings</dt><dd>" + esc(req.warning_lights || "—") + "</dd>" +
      "<dt>Known issues</dt><dd>" + esc(req.known_issues || "—") + "</dd>" +
      "<dt>Location</dt><dd>" + esc([req.loc_street, req.loc_unit, req.loc_city, req.loc_state, req.loc_zip].filter(Boolean).join(", ")) + "</dd>" +
      "<dt>Seller</dt><dd>" + esc([req.seller_type, req.seller_name, req.seller_phone].filter(Boolean).join(" · ") || "—") + "</dd>" +
      "<dt>Dealership name</dt><dd>" + esc(req.seller_type === "dealership" ? req.dealership_name || "Not provided" : "Not applicable") + "</dd>" +
      "<dt>Inspection location type</dt><dd>" + esc({ private_residence: "Private residence", other: "Another location", unknown: "Not sure" }[req.inspection_location_type] || "Not confirmed") + "</dd>" +
      "<dt>Discovery (customer-reported)</dt><dd>" + esc(d.discoveryLabel || "Not provided") + (req.discovery_detail ? " — " + esc(req.discovery_detail) : "") + "</dd>" +
      "<dt>Access</dt><dd>Inspection OK: " + yn(req.perm_inspection) + " · Road test: " + esc(req.perm_road_test) + " · Photos: " + esc(req.perm_photos) + " · Underbody: " + esc(req.perm_underbody) + " · Lift: " + esc(req.lift_available) + " · Level surface: " + esc(req.level_surface) + "</dd>" +
      "<dt>Timing</dt><dd>" + esc([req.decision_timeline, req.preferred_dates, req.time_window].filter(Boolean).join(" · ")) + (req.same_day_priority ? " · SAME-DAY PRIORITY" : "") + "</dd>" +
      "<dt>Travel est.</dt><dd>" + (req.travel_miles != null ? esc(req.travel_miles) + " mi (" + esc(req.travel_estimate_basis) + ")" : "unknown — custom review") + "</dd>" +
      "<dt>Acquisition source</dt><dd>" + esc(attributionLabel(req.attribution_source)) + "</dd>" +
      "<dt>Customer notes</dt><dd>" + esc(req.customer_notes || "—") + "</dd>" +
      "</dl></section>";

    if (preBooking && !paid.length && req.seller_type === "private") {
      html += '<section class="portal-card"><h2>Private-sale inspection location</h2>' +
        '<p class="field-hint">Confirm the location for this existing request. Confirm seller permission only when it has been granted. A dealership vehicle is never eligible, wherever it is parked.</p>' +
        '<label for="privateLocation">Inspection location</label><select id="privateLocation">' +
        '<option value="">Choose location</option>' +
        ['private_residence', 'other', 'unknown'].map(function (value) { return '<option value="' + value + '"' + (req.inspection_location_type === value ? ' selected' : '') + '>' + ({ private_residence: 'Private residence', other: 'Another location', unknown: 'Not sure' }[value]) + '</option>'; }).join('') +
        '</select><label class="field field-check"><input type="checkbox" id="privateInspectionPermission"' + (Number(req.perm_inspection) === 1 ? ' checked' : '') + ' /><span>Seller has authorized inspection access</span></label>' +
        '<button type="button" class="btn btn-ghost btn-sm" id="savePrivateLocation">Save location</button></section>';
    }

    html += '<section class="portal-card" id="inspectionReport" aria-label="Inspection report workspace"></section>';

    // ----- uploads -----
    if ((d.uploads || []).length) {
      html += '<section class="portal-card"><h2>Uploads</h2><div style="display:flex;flex-wrap:wrap;gap:10px;" id="uploadThumbs">';
      d.uploads.forEach(function (u) {
        html += '<figure style="margin:0;max-width:150px;"><img data-upload="' + esc(u.id) + '" alt="' + esc(u.original_name) + '" style="width:150px;height:110px;object-fit:cover;border-radius:10px;border:1px solid var(--line);" />' +
          '<figcaption style="font-size:12px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(u.original_name) + "</figcaption>" +
          '<button class="btn btn-ghost btn-sm" data-del-upload="' + esc(u.id) + '">Delete</button></figure>';
      });
      html += "</div></section>";
    }

    // ----- status control -----
    html += '<section class="portal-card"><h2>Status</h2><div class="admin-toolbar">' +
      '<select id="statusTo" aria-label="New request status"><option value="">Move to…</option>' +
      (d.allowedTransitions || []).map(function (s) { return '<option value="' + s + '">' + s.replace(/_/g, " ") + "</option>"; }).join("") +
      '</select><input id="statusReason" aria-label="Status change reason (internal and history)" placeholder="Reason (internal + history)" style="flex:1;min-width:200px;" />' +
      '<input id="statusNote" aria-label="Optional status note emailed to customer" placeholder="Optional note emailed to customer" style="flex:1;min-width:200px;" />' +
      '<button class="btn btn-primary" id="statusGo">Apply</button></div></section>';

    // ----- quote history + manual quote builder (secondary) -----
    html += '<details class="portal-card portal-secondary"><summary>Quotes &amp; manual quote builder</summary>';
    var activeQuote = (d.quotes || [])[0];
    if ((d.quotes || []).length) {
      html += '<table class="admin-table"><thead><tr><th>v</th><th>Status</th><th>Tier</th><th>Total</th><th>Expires</th><th></th></tr></thead><tbody>';
      d.quotes.forEach(function (q) {
        html += "<tr><td>" + q.version + "</td><td>" + esc(q.status) + "</td><td>" + esc(q.tier) + "</td><td>" + money(q.total_cents) + "</td><td class=\"mono\">" + esc(when(q.expires_at)) + "</td><td>" +
          (q.status === "draft" ? '<button class="btn btn-primary btn-sm" data-send-quote="' + esc(q.id) + '">Send to customer</button>' : "") + "</td></tr>";
      });
      html += "</tbody></table><hr style='border-color:var(--line-soft);margin:16px 0;' />";
    }
    var suggestedTier = ["standard", "euro_luxury_performance", "exotic_collector"].indexOf(req.suggested_tier) >= 0
      ? req.suggested_tier
      : "standard";
    html += '<h3>New quote version</h3>' +
      '<p class="field-hint">System suggestion: <strong>' + esc(suggestedTier.replace(/_/g, " ")) + '</strong>. Review the vehicle, location and scope before approving the final tier and amount.</p>' +
      '<div class="admin-toolbar">' +
      '<select id="qTier"><option value="standard"' + (suggestedTier === "standard" ? " selected" : "") + '>Standard</option>' +
      '<option value="euro_luxury_performance"' + (suggestedTier === "euro_luxury_performance" ? " selected" : "") + '>European/Luxury/Performance</option>' +
      '<option value="exotic_collector"' + (suggestedTier === "exotic_collector" ? " selected" : "") + '>Exotic/Collector/Modified</option></select>' +
      '<input id="qBase" placeholder="Base $ (blank = tier price)" inputmode="decimal" style="width:170px;" />' +
      '<input id="qTravel" placeholder="Travel $ (required if custom)" inputmode="decimal" style="width:210px;" />' +
      '<input id="qAddonLabel" placeholder="Add-on label" style="width:150px;" />' +
      '<input id="qAddon" placeholder="Add-on $" inputmode="decimal" style="width:110px;" />' +
      '<input id="qDiscount" placeholder="Discount $" inputmode="decimal" style="width:110px;" />' +
      "</div>" +
      '<div class="field"><input id="qNote" placeholder="Customer-facing note (optional)" /></div>' +
      '<div class="field"><input id="qInternal" placeholder="Internal justification (never shown to customer)" /></div>' +
      '<button class="btn btn-ghost" id="qCreate">Create draft quote</button></details>';

    // ----- scheduling -----
    html += '<details class="portal-card portal-secondary" id="jobScheduling"><summary>Scheduling detail &amp; manual time offers</summary>';
    if ((d.slots || []).length) {
      html += '<table class="admin-table"><thead><tr><th>Start</th><th>Status</th><th></th></tr></thead><tbody>';
      d.slots.forEach(function (s) {
        html += "<tr><td>" + esc(when(s.starts_at)) + "</td><td>" + esc(s.status) + (s.hold_expires_at ? " (hold until " + esc(when(s.hold_expires_at)) + ")" : "") + "</td><td>" +
          (s.status === "offered" || s.status === "held" ? '<button class="btn btn-ghost btn-sm" data-release-slot="' + esc(s.id) + '">Release</button>' : "") + "</td></tr>";
      });
      html += "</tbody></table>";
    } else {
      html += '<p style="color:var(--text-3);">No slots proposed yet.</p>';
    }
    html += '<h3>Offer windows (Las Vegas time)</h3><div class="admin-toolbar">' +
      '<input type="datetime-local" id="slot1" /><input type="datetime-local" id="slot2" /><input type="datetime-local" id="slot3" />' +
      '<button class="btn btn-ghost" id="slotsGo">Propose</button></div>' +
      '<p class="field-hint">Las Vegas time. Suggested templates: 9:00 AM, 12:30 PM, 4:00 PM. Options offered on this same request are alternatives and may share buffers; anything clashing with another job is rejected automatically.</p></details>';

    // ----- payments -----
    html += '<section class="portal-card" id="jobPayments"><h2>Payments</h2>';
    if ((d.payments || []).length) {
      html += '<table class="admin-table"><thead><tr><th>Amount</th><th>Status</th><th>Stripe ref</th><th>Date</th><th></th></tr></thead><tbody>';
      d.payments.forEach(function (p) {
        // A payment collected outside Stripe has no provider reference to show,
        // so say how it actually arrived instead of printing a bare dash that
        // reads like missing data.
        var reference = p.method === "offline"
          ? "Outside Stripe" + (p.offline_note ? " · " + p.offline_note : "")
          : (p.stripe_payment_intent || p.stripe_session_id || "—");
        html += "<tr><td>" + money(p.amount_cents) + (p.refunded_cents ? " (−" + money(p.refunded_cents) + ")" : "") + "</td><td>" + esc(p.status) + "</td>" +
          '<td class="mono">' + esc(reference) + "</td><td class=\"mono\">" + esc(when(p.created_at)) + "</td><td>" +
          ((p.status === "succeeded" || p.status === "partially_refunded") && p.method !== "offline"
            ? '<button class="btn btn-ghost btn-sm" data-refund="' + esc(p.id) + '">Refund…</button>'
            : "") + "</td></tr>";
      });
      html += "</tbody></table>";
      if (d.payments.some(function (p) { return p.method === "offline"; })) {
        html += '<p class="field-hint">A payment collected outside Stripe cannot be refunded from here — return that money the same way it arrived.</p>';
      }
    } else {
      html += '<p style="color:var(--text-3);">No payments.</p>';
    }

    // ----- money that arrived outside Stripe -----
    // Cash at the car, Zelle, a transfer over text. Without somewhere to put
    // it, a real paid job sits unrecorded and the revenue figures are short.
    if (!(d.payments || []).length) {
      html += '<details class="advanced-pricing" id="offlinePaymentBox"><summary>Record a payment collected outside Stripe</summary>' +
        '<p class="field-hint">For a job you were paid for directly. This writes the quote, the booking and the payment so the request reads as the real paid job it was, and the amount counts in your revenue. It does not create a Stripe charge and cannot be refunded from here.</p>' +
        '<div class="admin-toolbar">' +
        '<label class="field field-inline"><span>Amount collected $</span><input id="offlineAmount" inputmode="decimal" placeholder="325.00" /></label>' +
        '<label class="field field-inline"><span>How it was paid</span><input id="offlineNote" maxlength="200" placeholder="Zelle" /></label>' +
        '<label class="field field-inline"><span>Date collected</span><input id="offlineDate" type="date" /></label>' +
        "</div>" +
        '<button class="btn btn-primary btn-sm" id="recordOfflinePayment">Record this payment</button> ' +
        '<span id="offlinePaymentStatus" class="field-hint"></span></details>';
    }

    // ----- refund tracking -----
    var refundOperations = d.refundOperations || [];
    var refundAttempts = d.refundAttempts || [];
    var providerRefunds = d.providerRefunds || [];
    html += '<h3>Refund operations</h3>';
    if (refundOperations.length) {
      html += '<p class="field-hint">The operation status below is the current source of truth for the next action. Provider attempts remain visible as immutable history.</p>' +
        '<div style="overflow-x:auto;"><table class="admin-table"><thead><tr><th>Operation</th><th>Amount</th><th>Status</th><th>Attempts</th><th>Stripe refund</th><th>Updated</th><th>Next step</th></tr></thead><tbody>';
      refundOperations.forEach(function (refundOperation) {
        var operationStatus = String(refundOperation.status || "unknown");
        html += '<tr><td class="mono">' + esc(refundOperation.id || "—") + "</td>" +
          "<td>" + esc(money(Number(refundOperation.requested_amount_cents || 0))) + "</td>" +
          "<td>" + esc(operationStatus.replace(/_/g, " ")) + "</td>" +
          "<td>" + esc(refundOperation.attempt_count == null ? "—" : refundOperation.attempt_count) + "</td>" +
          '<td class="mono">' + esc(refundOperation.provider_refund_id || "—") + "</td>" +
          '<td class="mono">' + esc(when(refundOperation.updated_at)) + "</td>" +
          "<td>" + esc(refundStatusGuidance(operationStatus)) +
          (refundOperation.last_error ? '<span class="msg-meta">Last error: ' + esc(refundOperation.last_error) + "</span>" : "") +
          "</td></tr>";
      });
      html += "</tbody></table></div>";
    } else {
      html += '<p style="color:var(--text-3);">No refund operations.</p>';
    }

    html += '<h3>Refund attempts</h3>';
    if (refundAttempts.length) {
      html += '<div style="overflow-x:auto;"><table class="admin-table"><thead><tr><th>Operation</th><th>Attempt</th><th>Outcome</th><th>Provider status</th><th>Stripe refund</th><th>Updated</th><th>Error</th></tr></thead><tbody>';
      refundAttempts.forEach(function (refundAttempt) {
        html += '<tr><td class="mono">' + esc(refundAttempt.operation_id || "—") + "</td>" +
          "<td>" + esc(refundAttempt.attempt_no == null ? "—" : refundAttempt.attempt_no) + "</td>" +
          "<td>" + esc(String(refundAttempt.outcome_status || "unknown").replace(/_/g, " ")) + "</td>" +
          "<td>" + esc(refundAttempt.provider_status || "—") + "</td>" +
          '<td class="mono">' + esc(refundAttempt.provider_refund_id || "—") + "</td>" +
          '<td class="mono">' + esc(when(refundAttempt.updated_at)) + "</td>" +
          "<td>" + esc(refundAttempt.error || "—") + "</td></tr>";
      });
      html += "</tbody></table></div>";
    } else {
      html += '<p style="color:var(--text-3);">No refund attempts.</p>';
    }

    html += '<h3>Stripe refund ledger</h3>';
    if (providerRefunds.length) {
      html += '<p class="field-hint">Each Stripe Refund object is tracked independently. The payment balance is the sum of entries currently marked succeeded.</p>' +
        '<div style="overflow-x:auto;"><table class="admin-table"><thead><tr><th>Stripe refund</th><th>Amount</th><th>Status</th><th>Operation</th><th>Last event</th><th>Updated</th></tr></thead><tbody>';
      providerRefunds.forEach(function (providerRefund) {
        html += '<tr><td class="mono">' + esc(providerRefund.provider_refund_id || "—") + '</td>' +
          '<td>' + esc(money(Number(providerRefund.amount_cents || 0))) + '</td>' +
          '<td>' + esc(String(providerRefund.status || "unknown").replace(/_/g, " ")) + '</td>' +
          '<td class="mono">' + esc(providerRefund.operation_id || "external / unmatched") + '</td>' +
          '<td><span class="mono">' + esc(providerRefund.last_event_id || "—") + '</span>' +
          (providerRefund.last_event_created == null ? '' : '<span class="msg-meta">' + esc(new Date(Number(providerRefund.last_event_created) * 1000).toLocaleString()) + '</span>') + '</td>' +
          '<td class="mono">' + esc(when(providerRefund.updated_at)) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<p style="color:var(--text-3);">No Stripe Refund objects recorded.</p>';
    }

    // ----- dispute tracking -----
    var paymentDisputes = d.paymentDisputes || [];
    html += '<h3>Stripe dispute ledger</h3>';
    if (paymentDisputes.length) {
      html += '<p class="field-hint">Stripe dispute status and funds movement are tracked independently. A won/closed dispute never reopens the request, booking, or capacity automatically.</p>' +
        '<div style="overflow-x:auto;"><table class="admin-table"><thead><tr><th>Stripe dispute</th><th>Amount</th><th>Status</th><th>Funds</th><th>Payment / charge</th><th>Status event</th><th>Funds event</th><th>Updated</th></tr></thead><tbody>';
      paymentDisputes.forEach(function (dispute) {
        html += '<tr><td class="mono">' + esc(dispute.provider_dispute_id || "—") + '</td>' +
          '<td>' + esc(money(Number(dispute.amount_cents || 0))) + '</td>' +
          '<td>' + esc(String(dispute.provider_status || "unknown").replace(/_/g, " ")) + '</td>' +
          '<td>' + esc(String(dispute.funds_state || "unknown").replace(/_/g, " ")) + '</td>' +
          '<td><span class="mono">' + esc(dispute.payment_intent || "—") + '</span><span class="msg-meta">' + esc(dispute.provider_charge_id || "—") + '</span></td>' +
          '<td><span class="mono">' + esc(dispute.status_event_id || "—") + '</span>' +
          (dispute.status_event_created == null ? '' : '<span class="msg-meta">' + esc(new Date(Number(dispute.status_event_created) * 1000).toLocaleString()) + '</span>') + '</td>' +
          '<td><span class="mono">' + esc(dispute.funds_event_id || "—") + '</span>' +
          (dispute.funds_event_created == null ? '' : '<span class="msg-meta">' + esc(new Date(Number(dispute.funds_event_created) * 1000).toLocaleString()) + '</span>') + '</td>' +
          '<td class="mono">' + esc(when(dispute.updated_at)) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<p style="color:var(--text-3);">No Stripe Dispute objects recorded.</p>';
    }
    html += "</section>";

    // ----- agreements -----
    if ((d.acceptances || []).length) {
      html += '<section class="portal-card"><h2>Agreement acceptances</h2><ul class="msg-list">';
      d.acceptances.forEach(function (a) {
        html += "<li>" + esc(a.title) + " v" + a.doc_version + " — signed “" + esc(a.typed_name) + "”" +
          '<span class="msg-meta">' + esc(when(a.created_at)) + (a.ip ? " · IP " + esc(a.ip) : "") + "</span></li>";
      });
      html += "</ul></section>";
    }

    // ----- messages -----
    html += '<section class="portal-card"><h2>Messages</h2><ul class="msg-list">';
    (d.messages || []).forEach(function (m) {
      var retry = m.channel === "email" && (m.status === "failed" || m.status === "recorded")
        ? ' <button class="btn btn-ghost btn-sm" data-retry-email="' + esc(m.id) + '">Retry email</button>'
        : "";
      html += '<li class="' + (m.direction === "inbound" ? "inbound" : "") + '">' +
        "<strong>" + esc(m.direction) + (m.template ? " · " + esc(m.template) : "") + (m.channel === "email" ? " · " + esc(m.status) : "") + ":</strong> " +
        esc((m.subject ? m.subject + " — " : "") + (m.body_text || "").slice(0, 400)) +
        retry + '<span class="msg-meta">' + esc(when(m.created_at)) + "</span></li>";
    });
    html += "</ul><div class='admin-toolbar' style='margin-top:12px;'>" +
      '<input id="adminMsg" placeholder="Message to customer (portal + email)" style="flex:1;min-width:220px;" />' +
      '<button class="btn btn-ghost" id="adminMsgGo">Send</button></div></section>';

    // ----- internal notes & tools -----
    html += '<section class="portal-card"><h2>Internal notes &amp; tools</h2>' +
      '<div class="field"><label for="internalNotes">Private job notes — never shown to the customer</label><textarea id="internalNotes" rows="3">' + esc(req.internal_notes || "") + "</textarea></div>" +
      '<div class="admin-toolbar">' +
      '<button class="btn btn-ghost" id="saveNotes">Save notes</button>' +
      '<button class="btn btn-ghost" id="newLink">New portal link</button>' +
      "</div><p class='form-status mono' id='toolStatus' style='word-break:break-all;'></p></section>";

    // ----- history -----
    html += '<section class="portal-card"><h2>Status history</h2><ul class="msg-list">';
    (d.history || []).forEach(function (h) {
      html += "<li>" + esc(h.from_status || "·") + " → <strong>" + esc(h.to_status) + "</strong>" + (h.reason ? " — " + esc(h.reason) : "") +
        '<span class="msg-meta">' + esc(h.actor) + " · " + esc(when(h.created_at)) + "</span></li>";
    });
    html += "</ul></section>";

    content.innerHTML = html;
    bindDetail();
    makeDetailAccessible();
    reportEditor = window.AutoClarityReportEditor.mount(document.getElementById("inspectionReport"), {
      requestId: currentRequestId,
      api: api,
      fetchPhoto: function (path, signal) {
        var headers = {}, key = adminKey(); if (key) headers.authorization = "Bearer " + key;
        return fetch(path, { headers: headers, cache: "no-store", signal: signal }).then(function (response) {
          if (!response.ok) throw new Error("Private photo unavailable");
          return response.blob();
        });
      },
      onState: function (state) {
        var summary = document.getElementById("jobReportState");
        if (summary) summary.textContent = state.report ? state.report.state.replace(/_/g, " ") : "Not started";
        if (state.requestStatus && state.requestStatus !== detailCache.request.status) {
          var expectedId = currentRequestId;
          api("/api/admin/requests/" + encodeURIComponent(expectedId)).then(function (r) {
            if (!r.ok || expectedId !== currentRequestId) return;
            detailCache = r.body;
            var pill = document.getElementById("requestStatusPill");
            if (pill && r.body.request) pill.innerHTML = stagePill(stageOf(r.body.request));
            var dropdown = document.getElementById("statusTo");
            if (dropdown) dropdown.innerHTML = '<option value="">Move to…</option>' + (r.body.allowedTransitions || []).map(function (s) { return '<option value="' + esc(s) + '">' + esc(s.replace(/_/g, " ")) + '</option>'; }).join('');
          }).catch(function () {});
        }
      }
    });
  }

  function yn(v) { return Number(v) === 1 ? "yes" : "no"; }

  function dollarsToCents(str, allowZero) {
    var raw = String(str == null ? "" : str).replace(/[$,\s]/g, "");
    if (!raw) return null;
    var n = Number(raw);
    if (!isFinite(n) || n < 0 || (!allowZero && n === 0)) return null;
    return Math.round(n * 100);
  }

  function bindDetail() {
    document.getElementById("refreshJob").addEventListener("click", function () { openDetail(currentRequestId); });
    document.getElementById("backToList").addEventListener("click", function () {
      if (!leaveDetail()) return;
      currentRequestId = null;
      setRequestUrl("");
      show("requests");
    });

    // upload thumbnails require the auth header → fetch to blob URLs
    content.querySelectorAll("[data-upload]").forEach(function (img) {
      var id = img.getAttribute("data-upload");
      fetch("/api/admin/uploads/" + encodeURIComponent(id), { headers: { authorization: "Bearer " + adminKey() } })
        .then(function (res) { return res.ok ? res.blob() : null; })
        .then(function (blob) { if (blob && img.isConnected) { var url = URL.createObjectURL(blob); uploadBlobUrls.push(url); img.src = url; } })
        .catch(function () {});
    });
    content.querySelectorAll("[data-del-upload]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (!confirm("Delete this customer upload permanently?")) return;
        act({ action: "delete_upload", uploadId: btn.getAttribute("data-del-upload") });
      });
    });

    var saveLocation = document.getElementById("savePrivateLocation");
    if (saveLocation) saveLocation.addEventListener("click", function () {
      act({ action: "set_inspection_location", inspectionLocationType: document.getElementById("privateLocation").value, permInspection: document.getElementById("privateInspectionPermission").checked });
    });

    // ---------- booking proposal ----------
    var proposalSection = document.getElementById("bookingProposal");
    if (proposalSection) {
      var sendBtn = document.getElementById("sendProposal");
      var statusEl = document.getElementById("proposalStatus");
      var previewTimer = null;
      var draftCfg = (detailCache && detailCache.proposalDraft) || {};

      function currentForm() {
        var days = [].slice.call(proposalSection.querySelectorAll("[data-day]"))
          .filter(function (b) { return b.checked; })
          .map(function (b) { return b.getAttribute("data-day"); });
        var hours = [].slice.call(proposalSection.querySelectorAll("[data-hour]"))
          .filter(function (b) { return b.checked; })
          .map(function (b) { return b.getAttribute("data-hour"); });
        var selected = proposalSection.querySelector('input[name="pTier"]:checked');
        return {
          days: days,
          hours: hours,
          sundayHours: [].slice.call(proposalSection.querySelectorAll("[data-sunday-hour]")).filter(function (b) { return b.checked; }).map(function (b) { return b.getAttribute("data-sunday-hour"); }),
          tier: selected ? selected.value : draftCfg.tier,
          base: document.getElementById("pBase").value,
          travel: document.getElementById("pTravel").value,
          addonLabel: document.getElementById("pAddonLabel").value,
          addon: document.getElementById("pAddon").value,
          discount: document.getElementById("pDiscount").value,
          discountLabel: document.getElementById("pDiscountLabel").value,
          expires: document.getElementById("pExpires").value,
          internal: document.getElementById("pInternal").value,
          message: document.getElementById("pMessage").value,
          sameDay: (function () {
            var box = document.getElementById("pSameDay");
            return box ? box.checked : false;
          })(),
          advancedOpen: proposalSection.querySelector(".advanced-pricing").open
        };
      }

      // Anything typed survives a refresh or a trip to the request list.
      function persist() { writeDraft(currentForm()); }

      function pricePayload(form) {
        var addons = [];
        var addonCents = dollarsToCents(form.addon);
        if (addonCents) addons.push({ label: form.addonLabel || "Add-on", amountCents: addonCents });
        var travelCents = dollarsToCents(form.travel, true);
        return {
          tier: form.tier,
          basePriceCents: dollarsToCents(form.base) || undefined,
          travelCents: travelCents !== null ? travelCents : undefined,
          addons: addons,
          discountCents: dollarsToCents(form.discount) || undefined,
          discountLabel: form.discountLabel || undefined,
          sameDayPriority: form.sameDay === true,
          // The same times the send will use, so the previewed total and the
          // sent total are computed from identical inputs.
          slots: slateInstants(proposalSection, draftCfg)
        };
      }

      function refreshPrice() {
        var form = currentForm();
        persist();
        var payload = pricePayload(form);
        payload.action = "price_preview";
        api("/api/admin/requests/" + encodeURIComponent(currentRequestId), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        }).then(function (r) {
          if (!r.ok) return;
          document.getElementById("proposalPrice").innerHTML = priceTable(r.body.lines, r.body.totalCents);
          document.getElementById("proposalReviewNotes").innerHTML = reviewNoteHtml(r.body.reviewNotes);
          var note = document.getElementById("proposalTravelNote");
          if (note && r.body.travel) {
            note.textContent = r.body.travel.basisLabel + " Measured from " + (draftCfg.travelOriginLabel || "the AutoClarity service base") + ".";
          }
          sendBtn.innerHTML = "Review &amp; Send Booking Proposal" + (r.body.totalCents ? " — " + esc(money(r.body.totalCents)) : "");
          sendBtn.setAttribute("data-total", r.body.totalCents || "");
        }).catch(function () {});
      }

      function refreshSlate() {
        var instants = slateInstants(proposalSection, draftCfg);
        proposalSection.querySelectorAll(".chip").forEach(function (chip) {
          chip.classList.toggle("on", chip.querySelector("input").checked);
        });
        var summary = document.getElementById("slateSummary");
        if (instants.length === 0) {
          summary.textContent = "No times selected yet — tick at least one day and one time.";
        } else {
          var first = whenLong(instants[0]);
          var last = whenLong(instants[instants.length - 1]);
          summary.textContent = instants.length + " time" + (instants.length === 1 ? "" : "s")
            + " will be offered, from " + first + " to " + last
            + (instants.length > MAX_OFFERED_PROPOSAL ? " — only the first " + MAX_OFFERED_PROPOSAL + " will be sent" : "");
        }
        persist();
        return instants;
      }

      proposalSection.addEventListener("input", function () {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(refreshPrice, 250);
      });
      proposalSection.addEventListener("change", function (event) {
        if (event.target && event.target.name === "pTier") {
          proposalSection.querySelectorAll(".tier-option").forEach(function (label) {
            label.classList.toggle("selected", label.querySelector("input").checked);
          });
          clearTimeout(previewTimer);
          previewTimer = setTimeout(refreshPrice, 0);
          return;
        }
        if (event.target && (event.target.hasAttribute("data-day") || event.target.hasAttribute("data-hour") || event.target.hasAttribute("data-sunday-hour"))) {
          refreshSlate();
        }
      });

      proposalSection.querySelectorAll("[data-slate]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var preset = btn.getAttribute("data-slate");
          var hourSets = {
            workday: ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"],
            afternoons: ["13:00", "14:00", "15:00", "16:00", "17:00"],
            clear: []
          };
          var want = hourSets[preset] || [];
          proposalSection.querySelectorAll("[data-hour]").forEach(function (b) {
            b.checked = want.indexOf(b.getAttribute("data-hour")) !== -1;
          });
          proposalSection.querySelectorAll("[data-sunday-hour]").forEach(function (b) {
            var hour = b.getAttribute("data-sunday-hour");
            b.checked = preset === "afternoons" ? hour >= "12:00" : preset === "workday" ? hour >= "10:00" && hour <= "17:00" : false;
          });
          if (preset === "clear") {
            proposalSection.querySelectorAll("[data-day]").forEach(function (b) { b.checked = false; });
          }
          document.getElementById("slotHint").textContent = "";
          refreshSlate();
        });
      });
      refreshSlate();

      sendBtn.addEventListener("click", function () {
        var form = currentForm();
        var slots = slateInstants(proposalSection, draftCfg).slice(0, MAX_OFFERED_PROPOSAL);
        if (!slots.length) {
          statusEl.textContent = "Tick at least one day and one time — a proposal without times leaves the customer unable to book.";
          var firstDay = proposalSection.querySelector("[data-day]");
          if (firstDay) firstDay.focus();
          return;
        }
        var total = sendBtn.getAttribute("data-total") || draftCfg.totalCents;
        if (!total) {
          statusEl.textContent = "This location needs an explicit travel amount under Advanced pricing before a total can be sent.";
          return;
        }
        var payload = pricePayload(form);
        payload.action = "send_booking_proposal";
        payload.slots = slots;
        payload.customerNote = form.message || undefined;
        payload.adminNote = form.internal || undefined;
        payload.expiresHours = Number(form.expires) || undefined;
        payload.vehicleLabel = [detailCache.request.year, detailCache.request.make, detailCache.request.model].filter(Boolean).join(" ");
        // One key per composed proposal. A double click, a retried fetch and a
        // duplicated tab all reuse it, so only one proposal can be created.
        payload.proposalKey = proposalKeyFor(form, slots);

        sendBtn.disabled = true;
        statusEl.textContent = "Sending…";
        act(payload, function (r) {
          sendBtn.disabled = false;
          if (r.ok) {
            clearDraft();
            var n = r.body.notification || {};
            statusEl.textContent = r.body.duplicate
              ? "Already sent — nothing was duplicated."
              : n.deliveryConfirmed
                ? "Sent. The customer has the booking link."
                : "Saved and queued. Delivery is not confirmed yet — check the status above.";
            if (r.body.sameDayFeeDropped) {
              statusEl.textContent += " The same-day fee was not charged, because none of the times offered are today.";
            }
            if (r.body.skipped && r.body.skipped.length) {
              alert("These times were not offered:\n" + r.body.skipped.join("\n"));
            }
            return true;
          }
          var err = r.body && r.body.error;
          statusEl.textContent = (err && err.message) || "The proposal was not sent.";
          if (err && err.details && err.details.skipped && err.details.skipped.length) {
            statusEl.textContent += " " + err.details.skipped.join(" ");
          }
          return true;
        });
      });

      content.querySelectorAll("[data-retry-proposal]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          btn.disabled = true;
          act({ action: "retry_proposal_notification", proposalId: btn.getAttribute("data-retry-proposal") }, function (r) {
            btn.disabled = false;
            if (!r.ok) { statusEl.textContent = (r.body.error && r.body.error.message) || "Retry failed."; return true; }
            statusEl.textContent = r.body.alreadySent
              ? "Already delivered — nothing was re-sent."
              : (r.body.notification && r.body.notification.deliveryConfirmed)
                ? "Delivered."
                : "Queued again; delivery still unconfirmed.";
            return true;
          });
        });
      });
    }

    content.querySelectorAll("[data-set-kind]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var kind = btn.getAttribute("data-set-kind");
        var ask = kind === "test"
          ? "File this request as a test record?\n\nIt will be hidden from the business view and excluded from the scoreboard. Nothing is deleted, and you can change it back."
          : "Mark this request as a real customer?\n\nIt will appear in the business view and count on your scoreboard.";
        if (!confirm(ask)) return;
        act({ action: "set_record_kind", recordKind: kind }, function (r) {
          if (!r.ok) { alert((r.body.error && r.body.error.message) || "Could not change it."); return true; }
          return false;
        });
      });
    });

    document.getElementById("statusGo").addEventListener("click", function () {
      var to = document.getElementById("statusTo").value;
      if (!to) return;
      act({ action: "set_status", to: to, reason: document.getElementById("statusReason").value, note: document.getElementById("statusNote").value });
    });

    document.getElementById("qCreate").addEventListener("click", function () {
      var addons = [];
      var addonCents = dollarsToCents(document.getElementById("qAddon").value);
      var travelCents = dollarsToCents(document.getElementById("qTravel").value, true);
      if (addonCents) addons.push({ label: document.getElementById("qAddonLabel").value || "Add-on", amountCents: addonCents });
      act({
        action: "create_quote",
        tier: document.getElementById("qTier").value,
        basePriceCents: dollarsToCents(document.getElementById("qBase").value) || undefined,
        travelCents: travelCents !== null ? travelCents : undefined,
        addons: addons,
        discountCents: dollarsToCents(document.getElementById("qDiscount").value) || undefined,
        customerNote: document.getElementById("qNote").value,
        adminNote: document.getElementById("qInternal").value
      });
    });
    content.querySelectorAll("[data-send-quote]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        act({ action: "send_quote", quoteId: btn.getAttribute("data-send-quote") });
      });
    });

    document.getElementById("slotsGo").addEventListener("click", function () {
      var values = ["slot1", "slot2", "slot3"].map(function (id) { return document.getElementById(id).value; }).filter(Boolean);
      var cfg = (detailCache && detailCache.proposalDraft) || {};
      var invalid = values.some(function (value) {
        var date = value.split("T")[0];
        return (cfg.daysOfOperation || []).indexOf(new Date(date + "T12:00:00Z").getUTCDay()) === -1 || (cfg.blackoutDates || []).indexOf(date) !== -1;
      });
      if (invalid) { alert("Choose an eligible operating day that is not blacked out. Sunday requires a confirmed private residence and private-sale inspection permission."); return; }
      var slots = values.map(function (v) { var parts = v.split("T"); return vegasInstant(parts[0], parts[1]); });
      if (!slots.length) return;
      act({ action: "propose_slots", slots: slots }, function (r) {
        if (r.ok && r.body.skipped && r.body.skipped.length) alert("Skipped:\n" + r.body.skipped.join("\n"));
      });
    });
    content.querySelectorAll("[data-release-slot]").forEach(function (btn) {
      btn.addEventListener("click", function () { act({ action: "release_slot", slotId: btn.getAttribute("data-release-slot") }); });
    });

    var offlineBtn = document.getElementById("recordOfflinePayment");
    if (offlineBtn) {
      offlineBtn.addEventListener("click", function () {
        var statusEl = document.getElementById("offlinePaymentStatus");
        var cents = dollarsToCents(document.getElementById("offlineAmount").value);
        var note = document.getElementById("offlineNote").value.trim();
        var date = document.getElementById("offlineDate").value;
        if (!cents || cents <= 0) { statusEl.textContent = "Enter the amount you were actually paid."; return; }
        if (!note) { statusEl.textContent = "Say how it was paid — for example Zelle, or cash at the vehicle."; return; }
        if (!confirm("Record " + money(cents) + " as collected outside Stripe (" + note + ")?\n\nThis counts in your revenue and cannot be undone from here.")) return;
        offlineBtn.disabled = true;
        statusEl.textContent = "Recording…";
        act({
          action: "record_offline_payment",
          amountCents: cents,
          offlineNote: note,
          // A date with no time is midnight UTC, which can land on the previous
          // day in Las Vegas; noon keeps the date the owner picked.
          collectedAt: date ? new Date(date + "T12:00:00Z").toISOString() : undefined
        }, function (r) {
          offlineBtn.disabled = false;
          statusEl.textContent = r.ok
            ? (r.body.completionNote || "Recorded.")
            : ((r.body && r.body.error && r.body.error.message) || "The payment was not recorded.");
          return true;
        });
      });
    }

    content.querySelectorAll("[data-refund]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var amt = prompt("Refund amount in dollars (blank = full refund):") || "";
        var cents = dollarsToCents(amt);
        if (amt && cents === null) { alert("Invalid amount"); return; }
        if (!confirm("Submit " + (cents ? "$" + (cents / 100).toFixed(2) : "FULL") + " refund via Stripe?")) return;
        function submitRefund(refundOperationId) {
          act({
            action: "refund",
            paymentId: btn.getAttribute("data-refund"),
            amountCents: cents || undefined,
            refundOperationId: refundOperationId || undefined
          }, function (r) {
            var error = r.body && r.body.error;
            if (!r.ok && error && error.code === "refund_retry_available" && error.retryAllowed && !refundOperationId) {
              var approved = confirm(
                "Stripe definitively failed the prior refund. The failed attempt is recorded.\n\n" +
                "Retry that same refund amount as a new, separately tracked provider attempt?"
              );
              if (approved) submitRefund(error.operationId);
              return true;
            }
            return false;
          });
        }
        submitRefund(null);
      });
    });

    document.getElementById("adminMsgGo").addEventListener("click", function () {
      var note = document.getElementById("adminMsg").value.trim();
      if (note) act({ action: "send_message", note: note });
    });

    content.querySelectorAll("[data-retry-email]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var messageId = btn.getAttribute("data-retry-email");
        function runRetry(confirmFresh) {
          btn.disabled = true;
          btn.textContent = confirmFresh ? "Preparing fresh copy…" : "Retrying…";
          act({ action: "retry_email", messageId: messageId, confirmFresh: confirmFresh === true }, function (r) {
            var error = r.body && r.body.error;
            if (!r.ok && error && error.code === "email_retry_window_expired" && error.requiresFreshConfirmation && !confirmFresh) {
              var approved = window.confirm(
                "This email is more than 24 hours old, so delivery is ambiguous and the provider’s duplicate protection has expired.\n\n" +
                "Review the provider delivery history first. Send a new copy only if the customer still needs it.\n\n" +
                "Create and send a fresh copy now?"
              );
              if (approved) runRetry(true);
              else {
                btn.disabled = false;
                btn.textContent = "Retry email";
              }
              return true;
            }
            if (!r.ok) {
              btn.disabled = false;
              btn.textContent = "Retry email";
            }
            return false;
          });
        }
        runRetry(false);
      });
    });

    document.getElementById("saveNotes").addEventListener("click", function () {
      act({ action: "set_notes", internalNotes: document.getElementById("internalNotes").value });
    });
    document.getElementById("newLink").addEventListener("click", function () {
      api("/api/admin/requests/" + encodeURIComponent(currentRequestId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reissue_link" })
      }).then(function (r) {
        if (r.ok) document.getElementById("toolStatus").textContent = "New portal link (share only with the customer): " + r.body.url;
      }).catch(function () {});
    });
  }

  function makeDetailAccessible() {
    // Legacy operational controls retain their actions, with persistent names
    // and stacked cell labels so the same job can be operated on a phone.
    var names = { qTier: "Quote tier", qBase: "Quote base price in dollars", qTravel: "Travel price in dollars", qAddonLabel: "Add-on description", qAddon: "Add-on price in dollars", qDiscount: "Discount in dollars", qNote: "Customer-facing quote note", qInternal: "Private quote justification", slot1: "First appointment window (local time)", slot2: "Second appointment window (local time)", slot3: "Third appointment window (local time)", adminMsg: "Message to customer (portal and email)" };
    Object.keys(names).forEach(function (id) { var input = document.getElementById(id); if (input) input.setAttribute("aria-label", names[id]); });
    content.querySelectorAll(".admin-table").forEach(function (table) {
      table.classList.add("admin-mobile-cards");
      var headers = Array.from(table.querySelectorAll("thead th")).map(function (th) { return th.textContent; });
      table.querySelectorAll("tbody tr").forEach(function (row) { Array.from(row.cells).forEach(function (cell, index) { cell.setAttribute("data-label", headers[index] || "Action"); }); });
    });
    var messages = document.getElementById("adminMsg"); if (messages) messages.closest("section").id = "jobMessages";
  }

  /* ================= Config ================= */
  function renderConfig() {
    api("/api/admin/config").then(function (r) {
      if (!r.ok) return;
      var html = '<section class="portal-card"><h2>Effective configuration</h2>' +
        '<p style="color:var(--text-2);font-size:14px;margin-bottom:12px;">Prices are in CENTS (19900 = $199). Edit the JSON and save — only recognized keys are applied, everything is audit-logged. Full reference: docs/PPI_ADMIN_GUIDE.md.</p>' +
        '<div class="field"><textarea id="configJson" rows="24" style="font-family:ui-monospace,monospace;font-size:13px;">' +
        esc(JSON.stringify(r.body.config, null, 2)) + "</textarea></div>" +
        '<button class="btn btn-primary" id="configSave">Save configuration</button>' +
        ' <span class="form-status" id="configStatus"></span></section>';
      content.innerHTML = html;
      document.getElementById("configSave").addEventListener("click", function () {
        var status = document.getElementById("configStatus");
        var parsed;
        try { parsed = JSON.parse(document.getElementById("configJson").value); }
        catch (e) { status.textContent = "Invalid JSON: " + e.message; return; }
        status.textContent = "Saving…";
        api("/api/admin/config", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsed)
        }).then(function (rr) {
          status.textContent = rr.ok ? "Saved." : (rr.body.error && rr.body.error.message) || "Failed.";
          if (rr.ok) document.getElementById("configJson").value = JSON.stringify(rr.body.config, null, 2);
        }).catch(function () { status.textContent = "Network problem."; });
      });
    }).catch(function () {});
  }
})();
