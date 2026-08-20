/* Option C — UI-only prototype.
   All data is simulated client-side; API calls from SCREEN_FUNCTIONALITY.md
   are marked with TODO(api) where they would be wired in. */

(function () {
  "use strict";

  var RATE = 48.5;            // ₱ / kWh (pinned tariff)
  var HOLD = 1500;            // ₱ pre-auth
  var SOFT_STOP_FRACTION = 0.9;
  var KM_PER_KWH = 6;         // conservative range factor (est.)
  var CO2_PER_KWH = 0.7;      // kg CO₂ avoided vs gasoline (est.)

  var $ = function (id) { return document.getElementById(id); };

  var screens = {
    scan: $("screen-scan"),
    start: $("screen-start"),
    live: $("screen-live"),
    receipt: $("screen-receipt"),
    history: $("screen-history")
  };

  /* ---------- routing (hash-based so browser back works) ---------- */

  function currentRoute() {
    var name = (location.hash || "#/scan").replace(/^#\//, "");
    return screens[name] ? name : "scan";
  }

  function navigate(name) {
    if (currentRoute() === name) { render(); return; }
    location.hash = "#/" + name;
  }

  function render() {
    var active = currentRoute();
    Object.keys(screens).forEach(function (name) {
      screens[name].hidden = name !== active;
    });
    if (active === "live") startLiveSim(); else stopLiveSim();
    window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", render);

  /* ---------- money / number formatting ---------- */

  function peso(n) {
    return "₱" + n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /* ---------- S1 · scan ---------- */

  var codeInput = $("code-input");
  var codeError = $("code-error");

  codeInput.addEventListener("input", function () {
    codeInput.value = codeInput.value.toUpperCase();
    codeInput.classList.remove("is-invalid");
    codeError.hidden = true;
  });

  $("code-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var code = codeInput.value.trim();
    if (!/^CHG-\d{4}$/.test(code)) {
      codeError.textContent = code
        ? "No charger with that code — check the printed label (format CHG-0000)."
        : "Enter the code printed on the charger (format CHG-0000).";
      codeError.hidden = false;
      codeInput.classList.add("is-invalid");
      return;
    }
    // TODO(api): GET /chargers/{code}
    $("start-charger-id").textContent = code + " · Bay 14";
    navigate("start");
  });

  $("btn-history").addEventListener("click", function () { navigate("history"); });

  /* C1 quick start: run confirm + checkout with remembered inputs */
  $("btn-quickstart").addEventListener("click", function () {
    // TODO(api): POST /sessions + POST /payments/checkout with saved token
    authorizeThen(function () { beginSession(); });
  });

  /* ---------- C2 · start ---------- */

  $("btn-start-back").addEventListener("click", function () { history.back(); });

  var chips = Array.prototype.slice.call(document.querySelectorAll(".method-chips .chip"));
  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      chips.forEach(function (c) {
        var selected = c === chip;
        c.classList.toggle("is-selected", selected);
        c.setAttribute("aria-checked", String(selected));
      });
      selectedMethod = chip.dataset.method;
      // QR Ph may fall back to prepay per spec — reflect it in the CTA copy.
      $("btn-hold-start").textContent = selectedMethod === "QR Ph"
        ? "Pay ₱1,500.00 (unused amount refunded)"
        : "Hold & start charging";
    });
  });
  var selectedMethod = "Maya Wallet";

  $("btn-hold-start").addEventListener("click", function () {
    // TODO(api): single chained call — POST /sessions then POST /payments/checkout
    authorizeThen(function () { beginSession(); });
  });

  /* ---------- authorizing overlay ---------- */

  var authOverlay = $("auth-overlay");

  function authorizeThen(done) {
    $("auth-text").textContent = "Authorizing " + peso(HOLD) + " hold…";
    authOverlay.hidden = false;
    setTimeout(function () {
      $("auth-text").textContent = "Starting charger…";
      setTimeout(function () {
        authOverlay.hidden = true;
        done();
      }, 900);
    }, 1100);
  }

  /* ---------- S4 · live session simulation ---------- */

  var session = null;
  var liveTimer = null;

  function beginSession() {
    session = {
      startedAt: Date.now(),
      kwh: 0,
      soc: 42,          // starting state of charge (%)
      kw: 47,           // instantaneous power
      method: selectedMethod
    };
    navigate("live");
  }

  function startLiveSim() {
    if (liveTimer) return;
    if (!session) {          // e.g. page reloaded on #/live
      session = { startedAt: Date.now(), kwh: 12.6, soc: 68, kw: 47, method: "Maya Wallet" };
    }
    updateLive();
    // TODO(api): replace with SSE — GET /sessions/{id}/events
    liveTimer = setInterval(tick, 1000);
  }

  function stopLiveSim() {
    clearInterval(liveTimer);
    liveTimer = null;
  }

  function tick() {
    // Accelerated demo: ~40x real time so the numbers visibly move.
    session.kw = 44 + Math.random() * 8;
    session.kwh += (session.kw / 3600) * 40;
    session.soc = Math.min(99, session.soc + 0.09);

    var cost = session.kwh * RATE;
    if (cost >= HOLD * SOFT_STOP_FRACTION) {
      // Backend soft-stops at 90% of the hold — never exceeds the authorization.
      finishSession();
      return;
    }
    updateLive();
  }

  function updateLive() {
    var cost = session.kwh * RATE;
    var mins = Math.max(1, Math.round(24 + (Date.now() - session.startedAt) / 60000));
    var circumference = 2 * Math.PI * 104;
    var frac = session.soc / 100;

    $("ring-progress").setAttribute("stroke-dasharray",
      (circumference * frac).toFixed(1) + " " + circumference.toFixed(1));
    $("ring-pct").textContent = Math.round(session.soc) + "%";

    $("live-cost").textContent = peso(cost);
    $("live-stats").textContent = "charged so far · " + session.kwh.toFixed(1) +
      " kWh · " + Math.round(session.kw) + " kW · " + mins + " min";

    var kmAdded = Math.round(session.kwh * KM_PER_KWH);
    $("engage-pill").textContent = "+" + kmAdded + " km added (est.) · 80% ≈ " + etaLabel();

    var holdFrac = Math.min(1, cost / HOLD);
    var warning = holdFrac >= 0.75;
    $("hold-bar").setAttribute("aria-valuenow", Math.round(holdFrac * 100));
    $("hold-bar-fill").style.width = (holdFrac * 100).toFixed(1) + "%";
    $("hold-bar-fill").classList.toggle("is-warning", warning);
    $("hold-caption").textContent = warning
      ? peso(cost) + " of " + peso(HOLD) + " hold used — charging stops automatically before the cap"
      : peso(HOLD) + " held · the unused amount is released when you stop";
  }

  function etaLabel() {
    var eta = new Date(Date.now() + Math.max(2, (80 - session.soc)) * 90 * 1000);
    var h = eta.getHours() % 12 || 12;
    var m = String(eta.getMinutes()).padStart(2, "0");
    return h + ":" + m + " " + (eta.getHours() >= 12 ? "PM" : "AM");
  }

  /* ---------- stop sheet ---------- */

  var sheetBackdrop = $("sheet-backdrop");

  $("btn-stop").addEventListener("click", function () { sheetBackdrop.hidden = false; });
  $("btn-stop-cancel").addEventListener("click", function () { sheetBackdrop.hidden = true; });
  sheetBackdrop.addEventListener("click", function (e) {
    if (e.target === sheetBackdrop) sheetBackdrop.hidden = true;
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !sheetBackdrop.hidden) sheetBackdrop.hidden = true;
  });

  $("btn-stop-confirm").addEventListener("click", function () {
    sheetBackdrop.hidden = true;
    // TODO(api): POST /sessions/{id}/stop → capture exact amount
    finishSession();
  });

  /* ---------- S5 · receipt ---------- */

  function finishSession() {
    stopLiveSim();
    var kwh = session.kwh;
    var cost = Math.min(kwh * RATE, HOLD * SOFT_STOP_FRACTION);
    var mins = Math.max(1, Math.round(24 + (Date.now() - session.startedAt) / 60000));
    var now = new Date();

    $("rc-amount").textContent = peso(cost);
    $("rc-meta").textContent = "paid via " + session.method + " · " +
      now.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" }) +
      " · " + now.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
    $("rc-energy").textContent = kwh.toFixed(1) + " kWh · " + mins + " min";
    $("rc-released").textContent = peso(HOLD - cost);
    $("rc-eco").textContent = "About " + Math.round(kwh * KM_PER_KWH) +
      " km of range added · ~" + Math.round(kwh * CO2_PER_KWH) +
      " kg CO₂ avoided vs gasoline (est.)";

    session = null;
    navigate("receipt");
  }

  $("btn-done").addEventListener("click", function () { navigate("scan"); });

  $("btn-download").addEventListener("click", function (e) {
    e.preventDefault();
    // TODO(api): GET /receipts/{id}/pdf
    var link = e.currentTarget;
    var original = link.textContent;
    link.textContent = "Preparing PDF…";
    setTimeout(function () { link.textContent = original; }, 1200);
  });

  /* ---------- S6 · history ---------- */

  var pastSessions = [
    { site: "Ayala Malls Manila Bay", date: "Aug 19, 2026", time: "3:08 PM", kwh: 18.4, mins: 38, amount: 892.4,  or: "OR-2026-081942" },
    { site: "SM Mall of Asia",         date: "Aug 12, 2026", time: "6:41 PM", kwh: 21.0, mins: 44, amount: 1018.5, or: "OR-2026-081204" },
    { site: "BGC High Street",         date: "Aug 7, 2026",  time: "12:19 PM", kwh: 14.6, mins: 31, amount: 708.1,  or: "OR-2026-080731" },
    { site: "NLEX Marilao Northbound", date: "Aug 2, 2026",  time: "9:02 AM", kwh: 12.2, mins: 26, amount: 591.7,  or: "OR-2026-080226" }
  ];

  $("btn-history-back").addEventListener("click", function () { navigate("scan"); });

  Array.prototype.forEach.call(document.querySelectorAll(".session-row"), function (row) {
    row.addEventListener("click", function () {
      var s = pastSessions[Number(row.dataset.session)];
      if (!s) return;
      $("rc-amount").textContent = peso(s.amount);
      $("rc-meta").textContent = "paid via Maya Wallet · " + s.date + " · " + s.time;
      $("rc-energy").textContent = s.kwh.toFixed(1) + " kWh · " + s.mins + " min";
      $("rc-released").textContent = peso(HOLD - s.amount);
      $("rc-eco").textContent = "About " + Math.round(s.kwh * KM_PER_KWH) +
        " km of range added · ~" + Math.round(s.kwh * CO2_PER_KWH) +
        " kg CO₂ avoided vs gasoline (est.)";
      navigate("receipt");
    });
  });

  /* ---------- boot ---------- */

  render();
})();
