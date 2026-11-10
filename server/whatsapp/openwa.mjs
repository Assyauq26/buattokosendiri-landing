import { createHmac, timingSafeEqual } from "node:crypto";

// Audited source: rmyndharis/OpenWA v0.29.1, commit
// 79d7f865e0518cb2d210deb28a84dcb0f4f39e66. This is not @open-wa/wa-automate.
export const OPENWA_REVISION = "79d7f865e0518cb2d210deb28a84dcb0f4f39e66";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PHONE = /^\+[1-9][0-9]{7,14}$/;
export class GatewayError extends Error {
  constructor(code, outcome = "not_submitted") {
    super(code);
    this.code = code;
    this.outcome = outcome;
  }
}
const reject = (code) => {
  throw new GatewayError(code);
};
export function normalizePhone(value) {
  if (
    typeof value !== "string" ||
    value.length > 24 ||
    /[^+0-9 ()-]/.test(value)
  )
    reject("invalid_phone");
  let phone = value.replace(/[ ()-]/g, "");
  if (phone.startsWith("08")) phone = "+62" + phone.slice(1);
  else if (phone.startsWith("62")) phone = "+" + phone;
  if (!PHONE.test(phone)) reject("invalid_phone");
  return phone;
}
const sessionId = (id) => {
  if (!UUID.test(id || "")) reject("invalid_session");
  return id;
};

export class OpenWA {
  constructor({ origin, apiKey, fetcher = fetch }) {
    const url = new URL(origin);
    // Operator-controlled private origin only. Neither tenants nor requests can
    // select a gateway URL, redirect, media fetch, proxy, or arbitrary API path.
    if (
      url.origin !== origin ||
      url.protocol !== "http:" ||
      !["127.0.0.1", "openwa"].includes(url.hostname) ||
      url.username ||
      url.password ||
      typeof apiKey !== "string" ||
      apiKey.length < 32 ||
      /[\r\n]/.test(apiKey)
    )
      reject("gateway_configuration");
    this.origin = origin;
    this.apiKey = apiKey;
    this.fetcher = fetcher;
    this.retryUntil = 0;
  }
  async request(path, { method = "GET", body, key, send = false } = {}) {
    // All tenants share this private provider client. Respect a provider-wide
    // cooldown instead of letting polling or a different route amplify a 429.
    if (Date.now() < this.retryUntil) reject("gateway_rate_limited");
    try {
      const response = await this.fetcher(this.origin + "/api" + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          "X-API-Key": this.apiKey,
          "Content-Type": "application/json",
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        this.retryUntil =
          Date.now() +
          (Number.isFinite(seconds) && seconds > 0
            ? Math.min(Math.ceil(seconds), 3600)
            : 60) *
            1000;
      }
      const reader = response.body?.getReader();
      let size = 0;
      const parts = [];
      if (!reader) reject("gateway_response");
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 512 * 1024) {
            await reader.cancel();
            reject("gateway_response");
          }
          parts.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      let data;
      try {
        data = JSON.parse(Buffer.concat(parts).toString("utf8"));
      } catch {
        reject("gateway_response");
      }
      if (!response.ok) {
        // An HTTP failure does not prove the provider failed before submitting.
        // Never manufacture delivery success or retry an uncertain send under a new key.
        if (send && data?.code === "IDEMPOTENCY_KEY_IN_PROGRESS")
          throw new GatewayError("submission_pending", "unknown");
        if (send) throw new GatewayError("submission_unknown", "unknown");
        reject(
          response.status === 404 ? "session_missing" : "gateway_unavailable",
        );
      }
      return data;
    } catch (error) {
      if (send)
        throw new GatewayError(
          error instanceof GatewayError ? error.code : "submission_unknown",
          "unknown",
        );
      if (error instanceof GatewayError) throw error;
      throw new GatewayError("gateway_unavailable");
    }
  }
  async create(name) {
    if (!/^btos-(central|seller)-[a-f0-9]{24}$/.test(name))
      reject("invalid_session_name");
    const data = await this.request("/sessions", {
      method: "POST",
      body: { name },
    });
    return { id: sessionId(data.id), name: data.name };
  }
  async status(id) {
    const data = await this.request("/sessions/" + sessionId(id));
    if (
      data.id !== id ||
      ![
        "created",
        "disconnected",
        "initializing",
        "qr_ready",
        "authenticating",
        "ready",
        "action_required",
        "failed",
      ].includes(data.status)
    )
      reject("gateway_response");
    return {
      // A new provider session exists before its engine starts. Expose the same
      // connect action as disconnected, without claiming it has ever paired.
      status: data.status === "created" ? "disconnected" : data.status,
      phone: data.phone ? normalizePhone("+" + data.phone) : null,
      loaded: data.engineLoaded === true,
      connectedAt: data.connectedAt ?? null,
    };
  }
  async start(id) {
    await this.request("/sessions/" + sessionId(id) + "/start", {
      method: "POST",
    });
  }
  async logout(id) {
    await this.request("/sessions/" + sessionId(id) + "/logout", {
      method: "POST",
    });
  }
  async qr(id) {
    const data = await this.request("/sessions/" + sessionId(id) + "/qr");
    if (
      data.status !== "qr_ready" ||
      typeof data.qrCode !== "string" ||
      !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data.qrCode) ||
      data.qrCode.length > 256 * 1024
    )
      reject("qr_unavailable");
    // This provider DTO does not supply an expiry. Re-fetch while pairing and
    // clear the image on state change; do not invent a provider expiry timestamp.
    return { qrCode: data.qrCode, status: data.status };
  }
  async sendText(id, phone, text, key) {
    if (
      !PHONE.test(phone) ||
      typeof text !== "string" ||
      !text.length ||
      text.length > 4096 ||
      !/^[a-f0-9-]{32,64}$/.test(key)
    )
      reject("invalid_send");
    const data = await this.request(
      "/sessions/" + sessionId(id) + "/messages/send-text",
      {
        method: "POST",
        key,
        send: true,
        body: { chatId: phone.slice(1) + "@c.us", text, linkPreview: false },
      },
    );
    if (
      typeof data.messageId !== "string" ||
      !data.messageId.length ||
      data.messageId.length > 256 ||
      !Number.isSafeInteger(data.timestamp)
    )
      throw new GatewayError("submission_unknown", "unknown");
    return {
      state: "submitted",
      messageId: data.messageId,
      timestamp: data.timestamp,
    };
  }
}

export function verifyWebhook(raw, headers, secret, now = Date.now()) {
  if (
    !Buffer.isBuffer(raw) ||
    raw.length > 128 * 1024 ||
    typeof secret !== "string" ||
    secret.length < 32
  )
    reject("invalid_webhook");
  const supplied = /^sha256=([a-f0-9]{64})$/.exec(
    headers["x-openwa-signature"] || "",
  )?.[1];
  const expected = createHmac("sha256", secret).update(raw).digest();
  if (!supplied || !timingSafeEqual(Buffer.from(supplied, "hex"), expected))
    reject("invalid_webhook");
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    reject("invalid_webhook");
  }
  if (
    !body ||
    !UUID.test(body.sessionId || "") ||
    typeof body.timestamp !== "string" ||
    !Number.isFinite(Date.parse(body.timestamp)) ||
    Math.abs(now - Date.parse(body.timestamp)) > 120000 ||
    typeof body.event !== "string" ||
    body.event !== headers["x-openwa-event"] ||
    typeof body.idempotencyKey !== "string" ||
    !/^[\x21-\x7e]{1,255}$/.test(body.idempotencyKey) ||
    body.idempotencyKey !== headers["x-openwa-idempotency-key"] ||
    typeof body.deliveryId !== "string" ||
    !/^[\x21-\x7e]{1,255}$/.test(body.deliveryId) ||
    body.deliveryId !== headers["x-openwa-delivery-id"] ||
    !body.data ||
    typeof body.data !== "object"
  )
    reject("invalid_webhook");
  return body; // Callers must persist deduplication + state change in one transaction.
}

export function incomingIdentity(event, destinationPhone, now = Date.now()) {
  const m = event.data;
  if (
    event.event !== "message.received" ||
    m.fromMe !== false ||
    m.isGroup !== false ||
    m.isStatusBroadcast ||
    m.isForwarded ||
    m.forwardingScore ||
    m.author ||
    m.type !== "text" ||
    m.to !== destinationPhone.slice(1) + "@c.us" ||
    m.chatId !== m.from ||
    !Number.isSafeInteger(m.timestamp) ||
    Math.abs(now / 1000 - m.timestamp) > 180 ||
    typeof m.id !== "string" ||
    !m.id.length ||
    m.id.length > 256 ||
    typeof m.body !== "string" ||
    m.body.length > 512
  )
    reject("message_not_eligible");
  const number = /^([1-9][0-9]{7,14})@c\.us$/.exec(m.from || "")?.[1];
  // Only the provider's authenticated, resolved phone identity is accepted.
  // Unresolved @lid digits must never be treated as a phone number.
  if (!number || (m.isLidSender && m.senderPhone !== number))
    reject("sender_unresolved");
  return { phone: "+" + number, body: m.body, messageId: m.id };
}
