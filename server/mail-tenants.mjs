import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { installerPasswordVault } from "./store-setup.mjs";

export const mailDigest = value => createHash("sha256").update(value).digest("hex");
export function mailBrand(value) {
  return String(value ?? "").normalize("NFKC").replace(/[^\p{L}\p{M}\p{N} .&'()-]/gu, " ")
    .replace(/\s+/g, " ").trim().slice(0, 80).trim() || "Toko Online";
}
export function controlAuthorized(header, secret) {
  if (!/^[a-f0-9]{64}$/.test(secret || "")) return false;
  const supplied = /^Bearer ([a-f0-9]{64})$/.exec(header || "")?.[1];
  return Boolean(supplied && timingSafeEqual(Buffer.from(supplied), Buffer.from(secret)));
}
export function verifyMailReceipt(receipt, storeId, generation, secret) {
  if (!secret || !receipt || !Number.isSafeInteger(receipt.expires) || receipt.expires < Date.now() ||
      receipt.expires > Date.now() + 300_000 || !/^[a-f0-9]{64}$/.test(receipt.signature || '')) return false;
  const expected = createHmac('sha256', secret).update(`mail-ready-v1:${storeId}:${generation}:${receipt.expires}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(receipt.signature));
}

// Caller holds the stores row lock. Token encryption has a separate HKDF namespace
// from bootstrap passwords; a lost HTTP reply returns the SAME credential on retry.
export async function provisionMail(db, store, secret) {
  const vault = installerPasswordVault("mail-relay-v1:" + secret);
  let { rows: [tenant] } = await db.query("SELECT * FROM mail_tenants WHERE store_id=$1", [store.id]);
  if (!tenant) {
    // Free-plan admission gate. Serialize only first provisioning, not all sends.
    await db.query('SELECT pg_advisory_xact_lock(5924261106)');
    const { rows: [capacity] } = await db.query('SELECT count(*)::int AS total FROM mail_tenants');
    if (capacity.total >= 3) throw Object.assign(Error('Kapasitas canary email penuh; aktivasi umum belum dibuka.'), { status: 503 });
    const token = randomBytes(32).toString("hex");
    ({ rows: [tenant] } = await db.query(
      `INSERT INTO mail_tenants(store_id,origin,brand,seller_emails,token_digest,token_sealed)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [store.id, "https://" + store.domain, mailBrand(store.name), [store.admin_email],
        mailDigest(token), vault.seal(store.id, token)],
    ));
    await db.query("INSERT INTO mail_audit(store_id,event,generation) VALUES($1,'provisioned',1)", [store.id]);
  }
  if (!tenant.enabled || !tenant.token_sealed) return null;
  return { tenantId: store.id, origin: tenant.origin, brand: tenant.brand, generation: tenant.generation,
    token: vault.open(store.id, tenant.token_sealed) };
}

export async function lookupMailTenant(pool, tokenHash) {
  if (!/^[a-f0-9]{64}$/.test(tokenHash || "")) return null;
  const { rows: [row] } = await pool.query(
    `SELECT t.store_id,t.origin,t.brand,t.seller_emails,t.generation FROM mail_tenants t
     JOIN agents a ON a.store_id=t.store_id
     WHERE t.token_digest=$1 AND t.enabled AND a.revoked_at IS NULL`, [tokenHash],
  );
  return row ? { tenantId: row.store_id, origin: row.origin, brand: row.brand,
    sellerEmails: row.seller_emails, tokenHash, generation: row.generation } : null;
}

export async function rotateMail(db, tenant, secret) {
  const token = randomBytes(32).toString("hex");
  const sealed = installerPasswordVault("mail-relay-v1:" + secret).seal(tenant.store_id, token);
  await db.query(`UPDATE mail_tenants SET token_digest=$2,token_sealed=$3,generation=generation+1,
    verified_at=NULL,updated_at=now() WHERE store_id=$1`, [tenant.store_id, mailDigest(token), sealed]);
}
