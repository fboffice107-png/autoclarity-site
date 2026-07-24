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
  var lastScrolled = null;
  function onScroll() {
    var scrolled = window.scrollY > 8;
    if (scrolled !== lastScrolled) {
      nav.classList.toggle("is-scrolled", scrolled);
      lastScrolled = scrolled;
    }
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

  /* ---------- Nav underline: mark the section currently in view ---------- */
  var navAnchors = Array.prototype.slice.call(
    document.querySelectorAll('.nav-links a[href^="#"], .nav-links a[href*="#"]')
  ).filter(function (a) {
    var hash = a.getAttribute("href").split("#")[1];
    return hash && document.getElementById(hash);
  });
  if (navAnchors.length && "IntersectionObserver" in window) {
    var currentByHash = {};
    var spy = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) { currentByHash[entry.target.id] = entry.isIntersecting; });
        var active = null;
        navAnchors.forEach(function (a) {
          var hash = a.getAttribute("href").split("#")[1];
          if (!active && currentByHash[hash]) active = a;
        });
        navAnchors.forEach(function (a) { a.classList.toggle("is-current", a === active); });
      },
      { rootMargin: "-35% 0px -55% 0px" }
    );
    navAnchors.forEach(function (a) {
      spy.observe(document.getElementById(a.getAttribute("href").split("#")[1]));
    });
  }

  /* ---------- Gentle pointer-following glow ----------
     Desktop (fine pointer, wide viewport): follows the mouse continuously.
     Touch devices (coarse primary pointer): follows the finger while
     touching, fades ~650ms after lift, never runs between touches.
     Shared rules: motion allowed, single fixed composited layer behind
     content, and the glow hides while any form control has focus so
     nothing moves during form completion. */
  var glowSupport =
    !reducedMotion.matches &&
    (window.matchMedia("(pointer: fine)").matches && window.matchMedia("(min-width: 941px)").matches
      ? "desktop"
      : window.matchMedia("(pointer: coarse)").matches
        ? "touch"
        : null);
  if (glowSupport) {
    var glow = document.createElement("div");
    glow.className = "cursor-glow" + (glowSupport === "touch" ? " is-touch" : "");
    glow.setAttribute("aria-hidden", "true");
    document.body.appendChild(glow);

    var gx = window.innerWidth / 2, gy = window.innerHeight / 3;
    var tx = gx, ty = gy;
    var glowRaf = null;
    var formFocused = false;

    function glowTick() {
      gx += (tx - gx) * 0.09;
      gy += (ty - gy) * 0.09;
      glow.style.transform = "translate3d(" + gx.toFixed(1) + "px, " + gy.toFixed(1) + "px, 0)";
      if (Math.abs(tx - gx) > 0.5 || Math.abs(ty - gy) > 0.5) {
        glowRaf = requestAnimationFrame(glowTick);
      } else {
        glowRaf = null;
      }
    }
    function glowTarget(x, y) {
      if (formFocused) return;
      tx = x;
      ty = y;
      glow.classList.add("is-on");
      if (!glowRaf) glowRaf = requestAnimationFrame(glowTick);
    }

    if (glowSupport === "desktop") {
      window.addEventListener("pointermove", function (e) { glowTarget(e.clientX, e.clientY); }, { passive: true });
      document.addEventListener("pointerleave", function () { glow.classList.remove("is-on"); });
    } else {
      /* Passive only — scrolling stays native; no preventDefault, no layout
         reads (clientX/Y are event properties). rAF-throttled via glowTick. */
      function onTouch(e) {
        var t = e.touches && e.touches[0];
        if (t) glowTarget(t.clientX, t.clientY);
      }
      function onTouchEnd() {
        glow.classList.remove("is-on"); // CSS fades it over ~650ms
      }
      window.addEventListener("touchstart", onTouch, { passive: true });
      window.addEventListener("touchmove", onTouch, { passive: true });
      window.addEventListener("touchend", onTouchEnd, { passive: true });
      window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    }

    document.addEventListener("focusin", function (e) {
      var el = e.target;
      if (!el || !el.matches) return;
      if (el.matches("input, select, textarea, [contenteditable=\"true\"]") || (el.closest && el.closest("form"))) {
        formFocused = true;
        glow.classList.remove("is-on");
      }
    });
    document.addEventListener("focusout", function () { formFocused = false; });
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
