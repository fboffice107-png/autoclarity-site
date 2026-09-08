/* AutoClarity — owner-only, privacy-minimized lead classification queue. */
(function () {
  "use strict";

  var KEY_STORE = "ppi-admin-key";
  var CLASSIFICATIONS = [
    ["needs_owner_review", "Needs owner review"],
    ["genuine", "Genuine"],
    ["duplicate", "Duplicate"],
    ["spam", "Spam"],
    ["test", "Test"],
    ["closed", "Closed"],
  ];
  var STATUSES = [
    "draft", "submitted", "needs_info", "seller_access_pending", "ready_for_review",
    "quote_prepared", "quote_sent", "awaiting_time_selection", "awaiting_agreement",
    "awaiting_payment", "confirmed", "inspection_in_progress", "report_in_progress",
    "completed", "customer_cancelled", "admin_cancelled", "expired", "refunded",
    "refund_reconciliation_needed", "disputed",
  ];

  var content = document.getElementById("leadReviewContent");
  var loginPanel = document.getElementById("loginPanel");
  var loginStatus = document.getElementById("loginStatus");
  var refreshButton = document.getElementById("refreshButton");
  var filters = { classification: "needs_owner_review", status: "all" };
  var notice = "";

  function adminKey() {
    try { return sessionStorage.getItem(KEY_STORE) || ""; } catch (error) { return ""; }
  }

  function api(path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers || {});
    var key = adminKey();
    if (key) options.headers.authorization = "Bearer " + key;
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () {
        return { error: { message: "The server returned an unreadable response." } };
      }).then(function (body) {
        return { ok: response.ok, status: response.status, body: body };
      });
    });
  }

  function element(tag, text, className) {
    var node = document.createElement(tag);
    if (text != null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function sourceLabel(value) {
    value = String(value || "ppi_unknown");
    if (value === "ppi_unknown") return "Unknown / unattributed";
    if (value === "ppi_direct") return "Direct";
    if (value === "ppi_ios_app") return "AutoClarity iOS app";
    return value.replace(/^ppi_/, "").replace(/_/g, " ");
  }

  function showLogin(message) {
    loginPanel.hidden = false;
    refreshButton.hidden = true;
    content.replaceChildren();
    if (message) loginStatus.textContent = message;
  }

  function showFailure(message) {
    content.replaceChildren();
    var panel = element("section", null, "portal-card");
    panel.appendChild(element("h2", "Lead review unavailable"));
    panel.appendChild(element("p", message, "form-status"));
    content.appendChild(panel);
  }

  function stat(value, label) {
    var card = element("div", null, "stat-card");
    card.appendChild(element("div", value, "stat-num"));
    card.appendChild(element("div", label, "stat-label"));
    return card;
  }

  function option(select, value, label, selected) {
    var item = element("option", label);
    item.value = value;
    item.selected = value === selected;
    select.appendChild(item);
  }

  function classificationSelect(selected, requestRef) {
    var select = document.createElement("select");
    select.setAttribute("aria-label", "Lead classification for " + String(requestRef));
    CLASSIFICATIONS.forEach(function (item) { option(select, item[0], item[1], selected); });
    return select;
  }

  function evidenceBadges(row) {
    var wrap = element("div", null, "lead-review-badges");
    if (row.hasPayment) wrap.appendChild(element("span", "Payment record", "lead-review-badge"));
    if (row.hasBooking) wrap.appendChild(element("span", "Booking record", "lead-review-badge"));
    if (row.hasRecordedCompletion) wrap.appendChild(element("span", "Recorded completion", "lead-review-badge"));
    if (!wrap.childNodes.length) wrap.appendChild(element("span", "None", "mono"));
    return wrap;
  }

  function saveClassification(row, select, button, rowStatus) {
    var selected = select.value;
    button.disabled = true;
    select.disabled = true;
    rowStatus.textContent = "Saving…";
    api("/api/admin/lead-review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: row.id,
        expectedClassification: row.classification,
        classification: selected,
      }),
    }).then(function (result) {
      if (result.status === 401) {
        showLogin("Your preview key was not accepted.");
        return;
      }
      if (!result.ok) {
        if (result.status === 409) {
          notice = "That label changed in another session. The queue was refreshed.";
          load();
          return;
        }
        rowStatus.textContent = (result.body.error || {}).message || "Could not save this label.";
        button.disabled = false;
        select.disabled = false;
        return;
      }
      notice = result.body.noChange ? "No label change was needed." : "Lead label saved. No customer or lifecycle action was taken.";
      load();
    }).catch(function () {
      rowStatus.textContent = "Could not reach the lead review service.";
      button.disabled = false;
      select.disabled = false;
    });
  }

  function renderQueue(data) {
    loginPanel.hidden = true;
    refreshButton.hidden = false;
    content.replaceChildren();

    if (notice) {
      content.appendChild(element("div", notice, "notice good"));
      notice = "";
    }

    var counts = data.classificationCounts || {};
    var stats = element("section", null, "admin-grid");
    stats.appendChild(stat(counts.needs_owner_review || 0, "Needs owner review"));
    stats.appendChild(stat(data.staleNeedsOwnerReview || 0, "Stale unresolved"));
    stats.appendChild(stat(counts.genuine || 0, "Genuine — all time"));
    stats.appendChild(stat(data.newGenuine30d || 0, "New genuine — 30 days"));
    stats.appendChild(stat(counts.duplicate || 0, "Duplicate"));
    stats.appendChild(stat(counts.spam || 0, "Spam"));
    stats.appendChild(stat(counts.test || 0, "Test"));
    stats.appendChild(stat(counts.closed || 0, "Closed"));
    content.appendChild(stats);

    var evidenceNote = element(
      "p",
      "Zero genuine means zero owner-classified genuine requests. It does not mean zero real customers, paid inspections, or completed inspections.",
    );
    evidenceNote.style.color = "var(--text-2)";
    content.appendChild(evidenceNote);

    if (Number(data.reconciliationWarningCount || 0) > 0) {
      content.appendChild(element(
        "div",
        data.reconciliationWarningCount + " excluded-label request(s) have payment, booking, or completion evidence. Keep them in financial reconciliation totals and review them under Show all.",
        "notice warn",
      ));
    }

    var panel = element("section", null, "portal-card");
    panel.appendChild(element("h2", "Classification queue"));
    var guide = element(
      "p",
      "Genuine means the owner verified a real PPI inquiry. Review rows with payment, booking, or completion evidence carefully; if the evidence is inconclusive, leave the label unresolved. A label never changes lifecycle, payment, booking, or completion history. Closed closes lead review only; it does not mean cancelled, completed, paid, or refunded.",
    );
    guide.style.color = "var(--text-2)";
    guide.style.margin = "10px 0 16px";
    panel.appendChild(guide);

    var toolbar = element("div", null, "admin-toolbar");
    var classLabel = element("label", "Classification ");
    var classFilter = document.createElement("select");
    classFilter.id = "classificationFilter";
    option(classFilter, "all", "Show all", filters.classification);
    CLASSIFICATIONS.forEach(function (item) { option(classFilter, item[0], item[1], filters.classification); });
    classLabel.appendChild(classFilter);
    toolbar.appendChild(classLabel);

    var statusLabel = element("label", "Lifecycle ");
    var statusFilter = document.createElement("select");
    statusFilter.id = "statusFilter";
    option(statusFilter, "all", "All statuses", filters.status);
    STATUSES.forEach(function (status) { option(statusFilter, status, status.replace(/_/g, " "), filters.status); });
    statusLabel.appendChild(statusFilter);
    toolbar.appendChild(statusLabel);
    panel.appendChild(toolbar);

    function applyFilters() {
      filters.classification = classFilter.value;
      filters.status = statusFilter.value;
      load();
    }
    classFilter.addEventListener("change", applyFilters);
    statusFilter.addEventListener("change", applyFilters);

    if (!(data.queue || []).length) {
      var empty = element("p", "No requests match these filters.");
      empty.style.color = "var(--text-3)";
      panel.appendChild(empty);
      content.appendChild(panel);
      return;
    }

    var overflow = document.createElement("div");
    overflow.style.overflowX = "auto";
    var table = element("table", null, "admin-table lead-review-table");
    var head = document.createElement("thead");
    var headRow = document.createElement("tr");
    ["Request", "Age / lifecycle", "Vehicle / area", "Source", "Evidence", "Owner label"].forEach(function (heading) {
      headRow.appendChild(element("th", heading));
    });
    head.appendChild(headRow);
    table.appendChild(head);
    var body = document.createElement("tbody");

    data.queue.forEach(function (row) {
      var tr = document.createElement("tr");
      if (row.hasReconciliationEvidence) tr.className = "lead-review-warning";

      var requestCell = document.createElement("td");
      var requestLink = element("a", row.ref || row.id);
      requestLink.href = "/ppi/admin/?request=" + encodeURIComponent(row.id);
      requestCell.appendChild(requestLink);
      requestCell.appendChild(element("div", row.createdDate || "Date unavailable", "mono"));
      tr.appendChild(requestCell);

      var ageCell = document.createElement("td");
      ageCell.appendChild(element("div", String(row.ageDays || 0) + " days"));
      ageCell.appendChild(element("div", String(row.status || "").replace(/_/g, " "), "mono"));
      tr.appendChild(ageCell);

      var vehicleCell = document.createElement("td");
      var vehicle = row.vehicle || {};
      vehicleCell.appendChild(element("div", [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") || "Vehicle not specified"));
      var location = row.location || {};
      vehicleCell.appendChild(element("div", [location.city, location.zip].filter(Boolean).join(" · ") || "Area not specified", "mono"));
      tr.appendChild(vehicleCell);

      tr.appendChild(element("td", sourceLabel(row.attributionSource)));
      var evidenceCell = document.createElement("td");
      evidenceCell.appendChild(evidenceBadges(row));
      tr.appendChild(evidenceCell);

      var actionCell = document.createElement("td");
      var actions = element("div", null, "lead-review-actions");
      var select = classificationSelect(row.classification, row.ref || row.id);
      var save = element("button", "Save", "btn btn-primary btn-sm");
      save.type = "button";
      var rowStatus = element("span", "", "mono");
      save.setAttribute("aria-label", "Save classification for " + String(row.ref || row.id));
      rowStatus.setAttribute("aria-live", "polite");
      save.addEventListener("click", function () { saveClassification(row, select, save, rowStatus); });
      actions.appendChild(select);
      actions.appendChild(save);
      actionCell.appendChild(actions);
      actionCell.appendChild(rowStatus);
      tr.appendChild(actionCell);
      body.appendChild(tr);
    });

    table.appendChild(body);
    overflow.appendChild(table);
    panel.appendChild(overflow);
    content.appendChild(panel);
  }

  function load() {
    refreshButton.disabled = true;
    var query = new URLSearchParams({
      classification: filters.classification,
      status: filters.status,
      limit: "100",
    });
    api("/api/admin/lead-review?" + query.toString()).then(function (result) {
      refreshButton.disabled = false;
      if (result.status === 401) {
        showLogin();
        return;
      }
      if (!result.ok) {
        showFailure((result.body.error || {}).message || "Could not load lead review.");
        return;
      }
      renderQueue(result.body);
    }).catch(function () {
      refreshButton.disabled = false;
      showFailure("Could not reach the lead review service.");
    });
  }

  document.getElementById("loginForm").addEventListener("submit", function (event) {
    event.preventDefault();
    var key = document.getElementById("adminKey").value.trim();
    try { sessionStorage.setItem(KEY_STORE, key); } catch (error) {}
    loginStatus.textContent = "Checking…";
    load();
  });
  refreshButton.addEventListener("click", load);
  load();
})();
