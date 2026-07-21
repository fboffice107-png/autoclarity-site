/* AutoClarity — PPI admin dashboard (single-owner tool).
   Auth: Cloudflare Access in production (transparent), ADMIN_DEV_KEY in
   preview via sessionStorage. All data comes from /api/admin/*. */
(function () {
  "use strict";

  var KEY_STORE = "ppi-admin-key";
  var content = document.getElementById("adminContent");
  var nav = document.getElementById("adminNav");
  var loginPanel = document.getElementById("loginPanel");
  var currentView = "overview";
  var currentRequestId = null;
  var detailCache = null;

  function adminKey() {
    try { return sessionStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; }
  }

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers || {});
    var key = adminKey();
    if (key) options.headers["authorization"] = "Bearer " + key;
    return fetch(path, options).then(function (res) {
      if (res.status === 401) { showLogin(); throw new Error("unauthorized"); }
      return res.json().then(function (body) { return { status: res.status, ok: res.ok, body: body }; });
    });
  }

  function showLogin() {
    loginPanel.hidden = false;
    nav.hidden = true;
    content.innerHTML = "";
  }

  document.getElementById("loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var key = document.getElementById("adminKey").value.trim();
    try { sessionStorage.setItem(KEY_STORE, key); } catch (err) {}
    document.getElementById("loginStatus").textContent = "Checking…";
    boot();
  });

  nav.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      nav.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      currentRequestId = null;
      show(btn.getAttribute("data-view"));
    });
  });

  boot();

  function boot() {
    api("/api/admin/overview").then(function (r) {
      if (!r.ok) { showLogin(); return; }
      loginPanel.hidden = true;
      nav.hidden = false;
      show("overview", r.body);
    }).catch(function () {});
  }

  function show(view, preloaded) {
    currentView = view;
    if (view === "overview") renderOverview(preloaded);
    if (view === "requests") renderRequests();
    if (view === "config") renderConfig();
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = String(s == null ? "" : s);
    return d.innerHTML;
  }
  function money(cents) { return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }); }
  function when(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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
        stat(money(data.revenue30d.cents), "Revenue (30d)") +
        "</div>";

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

      html += '<section class="portal-card"><h2>Funnel (30 days)</h2><div class="admin-grid">';
      var funnelOrder = ["ppi_page_view", "ppi_form_started", "ppi_request_submitted", "ppi_quote_sent", "ppi_slot_selected", "ppi_agreement_accepted", "ppi_checkout_started", "ppi_booking_confirmed"];
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

  /* ================= Requests list ================= */
  function renderRequests() {
    var html = '<div class="admin-toolbar"><label for="statusFilter" class="sr-only">Filter by status</label>' +
      '<select id="statusFilter"><option value="">All statuses</option>' +
      ["submitted", "needs_info", "seller_access_pending", "ready_for_review", "quote_prepared", "quote_sent", "awaiting_time_selection", "awaiting_agreement", "awaiting_payment", "confirmed", "inspection_in_progress", "report_in_progress", "completed", "customer_cancelled", "admin_cancelled", "expired", "refunded", "disputed"]
        .map(function (s) { return '<option value="' + s + '">' + s.replace(/_/g, " ") + "</option>"; }).join("") +
      '</select></div><div id="requestsTable"></div>';
    content.innerHTML = html;
    document.getElementById("statusFilter").addEventListener("change", loadList);
    loadList();

    function loadList() {
      var filter = document.getElementById("statusFilter").value;
      api("/api/admin/requests" + (filter ? "?status=" + encodeURIComponent(filter) : "")).then(function (r) {
        if (!r.ok) return;
        var rows = r.body.requests || [];
        var t = '<section class="portal-card"><table class="admin-table"><thead><tr>' +
          "<th>Ref</th><th>Status</th><th>Vehicle</th><th>Customer</th><th>Area</th><th>Tier</th><th>Created</th></tr></thead><tbody>";
        rows.forEach(function (row) {
          var manual = row.manual_review_reasons && row.manual_review_reasons !== "[]";
          t += '<tr data-req="' + esc(row.id) + '"><td class="mono">' + esc(row.ref) + "</td>" +
            "<td>" + esc(String(row.status).replace(/_/g, " ")) + (manual ? " ⚠" : "") + (row.same_day_priority ? " ⚡" : "") + "</td>" +
            "<td>" + esc([row.year, row.make, row.model].filter(Boolean).join(" ")) + "</td>" +
            "<td>" + esc(row.full_name) + "</td>" +
            "<td>" + esc([row.loc_city, row.loc_zip].filter(Boolean).join(" ")) + "</td>" +
            "<td>" + esc(row.suggested_tier || "—") + "</td>" +
            '<td class="mono">' + esc(when(row.created_at)) + "</td></tr>";
        });
        t += "</tbody></table>" + (rows.length === 0 ? '<p style="color:var(--text-3);padding:12px 0 0;">No requests.</p>' : "") + "</section>";
        document.getElementById("requestsTable").innerHTML = t;
        document.querySelectorAll("#requestsTable [data-req]").forEach(function (tr) {
          tr.addEventListener("click", function () { openDetail(tr.getAttribute("data-req")); });
        });
      }).catch(function () {});
    }
  }

  /* ================= Request detail ================= */
  function openDetail(id) {
    currentRequestId = id;
    api("/api/admin/requests/" + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) return;
      detailCache = r.body;
      renderDetail();
    }).catch(function () {});
  }

  function act(payload, cb) {
    api("/api/admin/requests/" + encodeURIComponent(currentRequestId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (cb) cb(r);
      if (r.ok) openDetail(currentRequestId);
      else alert((r.body.error && r.body.error.message) || "Action failed");
    }).catch(function () {});
  }

  function renderDetail() {
    var d = detailCache;
    var req = d.request;
    var html = '<button class="btn btn-ghost btn-sm" id="backToList">← Back</button>';

    html += '<div class="portal-topbar" style="margin-top:14px;"><h1 style="font-size:24px;">' + esc(req.ref) + "</h1>" +
      '<span class="status-pill">' + esc(d.statusLabel) + "</span></div>";

    if (req.manual_review_reasons && req.manual_review_reasons !== "[]") {
      var reasons = [];
      try { reasons = JSON.parse(req.manual_review_reasons); } catch (e) {}
      if (reasons.length) html += '<div class="notice warn">Manual review: ' + esc(reasons.join(" · ")) + "</div>";
    }

    // ----- customer & vehicle -----
    html += '<section class="portal-card"><h2>Customer &amp; vehicle</h2><dl class="kv">' +
      "<dt>Customer</dt><dd>" + esc(req.full_name) + " · " + esc(req.email) + " · " + esc(req.phone) + " (prefers " + esc(req.preferred_contact) + ")</dd>" +
      "<dt>Vehicle</dt><dd>" + esc([req.year, req.make, req.model, req.vehicle_trim].filter(Boolean).join(" ")) + " · " + esc(req.mileage ? Number(req.mileage).toLocaleString() + " mi" : "mileage n/a") + "</dd>" +
      "<dt>VIN</dt><dd class=\"mono\">" + esc(req.vin || "not provided") + "</dd>" +
      "<dt>Prices</dt><dd>Asking " + (req.asking_price_cents ? money(req.asking_price_cents) : "—") + " · Expecting " + (req.expected_price_cents ? money(req.expected_price_cents) : "—") + "</dd>" +
      "<dt>Listing</dt><dd>" + (req.listing_url ? '<a href="' + esc(req.listing_url) + '" target="_blank" rel="noopener noreferrer">open listing ↗</a>' : "—") + "</dd>" +
      "<dt>Condition</dt><dd>Mods: " + esc(req.mod_status) + " · Title: " + esc(req.title_status) + " · Starts/drives: " + esc(req.starts_drives) + "</dd>" +
      "<dt>Warnings</dt><dd>" + esc(req.warning_lights || "—") + "</dd>" +
      "<dt>Known issues</dt><dd>" + esc(req.known_issues || "—") + "</dd>" +
      "<dt>Location</dt><dd>" + esc([req.loc_street, req.loc_unit, req.loc_city, req.loc_state, req.loc_zip].filter(Boolean).join(", ")) + "</dd>" +
      "<dt>Seller</dt><dd>" + esc([req.seller_type, req.seller_name, req.seller_phone].filter(Boolean).join(" · ") || "—") + "</dd>" +
      "<dt>Access</dt><dd>Inspection OK: " + yn(req.perm_inspection) + " · Scan OK: " + yn(req.perm_scan) + " · Road test: " + esc(req.perm_road_test) + " · Photos: " + esc(req.perm_photos) + " · Underbody: " + esc(req.perm_underbody) + " · Lift: " + esc(req.lift_available) + " · Level surface: " + esc(req.level_surface) + "</dd>" +
      "<dt>Timing</dt><dd>" + esc([req.decision_timeline, req.preferred_dates, req.time_window].filter(Boolean).join(" · ")) + (req.same_day_priority ? " · SAME-DAY PRIORITY" : "") + "</dd>" +
      "<dt>Travel est.</dt><dd>" + (req.travel_miles != null ? esc(req.travel_miles) + " mi (" + esc(req.travel_estimate_basis) + ")" : "unknown — custom review") + "</dd>" +
      "<dt>Customer notes</dt><dd>" + esc(req.customer_notes || "—") + "</dd>" +
      "</dl></section>";

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
      '<select id="statusTo"><option value="">Move to…</option>' +
      (d.allowedTransitions || []).map(function (s) { return '<option value="' + s + '">' + s.replace(/_/g, " ") + "</option>"; }).join("") +
      '</select><input id="statusReason" placeholder="Reason (internal + history)" style="flex:1;min-width:200px;" />' +
      '<input id="statusNote" placeholder="Optional note emailed to customer" style="flex:1;min-width:200px;" />' +
      '<button class="btn btn-primary" id="statusGo">Apply</button></div></section>';

    // ----- quote editor -----
    html += '<section class="portal-card"><h2>Quote</h2>';
    var activeQuote = (d.quotes || [])[0];
    if ((d.quotes || []).length) {
      html += '<table class="admin-table"><thead><tr><th>v</th><th>Status</th><th>Tier</th><th>Total</th><th>Expires</th><th></th></tr></thead><tbody>';
      d.quotes.forEach(function (q) {
        html += "<tr><td>" + q.version + "</td><td>" + esc(q.status) + "</td><td>" + esc(q.tier) + "</td><td>" + money(q.total_cents) + "</td><td class=\"mono\">" + esc(when(q.expires_at)) + "</td><td>" +
          (q.status === "draft" ? '<button class="btn btn-primary btn-sm" data-send-quote="' + esc(q.id) + '">Send to customer</button>' : "") + "</td></tr>";
      });
      html += "</tbody></table><hr style='border-color:var(--line-soft);margin:16px 0;' />";
    }
    html += '<h3>New quote version</h3><div class="admin-toolbar">' +
      '<select id="qTier"><option value="standard">Standard — suggested: ' + esc(req.suggested_tier || "?") + "</option>" +
      '<option value="euro_luxury_performance">European/Luxury/Performance</option>' +
      '<option value="exotic_collector">Exotic/Collector/Modified</option></select>' +
      '<input id="qBase" placeholder="Base $ (blank = tier price)" inputmode="decimal" style="width:170px;" />' +
      '<input id="qTravel" placeholder="Travel $ (blank = suggested)" inputmode="decimal" style="width:180px;" />' +
      '<input id="qAddonLabel" placeholder="Add-on label" style="width:150px;" />' +
      '<input id="qAddon" placeholder="Add-on $" inputmode="decimal" style="width:110px;" />' +
      '<input id="qDiscount" placeholder="Discount $" inputmode="decimal" style="width:110px;" />' +
      "</div>" +
      '<div class="field"><input id="qNote" placeholder="Customer-facing note (optional)" /></div>' +
      '<div class="field"><input id="qInternal" placeholder="Internal justification (never shown to customer)" /></div>' +
      '<button class="btn btn-ghost" id="qCreate">Create draft quote</button></section>';

    // ----- scheduling -----
    html += '<section class="portal-card"><h2>Scheduling</h2>';
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
    html += '<h3>Offer windows (your local time)</h3><div class="admin-toolbar">' +
      '<input type="datetime-local" id="slot1" /><input type="datetime-local" id="slot2" /><input type="datetime-local" id="slot3" />' +
      '<button class="btn btn-ghost" id="slotsGo">Propose</button></div>' +
      '<p class="field-hint">Suggested templates: 9:00 AM, 12:30 PM, 4:00 PM. Conflicts (incl. travel/report buffers) are rejected automatically.</p></section>';

    // ----- payments -----
    html += '<section class="portal-card"><h2>Payments</h2>';
    if ((d.payments || []).length) {
      html += '<table class="admin-table"><thead><tr><th>Amount</th><th>Status</th><th>Stripe ref</th><th>Date</th><th></th></tr></thead><tbody>';
      d.payments.forEach(function (p) {
        html += "<tr><td>" + money(p.amount_cents) + (p.refunded_cents ? " (−" + money(p.refunded_cents) + ")" : "") + "</td><td>" + esc(p.status) + "</td>" +
          '<td class="mono">' + esc(p.stripe_payment_intent || p.stripe_session_id || "—") + "</td><td class=\"mono\">" + esc(when(p.created_at)) + "</td><td>" +
          ((p.status === "succeeded" || p.status === "partially_refunded") ? '<button class="btn btn-ghost btn-sm" data-refund="' + esc(p.id) + '">Refund…</button>' : "") + "</td></tr>";
      });
      html += "</tbody></table>";
    } else {
      html += '<p style="color:var(--text-3);">No payments.</p>';
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
      html += '<li class="' + (m.direction === "inbound" ? "inbound" : "") + '">' +
        "<strong>" + esc(m.direction) + (m.template ? " · " + esc(m.template) : "") + (m.channel === "email" ? " · " + esc(m.status) : "") + ":</strong> " +
        esc((m.subject ? m.subject + " — " : "") + (m.body_text || "").slice(0, 400)) +
        '<span class="msg-meta">' + esc(when(m.created_at)) + "</span></li>";
    });
    html += "</ul><div class='admin-toolbar' style='margin-top:12px;'>" +
      '<input id="adminMsg" placeholder="Message to customer (portal + email)" style="flex:1;min-width:220px;" />' +
      '<button class="btn btn-ghost" id="adminMsgGo">Send</button></div></section>';

    // ----- internal notes & tools -----
    html += '<section class="portal-card"><h2>Internal notes &amp; tools</h2>' +
      '<div class="field"><textarea id="internalNotes" rows="3" placeholder="Internal notes (never shown to the customer)">' + esc(req.internal_notes || "") + "</textarea></div>" +
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
  }

  function yn(v) { return Number(v) === 1 ? "yes" : "no"; }

  function dollarsToCents(str) {
    var n = Number(String(str || "").replace(/[$,\s]/g, ""));
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n * 100);
  }

  function bindDetail() {
    document.getElementById("backToList").addEventListener("click", function () { show("requests"); });

    // upload thumbnails require the auth header → fetch to blob URLs
    content.querySelectorAll("[data-upload]").forEach(function (img) {
      var id = img.getAttribute("data-upload");
      fetch("/api/admin/uploads/" + encodeURIComponent(id), { headers: { authorization: "Bearer " + adminKey() } })
        .then(function (res) { return res.ok ? res.blob() : null; })
        .then(function (blob) { if (blob) img.src = URL.createObjectURL(blob); })
        .catch(function () {});
    });
    content.querySelectorAll("[data-del-upload]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (!confirm("Delete this customer upload permanently?")) return;
        act({ action: "delete_upload", uploadId: btn.getAttribute("data-del-upload") });
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
      if (addonCents) addons.push({ label: document.getElementById("qAddonLabel").value || "Add-on", amountCents: addonCents });
      act({
        action: "create_quote",
        tier: document.getElementById("qTier").value,
        basePriceCents: dollarsToCents(document.getElementById("qBase").value) || undefined,
        travelCents: dollarsToCents(document.getElementById("qTravel").value) !== null ? dollarsToCents(document.getElementById("qTravel").value) : undefined,
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
      var slots = ["slot1", "slot2", "slot3"].map(function (id) { return document.getElementById(id).value; })
        .filter(Boolean)
        .map(function (v) { return new Date(v).toISOString(); });
      if (!slots.length) return;
      act({ action: "propose_slots", slots: slots }, function (r) {
        if (r.ok && r.body.skipped && r.body.skipped.length) alert("Skipped:\n" + r.body.skipped.join("\n"));
      });
    });
    content.querySelectorAll("[data-release-slot]").forEach(function (btn) {
      btn.addEventListener("click", function () { act({ action: "release_slot", slotId: btn.getAttribute("data-release-slot") }); });
    });

    content.querySelectorAll("[data-refund]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var amt = prompt("Refund amount in dollars (blank = full refund):") || "";
        var cents = dollarsToCents(amt);
        if (amt && cents === null) { alert("Invalid amount"); return; }
        if (!confirm("Submit " + (cents ? "$" + (cents / 100).toFixed(2) : "FULL") + " refund via Stripe?")) return;
        act({ action: "refund", paymentId: btn.getAttribute("data-refund"), amountCents: cents || undefined });
      });
    });

    document.getElementById("adminMsgGo").addEventListener("click", function () {
      var note = document.getElementById("adminMsg").value.trim();
      if (note) act({ action: "send_message", note: note });
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
