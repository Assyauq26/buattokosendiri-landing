import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { centralPairing } from "../server/whatsapp/central-pairing.mjs";
test("operator pairing exposes no credentials, rejects foreign origins and quarantines wrong number", async () => {
  const port = 18093,
    origin = "http://127.0.0.1:" + port,
    number = "+6282211700060";
  let started = 0,
    loggedOut = 0,
    quarantined = false;
  const s = {
    provider_id: "00000000-0000-4000-8000-000000000001",
    expected_phone: number,
    connection_enabled: true,
  };
  let status = { status: "disconnected", phone: null };
  const pool = {
    query: async (sql) => {
      if (sql.startsWith("UPDATE")) quarantined = true;
      return { rows: [s] };
    },
  };
  const gateway = {
    status: async () => status,
    start: async () => {
      started++;
    },
    logout: async () => {
      loggedOut++;
    },
    qr: async () => ({ status: "qr_ready", qrCode: "private-synthetic-data" }),
  };
  const server = centralPairing({ pool, gateway, centralPhone: number, port });
  await once(server, "listening");
  try {
    let r = await fetch(origin + "/");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert(!(await r.text()).includes("API_KEY"));
    r = await fetch(origin + "/connect", {
      method: "POST",
      headers: { Origin: "https://evil.test", "X-Btos-Pairing": "1" },
    });
    assert.equal(r.status, 403);
    assert.equal(started, 0);
    r = await fetch(origin + "/connect", {
      method: "POST",
      headers: { Origin: origin },
    });
    assert.equal(r.status, 403);
    r = await fetch(origin + "/connect", {
      method: "POST",
      headers: { Origin: origin, "X-Btos-Pairing": "1" },
    });
    assert.equal(r.status, 200);
    assert.equal(started, 1);
    status = { status: "ready", phone: "+6281999999999" };
    r = await fetch(origin + "/status", {
      method: "POST",
      headers: { Origin: origin, "X-Btos-Pairing": "1" },
    });
    assert.equal(r.status, 409);
    assert(quarantined);
    assert.equal(loggedOut, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
