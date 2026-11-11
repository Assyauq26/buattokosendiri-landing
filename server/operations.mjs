import { randomUUID } from "node:crypto";
import { rotateMail } from "./mail-tenants.mjs";
import { storeReleases } from "./store-releases.mjs";

const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const states = ["queued", "running", "waiting_dns", "failed", "complete"];
const requestTypes = ["reinstall", "domain", "ownership", "close_store", "delete_account", "uninstall", "purge"];
const writes = ["retry", "reset", "release-ip", "review-request", "reject-request", "pause-wa", "resume-wa"];
const pageSize = 20;
const joins = `FROM stores s JOIN sellers u ON u.id=s.seller_id
  LEFT JOIN agents a ON a.store_id=s.id AND a.retired_at IS NULL
  LEFT JOIN jobs j ON j.store_id=s.id AND j.retired_at IS NULL
  LEFT JOIN mail_tenants m ON m.store_id=s.id`;
const fields = `s.id,s.name,s.domain,s.installation_generation,host(s.vps_ipv4) AS configured_ip,
  u.id AS owner_id,u.email AS owner_email,a.id AS installation_id,a.last_seen,a.revoked_at,
  host(a.public_ip) AS reported_ip,a.observation,a.observed_at,j.id AS job_id,j.state,j.stage,
  j.updated_at AS job_updated,j.release->>'version' AS target_version,
  CASE WHEN j.state='complete' THEN j.evidence->>'version' END AS completed_version,
  CASE WHEN j.state='complete' THEN j.evidence->>'source_sha' END AS completed_sha,
  j.evidence->>'error_code' AS error_code,m.enabled AS mail_enabled,m.brand AS sender,
  m.verified_at AS mail_verified,m.brand_synced_at`;

async function whatsappObservations(pool, id = null) {
  const { rows: [availability] } = await pool.query("SELECT to_regclass('platform_wa_sessions') IS NOT NULL AS available");
  if (!availability.available) return null;
  const [sessions, queue] = await Promise.all([
    pool.query(`SELECT purpose,state,connection_enabled,phone_suffix,paused,auth_enabled,notifications_enabled
      FROM platform_wa_sessions WHERE ($1::uuid IS NULL AND purpose='central') OR tenant_id=$1`, [id]),
    pool.query(`SELECT state,sum(total)::int AS total,max(last_update) AS last_update
      FROM platform_wa_queue WHERE ($1::uuid IS NULL OR tenant_id=$1) GROUP BY state ORDER BY state`, [id]),
  ]);
  return { session: sessions.rows[0] ?? null, queue: queue.rows };
}

export function agentObservation(data, reject) {
  const allowed = {
    agentVersion: /^\d{1,3}\.\d{1,3}\.\d{1,3}$/,
    appVersion: /^v?\d{1,3}\.\d{1,3}\.\d{1,3}$/,
    sourceSha: /^[a-f0-9]{40}$/,
    updater: /^(available|unavailable)$/,
    updaterInstallationId: /^[a-f0-9]{32}$/,
    updateState: /^(queued|preflight|downloading|preparing|backing_up|migrating|activating|verifying|rolling_back|recovery_required|succeeded|failed|rolled_back)$/,
    updateAt: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
    backupAt: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
    application: /^(ready|unavailable)$/,
  };
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    if (!Object.hasOwn(allowed, key) || typeof value !== "string" || !allowed[key].test(value))
      reject(422, "Data agent tidak valid.");
    if (key.endsWith("At") && !Number.isFinite(Date.parse(value)))
      reject(422, "Waktu observasi tidak valid.");
    result[key] = value;
  }
  return result;
}

function validReason(reason) {
  return typeof reason === "string" && reason.trim().length >= 8 && reason.length <= 240 &&
    !/[\x00-\x1f\x7f]/.test(reason);
}

export function createOperations({ pool, tx, rate, reject, secret, config }) {
  async function role(db, user, lock = false) {
    const { rows: [admin] } = await db.query(
      "SELECT role FROM platform_admins WHERE seller_id=$1 AND enabled" + (lock ? " FOR SHARE" : ""),
      [user.id]);
    if (!admin) reject(403, "Akses dashboard pusat tidak tersedia.");
    return admin.role;
  }
  return async (route, req, url, data, user, reply) => {
    if (route === "/ops/request" && req.method === "POST") {
      if (!requestTypes.includes(data.action) || !validReason(data.reason))
        reject(422, "Pilih jenis permintaan dan tulis alasan.");
      await rate("platform-request:" + user.id, 8, 3600);
      const result = await pool.query(`INSERT INTO platform_requests(id,store_id,actor_id,action,reason)
        SELECT $1,id,$2,$3,$4 FROM stores WHERE seller_id=$2
        ON CONFLICT (store_id,action) WHERE state='requested' DO NOTHING RETURNING id`,
        [randomUUID(), user.id, data.action, data.reason.trim()]);
      if (!result.rowCount) reject(409, "Toko belum terdaftar atau permintaan sejenis masih terbuka.");
      return reply(201, { id: result.rows[0].id });
    }
    if (route === "/ops/my-requests" && req.method === "GET") {
      const { rows } = await pool.query(`SELECT id,action,state,created_at,resolved_at FROM platform_requests
        WHERE actor_id=$1 ORDER BY created_at DESC LIMIT 30`, [user.id]);
      return reply(200, { requests: rows });
    }
    const adminRole = await role(pool, user);
    if (route === "/ops/releases" && req.method === "GET") {
      try {
        const signed = await storeReleases(config.storeCatalog, config.storeCatalogTrust);
        const catalog = JSON.parse(Buffer.from(signed.payload, "base64").toString("utf8"));
        return reply(200, { available: true, sequence: catalog.sequence, expiresAt: catalog.expiresAt,
          releases: catalog.releases.map(release => ({
            version: release.version, sha: release.sha, channel: release.channel,
            minimumUpdater: release.minimumUpdater, notes: release.notes,
          })) });
      } catch {
        return reply(200, { available: false, releases: [] });
      }
    }
    if (route === "/ops/tenants" && req.method === "GET") {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 120);
      const state = url.searchParams.get("state") || "";
      const version = url.searchParams.get("version") || "";
      const heartbeat = url.searchParams.get("heartbeat") || "";
      const page = Math.max(1, Math.min(10000, Number.parseInt(url.searchParams.get("page"), 10) || 1));
      if ((state && !states.includes(state)) || (version && !/^v?\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version)) ||
          !["", "recent", "late", "missing"].includes(heartbeat)) reject(422, "Filter tidak valid.");
      const where = `WHERE ($1='' OR strpos(lower(concat_ws(' ',s.name,s.domain,u.email,s.id,a.id)),lower($1))>0)
        AND ($2='' OR j.state=$2)
        AND ($3='' OR COALESCE(a.observation->>'appVersion',j.evidence->>'version')=$3)
        AND ($4='' OR ($4='missing' AND a.id IS NULL) OR
          ($4='late' AND a.revoked_at IS NULL AND a.last_seen<now()-interval '90 seconds') OR
          ($4='recent' AND a.revoked_at IS NULL AND a.last_seen>=now()-interval '90 seconds'))`;
      const [list, total, summary, versions, whatsapp] = await Promise.all([
        pool.query(`SELECT ${fields} ${joins} ${where} ORDER BY s.created_at DESC,s.id LIMIT $5 OFFSET $6`,
          [q, state, version, heartbeat, pageSize, (page - 1) * pageSize]),
        pool.query(`SELECT count(*)::int AS total ${joins} ${where}`, [q, state, version, heartbeat]),
        pool.query(`SELECT count(*)::int AS total,count(*) FILTER (WHERE j.state='complete')::int AS complete,
          count(*) FILTER (WHERE j.state='failed')::int AS failed,
          count(*) FILTER (WHERE a.revoked_at IS NULL AND a.last_seen<now()-interval '90 seconds')::int AS late,
          count(*) FILTER (WHERE a.observation->>'updateState' IN ('failed','recovery_required'))::int AS update_issues,
          (SELECT count(*)::int FROM platform_requests WHERE state='requested') AS requests ${joins}`),
        pool.query(`SELECT COALESCE(a.observation->>'appVersion',j.evidence->>'version') AS version,count(*)::int AS total
          ${joins} GROUP BY 1 ORDER BY 2 DESC,1 LIMIT 20`),
        whatsappObservations(pool).catch(() => null),
      ]);
      if (adminRole === "support")
        for (const row of list.rows) row.owner_email = row.owner_email.replace(/^(.).*@/, "$1•••@");
      return reply(200, { role: adminRole, rows: list.rows, total: total.rows[0].total,
        summary: summary.rows[0], versions: versions.rows, whatsapp, page, pageSize });
    }
    if (route === "/ops/tenant" && req.method === "GET") {
      const id = url.searchParams.get("id");
      if (!uuid(id)) reject(422, "ID tenant tidak valid.");
      const { rows: [store] } = await pool.query(`SELECT ${fields} ${joins} WHERE s.id=$1`, [id]);
      if (!store) reject(404, "Tenant tidak ditemukan.");
      if (adminRole === "support") store.owner_email = store.owner_email.replace(/^(.).*@/, "$1•••@");
      const [installs, events, audit, requests, whatsapp] = await Promise.all([
        pool.query(`SELECT * FROM (
          SELECT a.id,a.generation,a.last_seen,a.revoked_at,a.retired_at,j.state,j.stage
          FROM agents a LEFT JOIN jobs j ON j.agent_id=a.id WHERE a.store_id=$1
          UNION ALL
          SELECT id,generation,last_seen,revoked_at,retired_at,job_state,job_stage
          FROM installation_history WHERE store_id=$1
          ) history ORDER BY generation DESC LIMIT 30`, [id]),
        pool.query(`SELECT e.sequence,e.stage,e.state,e.created_at,e.evidence->>'error_code' AS error_code
          FROM job_events e WHERE e.job_id=$1 ORDER BY e.sequence DESC LIMIT 40`, [store.job_id]),
        pool.query(`SELECT id,actor_id,role,action,reason,installation_id,request_id,created_at
          FROM platform_audit WHERE store_id=$1 ORDER BY id DESC LIMIT 40`, [id]),
        pool.query(`SELECT id,action,reason,state,created_at,resolved_at FROM platform_requests
          WHERE store_id=$1 ORDER BY created_at DESC LIMIT 40`, [id]),
        whatsappObservations(pool, id).catch(() => null),
      ]);
      return reply(200, { role: adminRole, store, installations: installs.rows, events: events.rows,
        audit: audit.rows, requests: requests.rows, whatsapp });
    }
    if (route === "/ops/action" && req.method === "POST") {
      if (adminRole === "support") reject(403, "Hak akses hanya baca.");
      if (!writes.includes(data.action) || !uuid(data.storeId) || !uuid(data.requestId) || !validReason(data.reason))
        reject(422, "Lengkapi tindakan dan alasan.");
      if (Date.now() - new Date(user.authenticated_at).getTime() > 15 * 60_000 || !user.authenticated_at)
        reject(403, "Masuk ulang dengan OTP untuk menjalankan tindakan ini.");
      await rate("ops-write:" + user.id, 30, 3600);
      const result = await tx(async db => {
        const currentRole = await role(db, user, true);
        if (currentRole === "support" || (data.action === "reset" && currentRole !== "super_admin"))
          reject(403, "Izin untuk tindakan ini tidak tersedia.");
        const { rows: [store] } = await db.query("SELECT * FROM stores WHERE id=$1 FOR UPDATE", [data.storeId]);
        if (!store) reject(404, "Tenant tidak ditemukan.");
        const { rows: [prior] } = await db.query("SELECT actor_id,store_id,action FROM platform_audit WHERE request_id=$1", [data.requestId]);
        if (prior) {
          if (prior.actor_id !== user.id || prior.store_id !== store.id || prior.action !== data.action)
            reject(409, "Permintaan tidak cocok.");
          return { ok: true, replay: true };
        }
        const { rows: [agent] } = await db.query("SELECT id,revoked_at FROM agents WHERE store_id=$1 AND retired_at IS NULL FOR UPDATE", [store.id]);
        const { rows: [job] } = await db.query("SELECT id,state FROM jobs WHERE store_id=$1 AND retired_at IS NULL FOR UPDATE", [store.id]);
        if (data.action === "retry") {
          if (!agent || agent.revoked_at || !["failed", "waiting_dns"].includes(job?.state))
            reject(409, "Instalasi saat ini tidak dapat dicoba ulang.");
          await db.query("UPDATE jobs SET state='queued',updated_at=now() WHERE id=$1", [job.id]);
        } else if (data.action === "reset") {
          if (data.confirm !== store.id || data.installationId !== agent?.id || !agent || job?.state === "running")
            reject(409, "Konfirmasi instalasi tidak cocok atau instalasi masih berjalan.");
          await db.query(`INSERT INTO installation_history(id,store_id,generation,last_seen,revoked_at,job_state,job_stage,job_snapshot,events)
            SELECT a.id,a.store_id,a.generation,a.last_seen,now(),j.state,j.stage,
              CASE WHEN j.id IS NOT NULL THEN jsonb_build_object('id',j.id,'release',j.release,
                'sequence',j.sequence,'evidence',j.evidence,'updated_at',j.updated_at) END,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('sequence',e.sequence,'stage',e.stage,
                'state',e.state,'evidence',e.evidence,'created_at',e.created_at) ORDER BY e.sequence)
                FROM job_events e WHERE e.job_id=j.id),'[]'::jsonb)
            FROM agents a LEFT JOIN jobs j ON j.agent_id=a.id WHERE a.id=$1`, [agent.id]);
          await db.query("DELETE FROM job_events WHERE job_id IN (SELECT id FROM jobs WHERE agent_id=$1)", [agent.id]);
          await db.query("DELETE FROM jobs WHERE agent_id=$1", [agent.id]);
          await db.query("DELETE FROM pairings WHERE store_id=$1", [store.id]);
          await db.query("DELETE FROM agents WHERE id=$1", [agent.id]);
          await db.query("UPDATE stores SET installation_generation=installation_generation+1,admin_password_sealed=NULL WHERE id=$1", [store.id]);
          const { rows: [mail] } = await db.query("SELECT store_id FROM mail_tenants WHERE store_id=$1 FOR UPDATE", [store.id]);
          if (mail) {
            await rotateMail(db, mail, secret);
            await db.query("UPDATE mail_tenants SET brand_revision=-1 WHERE store_id=$1", [store.id]);
          }
        } else if (data.action === "release-ip") {
          if (data.confirm !== store.id) reject(422, "Konfirmasi ID tenant tidak cocok.");
          if (agent && job?.state !== "complete") reject(409, "Selesaikan atau reset registrasi instalasi sebelum melepas IP.");
          await db.query("UPDATE stores SET vps_ipv4=NULL WHERE id=$1", [store.id]);
        } else if (["pause-wa", "resume-wa"].includes(data.action)) {
          const observed = await whatsappObservations(db, store.id);
          if (!observed?.session) reject(409, "Sesi WhatsApp tenant belum terdaftar.");
          await db.query("SELECT platform_set_whatsapp_pause($1,$2)", [store.id, data.action === "pause-wa"]);
        } else {
          if (!uuid(data.targetRequestId)) reject(422, "ID permintaan tidak valid.");
          const { rowCount } = await db.query(`UPDATE platform_requests SET state=$3,resolved_at=now()
            WHERE id=$1 AND store_id=$2 AND state='requested'`, [data.targetRequestId, store.id,
            data.action === "review-request" ? "reviewed" : "rejected"]);
          if (!rowCount) reject(409, "Permintaan sudah diproses atau tidak ditemukan.");
        }
        await db.query(`INSERT INTO platform_audit(actor_id,role,store_id,installation_id,action,reason,request_id)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [user.id, currentRole, store.id, agent?.id ?? null, data.action, data.reason.trim(), data.requestId]);
        return { ok: true };
      });
      return reply(200, result);
    }
    reject(404, "Endpoint operasi tidak ditemukan.");
  };
}
