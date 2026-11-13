import { randomBytes, createHash, randomUUID } from "node:crypto";
export const hash = value => createHash("sha256").update(value).digest("hex");
export async function session(pool, email, role, recent = true) {
  const id = randomUUID();
  const raw = randomBytes(32).toString("hex");
  await pool.query("INSERT INTO sellers(id,email,consent_version) VALUES($1,$2,'local-test')", [id, email]);
  await pool.query(`INSERT INTO sessions(digest,seller_id,expires_at,authenticated_at)
    VALUES($1,$2,now()+interval '1 hour',now()-$3*interval '1 minute')`, [hash(raw), id, recent ? 0 : 25]);
  if (role) await pool.query("INSERT INTO platform_admins(seller_id,role) VALUES($1,$2)", [id, role]);
  return { id, cookie: "btos_session=" + raw };
}
