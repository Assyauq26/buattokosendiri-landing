import { createServer } from "node:http";
import { GatewayError, verifyWebhook } from "./openwa.mjs";
const fail = (code) => {
  throw new GatewayError(code);
};
async function body(req, maximum) {
  if (
    req.headers["content-type"]?.split(";")[0] !== "application/json" ||
    Number(req.headers["content-length"] || 0) > maximum
  )
    fail("invalid_request");
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > maximum) fail("invalid_request");
    parts.push(part);
  }
  return Buffer.concat(parts);
}
const exact = (data, keys) => {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).some((k) => !keys.includes(k))
  )
    fail("invalid_request");
  return data;
};
// Dedicated private service. Reverse proxy must expose only this exact prefix,
// never OpenWA's admin API. No cookies, CORS, arbitrary paths or redirects.
export function createWhatsAppServer({ auth, sessions, notifications }) {
  const server = createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (
        req.method !== "POST" ||
        !/^\/api\/platform\/whatsapp\/[a-z/-]+$/.test(req.url || "")
      )
        return reply(404, { error: "not_found" });
      if (req.url === "/api/platform/whatsapp/webhook") {
        const raw = await body(req, 128 * 1024),
          event = verifyWebhook(raw, req.headers, auth.webhookSecret);
        const {
          rows: [session],
        } = await auth.pool.query(
          "SELECT purpose FROM wa_sessions WHERE provider_id=$1",
          [event.sessionId],
        );
        if (!session) fail("session_mismatch");
        if (session.purpose === "central" && event.event !== "message.received")
          return reply(200, { ignored: true });
        return reply(
          200,
          session.purpose === "central"
            ? await auth.receive(raw, req.headers)
            : await notifications.receive(raw, req.headers),
        );
      }
      const token = /^Bearer ([a-f0-9]{64})$/.exec(
        req.headers.authorization || "",
      )?.[1];
      if (!token) fail("access_denied");
      let input;
      try {
        input = JSON.parse((await body(req, 4096)).toString("utf8"));
      } catch {
        fail("invalid_request");
      }
      const action = req.url.slice("/api/platform/whatsapp/".length);
      const routes = {
        "auth/start": [
          ["phone", "browserProof", "purpose"],
          () => auth.start(token, input),
        ],
        "auth/status": [
          ["id", "browserProof"],
          () => auth.status(token, input),
        ],
        "auth/finish": [
          ["id", "browserProof", "code"],
          () => auth.finish(token, input),
        ],
        "auth/exchange": [
          ["exchange", "browserProof"],
          () => auth.exchange(token, input),
        ],
        "session/status": [[], () => sessions.status(token)],
        "session/connect": [[], () => sessions.connect(token)],
        "session/disconnect": [[], () => sessions.disconnect(token)],
        "session/qr": [[], () => sessions.qr(token)],
        "notifications/consent": [
          ["phone", "granted", "occurredAt"],
          () => notifications.consent(token, input),
        ],
        "notifications/event": [
          ["id", "orderId", "revision", "type", "phone", "occurredAt"],
          () => notifications.enqueue(token, input),
        ],
        "notifications/history": [[], () => notifications.history(token)],
        "notifications/retry": [
          ["id"],
          () => notifications.retry(token, input),
        ],
        "notifications/preferences": [
          ["enabled", "preparing"],
          () => notifications.preferences(token, input),
        ],
      };
      const route = routes[action];
      if (!route) return reply(404, { error: "not_found" });
      exact(input, route[0]);
      // Limits all authenticated routes, including polling and invalid challenges.
      const tenant = await sessions.tenant(auth.pool, token);
      await auth.limit(auth.pool, "http:" + tenant.id, 120, 60);
      reply(200, await route[1]());
    } catch (e) {
      const code = e instanceof GatewayError ? e.code : "whatsapp_unavailable";
      const status =
        code === "access_denied"
          ? 401
          : ["rate_limited", "cooldown", "session_busy"].includes(code)
            ? 429
            : code === "whatsapp_unavailable"
              ? 503
              : 409;
      reply(status, { error: code });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 20000;
  server.maxHeadersCount = 30;
  server.maxConnections = 32;
  return server;
}
