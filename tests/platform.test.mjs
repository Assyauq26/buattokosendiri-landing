import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes, createHash, createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { createApp, CONSENT } from "../server/app.mjs";
import { config } from "../server/config.mjs";
import { session } from "./operations-fixture.mjs";
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const sent = new Map();
const setup = {
  vpsIpv4: "8.8.4.4",
  adminPassword: "Local-test-password-2026!",
  adminPasswordConfirmation: "Local-test-password-2026!",
};
let dnsStatus = "ready";
let app, origin, base, cfg;
const release = {
  repository: "Assyauq26/buattokoonline",
  version: "v1.0.0",
  sha: "a".repeat(40),
  approved: true,
};
before(async () => {
  if (
    !process.env.TEST_DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith(
      "/platform_m1_test",
    )
  )
    throw Error("Use dedicated platform_m1_test database");
  await pool.query(
    readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8"),
  );
  await pool.query(
    "TRUNCATE sellers,otp_challenges,sessions,rate_limits,stores,agents,pairings,jobs,job_events CASCADE",
  );
  cfg = {
    local: true,
    origin: "http://127.0.0.1:18181",
    secret: "test-secret-".repeat(5),
    releases: [release],
    sellerPilotOnly: false,
    installerTestEmails: ["pilot@example.com"],
    onePasteEmails: ["ops-owner@example.com"],
    brandSyncStoreIds: [],
  };
  app = createApp({
    pool,
    config: cfg,
    checkDns: async () => dnsStatus,
    sendMail: async (address, code, id) => sent.set(id, { address, code }),
  });
  await new Promise((r) => app.listen(18181, "127.0.0.1", r));
  origin = cfg.origin;
  base = origin + "/api/platform";
});
after(async () => {
  if (app) await new Promise((r) => app.close(r));
  await pool.end();
});
test("operations role, concurrent one-paste enrollment, audited reset, and replacement fencing", async () => {
  const owner = await session(pool, "ops-owner@example.com");
  const support = await session(pool, "ops-support@example.com", "support");
  const stale = await session(pool, "ops-stale@example.com", "super_admin", false);
  const admin = await session(pool, "ops-admin@example.com", "super_admin");
  const as = user => ({ Cookie: user.cookie });
  assert.equal((await req("/ops/tenants")).status, 401);
  assert.equal((await req("/ops/tenants", null, as(owner))).status, 403);
  dnsStatus = "ready";
  const info = { name: "Tenant Operasi", domain: "ops.example.com", adminEmail: "ops-owner@example.com", ...setup };
  const { store } = (await req("/store", { ...info, domain: "OPS.EXAMPLE.COM." }, as(owner))).body;
  assert.equal(store.domain, info.domain);
  assert.equal((await req("/store/dns", { domain: "tökö.example", vpsIpv4: setup.vpsIpv4 }, as(owner))).status, 200);
  assert.equal((await req("/store/dns", { domain: "https://ops.example.com", vpsIpv4: setup.vpsIpv4 }, as(owner))).status, 422);
  const releaseIp = { action: "release-ip", storeId: store.id, requestId: randomUUID(),
    reason: "Melepas konfigurasi IP uji", confirm: store.id };
  assert.equal((await req("/ops/action", releaseIp, as(support))).status, 403);
  assert.equal((await req("/ops/action", releaseIp, as(admin))).status, 200);
  assert.equal((await req("/store", null, as(owner))).body.store.vps_ipv4, null);
  assert.equal((await req("/store", info, as(owner))).body.store.id, store.id);
  const issued = await req("/pairing", { installer: "stdin" }, as(owner));
  assert.equal(issued.status, 200);
  assert.equal(issued.body.token, undefined);
  const token = /\n([a-f0-9]{64})\nBTOS_ENROLLMENT/.exec(issued.body.command)?.[1];
  assert.ok(token);
  assert.ok(!issued.body.command.includes("/bootstrap.sh?" + token));
  const clients = Array.from({ length: 2 }, () => ({
    token, credential: randomBytes(32).toString("hex"), protocol: 2, ipv4: setup.vpsIpv4,
  }));
  const results = await Promise.all(clients.map(client => req("/agent/pair", client)));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const win = results.findIndex(result => result.status === 200);
  const installationId = results[win].body.agentId;
  const auth = { Authorization: "Bearer " + clients[win].credential };
  await pool.query("UPDATE pairings SET expires_at=now()-interval '1 second' WHERE agent_id=$1", [installationId]);
  assert.equal((await req("/agent/pair", clients[win])).body.agentId, installationId);
  assert.equal((await req("/agent/observation", { agentVersion: "1.1.0", appVersion: "v1.0.0" }, auth)).status, 200);
  assert.equal((await req("/agent/observation", { command: "ignored" }, auth)).status, 422);
  const listed = await req("/ops/tenants?q=ops.example.com&heartbeat=recent", null, as(support));
  assert.equal(listed.body.total, 1);
  assert.equal(listed.body.rows[0].installation_id, installationId);
  assert.equal(JSON.stringify(listed.body).includes(clients[win].credential), false);
  const request = await req("/ops/request", { action: "reinstall", reason: "Pengujian lokal" }, as(owner));
  assert.equal(request.status, 201);
  assert.equal((await req("/ops/my-requests", null, as(support))).body.requests.length, 0);
  const action = { storeId: store.id, requestId: randomUUID(), installationId,
    action: "reset", reason: "Reset lokal terverifikasi", confirm: store.id };
  assert.equal((await req("/ops/action", action, as(support))).status, 403);
  assert.equal((await req("/ops/action", action, as(stale))).status, 403);
  assert.equal((await req("/ops/action", action, { ...as(admin), Origin: "https://other.example" })).status, 403);
  assert.equal((await req("/ops/action", action, as(admin))).status, 200);
  assert.equal((await req("/ops/action", action, as(admin))).body.replay, true);
  assert.equal((await req("/agent/job", null, auth)).status, 401);
  assert.equal((await req("/agent/pair", clients[win])).status, 410);
  const details = (await req("/ops/tenant?id=" + store.id, null, as(admin))).body;
  assert.equal(details.audit.filter(event => event.action === "reset").length, 1);
  assert.equal(details.installations.length, 1);
  assert.equal(details.store.domain, info.domain);
  assert.equal(details.store.installation_generation, 2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM agents WHERE store_id=$1", [store.id])).rows[0].n, 0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM installation_history WHERE store_id=$1", [store.id])).rows[0].n, 1);
  assert.equal((await req("/store", info, as(owner))).body.store.id, store.id);
  const replacement = await req("/pairing", {}, as(owner));
  const fresh = await req("/agent/pair", {
    ...clients[win], token: replacement.body.token, credential: randomBytes(32).toString("hex"),
  });
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.body.agentId, installationId);
  assert.equal((await pool.query("SELECT generation FROM agents WHERE id=$1", [fresh.body.agentId])).rows[0].generation, 2);
});
test("sender synchronization is scoped, revision fenced, repeatable and rejects revoked agents", async () => {
  const owner = await session(pool, "sync-owner@example.com");
  dnsStatus = "ready";
  await req("/store", { name: "Nama Awal", domain: "sync.example.com", adminEmail: "sync-owner@example.com", ...setup },
    { Cookie: owner.cookie });
  const pairing = await req("/pairing", {}, { Cookie: owner.cookie });
  const credential = randomBytes(32).toString("hex");
  const paired = await req("/agent/pair", { token: pairing.body.token, credential, protocol: 2, ipv4: setup.vpsIpv4 });
  const oldEnabled = cfg.mailEnabled;
  cfg.mailEnabled = true;
  cfg.mailControlSecret = "c".repeat(64);
  try {
    const provision = await req("/agent/mail", {}, { Authorization: "Bearer " + credential });
    const tokenHash = createHash("sha256").update(provision.body.token).digest("hex");
    const storeId = (await req("/store", null, { Cookie: owner.cookie })).body.store.id;
    cfg.brandSyncStoreIds = [storeId];
    const headers = { Authorization: "Bearer " + cfg.mailControlSecret };
    const body = { tokenHash, origin: "https://sync.example.com", name: "Hubify", revision: 4 };
    cfg.brandSyncStoreIds = [];
    assert.equal((await req("/internal/mail-registry", { tokenHash }, headers)).body.brandSync, false);
    assert.equal((await req("/internal/mail-identity", body, headers)).status, 403);
    cfg.brandSyncStoreIds = [storeId];
    assert.equal((await req("/internal/mail-identity", body)).status, 401);
    assert.equal((await req("/internal/mail-identity", { ...body, origin: "https://other.example" }, headers)).status, 401);
    const synced = await Promise.all([req("/internal/mail-identity", body, headers), req("/internal/mail-identity", body, headers)]);
    assert.deepEqual(synced.map(result => result.status), [200, 200]);
    assert.equal((await req("/internal/mail-identity", { ...body, revision: 3 }, headers)).status, 409);
    assert.equal((await req("/internal/mail-identity", { ...body, name: "Lama" }, headers)).status, 409);
    assert.equal((await req("/internal/mail-identity", { ...body, name: "Nama Baru", revision: 5 }, headers)).status, 200);
    assert.equal((await req("/internal/mail-identity", { ...body, name: "injected\r\nFrom:test", revision: 6 }, headers)).status, 422);
    const registry = await req("/internal/mail-registry", { tokenHash }, headers);
    assert.equal(registry.body.brand, "Nama Baru");
    assert.equal(registry.body.brandSync, true);
    const details = await req("/store", null, { Cookie: owner.cookie });
    assert.equal(details.body.store.name, "Nama Baru");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM mail_audit WHERE store_id=$1 AND event='brand-synced'",
      [details.body.store.id])).rows[0].n, 2);
    await pool.query("UPDATE agents SET revoked_at=now() WHERE id=$1", [paired.body.agentId]);
    assert.equal((await req("/internal/mail-identity", { ...body, revision: 6 }, headers)).status, 401);
  } finally { cfg.mailEnabled = oldEnabled; cfg.brandSyncStoreIds = []; }
});
test("WhatsApp observations and pause remain scoped to the selected tenant", async () => {
  const db = await pool.connect();
  try {
    await db.query("CREATE SCHEMA IF NOT EXISTS whatsapp_pilot");
    await db.query("SET search_path=whatsapp_pilot,public");
    await db.query(readFileSync(new URL("../server/whatsapp/schema.sql", import.meta.url), "utf8"));
    await db.query("SET search_path=public");
    await db.query(readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8"));
  } finally { db.release(); }
  const admin = await session(pool, "wa-ops@example.com", "operator");
  const { rows: stores } = await pool.query("SELECT id FROM stores ORDER BY created_at LIMIT 2");
  for (const store of stores) {
    await pool.query(`INSERT INTO whatsapp_pilot.wa_tenants(id,origin,brand,token_digest,paused)
      VALUES($1,$2,'Demo',$3,false)`, [store.id, "https://" + store.id + ".example.test", store.id]);
    await pool.query(`INSERT INTO whatsapp_pilot.wa_sessions(provider_id,tenant_id,purpose,expected_phone,connected_phone,state)
      VALUES($1,$2,'seller',$3,$3,'ready')`, [randomUUID(), store.id, "+6281" + store.id.replace(/\D/g, "").slice(0, 8)]);
  }
  const before = (await req("/ops/tenant?id=" + stores[0].id, null, { Cookie: admin.cookie })).body;
  assert.equal(before.whatsapp.session.state, "ready");
  assert.equal(JSON.stringify(before.whatsapp).includes("+6281"), false);
  assert.equal((await req("/ops/action", {
    action: "pause-wa", storeId: stores[0].id, requestId: randomUUID(), reason: "Menahan pengiriman uji lokal",
  }, { Cookie: admin.cookie })).status, 200);
  const { rows } = await pool.query("SELECT id,paused FROM whatsapp_pilot.wa_tenants ORDER BY id");
  assert.equal(rows.find(row => row.id === stores[0].id).paused, true);
  assert.equal(rows.find(row => row.id === stores[1].id).paused, false);
});
async function req(route, data, headers = {}) {
  const r = await fetch(base + route, {
    method: data ? "POST" : "GET",
    headers: {
      Origin: origin,
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  return {
    status: r.status,
    body: await r.json(),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
async function login(address) {
  const c = await req("/otp/request", { email: address, consent: CONSENT });
  assert.equal(c.status, 200);
  const v = await req("/otp/verify", {
    challenge: c.body.challenge,
    code: sent.get(c.body.challenge).code,
  });
  assert.equal(v.status, 200);
  return v.cookie;
}
test("OTP, sessions, tenant boundaries, pairing and durable completion", async () => {
  assert.equal((await req("/session")).status, 401);
  assert.equal(
    (
      await req(
        "/otp/request",
        { email: "a@example.com", consent: CONSENT },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const alice = await login("alice@example.com");
  const replayId = [...sent.keys()][0];
  assert.equal(
    (
      await req("/otp/verify", {
        challenge: replayId,
        code: sent.get(replayId).code,
      })
    ).status,
    401,
  );
  const bob = await login("bob@example.com");
  assert.equal((await req("/pairing", {}, { Cookie: bob })).status, 422);
  const info = { name: "Toko Alice", domain: "alice.example.com", adminEmail: "alice@example.com", ...setup };
  dnsStatus = "pending";
  assert.equal((await req("/store/dns", info, { Cookie: alice })).body.ready, false);
  assert.equal((await req("/store", info, { Cookie: alice })).status, 422);
  dnsStatus = "ready";
  assert.equal((await req("/store/dns", info, { Cookie: alice })).body.ready, true);
  assert.equal((await req("/store", { ...info, adminPasswordConfirmation: "wrong" }, { Cookie: alice })).status, 422);
  assert.equal(
    (
      await req(
        "/store",
        {
          name: "Toko Alice",
          domain: "alice.example.com",
          adminEmail: "alice@example.com",
          ...setup,
        },
        { Cookie: alice },
      )
    ).status,
    200,
  );
  assert.equal((await req("/store", null, { Cookie: bob })).body.store, null);
  assert.equal(
    (
      await req(
        "/store",
        {
          name: "Toko Bob",
          domain: "alice.example.com",
          adminEmail: "bob@example.com",
          ...setup,
        },
        { Cookie: bob },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await req(
        "/store",
        {
          name: "Toko Bob",
          domain: "hubify.web.id",
          adminEmail: "bob@example.com",
        },
        { Cookie: bob },
      )
    ).status,
    422,
  );
  const pairing = await req("/pairing", {}, { Cookie: alice });
  assert.equal(pairing.status, 200);
  assert.ok(
    !pairing.body.command.includes(pairing.body.token),
    "secret absent from shell command",
  );
  const credential = randomBytes(32).toString("hex");
  const data = { token: pairing.body.token, credential, protocol: 2, ipv4: setup.vpsIpv4 };
  assert.equal((await req("/agent/pair", { ...data, protocol: 1 })).status, 409);
  assert.equal((await req("/agent/pair", { ...data, ipv4: "8.8.8.8" })).status, 409);
  assert.equal((await req("/agent/pair", data)).status, 200);
  assert.equal(
    (await req("/agent/pair", data)).status,
    200,
    "idempotent pairing response retry",
  );
  assert.equal(
    (
      await req("/agent/pair", {
        ...data,
        credential: randomBytes(32).toString("hex"),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await req(
        "/store",
        {
          name: "Changed",
          domain: "other.example.com",
          adminEmail: "alice@example.com",
          ...setup,
        },
        { Cookie: alice },
      )
    ).status,
    409,
  );
  assert.equal((await req("/agent/job")).status, 401);
  const auth = { Authorization: "Bearer " + credential };
  const payload = await req("/agent/job", null, auth);
  assert.equal(payload.status, 200);
  const job = payload.body.job;
  assert.equal(job.release.sha, release.sha);
  const sellerStore = (await req("/store", null, { Cookie: alice })).body.store;
  assert.equal(sellerStore.admin_password_sealed, undefined);
  assert.equal(payload.body.store.admin_password_sealed, undefined);
  assert.equal((await req("/agent/admin-password", null, { Cookie: alice })).status, 401);
  assert.equal((await req("/agent/admin-password", null, auth)).status, 409);
  const sealed = (await pool.query("SELECT admin_password_sealed FROM stores WHERE id=$1", [sellerStore.id])).rows[0].admin_password_sealed;
  assert.ok(sealed && !sealed.includes(setup.adminPassword));
  assert.equal(
    (
      await req(
        "/agent/event",
        {
          jobId: job.id,
          sequence: 1,
          stage: "complete",
          state: "complete",
          evidence: {},
        },
        auth,
      )
    ).status,
    422,
    "success requires evidence",
  );
  const reportStage = (stage, sequence, state = "running") =>
    req("/agent/event", { jobId: job.id, stage, sequence, state }, auth);
  assert.equal((await reportStage("https", 1)).status, 200);
  assert.equal((await req("/agent/admin-password", null, auth)).body.password, setup.adminPassword);
  assert.equal((await reportStage("database", 2)).status, 200);
  assert.equal((await req("/store", null, { Cookie: alice })).body.job.progress, 72);
  assert.equal((await reportStage("preflight", 3, "failed")).status, 200);
  assert.equal((await req("/store", null, { Cookie: alice })).body.job.progress, 72);
  const complete = {
    jobId: job.id,
    sequence: 4,
    stage: "complete",
    state: "complete",
    evidence: {
      https: "PUBLIC_CERTIFICATE_VALID",
      application: "healthy",
      version: release.version,
      source_sha: release.sha,
      password: "do-not-store",
    },
  };
  assert.equal((await req("/agent/event", complete, auth)).status, 200);
  assert.equal(
    (await req("/agent/event", complete, auth)).status,
    200,
    "event replay is idempotent",
  );
  const state = await req("/store", null, { Cookie: alice });
  assert.equal(state.body.job.state, "complete");
  assert.equal(state.body.job.progress, 100);
  assert.equal((await req("/agent/admin-password", null, auth)).status, 409);
  assert.equal((await pool.query("SELECT admin_password_sealed FROM stores WHERE id=$1", [sellerStore.id])).rows[0].admin_password_sealed, null);
  assert.equal(state.body.job.evidence.password, undefined);
  assert.equal((await req("/store", null, { Cookie: bob })).body.store, null);
  assert.equal((await req("/revoke", {}, { Cookie: alice })).status, 200);
  assert.equal((await req("/agent/job", null, auth)).status, 401);
  await req("/logout", {}, { Cookie: alice });
  assert.equal((await req("/session", null, { Cookie: alice })).status, 401);
});
test("pairing can reconnect a healthy installation for the same domain", async () => {
  const cookie = await login("reconnect@example.com");
  const domain = "reconnect.example.com";
  assert.equal((await req("/store", { ...setup, name: "Toko Lama", domain, adminEmail: "reconnect@example.com" }, { Cookie: cookie })).status, 200);
  const pairing = await req("/pairing", {}, { Cookie: cookie });
  const credential = randomBytes(32).toString("hex");
  const data = { token: pairing.body.token, credential, protocol: 2, ipv4: setup.vpsIpv4 };
  assert.equal((await req("/agent/pair", { ...data, existingDomain: "different.example.com" })).status, 409);
  assert.equal((await req("/store", null, { Cookie: cookie })).body.job, null);
  assert.equal((await req("/agent/pair", { ...data, existingDomain: domain })).status, 200);
  const auth = { Authorization: "Bearer " + credential };
  const { job } = (await req("/agent/job", null, auth)).body;
  const evidence = { https: "PUBLIC_CERTIFICATE_VALID", application: "healthy", version: "v0.9.0", source_sha: "b".repeat(40) };
  const complete = { jobId: job.id, sequence: 1, stage: "complete", state: "complete" };
  assert.equal((await req("/agent/event", { ...complete, evidence }, auth)).status, 422);
  assert.equal((await req("/agent/event", { ...complete, evidence: { ...evidence, installation: "reattached" } }, auth)).status, 200);
  const result = (await req("/store", null, { Cookie: cookie })).body.job;
  assert.equal(result.progress, 100);
  assert.equal(result.evidence.version, "v0.9.0");
});
test("wrong OTP increments persist, lockout, expiry and request cooldown", async () => {
  const c = await req("/otp/request", {
    email: "wrong@example.com",
    consent: CONSENT,
  });
  const id = c.body.challenge;
  const wrong = sent.get(id).code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await req("/otp/verify", { challenge: id, code: wrong })).status,
      401,
    );
  assert.equal(
    (await req("/otp/verify", { challenge: id, code: sent.get(id).code }))
      .status,
    401,
  );
  assert.equal(
    (await pool.query("SELECT attempts FROM otp_challenges WHERE id=$1", [id]))
      .rows[0].attempts,
    5,
  );
  assert.equal(
    (
      await req("/otp/request", {
        email: "wrong@example.com",
        consent: CONSENT,
      })
    ).status,
    429,
  );
  const expired = await req("/otp/request", {
    email: "expired@example.com",
    consent: CONSENT,
  });
  await pool.query(
    "UPDATE otp_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expired.body.challenge],
  );
  assert.equal(
    (
      await req("/otp/verify", {
        challenge: expired.body.challenge,
        code: sent.get(expired.body.challenge).code,
      })
    ).status,
    401,
  );
});
test("public static allowlist prevents source and traversal exposure", async () => {
  for (const file of [
    "/server/schema.sql",
    "/.env",
    "/deploy/approved-releases.json",
    "/assets/%2e%2e/server/app.mjs",
  ])
    assert.equal((await fetch(origin + file)).status, 404);
  const landing = await fetch(origin + "/");
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /Mulai Sekarang/);
  const html = await fetch(origin + "/pendaftaran");
  assert.equal(html.status, 200);
  assert.match(
    html.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.match(await html.text(), /Kode OTP 6 digit/);
});
test("production origin and secret configuration fail closed", () => {
  assert.throws(() =>
    config({
      APP_ORIGIN: "http://example.com",
      DATABASE_URL: "x",
      AUTH_SECRET: "x".repeat(32),
    }),
  );
  assert.throws(() => config({ DATABASE_URL: "x", AUTH_SECRET: "short" }));
});

test("three tenants: concurrent provisioning, control authentication, lifecycle and readiness gate", async () => {
  cfg.mailEnabled = true;
  cfg.mailControlSecret = randomBytes(32).toString('hex');
  const tenants = [];
  try {
    for (const [index, brand] of ['Gheverhan', 'Toko Makmur', 'Fashion Store', 'Seller Baru'].entries()) {
      const address = `mail-${index}@example.com`;
      const cookie = await login(address);
      const store = await req('/store', { ...setup, name: brand, domain: `mail-${index}.example.com`, adminEmail: address }, { Cookie: cookie });
      assert.equal(store.status, 200);
      const pair = await req('/pairing', {}, { Cookie: cookie });
      const credential = randomBytes(32).toString('hex');
      assert.equal((await req('/agent/pair', { token: pair.body.token, credential, protocol: 2, ipv4: setup.vpsIpv4 })).status, 200);
      const auth = { Authorization: `Bearer ${credential}` };
      const replies = await Promise.all(Array.from({ length: 8 }, () => req('/agent/mail', {}, auth)));
      assert.ok(replies.every(r => r.status === 200));
      assert.equal(new Set(replies.map(r => r.body.token)).size, 1);
      const mail = replies[0].body;
      assert.equal(mail.tenantId, store.body.store.id);
      assert.equal(mail.brand, brand);
      assert.equal((await req('/agent/mail', {}, { Cookie: cookie })).status, 401);
      const publicStatus = await req('/store/mail', null, { Cookie: cookie });
      assert.ok(!JSON.stringify(publicStatus.body).includes(mail.token));
      const hash = createHash('sha256').update(mail.token).digest('hex');
      assert.equal((await req('/internal/mail-registry', { tokenHash: hash }, auth)).status, 401);
      assert.equal((await req('/internal/mail-registry', { tokenHash: hash }, { Authorization: `Bearer ${cfg.mailControlSecret}` })).body.brand, brand);
      const job = (await req('/agent/job', null, auth)).body.job;
      const event = { jobId: job.id, sequence: 1, stage: 'complete', state: 'complete',
        evidence: { https: 'PUBLIC_CERTIFICATE_VALID', application: 'healthy', version: release.version, source_sha: release.sha } };
      assert.equal((await req('/agent/event', event, auth)).status, 409);
      assert.equal((await req('/agent/mail-ack', { generation: 1 }, auth)).status, 422);
      const expires = Date.now() + 120000;
      const receipt = { expires, signature: createHmac('sha256', cfg.mailControlSecret)
        .update(`mail-ready-v1:${mail.tenantId}:1:${expires}`).digest('hex') };
      assert.equal((await req('/agent/mail-ack', { generation: 1, receipt }, auth)).status, 200);
      assert.equal((await req('/agent/event', event, auth)).status, 200);
      tenants.push({ cookie, auth, mail, receipt });
    }
    assert.equal(new Set(tenants.map(t => t.mail.token)).size, 4);
    assert.equal((await req('/agent/mail-ack', { generation: 1, receipt: tenants[0].receipt }, tenants[1].auth)).status, 422);
    const a = tenants[0], b = tenants[1];
    const changes = await Promise.all(Array.from({ length: 2 }, () => req('/store/mail', { action: 'rotate', generation: 1 }, { Cookie: a.cookie })));
    assert.deepEqual(changes.map(r => r.status).sort(), [200, 409]);
    const hash = createHash('sha256').update(a.mail.token).digest('hex');
    assert.equal((await req('/internal/mail-registry', { tokenHash: hash }, { Authorization: `Bearer ${cfg.mailControlSecret}` })).status, 404);
    assert.equal((await req('/agent/mail', {}, b.auth)).body.token, b.mail.token);
    assert.equal((await req('/store/mail', { action: 'identity', generation: 2, brand: 'New Brand', domain: 'new.example.com', adminEmail: 'unverified@example.com' }, { Cookie: a.cookie })).status, 422);
    dnsStatus = 'pending';
    assert.equal((await req('/store/mail', { action: 'identity', generation: 2, brand: 'New Brand', domain: 'new.example.com', adminEmail: 'mail-0@example.com' }, { Cookie: a.cookie })).status, 422);
    dnsStatus = 'ready';
    assert.equal((await req('/store/mail', { action: 'identity', generation: 2, brand: 'New Brand', domain: 'new.example.com', adminEmail: 'mail-0@example.com' }, { Cookie: a.cookie })).status, 200);
    const changed = (await req('/agent/mail', {}, a.auth)).body;
    assert.equal(changed.brand, 'New Brand');
    assert.equal(changed.origin, 'https://new.example.com');
    assert.notEqual(changed.token, a.mail.token);
    assert.equal((await req('/store/mail', { action: 'administrators', generation: 3, emails: ['mail-0@example.com', 'unknown@example.com'] }, { Cookie: a.cookie })).status, 422);
    assert.equal((await req('/store/mail', { action: 'administrators', generation: 3, emails: ['mail-0@example.com', 'mail-1@example.com'] }, { Cookie: a.cookie })).status, 200);
    const renewed = (await req('/agent/mail', {}, a.auth)).body;
    const entry = await req('/internal/mail-registry', { tokenHash: createHash('sha256').update(renewed.token).digest('hex') }, { Authorization: `Bearer ${cfg.mailControlSecret}` });
    assert.deepEqual(entry.body.sellerEmails.sort(), ['mail-0@example.com', 'mail-1@example.com']);
    assert.equal((await req('/store/mail', { action: 'disable', generation: 4 }, { Cookie: a.cookie })).status, 200);
    assert.equal((await req('/agent/mail', {}, a.auth)).status, 403);
    assert.equal((await req('/store/mail', { action: 'enable', generation: 5 }, { Cookie: a.cookie })).status, 200);
    assert.notEqual((await req('/agent/mail', {}, a.auth)).body.token, a.mail.token);
    assert.equal((await req('/revoke', {}, { Cookie: b.cookie })).status, 200);
    assert.equal((await req('/agent/mail', {}, b.auth)).status, 401);
    const audits = await pool.query('SELECT event,generation FROM mail_audit');
    assert.ok(audits.rowCount >= 6);
    assert.ok(!JSON.stringify(audits.rows).includes(a.mail.token));
  } finally { cfg.mailEnabled = false; dnsStatus = 'ready'; }
});
