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

    function allowedAttribution(value) {
      return /^ppi_(unknown|direct|internal|search|social|directory|referral|campaign|google|bing|yahoo|duckduckgo|facebook|instagram|tiktok|youtube|reddit|nextdoor|yelp|apple|email)(_(cpc|organic|social|paid_social|email|referral|display))?$/.test(String(value || ""));
    }

    function homepageReferrerCategory(host) {
      if (/(^|\.)(google\.|bing\.com$|search\.yahoo\.com$|duckduckgo\.com$)/.test(host)) return { source: "search", medium: "organic" };
      if (/(^|\.)(facebook\.com$|instagram\.com$|tiktok\.com$|youtube\.com$|reddit\.com$)/.test(host)) return { source: "social", medium: "social" };
      if (/(^|\.)(nextdoor\.com$|yelp\.com$|maps\.apple\.com$)/.test(host)) return { source: "directory", medium: "referral" };
      return { source: "referral", medium: "referral" };
    }

    function homepageAttribution() {
      try {
        var saved = sessionStorage.getItem(attributionKey);
        if (allowedAttribution(saved)) return saved;
        if (saved) sessionStorage.removeItem(attributionKey);
      } catch (e) {}

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
            var category = homepageReferrerCategory(ref.hostname.toLowerCase());
            source = category.source;
            medium = category.medium;
          }
        }
      } catch (e) {}
      var result = "ppi_" + (source || "direct") + (medium ? "_" + medium : "");
      if (!allowedAttribution(result)) result = "ppi_direct";
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

})();
