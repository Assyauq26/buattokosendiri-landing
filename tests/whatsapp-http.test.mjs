import { test } from "node:test";
import assert from "node:assert/strict";
import { createWhatsAppServer } from "../server/whatsapp/http.mjs";
import { GatewayError } from "../server/whatsapp/openwa.mjs";

test("private WhatsApp HTTP boundary rejects arbitrary paths, secrets, oversized bodies and forged webhooks", async () => {
  let calls = 0;
  const auth = {
    webhookSecret: "synthetic-secret-".repeat(4),
    limit: async () => {},
    start: async () => {
      calls++;
      return { id: "synthetic" };
    },
  };
  const sessions = {
    tenant: async (db, token) => {
      if (token !== "a".repeat(64)) throw new GatewayError("access_denied");
      return { id: "tenant" };
    },
    status: async () => ({ status: "disconnected" }),
  };
  const server = createWhatsAppServer({ auth, sessions, notifications: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const request = (path, body = {}, headers = {}, method = "POST") =>
    fetch(origin + "/api/platform/whatsapp/" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + "a".repeat(64),
        ...headers,
      },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    });
  try {
    assert.equal((await request("session/status")).status, 200);
    for (const path of [
      "session/../../admin",
      "session/status?token=x",
      "admin",
      "session/status/",
    ])
      assert.equal((await request(path)).status, 404);
    assert.equal((await request("session/status", {}, {}, "GET")).status, 404);
    assert.equal(
      (await request("session/status", {}, { Authorization: "" })).status,
      401,
    );
    assert.equal(
      (
        await request(
          "session/status",
          {},
          { Authorization: "Bearer " + "b".repeat(64) },
        )
      ).status,
      401,
    );
    assert.equal(
      (await request("session/status", { sessionId: "other-tenant" })).status,
      409,
    );
    assert.equal(
      (await request("auth/start", { phone: "x".repeat(5000) })).status,
      409,
    );
    assert.equal(
      (await request("auth/start", {}, { "Content-Type": "text/plain" }))
        .status,
      409,
    );
    assert.equal(
      (await request("webhook", { sessionId: "forged" })).status,
      409,
    );
    const result = await request("auth/start", {
      phone: "+6281575652263",
      browserProof: "c".repeat(64),
      purpose: "login",
    });
    assert.equal(result.status, 200);
    assert.equal(calls, 1);
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    assert.equal(result.headers.get("access-control-allow-origin"), null);
    auth.start = async () => {
      throw Error("private-key-and-raw-message");
    };
    const failed = await request("auth/start", {});
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: "whatsapp_unavailable" });
    auth.limit = async () => {
      throw new GatewayError("rate_limited");
    };
    assert.equal((await request("session/status")).status, 429);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
