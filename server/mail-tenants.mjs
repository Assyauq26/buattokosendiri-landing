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
    // Admission is dynamic. The caller's store row lock and unique constraints
    // preserve idempotency; provider capacity is enforced when sending mail.
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

export async function lookupMailTenant(pool, tokenHash, allowedIds = []) {
  if (!/^[a-f0-9]{64}$/.test(tokenHash || "")) return null;
  const { rows: [row] } = await pool.query(
    `SELECT t.store_id,t.origin,t.brand,t.seller_emails,t.generation FROM mail_tenants t
     JOIN agents a ON a.store_id=t.store_id
     WHERE t.token_digest=$1 AND t.enabled AND a.revoked_at IS NULL`, [tokenHash],
  );
  return row ? { tenantId: row.store_id, origin: row.origin, brand: row.brand,
    sellerEmails: row.seller_emails, tokenHash, generation: row.generation, brandSync: allowedIds.includes(row.store_id) } : null;
}

export async function syncMailBrand(db, data, allowedIds = []) {
  if (!/^[a-f0-9]{64}$/.test(data.tokenHash || "") ||
      typeof data.name !== "string" || !data.name.trim() || data.name.length > 100 ||
      /[\x00-\x1f\x7f]/.test(data.name) ||
      !Number.isInteger(data.revision) || data.revision < 0 || data.revision > 2147483647)
    return { status: 422 };
  const { rows: [store] } = await db.query(`SELECT s.id FROM stores s JOIN mail_tenants t ON t.store_id=s.id
    WHERE t.token_digest=$1 AND t.origin=$2 FOR UPDATE OF s`, [data.tokenHash, data.origin]);
  if (!store) return { status: 401 };
  if (!allowedIds.includes(store.id)) return { status: 403 };
  const { rows: [tenant] } = await db.query(`SELECT t.brand,t.brand_revision,t.generation,s.name FROM mail_tenants t
    JOIN stores s ON s.id=t.store_id JOIN agents a ON a.store_id=s.id AND a.revoked_at IS NULL
    WHERE t.store_id=$1 AND t.token_digest=$2 AND t.origin=$3 AND t.enabled FOR UPDATE OF t`,
    [store.id, data.tokenHash, data.origin]);
  if (!tenant) return { status: 401 };
  const name = data.name.trim();
  if (data.revision < tenant.brand_revision ||
      (data.revision === tenant.brand_revision && name !== tenant.name)) return { status: 409 };
  if (data.revision > tenant.brand_revision) {
    const brand = mailBrand(name);
    await db.query(`UPDATE mail_tenants SET brand=$2,brand_revision=$3,brand_synced_at=now() WHERE store_id=$1`,
      [store.id, brand, data.revision]);
    await db.query("UPDATE stores SET name=$2 WHERE id=$1", [store.id, name]);
    await db.query("INSERT INTO mail_audit(store_id,event,generation) VALUES($1,'brand-synced',$2)",
      [store.id, tenant.generation]);
    return { status: 200, brand };
  }
  return { status: 200, brand: tenant.brand };
}

export async function rotateMail(db, tenant, secret) {
  const token = randomBytes(32).toString("hex");
  const sealed = installerPasswordVault("mail-relay-v1:" + secret).seal(tenant.store_id, token);
  await db.query(`UPDATE mail_tenants SET token_digest=$2,token_sealed=$3,generation=generation+1,
    verified_at=NULL,updated_at=now() WHERE store_id=$1`, [tenant.store_id, mailDigest(token), sealed]);
}
