/* Option C driver PWA — wired to the real API (mock Maya + mock charge point
   behind it). Money arrives as integer centavos, energy as integer Wh;
   conversion to ₱ / kWh happens only here at the display edge. */

(function () {
  "use strict";

  var KM_PER_KWH = 6;    // conservative range factor (est.)
  var CO2_PER_KWH = 0.7; // kg CO₂ avoided vs gasoline (est.)

  var $ = function (id) { return document.getElementById(id); };

  var screens = {
    scan: $("screen-scan"),
    start: $("screen-start"),
    live: $("screen-live"),
    receipt: $("screen-receipt"),
    history: $("screen-history")
  };

  /* ---------- client state ---------- */

  var charger = null;          // ChargerDto shown on Start
  var connectorId = null;
  var selectedMethod = "Maya Wallet";
  var session = null;          // active SessionDto (Live)
  var receiptSession = null;   // SessionDto rendered on Receipt
  var pendingSession = null;   // retryable pending_payment session (failed/expired checkout)

  function lastCharge() {
    try { return JSON.parse(localStorage.getItem("lastCharge") || "null"); }
    catch (e) { return null; }
  }

  /* ---------- api ---------- */

  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (body) {
        return { ok: r.ok, status: r.status, body: body };
      });
    });
  }
  function post(path, body) {
    return api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }

  /* ---------- formatting ---------- */

  function peso(centavos) {
    return "₱" + (centavos / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function kwh(wh) { return (wh / 1000).toFixed(1); }
  function minutesBetween(a, b) {
    return Math.max(1, Math.round((new Date(b) - new Date(a)) / 60000));
  }
  function fmtDate(iso) {
    return new Date(iso).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
  }
  function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
  }

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
    /* Guard screens whose state is missing (deep hash loads, stale back nav). */
    if (active === "start" && !charger) { navigate("scan"); return; }
    if (active === "live" && !session) { navigate("scan"); return; }
    if (active === "receipt" && !receiptSession) { navigate("scan"); return; }

    Object.keys(screens).forEach(function (name) {
      screens[name].hidden = name !== active;
    });
    if (active === "scan") { renderQuickstart(); startScanner(); } else { stopScanner(); }
    if (active === "live") enterLive(); else leaveLive();
    if (active === "start") startAvailabilityPoll(); else stopAvailabilityPoll();
    if (active === "history") loadHistory();
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", render);

  /* ---------- overlay ---------- */

  var authOverlay = $("auth-overlay");
  function showOverlay(text) { $("auth-text").textContent = text; authOverlay.hidden = false; }
  function hideOverlay() { authOverlay.hidden = true; }

  /* ---------- S1 · scan: manual code entry ---------- */

  var codeInput = $("code-input");
  var codeError = $("code-error");

  function showCodeError(msg) {
    codeError.textContent = msg;
    codeError.hidden = false;
    codeInput.classList.add("is-invalid");
  }

  codeInput.addEventListener("input", function () {
    codeInput.value = codeInput.value.toUpperCase();
    codeInput.classList.remove("is-invalid");
    codeError.hidden = true;
  });

  $("code-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var code = codeInput.value.trim();
    if (!/^CHG-\d{4}$/.test(code)) {
      showCodeError(code
        ? "No charger with that code — check the printed label (format CHG-0000)."
        : "Enter the code printed on the charger (format CHG-0000).");
      return;
    }
    $("btn-go").disabled = true;
    api("/chargers/" + code).then(function (r) {
      $("btn-go").disabled = false;
      if (!r.ok) { showCodeError("No charger with that code."); return; }
      showStart(r.body);
    });
  });

  $("btn-history").addEventListener("click", function () { navigate("history"); });

  /* ---------- S1 · scan: camera QR scanning ---------- */

  var video = $("vf-video");
  var scanStream = null;
  var scanTimer = null;
  var scanBusy = false;

  function startScanner() {
    if (scanStream || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (!navigator.mediaDevices) cameraUnavailable();
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then(function (stream) {
        scanStream = stream;
        video.srcObject = stream;
        video.hidden = false;
        var detector = ("BarcodeDetector" in window)
          ? new window.BarcodeDetector({ formats: ["qr_code"] })
          : null;
        var canvas = document.createElement("canvas");
        var ctx = canvas.getContext("2d", { willReadFrequently: true });
        scanTimer = setInterval(function () {
          if (scanBusy || video.readyState < 2) return;
          if (detector) {
            scanBusy = true;
            detector.detect(video).then(function (codes) {
              scanBusy = false;
              if (codes.length) onQrDecoded(codes[0].rawValue);
            }).catch(function () { scanBusy = false; });
          } else if (window.jsQR) {
            canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0);
            var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            var hit = window.jsQR(img.data, img.width, img.height);
            if (hit) onQrDecoded(hit.data);
          }
        }, 400);
      })
      .catch(cameraUnavailable);
  }

  function cameraUnavailable() {
    video.hidden = true;
    var hint = document.querySelector(".vf-hint");
    if (hint) hint.textContent = "Camera unavailable — enter the charger code below";
  }

  function stopScanner() {
    clearInterval(scanTimer);
    scanTimer = null;
    if (scanStream) {
      scanStream.getTracks().forEach(function (t) { t.stop(); });
      scanStream = null;
      video.srcObject = null;
      video.hidden = true;
    }
  }

  function onQrDecoded(text) {
    /* Accept the deep-link URL (…/c/{slug}) or a bare printed code. */
    var slug = (text.match(/\/c\/([A-Za-z0-9-]+)/) || [])[1];
    var code = (text.match(/CHG-\d{4}/i) || [])[0];
    if (!slug && !code) return; // not one of ours — keep scanning
    stopScanner();
    var lookup = slug ? "/chargers/by-slug/" + slug : "/chargers/" + code.toUpperCase();
    api(lookup).then(function (r) {
      if (!r.ok) {
        showCodeError("Charger not found — check the code.");
        startScanner();
        return;
      }
      showStart(r.body);
    });
  }

  /* ---------- C2 · start ---------- */

  $("btn-start-back").addEventListener("click", function () { history.back(); });

  var startError = $("start-error");
  var availTimer = null;

  function showStart(c, errorMsg, keepPending) {
    if (!keepPending) pendingSession = null;
    charger = c;
    connectorId = pendingSession ? pendingSession.connectorId
      : (c.connectors.length ? c.connectors[0].id : null);
    renderStart();
    startError.hidden = !errorMsg;
    if (errorMsg) startError.textContent = errorMsg;
    navigate("start");
  }

  function renderStart() {
    var conn = charger.connectors[0] || {};
    $("start-charger-id").textContent = charger.code;
    $("start-site").textContent = charger.siteName + " · " + charger.bay;
    $("start-rate").textContent = peso(charger.tariffCentavosPerKwh);
    $("start-connector").textContent = (conn.type || "—") + " · DC fast up to " + (conn.maxKw || "—") + " kW";
    $("start-hold-title").textContent = peso(charger.holdCentavos) + " hold — pay only for the energy you use";
    renderAvailability(conn.status);
    renderCta();
  }

  function renderAvailability(status) {
    var el = $("start-avail");
    /* Our own pending session holds the connector claim — that's a
       reservation, not someone else charging. */
    if (pendingSession) {
      el.textContent = "reserved for you";
      el.classList.remove("is-unavailable");
      $("btn-hold-start").disabled = false;
      return;
    }
    var available = status === "AVAILABLE";
    el.textContent = available ? "available now" : (status === "OFFLINE" ? "charger offline" : "in use right now");
    el.classList.toggle("is-unavailable", !available);
    $("btn-hold-start").disabled = !available;
  }

  function startAvailabilityPoll() {
    stopAvailabilityPoll();
    availTimer = setInterval(function () {
      if (!charger) return;
      api("/chargers/" + charger.code).then(function (r) {
        if (r.ok) { charger = r.body; renderAvailability((charger.connectors[0] || {}).status); }
      });
    }, 15000);
  }
  function stopAvailabilityPoll() { clearInterval(availTimer); availTimer = null; }

  var chips = Array.prototype.slice.call(document.querySelectorAll(".method-chips .chip"));
  chips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      chips.forEach(function (c) {
        var selected = c === chip;
        c.classList.toggle("is-selected", selected);
        c.setAttribute("aria-checked", String(selected));
      });
      selectedMethod = chip.dataset.method;
      renderCta();
    });
  });

  function renderCta() {
    if (!charger) return;
    /* QR Ph has no auth/capture hold — prepay fallback, refunded after. */
    $("btn-hold-start").textContent = selectedMethod === "QR Ph"
      ? "Pay " + peso(charger.holdCentavos) + " (unused amount refunded)"
      : "Hold & start charging";
  }

  $("btn-hold-start").addEventListener("click", function () {
    beginCheckout(charger, connectorId, selectedMethod);
  });

  /* Create (or reuse a retryable) session, then the checkout, then hand the
     browser to the provider's hosted page. Return: boot() → resumePaymentReturn(). */
  function beginCheckout(c, connId, method) {
    startError.hidden = true;
    showOverlay("Contacting Maya…");

    /* Retry after a failed/expired checkout reuses the pending session —
       it already holds the connector claim. */
    if (pendingSession && pendingSession.chargerCode === c.code) {
      checkoutFor(c, pendingSession.id, method, true);
      return;
    }

    post("/sessions", { chargerCode: c.code, connectorId: connId }).then(function (r) {
      if (!r.ok) {
        hideOverlay();
        var msg = r.body && r.body.error === "connector_unavailable"
          ? "This connector is in use right now — try again in a moment."
          : "Couldn't start a session — try again.";
        showStart(c, msg);
        return;
      }
      checkoutFor(c, r.body.id, method, false);
    });
  }

  function checkoutFor(c, sessionId, method, isRetry) {
    localStorage.setItem("activeSessionId", sessionId);
    localStorage.setItem("lastCharge", JSON.stringify({
      code: c.code, siteName: c.siteName, bay: c.bay,
      rateCentavos: c.tariffCentavosPerKwh, holdCentavos: c.holdCentavos,
      connectorType: (c.connectors[0] || {}).type || "", method: method
    }));
    post("/payments/checkout", { sessionId: sessionId, method: method }).then(function (cr) {
      if (!cr.ok) {
        hideOverlay();
        if (isRetry && cr.body && cr.body.error === "session_not_payable") {
          /* The pending session's 10-min TTL lapsed — start over cleanly. */
          pendingSession = null;
          localStorage.removeItem("activeSessionId");
          beginCheckout(c, connectorId, method);
          return;
        }
        showStart(c, "Couldn't reach the payment provider — try again.", true);
        return;
      }
      location.href = cr.body.redirectUrl; // full-page hand-off to hosted checkout
    });
  }

  /* ---------- return from hosted checkout ---------- */

  function resumePaymentReturn(intentId) {
    showOverlay("Confirming payment…");
    var deadline = Date.now() + 30000;
    (function poll() {
      api("/payments/" + intentId).then(function (r) {
        if (!r.ok) { hideOverlay(); navigate("scan"); return; }
        var intent = r.body;
        if (intent.state === "AUTHORIZED" || intent.state === "CAPTURING" || intent.state === "CAPTURED") {
          waitForChargerStart(intent.sessionId);
        } else if (intent.state === "AUTH_FAILED" || intent.state === "EXPIRED") {
          hideOverlay();
          returnToStartOf(intent.sessionId,
            "Payment didn't go through — no money was taken. Try another method.");
        } else if (intent.state === "VOIDED") {
          /* Authorized, but the charger failed to start before we even saw it. */
          hideOverlay();
          localStorage.removeItem("activeSessionId");
          returnToStartOf(intent.sessionId,
            "Couldn't start this charger — the hold has been released. Try another connector.");
        } else if (Date.now() < deadline) {
          setTimeout(poll, 800);
        } else {
          hideOverlay();
          returnToStartOf(intent.sessionId, "Still waiting for the payment confirmation — try again.");
        }
      });
    })();
  }

  /* Hold is placed; now the charger has to actually start (watchdog: 90 s). */
  function waitForChargerStart(sessionId) {
    showOverlay("Starting charger…");
    var deadline = Date.now() + 120000;
    (function poll() {
      api("/sessions/" + sessionId).then(function (r) {
        if (!r.ok) { hideOverlay(); navigate("scan"); return; }
        var s = r.body;
        if (s.state === "charging" || s.state === "ended") {
          hideOverlay();
          session = s;
          localStorage.setItem("activeSessionId", s.id);
          if (s.state === "ended") { onSessionEnded(s); } else { navigate("live"); }
        } else if (s.state === "start_failed") {
          hideOverlay();
          localStorage.removeItem("activeSessionId");
          returnToStartOf(sessionId,
            "Couldn't start this charger — the hold has been released. Try another connector.");
        } else if (Date.now() < deadline) {
          setTimeout(poll, 1000);
        } else {
          hideOverlay();
          navigate("scan");
        }
      });
    })();
  }

  function returnToStartOf(sessionId, message) {
    api("/sessions/" + sessionId).then(function (r) {
      var s = r.ok ? r.body : null;
      if (!s) { navigate("scan"); return; }
      api("/chargers/" + s.chargerCode).then(function (cr) {
        if (!cr.ok) { navigate("scan"); return; }
        pendingSession = s.state === "pending_payment" ? s : null;
        showStart(cr.body, message, true);
      });
    });
  }

  /* ---------- S4 · live (SSE-driven) ---------- */

  var es = null;
  var esBackoff = 1000;
  var lastDataAt = 0;
  var staleTimer = null;
  var liveStartedAt = null;

  function enterLive() {
    if (!session) return;
    $("live-site").textContent = session.siteName + " · " + session.bay;
    $("live-charger").textContent = session.chargerCode;
    $("live-title").textContent = "Charging";
    $("hold-caption").textContent = peso(session.holdCentavos) +
      " held · the unused amount is released when you stop";
    liveStartedAt = session.startedAt || new Date().toISOString();
    if (!es) connectEvents();
    if (!staleTimer) {
      lastDataAt = Date.now();
      staleTimer = setInterval(function () {
        if (Date.now() - lastDataAt > 10000) {
          $("live-title").textContent = "Reconnecting…";
        }
      }, 2000);
    }
  }

  function leaveLive() {
    if (es) { es.close(); es = null; }
    clearInterval(staleTimer);
    staleTimer = null;
  }

  function connectEvents() {
    if (!session) return;
    es = new EventSource("/sessions/" + session.id + "/events");
    es.onmessage = function (msg) {
      lastDataAt = Date.now();
      $("live-title").textContent = "Charging";
      esBackoff = 1000;
      var event;
      try { event = JSON.parse(msg.data); } catch (e) { return; }
      if (event.type === "meter") updateLive(event);
      if (event.type === "state") onStateEvent(event);
    };
    es.onerror = function () {
      /* Manual backoff: close and reconnect with growing delay. */
      if (es) { es.close(); es = null; }
      if (currentRoute() !== "live") return;
      setTimeout(function () {
        if (currentRoute() === "live" && !es) connectEvents();
      }, esBackoff);
      esBackoff = Math.min(esBackoff * 2, 15000);
    };
  }

  function onStateEvent(event) {
    session = event.session || session;
    if (event.state === "ended") onSessionEnded(event.session);
    if (event.state === "charging" && event.session.startedAt) liveStartedAt = event.session.startedAt;
    if (event.state === "start_failed") {
      localStorage.removeItem("activeSessionId");
      returnToStartOf(session.id, "Charging stopped before it began — the hold has been released.");
    }
  }

  function updateLive(m) {
    var tariff = session.tariffCentavosPerKwh;
    var hold = session.holdCentavos;
    var costCentavos = Math.round(m.energyWh * tariff / 1000);
    var mins = minutesBetween(liveStartedAt, new Date().toISOString());

    $("live-cost").textContent = peso(costCentavos);
    $("live-stats").textContent = "charged so far · " + kwh(m.energyWh) + " kWh · " +
      Math.round(m.powerKw) + " kW · " + mins + " min";

    var circumference = 2 * Math.PI * 104;
    if (m.soc !== null && m.soc !== undefined) {
      $("ring-progress").setAttribute("stroke-dasharray",
        (circumference * m.soc / 100).toFixed(1) + " " + circumference.toFixed(1));
      $("ring-pct").textContent = Math.round(m.soc) + "%";
      var kmAdded = Math.round(m.energyWh / 1000 * KM_PER_KWH);
      var eta = new Date(Date.now() + Math.max(2, 80 - m.soc) * 90 * 1000);
      $("engage-pill").hidden = false;
      $("engage-pill").textContent = "+" + kmAdded + " km added (est.) · 80% ≈ " + fmtTime(eta.toISOString());
    } else {
      $("ring-pct").textContent = kwh(m.energyWh);
      $("engage-pill").hidden = true;
    }

    var holdFrac = Math.min(1, costCentavos / hold);
    var warning = holdFrac >= 0.75;
    $("hold-bar").setAttribute("aria-valuenow", Math.round(holdFrac * 100));
    $("hold-bar-fill").style.width = (holdFrac * 100).toFixed(1) + "%";
    $("hold-bar-fill").classList.toggle("is-warning", warning);
    $("hold-caption").textContent = warning
      ? peso(costCentavos) + " of " + peso(hold) + " hold used — charging stops automatically before the cap"
      : peso(hold) + " held · the unused amount is released when you stop";
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
    $("btn-stop").disabled = true;
    $("btn-stop").textContent = "Stopping…";
    post("/sessions/" + session.id + "/stop").then(function () {
      /* The session_ended event lands via SSE and routes to the receipt. */
    });
  });

  /* ---------- S5 · receipt ---------- */

  function onSessionEnded(dto) {
    localStorage.removeItem("activeSessionId");
    $("btn-stop").disabled = false;
    $("btn-stop").textContent = "Stop charging";
    renderReceipt(dto);
    navigate("receipt");
  }

  function renderReceipt(s) {
    receiptSession = s;
    var finalizing = s.amountCentavos === null || s.amountCentavos === undefined;
    $("rc-amount").textContent = finalizing ? "…" : peso(s.amountCentavos);
    $("rc-meta").textContent = finalizing
      ? "Finalizing payment…"
      : "paid via " + (s.paymentMethod || "Maya") + " · " + fmtDate(s.endedAt) + " · " + fmtTime(s.endedAt);
    $("rc-energy").textContent = kwh(s.billedWh || 0) + " kWh · " +
      (s.startedAt && s.endedAt ? minutesBetween(s.startedAt, s.endedAt) : "–") + " min";
    $("rc-rate").textContent = peso(s.tariffCentavosPerKwh) + " / kWh";
    $("rc-hold").textContent = peso(s.holdCentavos);
    $("rc-released-label").textContent = s.prepay ? "Refund issued" : "Hold released";
    $("rc-released").textContent = finalizing ? "…" : peso(s.holdCentavos - s.amountCentavos);
    $("rc-or").textContent = s.receiptNo || "issuing…";
    var energyKwh = (s.billedWh || 0) / 1000;
    $("rc-eco").textContent = "About " + Math.round(energyKwh * KM_PER_KWH) +
      " km of range added · ~" + Math.round(energyKwh * CO2_PER_KWH) +
      " kg CO₂ avoided vs gasoline (est.)";
    /* The ended snapshot can arrive a beat before capture writes the final
       amount / OR number — refetch until both are present. */
    if (finalizing || !s.receiptNo) {
      setTimeout(function () {
        if (receiptSession !== s) return; // user navigated on
        api("/sessions/" + s.id).then(function (r) {
          if (r.ok && receiptSession === s) renderReceipt(r.body);
        });
      }, 1000);
    }
  }

  $("btn-done").addEventListener("click", function () {
    receiptSession = null;
    session = null;
    navigate("scan");
  });

  $("btn-download").addEventListener("click", function (e) {
    e.preventDefault();
    /* Receipt PDFs are a Launch-phase feature (BIR format) — mocked for now. */
    var link = e.currentTarget;
    var original = link.textContent;
    link.textContent = "PDF available after launch";
    setTimeout(function () { link.textContent = original; }, 1500);
  });

  /* ---------- C1 · quick start ---------- */

  function renderQuickstart() {
    var last = lastCharge();
    var card = $("quickstart-card");
    var divider = $("quickstart-divider");
    if (!last) { card.hidden = true; divider.hidden = true; return; }
    card.hidden = false;
    divider.hidden = false;
    $("qs-title").textContent = last.siteName + " · " + last.code;
    $("qs-sub").textContent = last.method + " · " + last.connectorType + " · " +
      peso(last.rateCentavos) + " / kWh";
    $("btn-quickstart").textContent = "Quick start — hold " + peso(last.holdCentavos);
    $("btn-quickstart").disabled = false;
    $("qs-caption").textContent = "One tap: your last charger, rate, and payment method.";
  }

  $("btn-quickstart").addEventListener("click", function () {
    var last = lastCharge();
    if (!last) return;
    $("btn-quickstart").disabled = true;
    api("/chargers/" + last.code).then(function (r) {
      if (!r.ok || (r.body.connectors[0] || {}).status !== "AVAILABLE") {
        $("btn-quickstart").disabled = true;
        $("qs-caption").textContent = "Last charger busy — scan to pick another.";
        return;
      }
      /* Same chained flow with the remembered inputs; the mock provider still
         requires its hosted-page confirmation (real saved tokens: Phase 2/3
         of the product roadmap). */
      selectedMethod = last.method;
      beginCheckout(r.body, r.body.connectors[0].id, last.method);
    });
  });

  /* ---------- S6 · history ---------- */

  $("btn-history-back").addEventListener("click", function () { navigate("scan"); });

  function loadHistory() {
    api("/me/sessions").then(function (r) {
      if (!r.ok) return;
      var list = $("session-list");
      list.textContent = "";
      var sessions = r.body;

      var now = new Date();
      var monthName = now.toLocaleDateString("en-PH", { month: "long", year: "numeric" });
      var inMonth = sessions.filter(function (s) {
        var d = new Date(s.endedAt);
        return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      });
      var totalCentavos = inMonth.reduce(function (a, s) { return a + (s.amountCentavos || 0); }, 0);
      var totalWh = inMonth.reduce(function (a, s) { return a + (s.billedWh || 0); }, 0);
      $("hist-month").textContent = monthName;
      $("hist-total").textContent = peso(totalCentavos);
      $("hist-substats").textContent = inMonth.length + " session" + (inMonth.length === 1 ? "" : "s") +
        " · " + kwh(totalWh) + " kWh";
      var km = Math.round(totalWh / 1000 * KM_PER_KWH);
      $("hist-insight").hidden = km === 0;
      $("hist-insight").textContent = "≈ " + km + " km driven on charge this month (est.)";

      if (!sessions.length) {
        var empty = document.createElement("div");
        empty.className = "session-empty";
        empty.textContent = "No sessions yet — your receipts will appear here.";
        list.appendChild(empty);
        return;
      }
      sessions.forEach(function (s) {
        var row = document.createElement("button");
        row.className = "card session-row";
        row.innerHTML =
          '<div class="session-info">' +
            '<div class="session-site"></div>' +
            '<div class="caption"></div>' +
          '</div>' +
          '<div class="mono session-amt"></div>' +
          '<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
            '<path d="M9 5 L16 12 L9 19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        row.querySelector(".session-site").textContent = s.siteName;
        row.querySelector(".caption").textContent =
          new Date(s.endedAt).toLocaleDateString("en-PH", { month: "short", day: "numeric" }) +
          " · " + kwh(s.billedWh || 0) + " kWh · " +
          (s.startedAt ? minutesBetween(s.startedAt, s.endedAt) : "–") + " min";
        row.querySelector(".session-amt").textContent = peso(s.amountCentavos || 0);
        row.addEventListener("click", function () {
          renderReceipt(s);
          navigate("receipt");
        });
        list.appendChild(row);
      });
    });
  }

  /* ---------- boot ---------- */

  function boot() {
    var params = new URLSearchParams(location.search);
    var paymentReturn = params.get("payment_return");
    var slug = params.get("c");
    var error = params.get("error");
    if (paymentReturn || slug || error) {
      history.replaceState(null, "", "/" + location.hash); // consume the query
    }

    if (paymentReturn) {
      render();
      resumePaymentReturn(paymentReturn);
      return;
    }
    if (slug) {
      api("/chargers/by-slug/" + slug).then(function (r) {
        if (r.ok) { showStart(r.body); } else {
          render();
          showCodeError("Charger not found — check the code.");
        }
      });
      return;
    }
    if (error === "charger-not-found") {
      render();
      showCodeError("Charger not found — check the code.");
      return;
    }

    /* Session resume: reopening while a session is live goes straight to S4. */
    var activeId = localStorage.getItem("activeSessionId");
    if (activeId) {
      api("/sessions/" + activeId).then(function (r) {
        var s = r.ok ? r.body : null;
        if (s && (s.state === "charging" || s.state === "pending_start")) {
          session = s;
          if (s.state === "pending_start") { waitForChargerStart(s.id); }
          else { navigate("live"); render(); }
        } else {
          localStorage.removeItem("activeSessionId");
          render();
        }
      });
      return;
    }
    render();
  }

  boot();
})();
