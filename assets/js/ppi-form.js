/* AutoClarity — Las Vegas PPI intake form.
   Every submission goes to the AutoClarity API and is stored server-side
   before any success message is shown. While the marketing site is static
   hosting (GitHub Pages), the API lives on the Cloudflare deployment — the
   form falls back to that origin automatically (the API allows it via a CORS
   allowlist). There is no email-app path: if the API is unreachable the form
   says so honestly and keeps the customer's answers saved on their device. */
(function () {
  "use strict";

  var API = {
    config: "/api/ppi/runtime-config",
    submit: "/api/ppi/requests",
    vin: "/api/ppi/vin",
    events: "/api/ppi/events",
    waitlist: "/api/ppi/waitlist",
    upload: "/api/portal/upload"
  };

  // Same-origin first (Cloudflare hosting), then the hosted API (static hosting).
  var FALLBACK_API_ORIGIN = "https://autoclarity-site.pages.dev";
  var apiOrigin = ""; // resolved by resolveConfig()

  function api(path) { return apiOrigin + path; }

  var intakeShell = document.getElementById("intakeShell");
  var waitlistShell = document.getElementById("waitlistShell");
  var fallbackShell = document.getElementById("fallbackShell");
  var form = document.getElementById("intakeForm");
  if (!form) return;

  var runtime = null;
  var turnstileToken = "";
  var turnstileRendered = false;
  var formStarted = false;
  var STORAGE_KEY = "ppi-intake-draft-v1";

  /* ---------- sticky mobile CTA bar ---------- */
  function buildStickyBar(contact, tel, display) {
    if (document.getElementById("ppiSticky")) return; // once
    var bar = document.createElement("div");
    bar.id = "ppiSticky";
    bar.className = "ppi-sticky";
    bar.setAttribute("aria-label", "Quick actions");
    var html = '<a class="ppi-sticky-primary" href="#request" data-analytics="ppi_cta_click" data-step="sticky">Request Inspection</a>';
    if (contact && contact.configured && contact.callEnabled) html += '<a class="ppi-sticky-secondary" href="tel:' + tel + '" data-analytics="ppi_call_click" data-step="sticky" aria-label="Call ' + escapeHtml(display) + '">Call</a>';
    if (contact && contact.configured && contact.smsEnabled) html += '<a class="ppi-sticky-secondary" href="sms:' + tel + '" data-analytics="ppi_text_click" data-step="sticky">Text</a>';
    html += '<button type="button" class="ppi-sticky-close" id="ppiStickyClose" aria-label="Dismiss">✕</button>';
    bar.innerHTML = html;
    document.body.appendChild(bar);
    var dismissed = false;
    try { dismissed = sessionStorage.getItem("ppi-sticky-dismissed") === "1"; } catch (e) {}
    document.getElementById("ppiStickyClose").addEventListener("click", function () {
      bar.classList.remove("show");
      try { sessionStorage.setItem("ppi-sticky-dismissed", "1"); } catch (e) {}
    });
    var hero = document.querySelector(".ppi-hero");
    function onScroll() {
      if (dismissed) return;
      var past = hero ? window.scrollY > hero.offsetHeight * 0.7 : window.scrollY > 500;
      var request = document.getElementById("request");
      // hide again when the form itself is in view (don't cover form controls)
      var atForm = request && request.getBoundingClientRect().top < window.innerHeight * 0.9;
      bar.classList.toggle("show", past && !atForm);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* ---------- analytics (no PII ever) ---------- */
  function track(event, step) {
    try {
      var body = JSON.stringify({ event: event, step: step || "", source: "web" });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(api(API.events), new Blob([body], { type: "application/json" }));
      } else {
        fetch(api(API.events), { method: "POST", headers: { "content-type": "application/json" }, body: body, keepalive: true }).catch(function () {});
      }
    } catch (e) { /* analytics must never break the form */ }
  }

  document.querySelectorAll("[data-analytics]").forEach(function (el) {
    el.addEventListener("click", function () {
      track(el.getAttribute("data-analytics"), el.getAttribute("data-step") || "");
    });
  });

  /* ---------- runtime config (same-origin, then hosted API) ---------- */
  function fetchConfig(origin) {
    return fetch(origin + API.config, { headers: { accept: "application/json" } })
      .then(function (res) { if (!res.ok) throw new Error("config " + res.status); return res.json(); })
      .then(function (cfg) { apiOrigin = origin; return cfg; });
  }

  function resolveConfig() {
    return fetchConfig("").catch(function () {
      if (window.location.origin === FALLBACK_API_ORIGIN) throw new Error("api unreachable");
      return fetchConfig(FALLBACK_API_ORIGIN);
    });
  }

  var formReady = false;
  function applyConfig(cfg) {
    runtime = cfg;
    applyPricing(cfg);
    applyScanLanguage(cfg);
    applyContact(cfg);
    applyReviews(cfg);
    if (cfg.mode === "waitlist") {
      intakeShell.hidden = true;
      waitlistShell.hidden = false;
      setupWaitlist();
    } else if (!formReady) {
      formReady = true;
      setupForm();
    }
  }

  resolveConfig()
    .then(function (cfg) {
      applyConfig(cfg);
      track("ppi_page_view");
    })
    .catch(function () {
      // API unreachable right now. Keep the form usable (answers save to this
      // device); submission retries the API and reports honestly if it fails.
      formReady = true;
      setupForm();
    });

  function money(cents) { return "$" + Math.round(cents / 100); }

  function applyPricing(cfg) {
    if (!cfg.pricing) return;
    (cfg.pricing.tiers || []).forEach(function (tier) {
      var valEl = document.querySelector('[data-price="' + tier.key + '"]');
      if (valEl) valEl.textContent = money(tier.priceCents);
      // Struck-through regular price + launch label, only when a real launch
      // window is active and a lower price is set for this tier.
      var wasEl = document.querySelector('[data-was="' + tier.key + '"]');
      var launchEl = document.querySelector('[data-launch="' + tier.key + '"]');
      var prefixEl = document.querySelector('[data-prefix="' + tier.key + '"]');
      if (tier.wasCents && tier.wasCents > tier.priceCents) {
        if (wasEl) { wasEl.textContent = money(tier.wasCents); wasEl.hidden = false; }
        if (prefixEl) prefixEl.textContent = tier.startingAt ? "Launch price, starting at" : "Launch price";
        if (launchEl) { launchEl.textContent = "Introductory Las Vegas launch pricing"; launchEl.hidden = false; }
      } else if (prefixEl) {
        prefixEl.textContent = tier.startingAt ? "Starting at" : "Flat rate";
      }
    });
  }

  function applyReviews(cfg) {
    // Only real, owner-configured reviews are shown; the section stays hidden
    // otherwise. No star ratings are rendered or fabricated.
    var items = (cfg && cfg.reviews) || [];
    if (!items.length) return;
    var grid = document.getElementById("reviewsGrid");
    var section = document.getElementById("reviews");
    if (!grid || !section) return;
    grid.innerHTML = items.map(function (r) {
      return '<figure class="review-card"><blockquote>' + escapeHtml(r.text) + "</blockquote>" +
        "<figcaption>" + escapeHtml(r.name) + (r.vehicle ? " · " + escapeHtml(r.vehicle) : "") + "</figcaption></figure>";
    }).join("");
    section.hidden = false;
  }

  function applyScanLanguage(cfg) {
    // Show scan-on wording only when diagnostic scan is in the confirmed scope.
    var on = cfg.scanIncluded === true;
    document.querySelectorAll('[data-scan="on"]').forEach(function (el) { el.hidden = !on; });
    document.querySelectorAll('[data-scan="off"]').forEach(function (el) { el.hidden = on; });
  }

  function applyContact(cfg) {
    var c = cfg.contact;
    if (!c || !c.configured) return; // never invent a number
    var tel = String(c.phone).replace(/[^0-9+]/g, "");
    var display = String(c.phone);
    var parts = [];
    if (c.callEnabled) parts.push('<a class="btn btn-ghost btn-lg" href="tel:' + tel + '" data-analytics="ppi_call_click" data-step="hero">Call ' + escapeHtml(display) + "</a>");
    if (c.smsEnabled) parts.push('<a class="btn btn-ghost btn-lg" href="sms:' + tel + '" data-analytics="ppi_text_click" data-step="hero">Text us</a>');
    if (c.urgentCtaEnabled && parts.length) {
      var hero = document.getElementById("heroUrgent");
      if (hero) { hero.innerHTML = '<p class="urgent-lead">Buying today? Call or text AutoClarity</p>' + parts.join(""); hero.hidden = false; }
    }
    buildStickyBar(c, tel, display);
    // (re)bind analytics on freshly injected buttons
    document.querySelectorAll("[data-analytics]").forEach(function (el) {
      if (el.dataset.trackBound) return;
      el.dataset.trackBound = "1";
      el.addEventListener("click", function () { track(el.getAttribute("data-analytics"), el.getAttribute("data-step") || ""); });
    });
  }

  function escapeHtml(s) {
    var div = document.createElement("div");
    div.textContent = String(s == null ? "" : s);
    return div.innerHTML;
  }

  /* ---------- Turnstile ---------- */
  function loadTurnstile(cb) {
    if (window.turnstile) return cb();
    var script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = cb;
    script.onerror = function () { setStatus("Human-verification service failed to load. Please refresh and try again."); };
    document.head.appendChild(script);
  }

  function renderTurnstile(container) {
    if (!runtime || !window.turnstile || container.dataset.rendered) return;
    container.dataset.rendered = "1";
    window.turnstile.render(container, {
      sitekey: runtime.turnstileSiteKey,
      theme: "dark",
      callback: function (token) { turnstileToken = token; },
      "expired-callback": function () { turnstileToken = ""; },
      "error-callback": function () { turnstileToken = ""; }
    });
  }

  /* ---------- waitlist ---------- */
  function setupWaitlist() {
    var wlForm = document.getElementById("waitlistForm");
    var slot = waitlistShell.querySelector("[data-turnstile]");
    loadTurnstile(function () { renderTurnstile(slot); });
    wlForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var status = wlForm.querySelector(".form-status");
      status.textContent = "Joining…";
      fetch(api(API.waitlist), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: document.getElementById("wlEmail").value,
          zip: document.getElementById("wlZip").value,
          turnstileToken: turnstileToken
        })
      })
        .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
        .then(function (r) {
          if (r.ok) {
            status.textContent = r.body.message || "You're on the list.";
            track("ppi_waitlist_joined");
          } else {
            status.textContent = (r.body.error && r.body.error.message) || "Something went wrong — please try again.";
            if (window.turnstile) window.turnstile.reset();
          }
        })
        .catch(function () { status.textContent = "Network problem — please try again."; });
    });
  }

  /* ---------- multi-step form ---------- */
  var steps, current, backBtn, nextBtn, submitBtn, progressBar, stepLine;
  var STEP_NAMES = ["", "you_and_vehicle", "location", "timing_access", "review"];
  var STEP_LABELS = ["", "You & the vehicle", "Where is the vehicle?", "Timing & access", "Review & submit"];

  function setupForm() {
    steps = Array.prototype.slice.call(form.querySelectorAll(".form-step"));
    current = 1;
    backBtn = document.getElementById("backBtn");
    nextBtn = document.getElementById("nextBtn");
    submitBtn = document.getElementById("submitBtn");
    progressBar = document.getElementById("progressBar");
    stepLine = document.getElementById("stepLine");

    restoreDraft();
    showStep(current, true);

    form.addEventListener("input", function () {
      if (!formStarted) { formStarted = true; track("ppi_form_started"); }
      saveDraft();
    });

    backBtn.addEventListener("click", function () { if (current > 1) showStep(current - 1); });
    nextBtn.addEventListener("click", function () {
      if (!validateStep(current)) return;
      track("ppi_form_step_completed", STEP_NAMES[current]);
      showStep(current + 1);
    });
    form.addEventListener("submit", onSubmit);

    setupVin();
    buildStickyBar(); // Request-only bar; call/text added by applyContact if configured
  }

  function showStep(n, initial) {
    current = Math.min(Math.max(n, 1), steps.length);
    steps.forEach(function (fs) { fs.hidden = Number(fs.dataset.step) !== current; });
    backBtn.hidden = current === 1;
    nextBtn.hidden = current === steps.length;
    submitBtn.hidden = current !== steps.length;
    progressBar.style.width = (current / steps.length) * 100 + "%";
    stepLine.textContent = "Step " + current + " of " + steps.length + " · " + STEP_LABELS[current];
    setStatus("");
    if (current === steps.length) {
      buildReview();
      var slot = intakeShell.querySelector("[data-turnstile]");
      loadTurnstile(function () { renderTurnstile(slot); });
    }
    if (!initial) {
      var target = document.getElementById("request");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      var firstField = steps[current - 1].querySelector("input, select, textarea");
      if (firstField && window.matchMedia("(pointer: fine)").matches) firstField.focus({ preventScroll: true });
    }
    saveDraft();
  }

  function fieldError(name, message) {
    var el = form.querySelector('[data-error-for="' + name + '"]');
    var input = form.elements[name];
    if (el) el.textContent = message || "";
    if (input && input.setAttribute) input.setAttribute("aria-invalid", message ? "true" : "false");
  }

  function clearErrors(stepEl) {
    stepEl.querySelectorAll(".field-error").forEach(function (el) { el.textContent = ""; });
    stepEl.querySelectorAll('[aria-invalid="true"]').forEach(function (el) { el.setAttribute("aria-invalid", "false"); });
  }

  function validateStep(n) {
    var stepEl = steps[n - 1];
    clearErrors(stepEl);
    var ok = true;
    function fail(name, msg) { fieldError(name, msg); if (ok) focusField(name); ok = false; }

    if (n === 1) {
      // Contact
      if (val("fullName").length < 2) fail("fullName", "Please enter your full name.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val("email"))) fail("email", "Please enter a valid email address.");
      var digits = val("phone").replace(/\D/g, "");
      if (!(digits.length === 10 || (digits.length === 11 && digits.charAt(0) === "1"))) fail("phone", "Please enter a valid US mobile number.");
      // Vehicle
      var year = parseInt(val("year"), 10);
      var maxYear = new Date().getFullYear() + 2;
      if (!(year >= 1920 && year <= maxYear)) fail("year", "Enter a valid model year.");
      if (!val("make")) fail("make", "Vehicle make is required.");
      if (!val("model")) fail("model", "Vehicle model is required.");
      var vin = val("vin").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (vin && vin.length !== 17) fail("vin", "A modern VIN is 17 characters — or leave it blank and add it later.");
      if (vin && /[IOQ]/.test(vin)) fail("vin", "VINs never contain the letters I, O or Q — double-check the character.");
      var url = val("listingUrl");
      if (url && !/^https?:\/\//i.test(url)) fail("listingUrl", "Listing link should start with http(s)://");
    }
    if (n === 2) {
      if (!val("locCity")) fail("locCity", "City is required.");
      if (!/^\d{5}$/.test(val("locZip"))) fail("locZip", "Enter a 5-digit ZIP code.");
    }
    // Step 3 (timing & access) has no required fields.
    if (n === 4) {
      if (!form.elements.transactionalConsent.checked) fail("transactionalConsent", "We need permission to contact you about this request.");
      if (!form.elements.ackAccessDependent.checked) fail("ackAccessDependent", "Please acknowledge this to continue.");
    }
    return ok;
  }

  function focusField(name) {
    var input = form.elements[name];
    if (input && input.focus) input.focus();
  }

  function val(name) {
    var el = form.elements[name];
    return el ? String(el.value || "").trim() : "";
  }

  /* ---------- VIN helpers ---------- */
  function setupVin() {
    var vinInput = document.getElementById("vin");
    var hint = document.getElementById("vinHint");

    vinInput.addEventListener("blur", function () {
      var vin = vinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (vin.length !== 17) return;
      hint.textContent = "Checking VIN…";
      fetch(api(API.vin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vin: vin })
      })
        .then(function (res) { return res.json(); })
        .then(function (r) {
          if (!r.valid) {
            hint.textContent = "Usually on the driver’s door jamb or the windshield corner.";
            fieldError("vin", (r.errors && r.errors[0]) || "That VIN doesn’t look right.");
            return;
          }
          fieldError("vin", "");
          vinInput.value = r.normalized;
          if (r.decoded && r.decoded.make) {
            if (!val("year") && r.decoded.year) form.elements.year.value = r.decoded.year;
            if (!val("make")) form.elements.make.value = titleCase(r.decoded.make);
            if (!val("model")) form.elements.model.value = r.decoded.model || "";
            if (!val("trim")) form.elements.trim.value = r.decoded.trim || r.decoded.series || "";
            hint.textContent = "Decoded: " + [r.decoded.year, titleCase(r.decoded.make), r.decoded.model].filter(Boolean).join(" ") + " — correct any details that don’t match the listing.";
          } else if (r.decodeUnavailable) {
            hint.textContent = "VIN format looks good. The decoder is unavailable right now — please fill in the details manually.";
          } else {
            hint.textContent = "VIN format looks good.";
          }
          if (r.checkDigitValid === false) {
            fieldError("vin", "This VIN’s check digit doesn’t match — worth re-reading it from the vehicle. You can still continue.");
          }
        })
        .catch(function () { hint.textContent = "Couldn’t check the VIN right now — manual entry is fine."; });
    });

    setupVinScanner(vinInput);
  }

  function titleCase(s) {
    return String(s || "").toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  }

  /* Camera-assisted VIN scan — progressive, only where BarcodeDetector exists.
     Manual entry always remains the primary path. */
  function setupVinScanner(vinInput) {
    var scanBtn = document.getElementById("vinScanBtn");
    var panel = document.getElementById("vinScanPanel");
    var video = document.getElementById("vinVideo");
    var stopBtn = document.getElementById("vinScanStop");
    if (!("BarcodeDetector" in window) || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

    var stream = null;
    var scanning = false;
    scanBtn.hidden = false;

    function stop() {
      scanning = false;
      panel.hidden = true;
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    }

    scanBtn.addEventListener("click", function () {
      var detector;
      try {
        detector = new window.BarcodeDetector({ formats: ["code_39", "code_128", "data_matrix", "qr_code"] });
      } catch (e) { scanBtn.hidden = true; return; }
      navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
        .then(function (s) {
          stream = s;
          video.srcObject = s;
          panel.hidden = false;
          scanning = true;
          return video.play();
        })
        .then(function () {
          (function tick() {
            if (!scanning) return;
            detector.detect(video).then(function (codes) {
              for (var i = 0; i < codes.length; i++) {
                var raw = String(codes[i].rawValue || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
                if (raw.length === 18 && raw.charAt(0) === "I") raw = raw.slice(1); /* common code39 prefix */
                if (raw.length === 17 && !/[IOQ]/.test(raw)) {
                  vinInput.value = raw;
                  stop();
                  vinInput.dispatchEvent(new Event("blur"));
                  return;
                }
              }
              requestAnimationFrame(tick);
            }).catch(function () { requestAnimationFrame(tick); });
          })();
        })
        .catch(function () { stop(); });
    });
    stopBtn.addEventListener("click", stop);
    window.addEventListener("pagehide", stop);
  }

  /* ---------- draft save/resume (user's own device only) ---------- */
  var FIELDS = ["fullName","email","phone","preferredContact","transactionalConsent","marketingConsent","vin","year","mileage","make","model","trim","askingPrice","expectedPrice","listingUrl","modStatus","warningLights","knownIssues","titleStatus","startsDrives","locStreet","locUnit","locCity","locState","locZip","sellerType","sellerName","sellerPhone","locNotes","liftAvailable","levelSurface","permInspection","permScan","permRoadTest","permPhotos","permUnderbody","ackAccessDependent","decisionTimeline","preferredDates","timeWindow","sameDayPriority","customerNotes"];

  function saveDraft() {
    try {
      var data = { _step: current };
      FIELDS.forEach(function (name) {
        var el = form.elements[name];
        if (!el) return;
        data[name] = el.type === "checkbox" ? el.checked : el.value;
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) { /* storage may be unavailable */ }
  }

  function restoreDraft() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      FIELDS.forEach(function (name) {
        var el = form.elements[name];
        if (!el || data[name] === undefined) return;
        if (el.type === "checkbox") el.checked = Boolean(data[name]);
        else el.value = data[name];
      });
      if (data._step >= 1 && data._step <= 4) current = data._step;
    } catch (e) { /* corrupt draft — start clean */ }
  }

  function clearDraft() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  /* ---------- review + submit ---------- */
  // Lightweight client-side tier hint (PRELIMINARY only — the server computes
  // the real suggestion and the owner confirms the final quote).
  function preliminaryTier() {
    var make = val("make").toLowerCase();
    var model = val("model").toLowerCase();
    var trim = val("trim").toLowerCase();
    var mods = val("modStatus");
    var exotic = /ferrari|lamborghini|mclaren|aston martin|bentley|rolls|maserati|lotus|bugatti|pagani/.test(make);
    var euro = /bmw|mercedes|audi|porsche|land rover|range rover|jaguar|volvo|volkswagen|mini|tesla|lexus|genesis|maserati/.test(make);
    var perf = /corvette|gt-r|gtr|supra|nsx|hellcat|demon|trackhawk|raptor|trx|type r|wrx|sti|golf r|gti|911|amg|shelby|mustang|camaro|challenger|charger|m3|m4|m5/.test(model + " " + trim);
    var year = parseInt(val("year"), 10);
    var classic = year && (new Date().getFullYear() - year) >= 25;
    if (exotic || classic || mods === "heavy") return "Exotic, Collector or Heavily Modified";
    if (euro || perf || mods === "light") return "European, Luxury or Performance";
    return "Standard Vehicle";
  }

  function buildReview() {
    var card = document.getElementById("reviewCard");
    var rows = [
      ["Vehicle", [val("year"), val("make"), val("model"), val("trim")].filter(Boolean).join(" ") || "—"],
      ["VIN", val("vin") || "Not provided yet"],
      ["Location", [val("locCity"), val("locState"), val("locZip")].filter(Boolean).join(", ")],
      ["Seller", form.elements.sellerType.options[form.elements.sellerType.selectedIndex].text],
      ["Timing", form.elements.decisionTimeline.options[form.elements.decisionTimeline.selectedIndex].text],
      ["Contact", val("email") + " · " + val("phone")]
    ];
    card.innerHTML = rows.map(function (r) {
      return "<div><dt>" + escapeHtml(r[0]) + "</dt><dd>" + escapeHtml(r[1]) + "</dd></div>";
    }).join("");
    var tierEl = document.getElementById("reviewTier");
    if (tierEl) {
      tierEl.innerHTML = "Estimated tier: <strong>" + escapeHtml(preliminaryTier()) + " PPI</strong> — <em>preliminary; your exact price and any travel charge are confirmed after AutoClarity reviews the vehicle.</em>";
    }
  }

  function setStatus(msg) {
    var el = document.getElementById("formStatus");
    if (el) el.textContent = msg || "";
  }

  function onSubmit(e) {
    e.preventDefault();
    for (var i = 1; i <= steps.length; i++) {
      if (!validateStep(i)) { showStep(i); return; }
    }

    // The API wasn't reachable when the page loaded — try to connect now.
    // Nothing is ever claimed as "received" unless the API stored it.
    if (!runtime) {
      setStatus("Connecting to the booking system…");
      submitBtn.disabled = true;
      resolveConfig()
        .then(function (cfg) {
          submitBtn.disabled = false;
          applyConfig(cfg);
          var slot = intakeShell.querySelector("[data-turnstile]");
          loadTurnstile(function () { renderTurnstile(slot); });
          setStatus("Connected. Please complete the human-verification check above, then press Submit again.");
        })
        .catch(function () {
          submitBtn.disabled = false;
          showSubmitUnavailable();
        });
      return;
    }

    if (!turnstileToken) {
      setStatus("Please complete the human-verification check above.");
      return;
    }
    submitBtn.disabled = true;
    setStatus("Submitting your request…");

    var payload = { turnstileToken: turnstileToken };
    FIELDS.forEach(function (name) {
      var el = form.elements[name];
      if (!el) return;
      payload[name] = el.type === "checkbox" ? el.checked : el.value;
    });

    fetch(api(API.submit), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json().then(function (b) { return { status: res.status, body: b }; }); })
      .then(function (r) {
        submitBtn.disabled = false;
        if (r.status === 200 && (r.body.ok || r.body.duplicate)) {
          track("ppi_request_submitted");
          clearDraft();
          showSuccess(r.body);
          return;
        }
        if (r.status === 422 && r.body.fields) {
          var fields = Object.keys(r.body.fields);
          fields.forEach(function (name) { fieldError(name, r.body.fields[name]); });
          var stepWithError = earliestStepFor(fields);
          setStatus("Please correct the highlighted fields.");
          if (stepWithError) showStep(stepWithError);
          return;
        }
        setStatus((r.body.error && r.body.error.message) || "Something went wrong — please try again.");
        if (window.turnstile) { window.turnstile.reset(); turnstileToken = ""; }
      })
      .catch(function () {
        submitBtn.disabled = false;
        showSubmitUnavailable();
      });
  }

  /* Honest failure state: the request was NOT submitted. The form stays on
     screen with everything saved locally; other ways to reach AutoClarity are
     offered — never a success claim, never a forced email app. */
  function showSubmitUnavailable() {
    setStatus("We couldn't reach the booking system, so your request has NOT been submitted. " +
      "Your answers are saved on this device — please try again in a minute.");
    if (fallbackShell) fallbackShell.hidden = false;
  }

  var STEP_OF_FIELD = {
    fullName: 1, email: 1, phone: 1, year: 1, make: 1, model: 1, vin: 1, listingUrl: 1,
    locCity: 2, locZip: 2, locState: 2,
    transactionalConsent: 4, ackAccessDependent: 4
  };
  function earliestStepFor(fields) {
    var min = 0;
    fields.forEach(function (f) {
      var s = STEP_OF_FIELD[f];
      if (s && (min === 0 || s < min)) min = s;
    });
    return min;
  }

  /* ---------- success + uploads ---------- */
  function showSuccess(result) {
    form.hidden = true;
    document.getElementById("stepLine").hidden = true;
    document.querySelector(".form-progress").hidden = true;
    if (fallbackShell) fallbackShell.hidden = true;
    var panel = document.getElementById("successPanel");
    panel.hidden = false;
    document.getElementById("successRef").textContent = result.ref;
    var dupNote = document.getElementById("successDuplicateNote");
    if (dupNote) dupNote.hidden = !result.duplicate;
    var link = document.getElementById("successPortalLink");
    // The portal lives on the API origin (absolute while the marketing site is static hosting).
    link.href = api("/ppi/portal/?t=" + encodeURIComponent(result.portalToken));

    var uploadBlock = document.getElementById("uploadBlock");
    if (!runtime || runtime.uploadsEnabled === false) {
      uploadBlock.hidden = true;
    } else {
      setupUploads(result.portalToken);
    }
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function setupUploads(token) {
    var input = document.getElementById("uploadInput");
    var list = document.getElementById("uploadList");
    var max = (runtime && runtime.uploads && runtime.uploads.maxFiles) || 6;
    var maxBytes = (runtime && runtime.uploads && runtime.uploads.maxBytes) || 8388608;
    var done = 0;

    input.addEventListener("change", function () {
      var files = Array.prototype.slice.call(input.files || []);
      files.forEach(function (file) {
        var li = document.createElement("li");
        li.textContent = file.name + " — uploading…";
        list.appendChild(li);
        if (done >= max) { li.textContent = file.name + " — limit of " + max + " images reached"; li.className = "err"; return; }
        if (file.size > maxBytes) { li.textContent = file.name + " — over " + Math.round(maxBytes / 1048576) + " MB"; li.className = "err"; return; }
        var fd = new FormData();
        fd.append("file", file);
        fd.append("kind", "other");
        fetch(api(API.upload), { method: "POST", headers: { authorization: "Bearer " + token }, body: fd })
          .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
          .then(function (r) {
            if (r.ok) { done++; li.textContent = file.name; li.className = "ok"; }
            else { li.textContent = file.name + " — " + ((r.body.error && r.body.error.message) || "failed"); li.className = "err"; }
          })
          .catch(function () { li.textContent = file.name + " — network problem"; li.className = "err"; });
      });
      input.value = "";
    });
  }
})();
