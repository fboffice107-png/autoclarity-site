/* AutoClarity — Las Vegas PPI intake form.
   Progressive enhancement: without the API (e.g. static-only hosting) the page
   still renders and shows an email fallback instead of the form. */
(function () {
  "use strict";

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var API = {
    config: "/api/ppi/runtime-config",
    submit: "/api/ppi/requests",
    vin: "/api/ppi/vin",
    events: "/api/ppi/events",
    waitlist: "/api/ppi/waitlist",
    upload: "/api/portal/upload"
  };

  var intakeShell = document.getElementById("intakeShell");
  var waitlistShell = document.getElementById("waitlistShell");
  var fallbackShell = document.getElementById("fallbackShell");
  var form = document.getElementById("intakeForm");
  if (!form) return;

  var runtime = null;
  var turnstileToken = "";
  var turnstileRendered = false;
  var formStarted = false;
  var staticMode = false; // true when the API is unreachable (static hosting)
  var STORAGE_KEY = "ppi-intake-draft-v1";
  var DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  var submissionKey = "";
  var ATTRIBUTION_KEY = "ppi-attribution-v1";
  var attributionSource = getAttributionSource();

  /* Fetch JSON without leaving the form stuck forever. The caller still owns
     the important ambiguity: a timed-out submission may have reached the
     server, so its draft must remain intact until receipt is confirmed. */
  function requestJson(url, options, timeoutMs) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timedOut = false;
    var timer = null;
    var opts = options || {};
    if (controller) {
      opts.signal = controller.signal;
      timer = window.setTimeout(function () {
        timedOut = true;
        controller.abort();
      }, timeoutMs || 15000);
    }
    return fetch(url, opts)
      .then(function (res) {
        return res.text().then(function (text) {
          var body = {};
          if (text) {
            try { body = JSON.parse(text); }
            catch (e) { body = {}; }
          }
          return { ok: res.ok, status: res.status, body: body };
        });
      })
      .then(function (result) {
        if (timer) window.clearTimeout(timer);
        return result;
      }, function (error) {
        if (timer) window.clearTimeout(timer);
        if (timedOut) error.requestTimedOut = true;
        throw error;
      });
  }

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
      dismissed = true;
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
  function isAllowedAttribution(value) {
    return /^ppi_(direct|internal|search|social|directory|referral|campaign|google|bing|yahoo|duckduckgo|facebook|instagram|tiktok|youtube|reddit|nextdoor|yelp|apple|email)(_(cpc|organic|social|paid_social|email|referral|display))?$/.test(String(value || ""));
  }

  function referrerCategory(host) {
    if (/(^|\.)(google\.|bing\.com$|search\.yahoo\.com$|duckduckgo\.com$)/.test(host)) return { source: "search", medium: "organic" };
    if (/(^|\.)(facebook\.com$|instagram\.com$|tiktok\.com$|youtube\.com$|reddit\.com$)/.test(host)) return { source: "social", medium: "social" };
    if (/(^|\.)(nextdoor\.com$|yelp\.com$|maps\.apple\.com$)/.test(host)) return { source: "directory", medium: "referral" };
    return { source: "referral", medium: "referral" };
  }

  function getAttributionSource() {
    try {
      var saved = sessionStorage.getItem(ATTRIBUTION_KEY);
      if (isAllowedAttribution(saved)) return saved;
      if (saved) sessionStorage.removeItem(ATTRIBUTION_KEY);
    } catch (e) {}

    // Only a small allowlist of channel names is retained. Raw query values,
    // campaigns, search terms, URLs, hosts and referrer paths are never stored
    // or transmitted. External referrers are reduced to a broad category.
    var sourceMap = {
      google: "google", bing: "bing", yahoo: "yahoo", duckduckgo: "duckduckgo",
      facebook: "facebook", instagram: "instagram", tiktok: "tiktok",
      youtube: "youtube", reddit: "reddit", nextdoor: "nextdoor", yelp: "yelp",
      apple: "apple", newsletter: "email", email: "email"
    };
    var mediumMap = {
      cpc: "cpc", ppc: "cpc", paidsearch: "cpc", paid_search: "cpc",
      organic: "organic", social: "social", paidsocial: "paid_social",
      paid_social: "paid_social", email: "email", referral: "referral",
      display: "display"
    };
    var source = "";
    var medium = "";
    try {
      var params = new URLSearchParams(window.location.search);
      var rawSource = String(params.get("utm_source") || "").toLowerCase().replace(/[^a-z_]/g, "");
      var rawMedium = String(params.get("utm_medium") || "").toLowerCase().replace(/[^a-z_]/g, "");
      source = sourceMap[rawSource] || (rawSource ? "campaign" : "");
      medium = mediumMap[rawMedium] || "";
      if (!source && medium) source = "campaign";
      if (!source && document.referrer) {
        var ref = new URL(document.referrer);
        if (ref.origin === window.location.origin) source = "internal";
        else {
          var category = referrerCategory(ref.hostname.toLowerCase());
          source = category.source;
          medium = category.medium;
        }
      }
    } catch (e) {}
    var result = "ppi_" + (source || "direct") + (medium ? "_" + medium : "");
    if (!isAllowedAttribution(result)) result = "ppi_direct";
    try { sessionStorage.setItem(ATTRIBUTION_KEY, result); } catch (e) {}
    return result;
  }

  function track(event, step) {
    try {
      var body = JSON.stringify({ event: event, step: step || "", source: attributionSource });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(API.events, new Blob([body], { type: "application/json" }));
      } else {
        fetch(API.events, { method: "POST", headers: { "content-type": "application/json" }, body: body, keepalive: true }).catch(function () {});
      }
    } catch (e) { /* analytics must never break the form */ }
  }

  function bindAnalytics(root) {
    (root || document).querySelectorAll("[data-analytics]").forEach(function (el) {
      if (el.dataset.trackBound) return;
      el.dataset.trackBound = "1";
      el.addEventListener("click", function () {
        track(el.getAttribute("data-analytics"), el.getAttribute("data-step") || "");
      });
    });
  }
  bindAnalytics(document);

  /* ---------- runtime config ---------- */
  requestJson(API.config, { headers: { accept: "application/json" } }, 8000)
    .then(function (response) {
      if (!response.ok) throw new Error("config " + response.status);
      var cfg = response.body;
      runtime = cfg;
      applyPricing(cfg);
      applyTravel(cfg);
      applyScanLanguage(cfg);
      applyPaymentLanguage(cfg);
      applyContact(cfg);
      applyReviews(cfg);
      if (cfg.mode === "waitlist") {
        intakeShell.hidden = true;
        waitlistShell.hidden = false;
        setupWaitlist();
      } else {
        setupForm();
      }
      track("ppi_page_view");
    })
    .catch(function () {
      // No API reachable (e.g. static hosting): keep the multi-step form usable
      // and offer a prefilled email handoff. This is never called a receipt.
      staticMode = true;
      fallbackShell.hidden = false;
      setupForm();
      track("ppi_page_view");
    });

  function money(cents) {
    var amount = Number(cents) / 100;
    return amount.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: Number(cents) % 100 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  function applyPricing(cfg) {
    if (!cfg.pricing) return;
    (cfg.pricing.tiers || []).forEach(function (tier) {
      var valEl = document.querySelector('[data-price="' + tier.key + '"]');
      if (valEl) valEl.textContent = money(tier.priceCents);
      // Struck-through regular price + launch label, only when a real launch
      // window is active and a lower price is set for this tier.
      var wasEl = document.querySelector('[data-was="' + tier.key + '"]');
      var launchEl = document.querySelector('[data-launch="' + tier.key + '"]');
      if (tier.wasCents && tier.wasCents > tier.priceCents) {
        if (wasEl) { wasEl.textContent = money(tier.wasCents); wasEl.hidden = false; }
        if (launchEl) { launchEl.textContent = "Introductory Las Vegas launch pricing"; launchEl.hidden = false; }
      }
    });
  }

  function applyTravel(cfg) {
    var table = document.getElementById("travelRows");
    var travel = cfg && cfg.travel;
    var bands = travel && Array.isArray(travel.bands) ? travel.bands : [];
    if (!table || !bands.length) return;

    var priorMax = -1;
    var rows = [];
    for (var i = 0; i < bands.length; i++) {
      var maxMiles = Number(bands[i].maxMiles);
      var feeCents = Number(bands[i].feeCents);
      if (!Number.isInteger(maxMiles) || maxMiles <= priorMax || !Number.isSafeInteger(feeCents) || feeCents < 0) return;
      var startMiles = priorMax + 1;
      rows.push("<tr><th scope=\"row\">" + startMiles + "–" + maxMiles + " miles</th><td>" +
        (feeCents === 0 ? "Included" : "+" + money(feeCents) + " mobile-service charge") + "</td></tr>");
      priorMax = maxMiles;
    }
    var customBeyond = Number(travel.customBeyondMiles);
    if (!Number.isInteger(customBeyond) || customBeyond < priorMax) return;
    rows.push("<tr><th scope=\"row\">Beyond " + customBeyond + " miles</th><td>Custom review</td></tr>");
    table.innerHTML = rows.join("");
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

  function applyPaymentLanguage(cfg) {
    var on = cfg.paymentsEnabled === true;
    document.querySelectorAll('[data-payment="on"]').forEach(function (el) { el.hidden = !on; });
    document.querySelectorAll('[data-payment="off"]').forEach(function (el) { el.hidden = on; });
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
    // Existing elements are marked, so this binds only the newly injected
    // hero and sticky-bar actions without double-counting earlier CTAs.
    bindAnalytics(document);
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
      fetch(API.waitlist, {
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
    if (form.dataset.formReady === "1") return;
    form.dataset.formReady = "1";
    steps = Array.prototype.slice.call(form.querySelectorAll(".form-step"));
    current = 1;
    backBtn = document.getElementById("backBtn");
    nextBtn = document.getElementById("nextBtn");
    submitBtn = document.getElementById("submitBtn");
    progressBar = document.getElementById("progressBar");
    stepLine = document.getElementById("stepLine");

    var draftState = restoreDraft();
    setupDraftControls(draftState);
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
    document.getElementById("successEditBtn").addEventListener("click", function () {
      var panel = document.getElementById("successPanel");
      var progress = document.querySelector(".form-progress");
      panel.hidden = true;
      form.hidden = false;
      stepLine.hidden = false;
      if (progress) progress.hidden = false;
      submitBtn.disabled = false;
      showStep(4, true);
      document.getElementById("request").scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "start" });
    });

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
      if (staticMode) slot.hidden = true;
      else loadTurnstile(function () { renderTurnstile(slot); });
    }
    if (!initial) {
      var target = document.getElementById("request");
      if (target) target.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "start" });
      var firstField = steps[current - 1].querySelector("input, select, textarea");
      if (firstField && window.matchMedia("(pointer: fine)").matches) firstField.focus({ preventScroll: true });
    }
    if (!initial) saveDraft();
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
      fetch(API.vin, {
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

  function createSubmissionKey() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return window.crypto.randomUUID();
      }
      if (window.crypto && typeof window.crypto.getRandomValues === "function") {
        var bytes = new Uint8Array(18);
        window.crypto.getRandomValues(bytes);
        return "ppi_" + Array.prototype.map.call(bytes, function (byte) {
          return byte.toString(16).padStart(2, "0");
        }).join("");
      }
    } catch (e) {}
    return "ppi_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  function isValidSubmissionKey(value) {
    return /^[A-Za-z0-9_-]{16,128}$/.test(String(value || ""));
  }

  function ensureSubmissionKey() {
    if (!isValidSubmissionKey(submissionKey)) submissionKey = createSubmissionKey();
    return submissionKey;
  }

  function setDraftControl(hasDraft, message) {
    var button = document.getElementById("draftClearBtn");
    var status = document.getElementById("draftStatus");
    if (button) button.disabled = !hasDraft;
    if (status) status.textContent = message || "";
  }

  function setupDraftControls(state) {
    var button = document.getElementById("draftClearBtn");
    if (!button) return;
    setDraftControl(state === "restored", state === "restored"
      ? "Saved draft restored."
      : (state === "expired" ? "An expired saved draft was removed from this browser." : ""));
    button.addEventListener("click", function () {
      if (!window.confirm("Clear the saved draft and reset every field in this form? This cannot be undone.")) return;
      clearDraft();
      form.reset();
      current = 1;
      steps.forEach(function (step) { clearErrors(step); });
      showStep(1, true);
      setStatus("");
      setDraftControl(false, "Saved draft cleared. The form has been reset.");
      var firstField = form.querySelector("input, select, textarea");
      if (firstField) firstField.focus({ preventScroll: true });
    });
  }

  function saveDraft() {
    try {
      var data = { _step: current, _savedAt: Date.now(), _submissionKey: ensureSubmissionKey() };
      FIELDS.forEach(function (name) {
        var el = form.elements[name];
        if (!el) return;
        data[name] = el.type === "checkbox" ? el.checked : el.value;
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      setDraftControl(true, "");
    } catch (e) { /* storage may be unavailable */ }
  }

  function restoreDraft() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        ensureSubmissionKey();
        return "none";
      }
      var data = JSON.parse(raw);
      var savedAt = Number(data._savedAt || 0);
      var age = Date.now() - savedAt;
      if (savedAt && (age > DRAFT_TTL_MS || age < -5 * 60 * 1000)) {
        clearDraft();
        return "expired";
      }
      submissionKey = isValidSubmissionKey(data._submissionKey) ? data._submissionKey : createSubmissionKey();
      FIELDS.forEach(function (name) {
        var el = form.elements[name];
        if (!el || data[name] === undefined) return;
        if (el.type === "checkbox") el.checked = Boolean(data[name]);
        else el.value = data[name];
      });
      if (data._step >= 1 && data._step <= 4) current = data._step;
      // Migrate an existing pre-TTL draft on first use without discarding a
      // customer's in-progress request.
      if (!savedAt || !isValidSubmissionKey(data._submissionKey)) saveDraft();
      return "restored";
    } catch (e) {
      clearDraft();
      return "expired";
    }
  }

  function clearDraft() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    submissionKey = createSubmissionKey();
    setDraftControl(false, "");
  }

  /* ---------- review + submit ---------- */
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
      tierEl.innerHTML = "Pricing review: <strong>AutoClarity confirms the vehicle tier</strong> after reviewing the vehicle, location and scope. Your approved quote shows the exact price and any travel charge before you accept or pay.";
    }
  }

  function setStatus(msg) {
    var el = document.getElementById("formStatus");
    if (el) el.textContent = msg || "";
  }

  function choiceLabel(field, value) {
    var labels = {
      preferredContact: { email: "Email", phone: "Phone call", text: "Text message" },
      modStatus: { stock: "Stock / unmodified", light: "Lightly modified", heavy: "Heavily modified" },
      sellerType: { dealership: "Dealership", private: "Private seller", unknown: "Not sure" },
      decisionTimeline: {
        asap: "As soon as possible — the car may sell",
        few_days: "Within a few days",
        week_plus: "A week or more",
        browsing: "Still comparing vehicles"
      },
      timeWindow: { flexible: "Flexible", morning: "Morning", afternoon: "Afternoon" },
      titleStatus: { unknown: "Unknown", clean: "No — clean title", salvage_rebuilt: "Yes — salvage/rebuilt" },
      startsDrives: { yes: "Yes", no: "No", unknown: "Unknown" },
      permission: { yes: "Yes", no: "No", unknown: "Unknown" }
    };
    var group = labels[field] || labels.permission;
    return group[value] || String(value || "Not provided");
  }

  function yesNo(value) { return value ? "Yes" : "No"; }

  /* Snapshot the request before the network call. The confirmation renderer
     receives only strings and adds them with textContent, never HTML. */
  function captureConfirmationDetails(payload) {
    var vehicle = [payload.year, payload.make, payload.model, payload.trim].filter(Boolean).join(" ");
    var cityLine = [payload.locCity, [payload.locState, payload.locZip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    var address = [payload.locStreet, payload.locUnit, cityLine].filter(Boolean).join(", ");
    var timingRows = [
      ["Decision timeline", choiceLabel("decisionTimeline", payload.decisionTimeline)],
      ["Preferred dates", payload.preferredDates || "No dates provided"],
      ["Time of day", choiceLabel("timeWindow", payload.timeWindow)],
      ["Same-day priority", yesNo(payload.sameDayPriority)],
      ["Seller agreed to inspection", yesNo(payload.permInspection)],
      ["Road test permitted", choiceLabel("permission", payload.permRoadTest)],
      ["Photos permitted", choiceLabel("permission", payload.permPhotos)],
      ["Safe underbody access", choiceLabel("permission", payload.permUnderbody)],
      ["Lift available", choiceLabel("permission", payload.liftAvailable)],
      ["Level surface", choiceLabel("permission", payload.levelSurface)],
      ["Access conditions acknowledged", yesNo(payload.ackAccessDependent)]
    ];
    if ((runtime && runtime.scanIncluded) || payload.permScan) {
      timingRows.splice(6, 0, ["Diagnostic scan permission", yesNo(payload.permScan)]);
    }
    return [
      {
        title: "Your contact details",
        rows: [
          ["Name", payload.fullName],
          ["Email", payload.email],
          ["Mobile", payload.phone],
          ["Preferred contact", choiceLabel("preferredContact", payload.preferredContact)],
          ["Inspection contact permission", yesNo(payload.transactionalConsent)],
          ["Occasional updates", yesNo(payload.marketingConsent)]
        ]
      },
      {
        title: "Vehicle",
        rows: [
          ["Vehicle", vehicle],
          ["VIN", payload.vin || "Not provided yet"],
          ["Mileage", payload.mileage || "Not provided"],
          ["Seller asking price", payload.askingPrice || "Not provided"],
          ["Expected purchase price", payload.expectedPrice || "Not provided"],
          ["Listing", payload.listingUrl || "Not provided"],
          ["Modifications", choiceLabel("modStatus", payload.modStatus)]
        ]
      },
      {
        title: "Location & seller",
        rows: [
          ["Inspection address", address],
          ["Seller type", choiceLabel("sellerType", payload.sellerType)],
          ["Seller / salesperson", payload.sellerName || "Not provided"],
          ["Seller contact", payload.sellerPhone || "Not provided"],
          ["Access notes", payload.locNotes || "None provided"]
        ]
      },
      { title: "Timing & access", rows: timingRows },
      {
        title: "Known condition & notes",
        rows: [
          ["Warning lights / problems", payload.warningLights || "None provided"],
          ["Known mechanical issues", payload.knownIssues || "None provided"],
          ["Title status", choiceLabel("titleStatus", payload.titleStatus)],
          ["Starts and drives", choiceLabel("startsDrives", payload.startsDrives)],
          ["Additional notes", payload.customerNotes || "None provided"]
        ]
      }
    ];
  }

  function resetTurnstile() {
    if (window.turnstile) window.turnstile.reset();
    turnstileToken = "";
  }

  function submissionErrorMessage(response) {
    var code = response.body && response.body.error && response.body.error.code;
    var serverMessage = response.body && response.body.error && response.body.error.message;
    if (response.status === 429 || code === "rate_limited") {
      return "Too many attempts were made from this connection. Your answers are saved on this device; please wait before trying again.";
    }
    if (response.status === 403 || code === "turnstile_failed") {
      return serverMessage || "Human verification expired. Please complete the check again and resubmit.";
    }
    if (response.status === 409 && code === "waitlist_mode") {
      return serverMessage || "Inspection requests are not open right now. Join the waitlist above instead.";
    }
    if (response.status >= 500) {
      return "We couldn’t confirm a receipt. Your answers are still saved on this device. Check your email before retrying, or contact support if you are unsure.";
    }
    return serverMessage || "We couldn’t submit the request. Your answers are saved on this device; please review them and try again.";
  }

  function onSubmit(e) {
    e.preventDefault();
    for (var i = 1; i <= steps.length; i++) {
      if (!validateStep(i)) { showStep(i); return; }
    }

    // Static hosting (no API): hand the answers to the customer's email app.
    // This is not a receipt and the local draft remains until the API confirms
    // a persisted request.
    if (staticMode) {
      submitToEmail();
      return;
    }

    if (!turnstileToken) {
      setStatus("Please complete the human-verification check above.");
      return;
    }
    submitBtn.disabled = true;
    setStatus("Submitting your request…");

    // Persist the same idempotency key before every network attempt. A timeout
    // or interrupted response must reuse it because the server may have saved
    // the original request already.
    saveDraft();
    var payload = { turnstileToken: turnstileToken, submissionKey: ensureSubmissionKey() };
    FIELDS.forEach(function (name) {
      var el = form.elements[name];
      if (!el) return;
      payload[name] = el.type === "checkbox" ? el.checked : el.value;
    });
    var confirmationDetails = captureConfirmationDetails(payload);

    requestJson(API.submit, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    }, 15000)
      .then(function (r) {
        submitBtn.disabled = false;
        if (r.status === 200 && (r.body.ok || r.body.duplicate)) {
          var duplicate = r.body.duplicate === true;
          showSuccess(r.body, confirmationDetails, duplicate);
          if (duplicate) {
            // The verification token was consumed even though the duplicate
            // damper avoided a second lead. Reset it before offering the draft.
            resetTurnstile();
          } else {
            clearDraft();
            // Keep the original event for the existing admin funnel while
            // adding the precise conversion/receipt events requested here.
            track("ppi_request_submitted");
            track("ppi_form_completed", "request_saved");
            track("request_confirmation_viewed", "request_saved");
          }
          return;
        }
        if (r.status === 422 && r.body.fields) {
          var fields = Object.keys(r.body.fields);
          fields.forEach(function (name) { fieldError(name, r.body.fields[name]); });
          var stepWithError = earliestStepFor(fields);
          if (stepWithError) showStep(stepWithError);
          setStatus("Please correct the highlighted fields. Your other answers are still saved.");
          return;
        }
        setStatus(submissionErrorMessage(r));
        resetTurnstile();
      })
      .catch(function (error) {
        submitBtn.disabled = false;
        setStatus(error.requestTimedOut
          ? "The request timed out, so we couldn’t confirm whether it arrived. Your answers are saved here. Check your email before retrying to avoid a duplicate."
          : "The connection was interrupted, so we couldn’t confirm whether the request arrived. Your answers are saved here. Check your email before retrying.");
        resetTurnstile();
      });
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

  /* Static-hosting lead capture: build a prefilled email to support. */
  function submitToEmail() {
    var support = (runtime && runtime.supportEmail) || "support@getautoclarity.com";
    var lines = [];
    function add(label, name) { var v = val(name); if (v) lines.push(label + ": " + v); }
    lines.push("LAS VEGAS PPI REQUEST", "");
    add("Name", "fullName"); add("Email", "email"); add("Phone", "phone");
    add("Preferred contact", "preferredContact");
    lines.push("");
    add("Year", "year"); add("Make", "make"); add("Model", "model"); add("Trim", "trim");
    add("Mileage", "mileage"); add("VIN", "vin"); add("Listing", "listingUrl");
    add("Asking price", "askingPrice"); add("Expected price", "expectedPrice"); add("Modifications", "modStatus");
    lines.push("");
    lines.push("Location: " + [val("locStreet"), val("locUnit"), val("locCity"), val("locState"), val("locZip")].filter(Boolean).join(", "));
    add("Seller type", "sellerType"); add("Seller name", "sellerName"); add("Seller phone", "sellerPhone");
    add("Access notes", "locNotes");
    lines.push("");
    add("Decide by", "decisionTimeline"); add("Time of day", "timeWindow"); add("Preferred dates", "preferredDates");
    add("Warning lights", "warningLights"); add("Known issues", "knownIssues");
    add("Title", "titleStatus"); add("Starts/drives", "startsDrives"); add("Notes", "customerNotes");
    var subject = "Las Vegas PPI request — " + [val("year"), val("make"), val("model")].filter(Boolean).join(" ");
    var href = "mailto:" + support + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(lines.join("\n"));
    saveDraft();
    fallbackShell.hidden = false;
    setStatus("Opening a prepared email. Your request has not been received yet — review it and choose Send in your email app. This draft remains saved here.");
    window.location.href = href;
  }

  /* ---------- success + uploads ---------- */
  function renderConfirmationDetails(groups) {
    var container = document.getElementById("successSummary");
    while (container.firstChild) container.removeChild(container.firstChild);
    groups.forEach(function (group) {
      var section = document.createElement("section");
      section.className = "success-summary-group";
      var heading = document.createElement("h5");
      heading.textContent = group.title;
      section.appendChild(heading);
      var list = document.createElement("dl");
      group.rows.forEach(function (row) {
        var wrapper = document.createElement("div");
        wrapper.className = "success-summary-row";
        var term = document.createElement("dt");
        var detail = document.createElement("dd");
        term.textContent = row[0];
        detail.textContent = String(row[1] == null || row[1] === "" ? "Not provided" : row[1]);
        wrapper.appendChild(term);
        wrapper.appendChild(detail);
        list.appendChild(wrapper);
      });
      section.appendChild(list);
      container.appendChild(section);
    });
  }

  function updateEmailNotice(result, email, duplicate) {
    var notice = document.getElementById("successEmailNotice");
    var status = String(result.emailStatus || (result.confirmationEmail && result.confirmationEmail.status) || "").toLowerCase();
    var hasPortal = Boolean(result.portalToken);
    var tone = "info";
    var message;
    if (duplicate) {
      tone = "warn";
      message = "An existing open request matched these details. A second request and a second confirmation email were not created; your local draft is still available below.";
    } else if (status === "sent") {
      tone = "good";
      message = "Confirmation email sent to " + email + ". Keep it for your reference" + (hasPortal ? " and secure status link." : ".");
    } else if (status === "recorded" || status === "queued" || status === "pending") {
      tone = "info";
      message = "Your request is safely saved, but delivery of the confirmation email to " + email + " is not yet confirmed. " +
        (hasPortal ? "Use the secure status page below in the meantime." : "Save the reference shown below and contact support if the email does not arrive.");
    } else if (status === "failed") {
      tone = "warn";
      message = "Your request is safely saved, but confirmation-email delivery could not be completed. Save the reference" +
        (hasPortal ? " and use the secure status page below; support can also help." : " and contact support for help.");
    } else {
      message = "Your request is safely saved, but confirmation-email delivery to " + email + " is not yet confirmed. " +
        (hasPortal ? "Use the secure status page below or contact support if needed." : "Save the reference shown below and contact support if the email does not arrive.");
    }
    notice.className = "success-email notice " + tone;
    notice.textContent = message;
    if (duplicate) return "duplicate";
    if (status === "sent") return "sent";
    if (status === "failed") return "failed";
    return "unconfirmed";
  }

  function showSuccess(result, confirmationDetails, duplicate) {
    form.hidden = true;
    document.getElementById("stepLine").hidden = true;
    document.querySelector(".form-progress").hidden = true;
    var panel = document.getElementById("successPanel");
    panel.hidden = false;

    var ref = result.requestRef || result.ref || "";
    document.getElementById("successKicker").textContent = duplicate ? "Duplicate prevented" : "Request saved";
    document.getElementById("successTitle").textContent = duplicate ? "You already have an open request" : "Your request has been received ✓";
    document.getElementById("successMessage").textContent = duplicate
      ? (result.message || "AutoClarity found an open request for this vehicle and did not create a second one.")
      : "Your request is saved immediately. AutoClarity will review the vehicle, location, and requested timing, and typically responds within 24 hours with scheduling details.";
    var emailState = updateEmailNotice(result, String((confirmationDetails[0].rows[1] || [])[1] || "your email address"), duplicate);

    var refRow = document.getElementById("successRefRow");
    refRow.hidden = !ref;
    document.getElementById("successRef").textContent = ref;
    var link = document.getElementById("successPortalLink");
    var token = String(result.portalToken || "");
    link.hidden = !token;
    if (token) link.href = "/ppi/portal/?t=" + encodeURIComponent(token);
    else link.removeAttribute("href");

    var editBtn = document.getElementById("successEditBtn");
    editBtn.hidden = !duplicate;
    document.getElementById("successSummaryTitle").textContent = duplicate ? "Details entered this time" : "Details AutoClarity received";
    var correctionHint;
    if (duplicate) {
      correctionHint = "These entries did not replace the details on your existing request. Return to your saved draft if you need to copy or change anything, or contact support.";
    } else if (emailState === "sent") {
      correctionHint = "Review this receipt now. If anything is incorrect, reply to the confirmation email before your appointment is finalized.";
    } else if (token) {
      correctionHint = "Review this receipt now. If anything is incorrect, use your secure status page or email support@getautoclarity.com and include the reference above.";
    } else {
      correctionHint = "Review this receipt now. If anything is incorrect, email support@getautoclarity.com and include the reference above.";
    }
    document.getElementById("successSummaryHint").textContent = correctionHint;
    renderConfirmationDetails(confirmationDetails);

    var uploadBlock = document.getElementById("uploadBlock");
    if (!token || duplicate || !runtime || runtime.uploadsEnabled === false) {
      uploadBlock.hidden = true;
    } else {
      uploadBlock.hidden = false;
      setupUploads(token);
    }
    panel.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "start" });
    try { panel.focus({ preventScroll: true }); } catch (e) { panel.focus(); }
  }

  function setupUploads(token) {
    var input = document.getElementById("uploadInput");
    var list = document.getElementById("uploadList");
    var max = (runtime && runtime.uploads && runtime.uploads.maxFiles) || 6;
    var maxBytes = (runtime && runtime.uploads && runtime.uploads.maxBytes) || 8388608;
    var done = 0;
    input.dataset.portalToken = token;
    if (input.dataset.uploadBound === "1") return;
    input.dataset.uploadBound = "1";

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
        fetch(API.upload, { method: "POST", headers: { authorization: "Bearer " + input.dataset.portalToken }, body: fd })
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
