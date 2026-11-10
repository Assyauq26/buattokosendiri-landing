import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  OpenWA,
  verifyWebhook,
  incomingIdentity,
  normalizePhone,
} from "../server/whatsapp/openwa.mjs";
const id = "12345678-1234-1234-1234-123456789abc",
  key = "a".repeat(64),
  now = 1800000000000;
const incoming = () => ({
  event: "message.received",
  sessionId: id,
  timestamp: new Date(now).toISOString(),
  idempotencyKey: "evt-1",
  deliveryId: "delivery-1",
  data: {
    id: "msg-1",
    from: "6281575652263@c.us",
    to: "6282211700060@c.us",
    chatId: "6281575652263@c.us",
    fromMe: false,
    isGroup: false,
    type: "text",
    timestamp: now / 1000,
    body: "BTOS test",
  },
});
function signed(body) {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    raw,
    headers: {
      "x-openwa-signature":
        "sha256=" + createHmac("sha256", key).update(raw).digest("hex"),
      "x-openwa-event": body.event,
      "x-openwa-idempotency-key": body.idempotencyKey,
      "x-openwa-delivery-id": body.deliveryId,
    },
  };
}
test("operator private gateway origin and session identifiers are bounded", async () => {
  for (const origin of [
    "https://evil.test",
    "http://169.254.169.254",
    "http://127.0.0.1/path",
    "http://user@openwa:3000",
  ])
    assert.throws(() => new OpenWA({ origin, apiKey: key }));
  const gateway = new OpenWA({
    origin: "http://127.0.0.1:3000",
    apiKey: key,
    fetcher: () => {
      throw Error("must not call");
    },
  });
  await assert.rejects(gateway.status("../admin"));
  await assert.rejects(
    gateway.sendText(id, "+6281575652263", "test", "arbitrary"),
  );
  assert.equal(normalizePhone("081575652263"), "+6281575652263");
  for (const value of [
    "6281575652263@lid",
    "+62\r\n12345678",
    "javascript:foo",
    "123",
  ])
    assert.throws(() => normalizePhone(value));
});
test("fresh provider session can start pairing without being treated as invalid", async () => {
  const gateway = new OpenWA({
    origin: "http://openwa:2785",
    apiKey: key,
    fetcher: async () =>
      Response.json({
        id,
        status: "created",
        phone: null,
        engineLoaded: false,
      }),
  });
  assert.deepEqual(await gateway.status(id), {
    status: "disconnected",
    phone: null,
    loaded: false,
    connectedAt: null,
  });
});

test("provider cooldown prevents cross-route polling and sending until Retry-After", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  let calls = 0;
  const gateway = new OpenWA({
    origin: "http://openwa:2785",
    apiKey: key,
    fetcher: async () =>
      ++calls === 1
        ? Response.json(
            { message: "Too Many Requests" },
            { status: 429, headers: { "Retry-After": "60" } },
          )
        : Response.json({
            id,
            status: "ready",
            phone: "6282211700060",
            engineLoaded: true,
          }),
  });
  await assert.rejects(gateway.status(id));
  await assert.rejects(gateway.status(id), { code: "gateway_rate_limited" });
  await assert.rejects(gateway.sendText(id, "+6281575652263", "test", key), {
    code: "gateway_rate_limited",
    outcome: "not_submitted",
  });
  assert.equal(calls, 1);
  t.mock.timers.tick(60001);
  assert.equal((await gateway.status(id)).status, "ready");
  assert.equal(calls, 2);
});

test("provider send uses stable idempotency and never claims delivered", async () => {
  const calls = [];
  const gateway = new OpenWA({
    origin: "http://openwa:3000",
    apiKey: key,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return Response.json(
        { messageId: "provider-msg-1", timestamp: now / 1000 },
        { status: 201 },
      );
    },
  });
  const result = await gateway.sendText(
    id,
    "+6281575652263",
    "Test terbatas",
    "b".repeat(32),
  );
  assert.equal(result.state, "submitted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers["Idempotency-Key"], "b".repeat(32));
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    chatId: "6281575652263@c.us",
    text: "Test terbatas",
    linkPreview: false,
  });
});
test("timeout, provider errors and malformed send acknowledgement remain unknown without retries", async () => {
  for (const response of [
    () => {
      throw Error("secret provider body");
    },
    () =>
      Response.json({ code: "IDEMPOTENCY_OUTCOME_UNKNOWN" }, { status: 409 }),
    () =>
      Response.json({ code: "IDEMPOTENCY_KEY_IN_PROGRESS" }, { status: 409 }),
    () => Response.json({ message: "secret" }, { status: 500 }),
    () => Response.json({ ok: true }),
  ]) {
    let calls = 0;
    const gateway = new OpenWA({
      origin: "http://openwa:3000",
      apiKey: key,
      fetcher: async () => {
        calls++;
        return response();
      },
    });
    await assert.rejects(
      gateway.sendText(id, "+6281575652263", "test", "b".repeat(32)),
      (error) =>
        error.outcome === "unknown" && !error.message.includes("secret"),
    );
    assert.equal(calls, 1);
  }
});
test("signature covers exact bytes, envelope headers, timestamp and session", () => {
  const body = incoming(),
    { raw, headers } = signed(body);
  assert.deepEqual(verifyWebhook(raw, headers, key, now), body);
  assert.throws(() =>
    verifyWebhook(Buffer.concat([raw, Buffer.from(" ")]), headers, key, now),
  );
  assert.throws(() => verifyWebhook(raw, headers, "b".repeat(64), now));
  assert.throws(() => verifyWebhook(raw, headers, key, now + 121000));
  for (const field of [
    "x-openwa-event",
    "x-openwa-idempotency-key",
    "x-openwa-delivery-id",
  ])
    assert.throws(() =>
      verifyWebhook(raw, { ...headers, [field]: "other" }, key, now),
    );
  const bad = signed({ ...body, sessionId: "other" });
  assert.throws(() => verifyWebhook(bad.raw, bad.headers, key, now));
});
test("only fresh direct unforwarded incoming messages with proven phone identity qualify", () => {
  assert.equal(
    incomingIdentity(incoming(), "+6282211700060", now).phone,
    "+6281575652263",
  );
  for (const change of [
    { fromMe: true },
    { isGroup: true },
    { isForwarded: true },
    { forwardingScore: 1 },
    { isStatusBroadcast: true },
    { author: "123@c.us" },
    { type: "image" },
    { to: "other@c.us" },
    { timestamp: now / 1000 - 181 },
    { from: "6281575652263@lid", chatId: "6281575652263@lid" },
    { isLidSender: true },
    { isLidSender: true, senderPhone: "6289999999999" },
  ]) {
    const event = incoming();
    Object.assign(event.data, change);
    assert.throws(() => incomingIdentity(event, "+6282211700060", now));
  }
  const resolved = incoming();
  Object.assign(resolved.data, {
    isLidSender: true,
    senderPhone: "6281575652263",
  });
  assert.equal(
    incomingIdentity(resolved, "+6282211700060", now).phone,
    "+6281575652263",
  );
});
test("pairing QR stays private data and cannot inject HTML or external image URL", async () => {
  for (const qrCode of [
    "https://evil.test/qr",
    "data:image/svg+xml;base64,AAAA",
  ]) {
    const gateway = new OpenWA({
      origin: "http://openwa:3000",
      apiKey: key,
      fetcher: async () => Response.json({ status: "qr_ready", qrCode }),
    });
    await assert.rejects(gateway.qr(id));
  }
  const gateway = new OpenWA({
    origin: "http://openwa:3000",
    apiKey: key,
    fetcher: async () =>
      Response.json({
        status: "qr_ready",
        qrCode: "data:image/png;base64,AAAA",
      }),
  });
  assert.deepEqual(await gateway.qr(id), {
    status: "qr_ready",
    qrCode: "data:image/png;base64,AAAA",
  });
});
