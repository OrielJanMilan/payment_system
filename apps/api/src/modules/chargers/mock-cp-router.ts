import { Router } from "express";
import { chargePoint } from "./gateway.ts";
import type { StartBehavior } from "./mock-cp.ts";

/* Dev-only control surface for the virtual charge point: force the failure
   scenarios Phase 6 tests on the phone. Never mounted in production. */
export const mockCpRouter = Router();

mockCpRouter.get("/mock-cp/state", (_req, res) => {
  res.json(chargePoint().snapshot());
});

mockCpRouter.post("/mock-cp/scenario", (req, res) => {
  const behavior = String((req.body ?? {}).startBehavior) as StartBehavior;
  if (!["normal", "reject", "silent"].includes(behavior)) {
    res.status(400).json({ error: "startBehavior must be normal | reject | silent" });
    return;
  }
  chargePoint().startBehavior = behavior;
  res.json({ ok: true, startBehavior: behavior });
});

mockCpRouter.post("/mock-cp/unplug", (_req, res) => {
  res.json({ ok: chargePoint().unplug() });
});
mockCpRouter.post("/mock-cp/full", (_req, res) => {
  res.json({ ok: chargePoint().vehicleFull() });
});
mockCpRouter.post("/mock-cp/powerloss", (_req, res) => {
  res.json({ ok: chargePoint().powerLoss() });
});
mockCpRouter.post("/mock-cp/offline", (_req, res) => {
  chargePoint().setOnline(false);
  res.json({ ok: true });
});
mockCpRouter.post("/mock-cp/online", (_req, res) => {
  chargePoint().setOnline(true);
  res.json({ ok: true });
});

mockCpRouter.get("/mock-cp/panel", (_req, res) => {
  res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mock Charge Point Panel</title>
<style>
  body{font-family:ui-monospace,monospace;background:#14181c;color:#d7e0e6;margin:0;padding:24px;max-width:560px}
  h1{font-size:15px;color:#7ee2a8}
  pre{background:#1d2329;border-radius:8px;padding:14px;font-size:12px;overflow-x:auto}
  button{margin:4px 6px 4px 0;padding:9px 13px;border:0;border-radius:8px;background:#2a323a;color:#d7e0e6;font:inherit;cursor:pointer}
  button:hover{background:#39434d}
  .grp{margin:14px 0 4px;font-size:11px;color:#8b98a3;text-transform:uppercase;letter-spacing:.08em}
</style></head><body>
<h1>⚡ Mock charge point — CHG-0042</h1>
<pre id="state">loading…</pre>
<div class="grp">Next remote-start behavior</div>
<button onclick="post('/mock-cp/scenario',{startBehavior:'normal'})">normal</button>
<button onclick="post('/mock-cp/scenario',{startBehavior:'reject'})">reject start</button>
<button onclick="post('/mock-cp/scenario',{startBehavior:'silent'})">accept, never start (watchdog)</button>
<div class="grp">Mid-session events</div>
<button onclick="post('/mock-cp/unplug')">unplug cable (EVDisconnected)</button>
<button onclick="post('/mock-cp/full')">vehicle full</button>
<button onclick="post('/mock-cp/powerloss')">power loss</button>
<div class="grp">Connectivity</div>
<button onclick="post('/mock-cp/offline')">go offline</button>
<button onclick="post('/mock-cp/online')">back online</button>
<script>
async function post(url, body){ await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}); refresh(); }
async function refresh(){ document.getElementById('state').textContent = JSON.stringify(await (await fetch('/mock-cp/state')).json(), null, 2); }
refresh(); setInterval(refresh, 2000);
</script></body></html>`);
});
