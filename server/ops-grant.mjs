import pg from "pg";
import { randomUUID } from "node:crypto";

const [email, role] = process.argv.slice(2);
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !["super_admin", "operator", "support", "revoke"].includes(role))
  throw Error("Usage: node server/ops-grant.mjs EMAIL super_admin|operator|support|revoke");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const db = await pool.connect();
try {
  await db.query("BEGIN");
  await db.query("SELECT pg_advisory_xact_lock(5924261106)");
  const { rows: [seller] } = await db.query("SELECT id FROM sellers WHERE email=$1", [email.toLowerCase()]);
  if (!seller) throw Error("Verify this email through platform OTP before granting a role");
  const { rows: [prior] } = await db.query("SELECT role,enabled FROM platform_admins WHERE seller_id=$1 FOR UPDATE", [seller.id]);
  if (prior?.role === "super_admin" && prior.enabled && role !== "super_admin") {
    const { rows: [remaining] } = await db.query("SELECT count(*)::int AS n FROM platform_admins WHERE role='super_admin' AND enabled AND seller_id<>$1", [seller.id]);
    if (!remaining.n) throw Error("The last Super Admin must be replaced before revocation");
  }
  if (role === "revoke")
    await db.query("UPDATE platform_admins SET enabled=false WHERE seller_id=$1", [seller.id]);
  else
    await db.query(`INSERT INTO platform_admins(seller_id,role) VALUES($1,$2)
      ON CONFLICT(seller_id) DO UPDATE SET role=$2,enabled=true`, [seller.id, role]);
  await db.query(`INSERT INTO platform_audit(actor_id,role,target_seller_id,action,reason,request_id)
    VALUES('00000000-0000-0000-0000-000000000000','operator-console',$1,'role-change',$2,$3)`,
    [seller.id, role, randomUUID()]);
  await db.query("COMMIT");
  console.log("Operator role updated and audited.");
} catch (error) {
  await db.query("ROLLBACK");
  throw error;
} finally {
  db.release();
  await pool.end();
}
