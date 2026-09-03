// ads.js — experience-first Google AdSense loader. Does NOTHING unless the server injected
// an #sdc-ads config island (i.e. a publisher id is configured). Even then it stays inert
// until the visitor consents — no ad script, no cookies, no requests before "Allow ads".
// Slots reserve their space up front (no layout shift) and fill lazily on scroll. CSP-safe:
// external script (script-src 'self'); the adsbygoogle push runs here, not inline.
(function () {
  "use strict";
  var cfgEl = document.getElementById("sdc-ads");
  if (!cfgEl) return; // ads disabled server-side
  var CFG; try { CFG = JSON.parse(cfgEl.textContent); } catch (e) { return; }
  if (!CFG || !/^ca-pub-\d{10,20}$/.test(CFG.client || "")) return;

  var CONSENT_KEY = "sdc_ads_consent";
  function getConsent() { try { return localStorage.getItem(CONSENT_KEY); } catch (e) { return null; } }
  function setConsent(v) { try { localStorage.setItem(CONSENT_KEY, v); } catch (e) {} }

  var loaderInjected = false, active = false;
  function injectLoader() {
    if (loaderInjected) return; loaderInjected = true;
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + encodeURIComponent(CFG.client);
    s.crossOrigin = "anonymous";
    document.head.appendChild(s);
  }

  var io = ("IntersectionObserver" in window)
    ? new IntersectionObserver(function (entries) { entries.forEach(function (en) { if (en.isIntersecting) { io.unobserve(en.target); fill(en.target); } }); }, { rootMargin: "320px" })
    : null;

  function fill(slot) {
    if (slot.dataset.adFilled) return;
    var slotId = CFG.slots && CFG.slots[slot.getAttribute("data-ad-slot-name")];
    if (!slotId) return;
    slot.dataset.adFilled = "1";
    var ins = document.createElement("ins");
    ins.className = "adsbygoogle";
    ins.style.display = "block"; // CSSOM style write is CSP-safe
    ins.setAttribute("data-ad-client", CFG.client);
    ins.setAttribute("data-ad-slot", slotId);
    ins.setAttribute("data-ad-format", "auto");
    ins.setAttribute("data-full-width-responsive", "true");
    slot.appendChild(ins);
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch (e) {}
  }

  // Reserve space + label for every configured slot NOW (so the ad's arrival causes no
  // layout shift), then fill it lazily when it nears the viewport.
  function scan() {
    if (!active) return;
    var slots = document.querySelectorAll(".ad-slot[data-ad-slot-name]");
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      if (s.dataset.adReserved) continue;
      if (!(CFG.slots && CFG.slots[s.getAttribute("data-ad-slot-name")])) continue; // no unit id → leave hidden
      s.dataset.adReserved = "1";
      s.classList.add("ad-on");
      var label = document.createElement("span"); label.className = "ad-label"; label.textContent = "Advertisement";
      s.insertBefore(label, s.firstChild);
      if (io) io.observe(s); else fill(s);
    }
  }
  window.__adsScan = function () { scan(); }; // app.js calls this after inserting the in-feed slot

  function activate() { if (active) return; active = true; injectLoader(); scan(); }

  function showConsent() {
    var bar = document.createElement("div");
    bar.className = "ad-consent"; bar.setAttribute("role", "dialog"); bar.setAttribute("aria-label", "Advertising consent");
    var msg = document.createElement("span"); msg.className = "ad-consent-msg";
    msg.textContent = "Ads keep this site free. They may set cookies to show and measure ads — is that OK?";
    var accept = document.createElement("button"); accept.className = "ad-consent-btn accept"; accept.type = "button"; accept.textContent = "Allow ads";
    var decline = document.createElement("button"); decline.className = "ad-consent-btn decline"; decline.type = "button"; decline.textContent = "No thanks";
    accept.addEventListener("click", function () { setConsent("yes"); bar.remove(); activate(); });
    decline.addEventListener("click", function () { setConsent("no"); bar.remove(); });
    bar.appendChild(msg); bar.appendChild(accept); bar.appendChild(decline);
    document.body.appendChild(bar);
  }

  var c = getConsent();
  if (c === "yes") activate();
  else if (c !== "no") { document.readyState === "loading" ? addEventListener("DOMContentLoaded", showConsent) : showConsent(); }
})();
