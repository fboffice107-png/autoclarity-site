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

  /* ---------- Energized grid + ambient bloom (pointer/touch) ----------
     Two decorative fixed layers behind content, pointer-events: none:
       .cursor-glow — restrained atmospheric bloom following the pointer.
       .neon-grid  — bright copy of the technical grid, revealed through a
                     mask of the current position plus a short fading trail,
                     so the grid lines themselves light up. Created only on
                     pages that opt in via <body data-fx-full> (homepage +
                     inspection landing); other main.js pages keep bloom only.
     Device gates are capability-based, never viewport-width based:
       desktop = (hover: hover) and (pointer: fine) — any laptop qualifies;
       touch   = (pointer: coarse) — follows the finger while touching,
                 fades after lift, never runs between touches.
     Shared rules: nothing is created under prefers-reduced-motion, both
     layers hide while a form control has focus, all updates go through one
     requestAnimationFrame loop that stops when the trail has drained. */
  var fxMode =
    !reducedMotion.matches &&
    (window.matchMedia("(hover: hover) and (pointer: fine)").matches
      ? "desktop"
      : window.matchMedia("(pointer: coarse)").matches
        ? "touch"
        : null);
  if (fxMode) {
    var isTouchFx = fxMode === "touch";
    var glow = document.createElement("div");
    glow.className = "cursor-glow" + (isTouchFx ? " is-touch" : "");
    glow.setAttribute("aria-hidden", "true");
    document.body.appendChild(glow);

    var neon = null;
    if (document.body.hasAttribute("data-fx-full")) {
      neon = document.createElement("div");
      neon.className = "neon-grid" + (isTouchFx ? " is-touch" : "");
      neon.setAttribute("aria-hidden", "true");
      document.body.appendChild(neon);
    }

    var HEAD_R = isTouchFx ? 150 : 190;     // reveal radius around the pointer
    var TRAIL_MS = isTouchFx ? 620 : 550;   // how long a trail point lives
    var SAMPLE_DIST = 26;                   // px between stored trail points
    var MAX_TRAIL = 6;
    var LERP = isTouchFx ? 0.3 : 0.16;      // finger tracks tighter than mouse
    var IDLE_MS = 1700;

    var gx = window.innerWidth / 2, gy = window.innerHeight / 3;
    var tx = gx, ty = gy;
    var trail = [];                          // {x, y, born}, newest last
    var lastSampleX = gx, lastSampleY = gy;
    var fxRaf = null;
    var formFocused = false;
    var idleTimer = null;

    function setOn(on) {
      glow.classList.toggle("is-on", on);
      if (neon) neon.classList.toggle("is-on", on);
    }

    function renderMask(now) {
      if (!neon) return;
      var parts = [
        "radial-gradient(circle " + HEAD_R + "px at " + gx.toFixed(1) + "px " + gy.toFixed(1) +
          "px, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.5) 52%, rgba(0,0,0,0) 76%)"
      ];
      for (var i = trail.length - 1; i >= 0; i--) {
        var age = (now - trail[i].born) / TRAIL_MS; // 0 fresh → 1 expired
        if (age >= 1) continue;
        var r = HEAD_R * (0.82 - 0.52 * age);
        var a = 0.5 * (1 - age);
        parts.push(
          "radial-gradient(circle " + r.toFixed(0) + "px at " + trail[i].x.toFixed(1) + "px " +
            trail[i].y.toFixed(1) + "px, rgba(0,0,0," + a.toFixed(3) + ") 0%, rgba(0,0,0,0) 70%)"
        );
      }
      var mask = parts.join(",");
      neon.style.webkitMaskImage = mask;
      neon.style.maskImage = mask;
    }

    function fxTick() {
      var now = performance.now();
      gx += (tx - gx) * LERP;
      gy += (ty - gy) * LERP;
      glow.style.transform = "translate3d(" + gx.toFixed(1) + "px, " + gy.toFixed(1) + "px, 0)";

      while (trail.length && now - trail[0].born >= TRAIL_MS) trail.shift();
      var dx = gx - lastSampleX, dy = gy - lastSampleY;
      if (dx * dx + dy * dy >= SAMPLE_DIST * SAMPLE_DIST) {
        trail.push({ x: gx, y: gy, born: now });
        if (trail.length > MAX_TRAIL) trail.shift();
        lastSampleX = gx;
        lastSampleY = gy;
      }
      renderMask(now);

      /* Keep animating while converging on the target or draining the trail;
         otherwise stop completely — no background work while parked. */
      if (Math.abs(tx - gx) > 0.5 || Math.abs(ty - gy) > 0.5 || trail.length) {
        fxRaf = requestAnimationFrame(fxTick);
      } else {
        fxRaf = null;
      }
    }

    function fxTarget(x, y) {
      if (formFocused) return;
      tx = x;
      ty = y;
      setOn(true);
      if (neon) {
        neon.classList.remove("is-idle");
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(function () { neon.classList.add("is-idle"); }, IDLE_MS);
      }
      if (!fxRaf) fxRaf = requestAnimationFrame(fxTick);
    }

    if (fxMode === "desktop") {
      window.addEventListener(
        "pointermove",
        function (e) {
          /* A touchscreen laptop still matches (pointer: fine); ignore the
             synthetic/touch pointer stream so touching the screen does not
             drive the desktop effect. */
          if (e.pointerType && e.pointerType !== "mouse" && e.pointerType !== "pen") return;
          fxTarget(e.clientX, e.clientY);
        },
        { passive: true }
      );
      document.addEventListener("pointerleave", function () { setOn(false); });
      document.addEventListener("pointerenter", function (e) {
        if (e.pointerType && e.pointerType !== "mouse" && e.pointerType !== "pen") return;
        /* Re-enter: snap to the entry point so the reveal doesn't sweep in
           from a stale position. */
        gx = tx = e.clientX;
        gy = ty = e.clientY;
        trail.length = 0;
        fxTarget(e.clientX, e.clientY);
      });
    } else {
      /* Passive only — scrolling stays native; no preventDefault, no layout
         reads (clientX/Y are event properties). rAF-throttled via fxTick.
         Touch mode listens to touch events exclusively, so the synthetic
         mouse events browsers fire after a tap can never re-trigger it. */
      function onTouchStart(e) {
        var t = e.touches && e.touches[0];
        if (!t) return;
        gx = tx = t.clientX;                 // appear under the finger, no sweep
        gy = ty = t.clientY;
        trail.length = 0;
        lastSampleX = gx;
        lastSampleY = gy;
        fxTarget(t.clientX, t.clientY);
      }
      function onTouchMove(e) {
        var t = e.touches && e.touches[0];
        if (t) fxTarget(t.clientX, t.clientY);
      }
      function onTouchEnd() {
        setOn(false); // CSS fades both layers; the rAF loop drains the trail then stops
      }
      window.addEventListener("touchstart", onTouchStart, { passive: true });
      window.addEventListener("touchmove", onTouchMove, { passive: true });
      window.addEventListener("touchend", onTouchEnd, { passive: true });
      window.addEventListener("touchcancel", onTouchEnd, { passive: true });
    }

    window.addEventListener("resize", function () {
      /* Orientation change / window resize: stale viewport coordinates make
         no sense — drop the trail; the next input rebuilds it. */
      trail.length = 0;
    });

    document.addEventListener("focusin", function (e) {
      var el = e.target;
      if (!el || !el.matches) return;
      if (el.matches("input, select, textarea, [contenteditable], [contenteditable=\"true\"]") || (el.closest && el.closest("form"))) {
        formFocused = true;
        setOn(false);
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
