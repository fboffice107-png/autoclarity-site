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
    estimate: "/api/ppi/estimate",
    events: "/api/ppi/events",
    waitlist: "/api/ppi/waitlist",
    upload: "/api/portal/upload"
  };

  var intakeShell = document.getElementById("intakeShell");
  var waitlistTemplate = document.getElementById("waitlistTemplate");
  var fallbackTemplate = document.getElementById("fallbackTemplate");
  var waitlistShell = null;
  var fallbackShell = null;
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

  /* Dormant waitlist/outage copy lives in inert templates. Mount only the
     state confirmed by runtime configuration, then remove both templates from
     the rendered document so healthy live mode exposes no contradictory UI. */
  function mountConditionalShell(template, fallbackAnchor) {
    if (!template || !template.content || !template.content.firstElementChild) return null;
    var node = template.content.firstElementChild.cloneNode(true);
    var anchor = fallbackAnchor || (template.parentNode ? template : null);
    if (!anchor || !anchor.parentNode) return null;
    anchor.parentNode.insertBefore(node, anchor);
    node.classList.add("in-view");
    return node;
  }

  function removeRuntimeTemplates() {
    if (waitlistTemplate && waitlistTemplate.parentNode) waitlistTemplate.remove();
    if (fallbackTemplate && fallbackTemplate.parentNode) fallbackTemplate.remove();
  }

  function runtimeConfigIsValid(cfg) {
    return Boolean(
      cfg &&
      ["live", "request", "waitlist"].indexOf(cfg.mode) !== -1 &&
      typeof cfg.paymentsEnabled === "boolean" &&
      typeof cfg.bookingEnabled === "boolean" &&
      typeof cfg.uploadsEnabled === "boolean" &&
      typeof cfg.smsAvailable === "boolean" &&
      typeof cfg.turnstileSiteKey === "string" &&
      cfg.turnstileSiteKey.length > 0 &&
      cfg.pricing && Array.isArray(cfg.pricing.tiers) && cfg.pricing.tiers.length > 0 &&
      cfg.travel && Array.isArray(cfg.travel.bands)
    );
  }

  function applyWaitlistCopy() {
    document.querySelectorAll("[data-request-cta]").forEach(function (cta) {
      cta.textContent = "Join the Launch List";
    });
    var title = document.getElementById("request-title");
    var subtitle = title && title.parentNode ? title.parentNode.querySelector(".section-sub") : null;
    if (title) title.textContent = "Join the Las Vegas inspection launch list";
    if (subtitle) subtitle.textContent = "Share your email and ZIP code to hear when Las Vegas appointments open.";
  }

  function activateWaitlistState(moveFocus) {
    if (fallbackShell && fallbackShell.parentNode) fallbackShell.remove();
    intakeShell.hidden = true;
    if (!waitlistShell || !waitlistShell.isConnected) {
      waitlistShell = mountConditionalShell(waitlistTemplate, intakeShell);
    }
    if (!waitlistShell) throw new Error("waitlist template unavailable");
    applyWaitlistCopy();
    setupWaitlist();
    removeRuntimeTemplates();
    if (moveFocus) {
      var heading = waitlistShell.querySelector("h3");
      if (heading) {
        heading.setAttribute("tabindex", "-1");
        heading.focus({ preventScroll: true });
      }
    }
  }

  function activateFallbackState() {
    intakeShell.hidden = false;
    if (waitlistShell && waitlistShell.parentNode) waitlistShell.remove();
    if (!fallbackShell || !fallbackShell.isConnected) {
      fallbackShell = mountConditionalShell(fallbackTemplate, intakeShell);
    }
    if (!fallbackShell) throw new Error("fallback template unavailable");
    removeRuntimeTemplates();
    if (!document.activeElement || document.activeElement === document.body) {
      fallbackShell.focus({ preventScroll: true });
    }
  }

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
    var html = '<a class="ppi-sticky-primary" href="#request" data-request-cta data-analytics="ppi_cta_click" data-step="request_intent_sticky">Request an Inspection</a>';
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
  var ALLOWED_ATTRIBUTIONS = [
    "ppi_unknown", "ppi_direct", "ppi_internal", "ppi_search_organic", "ppi_social_social",
    "ppi_directory_referral", "ppi_referral_referral", "ppi_google_cpc", "ppi_google_organic",
    "ppi_bing_cpc", "ppi_bing_organic", "ppi_yahoo_organic", "ppi_duckduckgo_organic",
    "ppi_facebook_social", "ppi_facebook_paid_social", "ppi_instagram_social",
    "ppi_instagram_paid_social", "ppi_tiktok_social", "ppi_tiktok_paid_social",
    "ppi_youtube_social", "ppi_youtube_paid_social", "ppi_reddit_social",
    "ppi_reddit_paid_social", "ppi_nextdoor_referral", "ppi_yelp_referral", "ppi_apple_referral",
    "ppi_email_email", "ppi_campaign_cpc", "ppi_campaign_organic", "ppi_campaign_social",
    "ppi_campaign_paid_social", "ppi_campaign_email", "ppi_campaign_referral", "ppi_campaign_display",
    "ppi_google_business_profile", "ppi_bing_places", "ppi_apple_maps", "ppi_ios_app", "ppi_chatgpt_search",
    "ppi_perplexity_search", "ppi_claude_search"
  ];
  var attributionSource = getAttributionSource();

  function isAllowedAttribution(value) {
    return ALLOWED_ATTRIBUTIONS.indexOf(String(value || "")) !== -1;
  }

  function referrerCategory(host) {
    if (/(^|\.)chatgpt\.com$/.test(host)) return "ppi_chatgpt_search";
    if (/(^|\.)perplexity\.(ai|com)$/.test(host)) return "ppi_perplexity_search";
    if (/(^|\.)claude\.ai$/.test(host)) return "ppi_claude_search";
    if (/(^|\.)google\.[a-z.]+$/.test(host)) return "ppi_google_organic";
    if (/(^|\.)bing\.com$/.test(host)) return "ppi_bing_organic";
    if (/(^|\.)search\.yahoo\.com$/.test(host)) return "ppi_yahoo_organic";
    if (/(^|\.)duckduckgo\.com$/.test(host)) return "ppi_duckduckgo_organic";
    if (/(^|\.)facebook\.com$/.test(host)) return "ppi_facebook_social";
    if (/(^|\.)instagram\.com$/.test(host)) return "ppi_instagram_social";
    if (/(^|\.)tiktok\.com$/.test(host)) return "ppi_tiktok_social";
    if (/(^|\.)youtube\.com$/.test(host)) return "ppi_youtube_social";
    if (/(^|\.)reddit\.com$/.test(host)) return "ppi_reddit_social";
    if (/(^|\.)nextdoor\.com$/.test(host)) return "ppi_nextdoor_referral";
    if (/(^|\.)yelp\.com$/.test(host)) return "ppi_yelp_referral";
    if (/(^|\.)maps\.apple\.com$/.test(host)) return "ppi_apple_maps";
    return "ppi_referral_referral";
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
    var dedicatedSourceMap = {
      gbp: "ppi_google_business_profile", googlebusinessprofile: "ppi_google_business_profile",
      google_business_profile: "ppi_google_business_profile", bingplaces: "ppi_bing_places",
      bing_places: "ppi_bing_places", applemaps: "ppi_apple_maps", apple_maps: "ppi_apple_maps",
      chatgpt: "ppi_chatgpt_search", openai: "ppi_chatgpt_search",
      perplexity: "ppi_perplexity_search", claude: "ppi_claude_search", anthropic: "ppi_claude_search"
    };
    var mediumMap = {
      cpc: "cpc", ppc: "cpc", paidsearch: "cpc", paid_search: "cpc",
      organic: "organic", social: "social", paidsocial: "paid_social",
      paid_social: "paid_social", email: "email", referral: "referral",
      display: "display"
    };
    var result = "";
    try {
      var params = new URLSearchParams(window.location.search);
      var rawSource = String(params.get("utm_source") || "").toLowerCase().replace(/[^a-z_]/g, "");
      var rawMedium = String(params.get("utm_medium") || "").toLowerCase().replace(/[^a-z_]/g, "");
      if (rawSource === "ios_app") {
        result = rawMedium === "owned" ? "ppi_ios_app" : "ppi_unknown";
      } else if (dedicatedSourceMap[rawSource]) {
        result = dedicatedSourceMap[rawSource];
      } else if (rawSource || rawMedium) {
        var source = sourceMap[rawSource] || (rawSource ? "campaign" : "");
        var medium = mediumMap[rawMedium] || "";
        if (!medium) {
          result = "ppi_unknown";
        } else {
          if (!source) source = "campaign";
          result = "ppi_" + source + "_" + medium;
          if (!isAllowedAttribution(result)) result = "ppi_campaign_" + medium;
        }
      }
      if (!result && document.referrer) {
        var ref = new URL(document.referrer);
        result = ref.origin === window.location.origin
          ? "ppi_internal"
          : referrerCategory(ref.hostname.toLowerCase());
      }
    } catch (e) {}
    if (!result) result = "ppi_direct";
    if (!isAllowedAttribution(result)) result = "ppi_unknown";
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
      if (!runtimeConfigIsValid(cfg)) throw new Error("invalid runtime config");
      runtime = cfg;
      applyPricing(cfg);
      applyTravel(cfg);
      applyScanLanguage(cfg);
      applyPaymentLanguage(cfg);
      applySmsAvailability(cfg);
      applyReviews(cfg);
      if (cfg.mode === "waitlist") {
        activateWaitlistState();
      } else {
        intakeShell.hidden = false;
        applyContact(cfg);
        setupForm();
        removeRuntimeTemplates();
      }
      track("ppi_page_view");
    })
    .catch(function () {
      // No API reachable (e.g. static hosting): keep the multi-step form usable
      // and offer a prefilled email handoff. This is never called a receipt.
      staticMode = true;
      activateFallbackState();
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
    // The page ships no review claims. Mount this section only after real,
    // owner-approved review records arrive from runtime configuration.
    var items = (cfg && cfg.reviews) || [];
    if (!items.length) return;
    var finalCta = document.querySelector(".final-cta");
    if (!finalCta || !finalCta.parentNode || document.getElementById("reviews")) return;
    var section = document.createElement("section");
    section.className = "section section-alt";
    section.id = "reviews";
    section.setAttribute("aria-labelledby", "reviews-title");
    section.innerHTML = '<div class="section-inner section-narrow"><header class="section-head">' +
      '<p class="kicker">Reviews</p><h2 id="reviews-title">Customer reviews</h2></header>' +
      '<div class="reviews-grid" id="reviewsGrid"></div></div>';
    finalCta.parentNode.insertBefore(section, finalCta);
    var grid = document.getElementById("reviewsGrid");
    grid.innerHTML = items.map(function (r) {
      return '<figure class="review-card"><blockquote>' + escapeHtml(r.text) + "</blockquote>" +
        "<figcaption>" + escapeHtml(r.name) + (r.vehicle ? " · " + escapeHtml(r.vehicle) : "") + "</figcaption></figure>";
    }).join("");
  }

  function applySmsAvailability(cfg) {
    var select = document.getElementById("preferredContact");
    if (!select || cfg.smsAvailable !== true || select.querySelector('option[value="text"]')) return;
    var option = document.createElement("option");
    option.value = "text";
    option.textContent = "Text message";
    select.appendChild(option);
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
  function loadTurnstile(cb, onError) {
    if (window.turnstile) return cb();
    var script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = cb;
    script.onerror = function () {
      if (onError) onError();
      else setStatus("Human-verification service failed to load. Please refresh and try again.");
    };
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
    if (!wlForm || wlForm.dataset.waitlistReady === "1") return;
    wlForm.dataset.waitlistReady = "1";
    var slot = waitlistShell.querySelector("[data-turnstile]");
    loadTurnstile(function () { renderTurnstile(slot); }, function () {
      wlForm.querySelector(".form-status").textContent = "Human-verification service failed to load. Please refresh and try again.";
    });
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
      if (!formStarted) { formStarted = true; track("ppi_form_started", "request_intake"); }
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

    setupModDetails();
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
      refreshPackage();
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
      if (val("modStatus") !== "stock" && val("modDetails").length < 3) {
        fail("modDetails", "Tell us briefly what was modified (for example: wheels, exhaust, suspension).");
      }
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


  /* "Lightly modified" has to say what was modified — so the field appears the
     moment it becomes relevant, and disappears when it does not apply. */
  function setupModDetails() {
    var select = form.elements.modStatus;
    var field = document.getElementById("modDetailsField");
    if (!select || !field) return;
    function sync() {
      var relevant = select.value !== "stock";
      field.hidden = !relevant;
      if (!relevant && form.elements.modDetails) form.elements.modDetails.value = "";
    }
    select.addEventListener("change", sync);
    sync();
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
  var FIELDS = ["fullName","email","phone","preferredContact","transactionalConsent","marketingConsent","vin","year","mileage","make","model","trim","askingPrice","expectedPrice","listingUrl","modStatus","modDetails","warningLights","knownIssues","titleStatus","startsDrives","locStreet","locUnit","locCity","locState","locZip","sellerType","sellerName","sellerPhone","locNotes","liftAvailable","levelSurface","permInspection","permScan","permRoadTest","permPhotos","permUnderbody","ackAccessDependent","decisionTimeline","preferredDates","timeWindow","sameDayPriority","customerNotes","selectedTier"];

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


  /* ---------- package + price estimate ----------
     The customer sees a package and a number before they submit. Both come
     from /api/ppi/estimate, which runs the same classifier and the same price
     math as the admin proposal and the Stripe checkout — so this cannot drift
     from what is actually charged. It is labelled an estimate because the
     owner still reviews the vehicle before making it an offer. */

  var selectedTier = "";
  var estimateToken = 0;

  function estimateMoney(cents) {
    return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  }

  function refreshPackage() {
    var choice = document.getElementById("packageChoice");
    if (!choice) return;
    var token = ++estimateToken;
    var body = {
      year: val("year"), make: val("make"), model: val("model"), trim: val("trim"),
      modStatus: val("modStatus"), modDetails: val("modDetails"),
      titleStatus: val("titleStatus"), startsDrives: val("startsDrives"),
      locZip: val("locZip"), selectedTier: selectedTier
    };
    requestJson(API.estimate, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }, 10000).then(function (r) {
      if (token !== estimateToken) return; // a newer answer already won
      if (r.status !== 200 || !r.body || !r.body.ok) { renderPackageFallback(); return; }
      renderPackage(r.body);
    }).catch(function () { if (token === estimateToken) renderPackageFallback(); });
  }

  function renderPackageFallback() {
    var choice = document.getElementById("packageChoice");
    if (!choice) return;
    choice.innerHTML = "";
    document.getElementById("packageReason").textContent =
      "We could not check pricing just now. Submitting still works — AutoClarity confirms your exact package and price by email.";
    document.getElementById("packageEstimate").innerHTML = "";
    document.getElementById("packageDisclaimer").textContent = "";
  }

  function renderPackage(data) {
    if (!selectedTier) selectedTier = data.selectedTier;
    var hidden = form.elements.selectedTier;
    if (hidden) hidden.value = selectedTier;

    document.getElementById("packageReason").textContent = data.customerReason || "";

    var choice = document.getElementById("packageChoice");
    choice.innerHTML = (data.tiers || []).map(function (t) {
      var picked = t.key === selectedTier;
      return '<label class="tier-option' + (picked ? " selected" : "") + '">' +
        '<input type="radio" name="packageTier" value="' + escapeHtml(t.key) + '"' + (picked ? " checked" : "") + ' />' +
        '<span class="tier-option-name">' + escapeHtml(t.label) + "</span>" +
        '<span class="tier-option-price">' + escapeHtml(estimateMoney(t.priceCents)) + "</span>" +
        (t.key === data.suggestedTier ? '<span class="tier-option-flag">Suggested for your vehicle</span>' : "") +
        '<span class="tier-option-blurb">' + escapeHtml(t.blurb) + "</span></label>";
    }).join("");
    choice.querySelectorAll('input[name="packageTier"]').forEach(function (input) {
      input.addEventListener("change", function () {
        selectedTier = input.value;
        saveDraft();
        refreshPackage();
      });
    });

    var notes = [];
    if (data.mismatch) {
      notes.push(data.mismatch.direction === "lower"
        ? "You picked a package below our suggestion. That's fine — AutoClarity checks the vehicle and confirms the final price with you before anything is charged."
        : "You picked a package above our suggestion. AutoClarity will confirm it is genuinely needed before charging more.");
    }
    (data.customerNotes || []).forEach(function (n) { notes.push(n); });
    document.getElementById("packageNotes").innerHTML = notes.length
      ? '<div class="notice info"><ul>' + notes.map(function (n) { return "<li>" + escapeHtml(n) + "</li>"; }).join("") + "</ul></div>"
      : "";

    var rows = (data.lines || []).map(function (l) {
      return "<tr><td>" + escapeHtml(l.label) + "</td><td>" + escapeHtml(l.display) + "</td></tr>";
    }).join("");
    var totalText = data.totalCents
      ? estimateMoney(data.totalCents)
      : "AutoClarity will quote travel for this address";
    document.getElementById("packageEstimate").innerHTML =
      '<table class="line-items">' + rows +
      '<tr class="total"><td>Estimated total</td><td>' + escapeHtml(totalText) + "</td></tr></table>" +
      (data.travel && data.travel.basisLabel ? '<p class="field-hint">' + escapeHtml(data.travel.basisLabel) + "</p>" : "");

    document.getElementById("packageDisclaimer").textContent = data.disclaimer || "";
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
      tierEl.innerHTML = "Submitting is free and charges nothing. AutoClarity reviews the vehicle, confirms the package above, and emails you one link with the exact price and available appointment times.";
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
    var payload = {
      turnstileToken: turnstileToken,
      submissionKey: ensureSubmissionKey(),
      attributionSource: attributionSource
    };
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
        if (r.status === 409 && r.body && r.body.error && r.body.error.code === "waitlist_mode") {
          resetTurnstile();
          activateWaitlistState(true);
          var waitlistStatus = waitlistShell.querySelector(".form-status");
          waitlistStatus.textContent = r.body.error.message || "Inspection requests are not open right now. Join the launch list instead.";
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
    fullName: 1, email: 1, phone: 1, year: 1, make: 1, model: 1, vin: 1, listingUrl: 1, modDetails: 1,
    locCity: 2, locZip: 2, locState: 2,
    transactionalConsent: 4, ackAccessDependent: 4, selectedTier: 4
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
    if (!fallbackShell || !fallbackShell.isConnected) activateFallbackState();
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
      : "Your request is saved immediately. AutoClarity will review the vehicle, location, access, and requested timing, then follow up by email with next steps.";
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
