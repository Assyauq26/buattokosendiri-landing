// Operator invocation only. Secrets arrive through server env/files, never CLI output.
import pg from "pg";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { OpenWA } from "./openwa.mjs";
const id = process.env.WA_PILOT_STORE_ID;
if (!/^[a-f0-9-]{36}$/.test(id || "")) throw Error("pilot_registry_required");
const token = (await readFile("/run/hubify-whatsapp-token", "utf8")).trim();
if (!/^[a-f0-9]{64}$/.test(token)) throw Error("pilot_credential_required");
const gateway = new OpenWA({
  origin: process.env.OPENWA_PRIVATE_ORIGIN,
  apiKey: process.env.OPENWA_API_KEY,
});
const pool = new pg.Pool({
  connectionString: process.env.WA_DATABASE_URL,
  max: 2,
});
const hash = (v) => createHash("sha256").update(v).digest("hex");
try {
  await pool.query(
    `INSERT INTO wa_tenants(id,origin,brand,token_digest,auth_enabled,notifications_enabled,paused)
 VALUES($1,'https://hubify.web.id','Gheverhan',$2,true,false,false)
 ON CONFLICT(id) DO NOTHING`,
    [id, hash(token)],
  );
  const {
    rows: [tenant],
  } = await pool.query("SELECT * FROM wa_tenants WHERE id=$1", [id]);
  if (
    tenant.origin !== "https://hubify.web.id" ||
    tenant.token_digest !== hash(token)
  )
    throw Error("registry_conflict");
  for (const [purpose, number] of [
    ["central", "+6282211700060"],
    ["seller", "+6281575652263"],
  ]) {
    const name = "btos-" + purpose + "-" + hash(purpose + id).slice(0, 24);
    const existing = await gateway.request("/sessions?name=" + name);
    if (!Array.isArray(existing) || existing.length > 1)
      throw Error("provider_registry_conflict");
    const session = existing[0] || (await gateway.create(name));
    if (session.name !== name || !/^[a-f0-9-]{36}$/.test(session.id))
      throw Error("provider_registry_conflict");
    await pool.query(
      `INSERT INTO wa_sessions(provider_id,tenant_id,purpose,expected_phone) VALUES($1,$2,$3,$4) ON CONFLICT(provider_id) DO NOTHING`,
      [session.id, purpose === "central" ? null : id, purpose, number],
    );
    const {
      rows: [stored],
    } = await pool.query("SELECT * FROM wa_sessions WHERE provider_id=$1", [
      session.id,
    ]);
    if (
      stored.expected_phone !== number ||
      stored.purpose !== purpose ||
      stored.tenant_id !== (purpose === "central" ? null : id)
    )
      throw Error("session_registry_conflict");
    const url = "http://relay:8092/api/platform/whatsapp/webhook";
    const hooks = await gateway.request(
      "/sessions/" + session.id + "/webhooks",
    );
    if (
      !Array.isArray(hooks) ||
      hooks.some((h) => h.url !== url) ||
      hooks.length > 1
    )
      throw Error("webhook_registry_conflict");
    if (!hooks.length)
      await gateway.request("/sessions/" + session.id + "/webhooks", {
        method: "POST",
        body: {
          url,
          events:
            purpose === "central"
              ? ["message.received"]
              : ["message.received", "message.ack", "message.failed"],
          secret: process.env.OPENWA_WEBHOOK_SECRET,
          retryCount: 1,
        },
      });
  }
  console.log("PILOT_REGISTRY_READY_NO_PAIRING_OR_SEND");
} finally {
  await pool.end();
}
