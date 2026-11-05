import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createApp, CONSENT } from "../server/app.mjs";
import { config } from "../server/config.mjs";
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const sent = new Map();
const setup = {
  vpsIpv4: "8.8.4.4",
  adminPassword: "Local-test-password-2026!",
  adminPasswordConfirmation: "Local-test-password-2026!",
};
let dnsStatus = "ready";
let app, origin, base;
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
  const cfg = {
    local: true,
    origin: "http://127.0.0.1:18181",
    secret: "test-secret-".repeat(5),
    releases: [release],
    sellerPilotOnly: false,
    installerTestEmails: ["pilot@example.com"],
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
