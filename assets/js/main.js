/* AutoClarity — getautoclarity.com
   Progressive enhancement only: the page is fully usable with JS disabled. */
(function () {
  "use strict";

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* Enable scroll-reveal styling only when JS runs and motion is allowed. */
  if (!reducedMotion.matches) {
    document.documentElement.classList.add("js-anim");
  }

  /* ---------- Nav: elevate on scroll ---------- */
  var nav = document.querySelector(".nav");
  var scrollCues = Array.prototype.slice.call(document.querySelectorAll(".scroll-cue"));
  var lastScrolled = null;
  function onScroll() {
    var scrolled = window.scrollY > 8;
    if (scrolled !== lastScrolled) {
      if (nav) nav.classList.toggle("is-scrolled", scrolled);
      lastScrolled = scrolled;
    }
    var cueDismissed = window.scrollY > Math.max(72, window.innerHeight * 0.1);
    scrollCues.forEach(function (cue) {
      cue.classList.toggle("is-dismissed", cueDismissed);
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- Compact homepage navigation ---------- */
  var mobileMenu = document.querySelector(".nav-mobile-menu");
  if (mobileMenu) {
    var mobileMenuSummary = mobileMenu.querySelector("summary");

    function syncMobileMenuLabel() {
      if (!mobileMenuSummary) return;
      var open = mobileMenu.open;
      mobileMenuSummary.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
      mobileMenuSummary.setAttribute("aria-expanded", open ? "true" : "false");
    }

    mobileMenu.addEventListener("toggle", syncMobileMenuLabel);
    mobileMenu.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () { mobileMenu.open = false; });
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && mobileMenu.open) {
        mobileMenu.open = false;
        if (mobileMenuSummary) mobileMenuSummary.focus();
      }
    });
    document.addEventListener("pointerdown", function (event) {
      if (mobileMenu.open && !mobileMenu.contains(event.target)) mobileMenu.open = false;
    });
    syncMobileMenuLabel();
  }

  /* ---------- Scroll reveals ---------- */
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reducedMotion.matches) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.1 }
    );
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in-view"); });
  }

  /* ---------- Page-wide electric-blue ambience ----------
     Decorative layers are created only on opted-in public pages, only for a
     real fine pointer or coarse touch device, and never for reduced motion.
     The full-viewport grid uses one broad feathered mask—no multi-point trail
     or permanent animation—while the bloom itself moves by transform. */
  var fxMode =
    document.body.hasAttribute("data-fx-full") &&
    !reducedMotion.matches &&
    (window.matchMedia("(hover: hover) and (pointer: fine)").matches
      ? "desktop"
      : window.matchMedia("(pointer: coarse)").matches
        ? "touch"
        : null);

  if (fxMode) {
    var isTouchFx = fxMode === "touch";
    var glow = document.createElement("div");
    var neon = document.createElement("div");
    glow.className = "cursor-glow" + (isTouchFx ? " is-touch" : "");
    neon.className = "neon-grid" + (isTouchFx ? " is-touch" : "");
    glow.setAttribute("aria-hidden", "true");
    neon.setAttribute("aria-hidden", "true");
    document.body.appendChild(glow);
    document.body.appendChild(neon);

    var gx = window.innerWidth / 2;
    var gy = window.innerHeight / 3;
    var tx = gx;
    var ty = gy;
    var fxRaf = null;
    var fxActive = true;
    var formFocused = false;
    var calmRegionVisible = false;
    var idleTimer = null;
    var calmObserver = null;
    var revealRadius = isTouchFx ? 310 : 430;
    var lerp = isTouchFx ? 0.34 : 0.16;

    function setFxOn(on) {
      if (!fxActive) return;
      glow.classList.toggle("is-on", on);
      neon.classList.toggle("is-on", on);
      if (!on) {
        glow.classList.remove("is-idle");
        neon.classList.remove("is-idle");
      }
    }

    function setFxIdleLater() {
      glow.classList.remove("is-idle");
      neon.classList.remove("is-idle");
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(function () {
        if (!fxActive) return;
        glow.classList.add("is-idle");
        neon.classList.add("is-idle");
      }, 1300);
    }

    function renderFxMask() {
      var mask =
        "radial-gradient(circle " + revealRadius + "px at " + gx.toFixed(1) + "px " + gy.toFixed(1) +
        "px, rgba(0,0,0,0.94) 0%, rgba(0,0,0,0.68) 38%, rgba(0,0,0,0.24) 68%, rgba(0,0,0,0) 100%)";
      neon.style.webkitMaskImage = mask;
      neon.style.maskImage = mask;
    }

    function fxTick() {
      if (!fxActive) return;
      gx += (tx - gx) * lerp;
      gy += (ty - gy) * lerp;
      glow.style.transform = "translate3d(" + gx.toFixed(1) + "px, " + gy.toFixed(1) + "px, 0)";
      renderFxMask();
      if (Math.abs(tx - gx) > 0.45 || Math.abs(ty - gy) > 0.45) {
        fxRaf = requestAnimationFrame(fxTick);
      } else {
        gx = tx;
        gy = ty;
        glow.style.transform = "translate3d(" + gx.toFixed(1) + "px, " + gy.toFixed(1) + "px, 0)";
        renderFxMask();
        fxRaf = null;
      }
    }

    function targetIsCalm(target) {
      return !!(target && target.closest && target.closest("[data-fx-calm]"));
    }

    function fxTarget(x, y, target) {
      if (!fxActive || formFocused || calmRegionVisible || targetIsCalm(target)) {
        setFxOn(false);
        return;
      }
      tx = x;
      ty = y;
      setFxOn(true);
      setFxIdleLater();
      if (!fxRaf) fxRaf = requestAnimationFrame(fxTick);
    }

    function desktopPointerMove(e) {
      if (e.pointerType && e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      fxTarget(e.clientX, e.clientY, e.target);
    }

    function desktopPointerEnter(e) {
      if (e.pointerType && e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      gx = tx = e.clientX;
      gy = ty = e.clientY;
      fxTarget(e.clientX, e.clientY, e.target);
    }

    function touchStart(e) {
      var touch = e.touches && e.touches[0];
      if (!touch) return;
      gx = tx = touch.clientX;
      gy = ty = touch.clientY;
      fxTarget(touch.clientX, touch.clientY, e.target);
    }

    function touchMove(e) {
      var touch = e.touches && e.touches[0];
      if (touch) fxTarget(touch.clientX, touch.clientY, e.target);
    }

    function touchEnd() { setFxOn(false); }

    if (fxMode === "desktop") {
      window.addEventListener("pointermove", desktopPointerMove, { passive: true });
      document.addEventListener("pointerleave", touchEnd);
      document.addEventListener("pointerenter", desktopPointerEnter, { passive: true });
    } else {
      window.addEventListener("touchstart", touchStart, { passive: true });
      window.addEventListener("touchmove", touchMove, { passive: true });
      window.addEventListener("touchend", touchEnd, { passive: true });
      window.addEventListener("touchcancel", touchEnd, { passive: true });
    }

    function focusIn(e) {
      var el = e.target;
      if (!el || !el.matches) return;
      if (el.matches("input, select, textarea, [contenteditable]:not([contenteditable=\"false\"])") || (el.closest && el.closest("form"))) {
        formFocused = true;
        setFxOn(false);
      }
    }
    function focusOut() { formFocused = false; }
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", focusOut);

    var calmRegions = document.querySelectorAll("[data-fx-calm]");
    if (calmRegions.length && "IntersectionObserver" in window) {
      calmObserver = new IntersectionObserver(function (entries) {
        calmRegionVisible = entries.some(function (entry) {
          return entry.isIntersecting && entry.intersectionRatio >= 0.3;
        });
        if (calmRegionVisible) setFxOn(false);
      }, { threshold: [0, 0.3, 0.6] });
      calmRegions.forEach(function (region) { calmObserver.observe(region); });
    }

    function teardownFx() {
      if (!fxActive) return;
      fxActive = false;
      if (fxRaf) cancelAnimationFrame(fxRaf);
      if (idleTimer) clearTimeout(idleTimer);
      window.removeEventListener("pointermove", desktopPointerMove);
      document.removeEventListener("pointerleave", touchEnd);
      document.removeEventListener("pointerenter", desktopPointerEnter);
      window.removeEventListener("touchstart", touchStart);
      window.removeEventListener("touchmove", touchMove);
      window.removeEventListener("touchend", touchEnd);
      window.removeEventListener("touchcancel", touchEnd);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", focusOut);
      if (calmObserver) calmObserver.disconnect();
      if (reducedMotion.removeEventListener) reducedMotion.removeEventListener("change", reducedMotionChange);
      else if (reducedMotion.removeListener) reducedMotion.removeListener(reducedMotionChange);
      glow.remove();
      neon.remove();
    }
    function reducedMotionChange(e) { if (e.matches) teardownFx(); }
    window.addEventListener("pagehide", teardownFx, { once: true });
    if (reducedMotion.addEventListener) {
      reducedMotion.addEventListener("change", reducedMotionChange);
    } else if (reducedMotion.addListener) {
      reducedMotion.addListener(reducedMotionChange);
    }
  }

  /* ---------- Homepage conversion analytics (allowlisted, no PII) ---------- */
  if (document.body.dataset.page === "home") {
    var attributionKey = "ppi-attribution-v1";
    var allowedAttributions = [
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

    function allowedAttribution(value) {
      return allowedAttributions.indexOf(String(value || "")) !== -1;
    }

    function homepageReferrerCategory(host) {
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

    function campaignAttribution(rawSource, rawMedium) {
      if (rawSource === "ios_app") return rawMedium === "owned" ? "ppi_ios_app" : "ppi_unknown";
      if (dedicatedSourceMap[rawSource]) return dedicatedSourceMap[rawSource];
      var source = sourceMap[rawSource] || (rawSource ? "campaign" : "");
      var medium = mediumMap[rawMedium] || "";
      // A campaign source without an explicit recognized medium is ambiguous:
      // "google" may be paid or organic, for example. Preserve it as unknown
      // rather than silently converting campaign traffic into Direct/Organic.
      if (!medium) return "ppi_unknown";
      if (!source && medium) source = "campaign";
      var candidate = "ppi_" + source + (medium ? "_" + medium : "");
      if (allowedAttribution(candidate)) return candidate;
      candidate = "ppi_campaign_" + medium;
      return allowedAttribution(candidate) ? candidate : "ppi_unknown";
    }

    function homepageAttribution() {
      try {
        var saved = sessionStorage.getItem(attributionKey);
        if (allowedAttribution(saved)) return saved;
        if (saved) sessionStorage.removeItem(attributionKey);
      } catch (e) {}

      var result = "";
      try {
        var params = new URLSearchParams(window.location.search);
        var rawSource = String(params.get("utm_source") || "").toLowerCase().replace(/[^a-z_]/g, "");
        var rawMedium = String(params.get("utm_medium") || "").toLowerCase().replace(/[^a-z_]/g, "");
        if (rawSource || rawMedium) result = campaignAttribution(rawSource, rawMedium);
        if (!result && document.referrer) {
          var ref = new URL(document.referrer);
          result = ref.origin === window.location.origin
            ? "ppi_internal"
            : homepageReferrerCategory(ref.hostname.toLowerCase());
        }
      } catch (e) {}
      if (!result) result = "ppi_direct";
      if (!allowedAttribution(result)) result = "ppi_unknown";
      try { sessionStorage.setItem(attributionKey, result); } catch (e) {}
      return result;
    }

    // Session storage makes this first-touch value available when the visitor
    // follows a homepage CTA into the PPI funnel. It contains no raw URL,
    // campaign, host, query text or customer data.
    var ppiAttribution = homepageAttribution();
    document.querySelectorAll("[data-analytics]").forEach(function (el) {
      el.addEventListener("click", function () {
        try {
          var body = JSON.stringify({
            event: el.getAttribute("data-analytics") || "",
            step: el.getAttribute("data-step") || "",
            source: ppiAttribution
          });
          if (navigator.sendBeacon) {
            navigator.sendBeacon("/api/ppi/events", new Blob([body], { type: "application/json" }));
          } else {
            fetch("/api/ppi/events", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: body,
              keepalive: true
            }).catch(function () {});
          }
        } catch (e) {
          /* Analytics must never block navigation or page behavior. */
        }
      });
    });
  }

  /* ---------- Hero phone: pointer tilt (fine pointers only) ---------- */
  var scene = document.getElementById("phoneScene");
  var heroVisual = document.getElementById("heroVisual");
  if (
    scene &&
    heroVisual &&
    !reducedMotion.matches &&
    window.matchMedia("(pointer: fine)").matches
  ) {
    var rafId = null;
    var pending = null;

    heroVisual.addEventListener(
      "pointermove",
      function (e) {
        pending = e;
        if (rafId) return;
        rafId = requestAnimationFrame(function () {
          rafId = null;
          if (!pending) return;
          var rect = scene.getBoundingClientRect();
          var x = (pending.clientX - rect.left) / rect.width - 0.5;
          var y = (pending.clientY - rect.top) / rect.height - 0.5;
          scene.style.setProperty("--tilt-x", (x * 7).toFixed(2));
          scene.style.setProperty("--tilt-y", (-y * 6).toFixed(2));
        });
      },
      { passive: true }
    );

    heroVisual.addEventListener("pointerleave", function () {
      scene.style.setProperty("--tilt-x", "0");
      scene.style.setProperty("--tilt-y", "0");
    });
  }

  /* ---------- How-it-works stepper (accessible tabs) ---------- */
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".demo-step"));
  var panels = Array.prototype.slice.call(document.querySelectorAll(".demo-screen"));

  var demoPhone = document.querySelector(".phone-demo");

  function selectStep(index) {
    /* On the stacked (mobile) layout the phone sits above the step buttons.
       If it has scrolled mostly out of view, bring its lower half back while
       keeping the tapped step on screen. */
    if (demoPhone && window.matchMedia("(max-width: 940px)").matches) {
      var rect = demoPhone.getBoundingClientRect();
      if (rect.bottom < window.innerHeight * 0.3) {
        window.scrollTo({
          top: window.scrollY + rect.bottom - window.innerHeight * 0.55,
          behavior: reducedMotion.matches ? "auto" : "smooth"
        });
      }
    }
    tabs.forEach(function (tab, i) {
      var active = i === index;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
    });
    panels.forEach(function (panel, i) {
      var active = i === index;
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
      panel.classList.remove("is-entering");
      if (active && !reducedMotion.matches) {
        /* restart the entrance animation */
        void panel.offsetWidth;
        panel.classList.add("is-entering");
      }
    });
  }

  tabs.forEach(function (tab, i) {
    tab.addEventListener("click", function () { selectStep(i); });
    tab.addEventListener("keydown", function (e) {
      var next = null;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (i + 1) % tabs.length;
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
      if (e.key === "Home") next = 0;
      if (e.key === "End") next = tabs.length - 1;
      if (next !== null) {
        e.preventDefault();
        selectStep(next);
        tabs[next].focus();
      }
    });
  });

  /* ---------- CSP-safe print action (sample report) ---------- */
  Array.prototype.slice.call(document.querySelectorAll("[data-print-page]")).forEach(function (button) {
    button.addEventListener("click", function () { window.print(); });
  });

})();
