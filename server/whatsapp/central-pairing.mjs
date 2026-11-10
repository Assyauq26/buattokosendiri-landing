import { createServer } from "node:http";
// Operator-only loopback endpoint, reached through an authenticated SSH tunnel.
// It cannot enumerate/read chats, select sessions or expose gateway credentials.
// Do not route this port through the public reverse proxy.
export function centralPairing({ pool, gateway, centralPhone, port = 8093 }) {
  const origin = "http://127.0.0.1:" + port;
  const page = `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pairing WhatsApp pusat</title><style>body{font:16px system-ui;margin:40px auto;padding:20px;max-width:520px}button{padding:12px 20px;border-radius:8px;background:#111;color:white}img{max-width:100%;display:block;margin:24px auto}p{line-height:1.6}</style><h1>WhatsApp pusat</h1><p>Gunakan nomor pusat yang telah diotorisasi. Buka WhatsApp → Perangkat tertaut → Tautkan perangkat.</p><button id="start">Hubungkan nomor pusat</button><p id="state" role="status"></p><img id="qr" hidden alt="QR privat nomor pusat"><script src="/pair.js"></script></html>`;
  const js = `const state=document.querySelector('#state'),qr=document.querySelector('#qr'),button=document.querySelector('#start');let busy=false;async function run(action){if(busy||document.hidden)return;busy=true;button.disabled=true;try{const r=await fetch('/'+action,{method:'POST',headers:{'X-Btos-Pairing':'1'}});const d=await r.json();state.textContent=d.error||('Status: '+d.status);qr.hidden=!d.qrCode;if(d.qrCode)qr.src=d.qrCode;else qr.removeAttribute('src');}catch{state.textContent='Koneksi belum tersedia';qr.hidden=true;qr.removeAttribute('src');}finally{busy=false;button.disabled=false;}}button.onclick=()=>run('connect');document.addEventListener('visibilitychange',()=>{if(document.hidden){qr.hidden=true;qr.removeAttribute('src');}});setInterval(()=>run('status'),5000);run('status');`;
  let working = false;
  const server = createServer(async (req, res) => {
    const finish = (status, type, data) => {
      res.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      });
      res.end(data);
    };
    const json = (status, value) =>
      finish(status, "application/json", JSON.stringify(value));
    if (
      req.headers.host !== "127.0.0.1:" + port ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return json(403, { error: "Tidak diizinkan" });
    if (req.method === "GET" && req.url === "/")
      return finish(200, "text/html; charset=utf-8", page);
    if (req.method === "GET" && req.url === "/pair.js")
      return finish(200, "text/javascript", js);
    if (
      req.method !== "POST" ||
      !["/connect", "/status"].includes(req.url) ||
      req.headers.origin !== origin ||
      req.headers["x-btos-pairing"] !== "1"
    )
      return json(403, { error: "Tidak diizinkan" });
    if (working) return json(429, { error: "Sedang memproses" });
    working = true;
    try {
      const {
        rows: [s],
      } = await pool.query("SELECT * FROM wa_sessions WHERE purpose='central'");
      if (!s || s.expected_phone !== centralPhone || !s.connection_enabled)
        return json(409, { error: "Nomor pusat belum disiapkan operator" });
      let actual = await gateway.status(s.provider_id);
      if (actual.phone && actual.phone !== centralPhone) {
        await pool.query(
          "UPDATE wa_sessions SET state='failed',connected_phone=NULL,generation=generation+1,connection_enabled=false WHERE provider_id=$1",
          [s.provider_id],
        );
        try {
          await gateway.logout(s.provider_id);
        } catch {}
        return json(409, {
          error: "Nomor tidak sesuai. Sambungan dihentikan.",
        });
      }
      if (
        req.url === "/connect" &&
        ["disconnected", "failed"].includes(actual.status)
      ) {
        await gateway.start(s.provider_id);
        actual = await gateway.status(s.provider_id);
      }
      const qr =
        actual.status === "qr_ready" ? await gateway.qr(s.provider_id) : {};
      return json(200, { status: actual.status, ...qr });
    } catch {
      return json(503, { error: "Koneksi belum tersedia" });
    } finally {
      working = false;
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 20000;
  server.maxConnections = 4;
  server.listen(port, "0.0.0.0");
  return server;
}
