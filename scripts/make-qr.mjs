/* Generate the charger QR code for phone testing.
   Usage: node scripts/make-qr.mjs <public-base-url> [qr_slug] [out.png]
   The quick-tunnel URL changes on every cloudflared restart — rerun this
   script (and re-scan) whenever the tunnel is restarted. */

import QRCode from "qrcode";

const [baseUrl, slug = "chg-0042-a1b2", out = "qr-chg-0042.png"] = process.argv.slice(2);
if (!baseUrl) {
  console.error("usage: node scripts/make-qr.mjs <public-base-url> [qr_slug] [out.png]");
  process.exit(1);
}
const url = `${baseUrl.replace(/\/$/, "")}/c/${slug}`;
await QRCode.toFile(out, url, { width: 640, margin: 2, errorCorrectionLevel: "M" });
console.log(`QR for ${url}\n→ ${out}`);
