import { sellerOtpMessage } from "./seller-otp-mail.mjs";
import { storeReleases } from "./store-releases.mjs";
import { controlAuthorized, lookupMailTenant, provisionMail, rotateMail, mailBrand, verifyMailReceipt } from "./mail-tenants.mjs";
import { createServer } from "node:http";
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { checkStoreDns, installerPasswordVault, isStoreIpv4, validAdminPassword } from "./store-setup.mjs";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const STAGES = [
  "preflight",
  "runtime",
  "dns",
  "https",
  "database",
  "application",
  "admin",
  "health",
  "complete",
];
export const CONSENT = "2026-11-05.M1";
const STAGE_PROGRESS = { preflight: 8, runtime: 20, dns: 34, https: 45, application: 55, database: 72, admin: 85, health: 94 };
const STORE_FIELDS = "id,name,domain,admin_email,host(vps_ipv4) AS vps_ipv4";
const DNS_MESSAGES = {
  ready: "DNS sudah mengarah ke IP VPS Anda.",
  pending: "Record A belum mengarah ke IP VPS di kedua resolver. Periksa pengaturan lalu coba lagi setelah DNS menyebar.",
  ipv6: "Domain masih punya record AAAA. Hapus record AAAA untuk hostname toko ini agar instalasi IPv4 bisa dilanjutkan.",
  unavailable: "DNS belum bisa diperiksa. Coba lagi sebentar.",
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("hex");
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const reject = (status, message) => {
  throw new ApiError(status, message);
};
function email(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(value)
  )
    reject(422, "Alamat email tidak valid.");
  return value.toLowerCase();
}
function domain(value) {
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)
  )
    reject(422, "Isi domain tanpa https, port, atau path.");
  if (
    ["buattokosendiri.web.id", "hubify.web.id"].some(
      (x) => value === x || value.endsWith("." + x),
    )
  )
    reject(422, "Gunakan domain toko milik Anda sendiri.");
  return value;
}
export function createApp({ pool, config, sendMail, checkDns = checkStoreDns }) {
  const passwordVault = installerPasswordVault(config.secret);
  const installerTestEmails = config.installerTestEmails || [];
  const canSignIn = (email) => !config.sellerPilotOnly || installerTestEmails.includes(email);
  const mac = (value) =>
    createHmac("sha256", config.secret).update(value).digest("hex");
  const cookieName = config.local ? "btos_session" : "__Host-btos_session";
  const cookie = (value, age = 43200) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${config.local ? "" : "; Secure"}`;
  async function tx(fn) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  async function rate(key, limit, seconds) {
    const {
      rows: [row],
    } = await pool.query(
      `INSERT INTO rate_limits(bucket,hits,expires_at) VALUES($1,1,now()+$2*interval '1 second')
   ON CONFLICT(bucket) DO UPDATE SET hits=CASE WHEN rate_limits.expires_at<now() THEN 1 ELSE rate_limits.hits+1 END,
   expires_at=CASE WHEN rate_limits.expires_at<now() THEN EXCLUDED.expires_at ELSE rate_limits.expires_at END RETURNING hits`,
      [mac(key), seconds],
    );
    if (row.hits > limit)
      reject(429, "Terlalu banyak permintaan. Coba lagi nanti.");
  }
  async function seller(req) {
    const raw =
      (req.headers.cookie || "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith(cookieName + "="))
        ?.slice(cookieName.length + 1) || "";
    const {
      rows: [user],
    } = await pool.query(
      "SELECT s.id,s.email FROM sellers s JOIN sessions t ON t.seller_id=s.id WHERE t.digest=$1 AND t.expires_at>now()",
      [digest(raw)],
    );
    if (!user) reject(401, "Silakan masuk menggunakan OTP email.");
    if (!canSignIn(user.email)) reject(403, "Pendaftaran terbatas untuk akun uji.");
    return user;
  }
  async function agent(req) {
    const raw = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!/^[a-f0-9]{64}$/.test(raw))
      reject(401, "Otorisasi agent tidak valid.");
    const {
      rows: [row],
    } = await pool.query(
      `UPDATE agents a SET last_seen=now() FROM stores s JOIN sellers u ON u.id=s.seller_id
       WHERE a.digest=$1 AND a.revoked_at IS NULL AND a.store_id=s.id
         AND (NOT $2::boolean OR u.email=ANY($3::text[])) RETURNING a.*`,
      [digest(raw), Boolean(config.sellerPilotOnly), installerTestEmails],
    );
    if (!row) reject(401, "Otorisasi agent tidak valid.");
    return row;
  }
  async function mail(to, code, id) {
    if (sendMail) return sendMail(to, code, id);
    if (!config.resendKey)
      reject(503, "OTP belum tersedia. Konfigurasi email menunggu operator.");
    // Explicit free-plan budget partition: platform 50/day + relay 50/day.
    const calendar = new Date().toISOString();
    try {
      await rate('provider-burst', 1, 1);
      await rate('provider-day:' + calendar.slice(0, 10), 50, 86400);
      await rate('provider-month:' + calendar.slice(0, 7), 1500, 32 * 86400);
    } catch (error) {
      console.warn('platform_mail.quota_exhausted');
      if (error.status === 429) reject(429, 'Batas pengiriman Email & OTP Beta tercapai. Email belum dikirim. Coba lagi setelah batas pengiriman pulih.');
      throw error;
    }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      redirect: "error",
      headers: {
        Authorization: `Bearer ${config.resendKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": id,
      },
      body: JSON.stringify(sellerOtpMessage(to, code)),
    });
    await response.body?.cancel();
    if (!response.ok)
      reject(503, "Email belum dapat dikirim. Coba lagi nanti.");
  }
  async function api(req, url, data, reply) {
    const route = url.pathname.replace("/api/platform", "");
    const peer = req.socket.remoteAddress.replace(/^::ffff:/, "");
    const forwarded = req.headers["x-forwarded-for"]?.split(",").at(-1).trim();
    const ip = peer === config.trustedProxyIp && isIP(forwarded || "") ? forwarded : peer;
    // Operator-only control plane; the public proxy must also block /internal/*.
    if (route === "/internal/mail-registry" && req.method === "POST") {
      if (!config.mailEnabled || !controlAuthorized(req.headers.authorization, config.mailControlSecret))
        reject(401, "Otorisasi tidak valid.");
      const tenant = await lookupMailTenant(pool, data.tokenHash);
      return reply(tenant ? 200 : 404, tenant || { error: "Tenant tidak tersedia." });
    }
    if (route === "/health" && req.method === "GET") {
      await pool.query("SELECT 1");
      return reply(200, {
        ok: true,
        otpConfigured: Boolean(config.resendKey),
        installerEnabled: config.releases.length > 0,
      });
    }
    if (route === "/store-releases" && req.method === "GET") {
      try {
        return reply(200, await storeReleases(config.storeCatalog, config.storeCatalogTrust));
      } catch {
        return reply(503, { error: "Daftar rilis terverifikasi belum tersedia." });
      }
    }
    if (
      req.method === "POST" &&
      !route.startsWith("/agent/") &&
      req.headers.origin !== config.origin
    )
      reject(403, "Origin tidak diizinkan.");
    if (req.method === "POST" && route === "/otp/request") {
      if (data.consent !== CONSENT)
        reject(422, "Setujui kebijakan privasi terbaru.");
      const address = email(data.email);
      if (!canSignIn(address)) reject(403, "Pendaftaran terbatas untuk akun uji.");
      await rate("otp-ip:" + ip, 12, 3600);
      await rate("otp-email:" + address, 5, 3600);
      await rate("otp-cooldown:" + address, 1, 60);
      const id = randomUUID(),
        code = String(randomInt(0, 1000000)).padStart(6, "0");
      await pool.query(
        "INSERT INTO otp_challenges(id,email,digest,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
        [id, address, mac(id + ":" + code)],
      );
      try {
        await mail(address, code, id);
      } catch (e) {
        await pool.query("DELETE FROM otp_challenges WHERE id=$1", [id]);
        throw e;
      }
      return reply(200, {
        challenge: id,
        message: "Periksa email Anda. Kode berlaku 10 menit.",
      });
    }
    if (req.method === "POST" && route === "/otp/verify") {
      await rate("verify:" + ip, 40, 600);
      if (
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.challenge || "") ||
        !/^\d{6}$/.test(data.code || "")
      )
        reject(422, "Kode tidak valid.");
      const raw = token();
      const verified = await tx(async (db) => {
        const {
          rows: [otp],
        } = await db.query(
          "SELECT * FROM otp_challenges WHERE id=$1 FOR UPDATE",
          [data.challenge],
        );
        if (
          !otp ||
          !canSignIn(otp.email) ||
          otp.consumed_at ||
          otp.attempts >= 5 ||
          otp.expires_at < new Date()
        )
          return false;
        await db.query(
          "UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1",
          [otp.id],
        );
        if (
          !timingSafeEqual(
            Buffer.from(otp.digest),
            Buffer.from(mac(otp.id + ":" + data.code)),
          )
        )
          return false;
        await db.query(
          "UPDATE otp_challenges SET consumed_at=now() WHERE email=$1 AND consumed_at IS NULL",
          [otp.email],
        );
        const {
          rows: [user],
        } = await db.query(
          "INSERT INTO sellers(id,email,consent_version) VALUES($1,$2,$3) ON CONFLICT(email) DO UPDATE SET consent_version=EXCLUDED.consent_version RETURNING id",
          [randomUUID(), otp.email, CONSENT],
        );
        await db.query(
          "INSERT INTO sessions(digest,seller_id,expires_at) VALUES($1,$2,now()+interval '12 hours')",
          [digest(raw), user.id],
        );
        return true;
      });
      if (!verified)
        reject(401, "Kode salah, sudah dipakai, atau kedaluwarsa.");
      return reply(200, { ok: true }, { "Set-Cookie": cookie(raw) });
    }
    if (route === "/agent/pair" && req.method === "POST") {
      await rate("pair:" + ip, 30, 600);
      if (
        !/^[a-f0-9]{64}$/.test(data.token || "") ||
        !/^[a-f0-9]{64}$/.test(data.credential || "")
      )
        reject(422, "Token pairing tidak valid.");
      const result = await tx(async (db) => {
        const tokenDigest = digest(data.token);
        const { rows: [candidate] } = await db.query(
          "SELECT store_id FROM pairings WHERE digest=$1", [tokenDigest],
        );
        if (!candidate) reject(410, "Token pairing kedaluwarsa.");
        // Match issuance lock order: store first, then token.
        const { rows: [store] } = await db.query(
          `SELECT s.id, s.domain, host(s.vps_ipv4) AS vps_ipv4, u.email FROM stores s JOIN sellers u ON u.id=s.seller_id
           WHERE s.id=$1 FOR UPDATE OF s`, [candidate.store_id],
        );
        if (!store || !canSignIn(store.email))
          reject(403, "Instalasi terbatas untuk akun uji yang diotorisasi.");
        const {
          rows: [pair],
        } = await db.query(
          "SELECT * FROM pairings WHERE digest=$1 FOR UPDATE",
          [tokenDigest],
        );
        if (!pair || pair.expires_at < new Date())
          reject(410, "Token pairing kedaluwarsa.");
        if (data.existingDomain !== undefined && data.existingDomain !== store.domain)
          reject(409, "VPS masih menjalankan toko dengan domain lain. Daftarkan domain toko yang sama untuk menyambungkannya kembali.");
        if (pair.consumed_at) {
          const {
            rows: [existing],
          } = await db.query(
            "SELECT id FROM agents WHERE id=$1 AND digest=$2 AND revoked_at IS NULL",
            [pair.agent_id, digest(data.credential)],
          );
          if (!existing) reject(409, "Token pairing telah dipakai.");
          return { agentId: existing.id, passwordFromWizard: Boolean(store.vps_ipv4) };
        }
        if (store.vps_ipv4 && data.protocol !== 2)
          reject(409, "Unduh ulang perintah bootstrap terbaru dari wizard.");
        if (store.vps_ipv4 && data.ipv4 !== store.vps_ipv4)
          reject(409, "IP VPS ini tidak sama dengan IP di Info Toko. Pairing belum dilakukan.");
        const {
          rows: [existing],
        } = await db.query("SELECT id FROM agents WHERE store_id=$1", [
          store.id,
        ]);
        if (existing)
          reject(
            409,
            "Toko sudah memiliki agent. Pemulihan memerlukan operator.",
          );
        const release = config.releases[0];
        if (!release) reject(503, "Rilis installer belum disetujui.");
        const id = randomUUID();
        await db.query(
          "INSERT INTO agents(id,store_id,digest) VALUES($1,$2,$3)",
          [id, store.id, digest(data.credential)],
        );
        await db.query(
          "UPDATE pairings SET consumed_at=now(),agent_id=$1 WHERE digest=$2",
          [id, digest(data.token)],
        );
        await db.query(
          "INSERT INTO jobs(id,store_id,agent_id,release,evidence) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), store.id, id, release, data.existingDomain === store.domain ? { reattachRequested: true } : {}],
        );
        return { agentId: id, passwordFromWizard: Boolean(store.vps_ipv4) };
      });
      return reply(200, result);
    }
    if (route.startsWith("/agent/")) {
      const a = await agent(req);
      if (route === "/agent/mail" && req.method === "POST") {
        if (!config.mailEnabled) reject(503, "Aktivasi email belum tersedia.");
        await rate("agent-mail:" + a.id, 120, 3600);
        const result = await tx(async db => {
          const { rows: [store] } = await db.query("SELECT * FROM stores WHERE id=$1 FOR UPDATE", [a.store_id]);
          // Provision only canonical platform identity, never caller-supplied fields.
          const { rows: [active] } = await db.query("SELECT id FROM agents WHERE id=$1 AND revoked_at IS NULL", [a.id]);
          if (!active) reject(401, "Agent tidak aktif.");
          return provisionMail(db, store, config.secret);
        });
        if (!result) reject(403, "Email toko dinonaktifkan.");
        return reply(200, result);
      }
      if (route === "/agent/mail-ack" && req.method === "POST") {
        if (!verifyMailReceipt(data.receipt, a.store_id, data.generation, config.mailControlSecret))
          reject(422, "Bukti kesiapan relay tidak valid.");
        const result = await pool.query(`UPDATE mail_tenants SET verified_at=now()
          WHERE store_id=$1 AND generation=$2 AND enabled RETURNING store_id`, [a.store_id, data.generation]);
        if (!result.rowCount) reject(409, "Konfigurasi email telah berubah.");
        return reply(200, { ok: true });
      }
      if (route === "/agent/job" && req.method === "GET") {
        const {
          rows: [job],
        } = await pool.query(
          `UPDATE jobs SET lease_until=now()+interval '90 seconds' WHERE agent_id=$1 RETURNING *`,
          [a.id],
        );
        const {
          rows: [store],
        } = await pool.query(
          `SELECT ${STORE_FIELDS} FROM stores WHERE id=$1`,
          [a.store_id],
        );
        return reply(200, { job, store: store ? { ...store, mailRequired: config.mailEnabled } : store });
      }
      if (route === "/agent/admin-password" && req.method === "GET") {
        const { rows: [store] } = await pool.query(
          `SELECT s.id,s.admin_password_sealed FROM stores s JOIN jobs j ON j.store_id=s.id
           JOIN agents a ON a.id=j.agent_id WHERE a.id=$1 AND a.revoked_at IS NULL
           AND j.state='running' AND j.stage IN ('https','application','database','admin','health')`, [a.id],
        );
        if (!store?.admin_password_sealed) reject(409, "Password instalasi tidak tersedia.");
        return reply(200, { password: passwordVault.open(store.id, store.admin_password_sealed) });
      }
      if (route === "/agent/event" && req.method === "POST") {
        if (
          !STAGES.includes(data.stage) ||
          !["running", "waiting_dns", "failed", "complete"].includes(
            data.state,
          ) ||
          !Number.isSafeInteger(data.sequence)
        )
          reject(422, "Event tidak valid.");
        const e = data.evidence || {};
        // Accept only non-secret operational evidence. No arbitrary logs or command output.
        const evidence = {};
        for (const key of [
          "https",
          "application",
          "installation",
          "version",
          "source_sha",
          "ipv4",
          "error_code",
        ])
          if (
            typeof e[key] === "string" &&
            /^[a-zA-Z0-9_.:-]{1,80}$/.test(e[key])
          )
            evidence[key] = e[key];
        const result = await tx(async (db) => {
          const {
            rows: [job],
          } = await db.query(
            "SELECT * FROM jobs WHERE agent_id=$1 FOR UPDATE",
            [a.id],
          );
          if (!job || data.jobId !== job.id)
            reject(404, "Job tidak ditemukan.");
          if (data.sequence <= job.sequence)
            return { ok: true, sequence: job.sequence };
          if (job.state === "complete" || data.sequence !== job.sequence + 1)
            reject(409, "Urutan event tidak valid.");
          const reattached = evidence.installation === "reattached";
          const versionVerified = reattached && job.evidence.reattachRequested === true
            ? /^[a-f0-9]{40}$/.test(evidence.source_sha || "") && /^v\d+\.\d+\.\d+$/.test(evidence.version || "")
            : evidence.source_sha === job.release.sha && evidence.version === job.release.version;
          if (data.state === "complete" && config.mailEnabled) {
            const { rowCount } = await db.query(`SELECT store_id FROM mail_tenants
              WHERE store_id=$1 AND enabled AND verified_at IS NOT NULL`, [a.store_id]);
            if (!rowCount) reject(409, "Aktivasi Email OTP belum terverifikasi.");
          }
          if (
            data.state === "complete" &&
            (data.stage !== "complete" ||
              evidence.https !== "PUBLIC_CERTIFICATE_VALID" ||
              evidence.application !== "healthy" ||
              !versionVerified)
          )
            reject(422, "Bukti penyelesaian belum lengkap.");
          await db.query(
            "INSERT INTO job_events(job_id,sequence,stage,state,evidence) VALUES($1,$2,$3,$4,$5)",
            [job.id, data.sequence, data.stage, data.state, evidence],
          );
          await db.query(
            "UPDATE jobs SET sequence=$2,stage=$3,state=$4,evidence=evidence || $5::jsonb,updated_at=now(),lease_until=now()+interval '90 seconds' WHERE id=$1",
            [job.id, data.sequence, data.stage, data.state, evidence],
          );
          if (data.state === "complete")
            await db.query("UPDATE stores SET admin_password_sealed=NULL WHERE id=$1", [job.store_id]);
          return { ok: true, sequence: data.sequence };
        });
        return reply(200, result);
      }
      reject(404, "Endpoint tidak ditemukan.");
    }
    const user = await seller(req);
    if (route === "/store/mail" && req.method === "GET") {
      const { rows: [mail] } = await pool.query(`SELECT t.origin,t.brand,t.seller_emails,t.generation,t.enabled,t.verified_at
        FROM mail_tenants t JOIN stores s ON s.id=t.store_id WHERE s.seller_id=$1`, [user.id]);
      return reply(200, { mail: mail || null });
    }
    if (route === "/store/mail" && req.method === "POST") {
      await rate("mail-management:" + user.id, 20, 3600);
      if (!config.mailEnabled) reject(503, "Aktivasi email belum tersedia.");
      if (!["rotate", "disable", "enable", "identity", "administrators"].includes(data.action) || !Number.isSafeInteger(data.generation))
        reject(422, "Permintaan tidak valid.");
      const result = await tx(async db => {
        const { rows: [store] } = await db.query("SELECT * FROM stores WHERE seller_id=$1 FOR UPDATE", [user.id]);
        if (!store) reject(404, "Toko tidak ditemukan.");
        const { rows: [tenant] } = await db.query("SELECT * FROM mail_tenants WHERE store_id=$1 FOR UPDATE", [store.id]);
        // Compare-and-swap makes repeat/concurrent management requests harmless.
        if (!tenant || tenant.generation !== data.generation) reject(409, "Muat ulang status email terbaru.");
        if (data.action === 'administrators') {
          if (!Array.isArray(data.emails) || !data.emails.length || data.emails.length > 5)
            reject(422, 'Isi maksimal lima email administrator.');
          const emails = [...new Set(data.emails.map(email))];
          if (!emails.includes(user.email)) reject(422, 'Pemilik toko harus tetap terdaftar.');
          const { rowCount } = await db.query('SELECT id FROM sellers WHERE email=ANY($1::text[])', [emails]);
          if (rowCount !== emails.length) reject(422, 'Setiap administrator harus memverifikasi emailnya di platform terlebih dahulu.');
          await db.query('UPDATE mail_tenants SET seller_emails=$2 WHERE store_id=$1', [store.id, emails]);
        }
        if (data.action === "identity") {
          const d = domain(data.domain);
          if (typeof data.brand !== "string" || !data.brand.trim() || data.brand.length > 100)
            reject(422, "Nama toko tidak valid.");
          // Owner's freshly authenticated platform session controls identity. Agent
          // credentials alone never authorize a brand, origin or administrator change.
          if (email(data.adminEmail) !== user.email)
            reject(422, "Administrator email harus akun platform yang telah diverifikasi OTP.");
          if (await checkDns(d, store.vps_ipv4) !== "ready") reject(422, "Verifikasi DNS belum berhasil.");
          await db.query(`UPDATE mail_tenants SET origin=$2,brand=$3,seller_emails=$4 WHERE store_id=$1`,
            [store.id, "https://" + d, mailBrand(data.brand), [...new Set([...tenant.seller_emails, user.email])]]);
          await db.query('UPDATE stores SET domain=$2,name=$3,admin_email=$4 WHERE id=$1',
            [store.id, d, data.brand.trim(), user.email]);
        }
        await rotateMail(db, tenant, config.secret);
        if (["disable", "enable"].includes(data.action))
          await db.query("UPDATE mail_tenants SET enabled=$2 WHERE store_id=$1", [store.id, data.action === "enable"]);
        await db.query("INSERT INTO mail_audit(store_id,event,generation) VALUES($1,$2,$3)",
          [store.id, data.action, tenant.generation + 1]);
        return { ok: true, generation: tenant.generation + 1 };
      });
      return reply(200, result);
    }
    if (route === "/session" && req.method === "GET")
      return reply(200, { seller: user, consent: CONSENT });
    if (route === "/logout" && req.method === "POST") {
      const raw =
        (req.headers.cookie || "")
          .split(";")
          .map((x) => x.trim())
          .find((x) => x.startsWith(cookieName + "="))
          ?.slice(cookieName.length + 1) || "";
      await pool.query("DELETE FROM sessions WHERE digest=$1", [digest(raw)]);
      return reply(200, { ok: true }, { "Set-Cookie": cookie("", 0) });
    }
    if (route === "/store/dns" && req.method === "POST") {
      const d = domain(data.domain);
      if (!isStoreIpv4(data.vpsIpv4)) reject(422, "Masukkan IPv4 publik VPS toko yang valid.");
      await rate("store-dns:" + user.id, 30, 600);
      const status = await checkDns(d, data.vpsIpv4);
      return reply(200, { ready: status === "ready", message: DNS_MESSAGES[status] });
    }
    if (route === "/store" && req.method === "POST") {
      if (
        typeof data.name !== "string" ||
        data.name.trim() !== data.name ||
        !data.name.length ||
        data.name.length > 100 ||
        /[\x00-\x1f\x7f]/.test(data.name)
      )
        reject(422, "Nama toko harus 1–100 karakter.");
      const d = domain(data.domain),
        admin = email(data.adminEmail);
      if (config.mailEnabled && admin !== user.email)
        reject(422, "Gunakan email platform yang sudah diverifikasi untuk administrator toko.");
      if (!isStoreIpv4(data.vpsIpv4)) reject(422, "Masukkan IPv4 publik VPS toko yang valid.");
      if (!validAdminPassword(data.adminPassword, data.adminPasswordConfirmation))
        reject(422, "Password harus cocok, minimal 12 karakter, maksimal 72 byte, dan memakai tiga jenis karakter.");
      await rate("store-dns:" + user.id, 30, 600);
      const dnsStatus = await checkDns(d, data.vpsIpv4);
      if (dnsStatus !== "ready") reject(422, DNS_MESSAGES[dnsStatus]);
      const row = await tx(async (db) => {
        await db.query("SELECT id FROM sellers WHERE id=$1 FOR UPDATE", [
          user.id,
        ]);
        const {
          rows: [existing],
        } = await db.query(
          "SELECT id FROM stores WHERE seller_id=$1 FOR UPDATE",
          [user.id],
        );
        if (existing) {
          const { rowCount } = await db.query(
            "SELECT id FROM agents WHERE store_id=$1",
            [existing.id],
          );
          if (rowCount)
            reject(409, "Informasi toko dikunci setelah VPS dipasangkan.");
        }
        const storeId = existing?.id || randomUUID();
        const {
          rows: [store],
        } = await db.query(
          `INSERT INTO stores(id,seller_id,name,domain,admin_email,vps_ipv4,admin_password_sealed) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(seller_id) DO UPDATE SET name=$3,domain=$4,admin_email=$5,vps_ipv4=$6,admin_password_sealed=$7 RETURNING ${STORE_FIELDS}`,
          [storeId, user.id, data.name, d, admin, data.vpsIpv4, passwordVault.seal(storeId, data.adminPassword)],
        );
        await db.query("DELETE FROM pairings WHERE store_id=$1 AND consumed_at IS NULL", [store.id]);
        return store;
      });
      return reply(200, { store: row });
    }
    if (route === "/store" && req.method === "GET") {
      const {
        rows: [store],
      } = await pool.query(`SELECT ${STORE_FIELDS} FROM stores WHERE seller_id=$1`, [
        user.id,
      ]);
      if (!store) return reply(200, { store: null });
      const {
        rows: [job],
      } = await pool.query(
        "SELECT id,state,stage,sequence,evidence,updated_at,lease_until,release FROM jobs WHERE store_id=$1",
        [store.id],
      );
      const {
        rows: [a],
      } = await pool.query(
        "SELECT id,last_seen,revoked_at FROM agents WHERE store_id=$1",
        [store.id],
      );
      if (job) {
        const { rows } = await pool.query(
          "SELECT DISTINCT stage FROM job_events WHERE job_id=$1 AND state IN ('running','waiting_dns')", [job.id],
        );
        job.progress = job.state === "complete" ? 100 :
          Math.max(0, ...rows.map(({ stage }) => STAGE_PROGRESS[stage] || 0));
      }
      return reply(200, { store, job: job || null, agent: a || null });
    }
    if (route === "/pairing" && req.method === "POST") {
      await rate("pairing-seller:" + user.id, 10, 3600);
      if (!config.releases.length)
        reject(
          503,
          "Installer belum dibuka: operator perlu menetapkan rilis yang disetujui.",
        );
      const raw = token();
      await tx(async (db) => {
        const {
          rows: [store],
        } = await db.query(
          "SELECT * FROM stores WHERE seller_id=$1 FOR UPDATE",
          [user.id],
        );
        if (!store) reject(422, "Lengkapi informasi toko.");
        if (!store.vps_ipv4 || !store.admin_password_sealed)
          reject(422, "Lengkapi DNS dan password dashboard di Info Toko.");
        if (
          (
            await db.query("SELECT id FROM agents WHERE store_id=$1", [
              store.id,
            ])
          ).rowCount
        )
          reject(409, "VPS sudah dipasangkan.");
        const dnsStatus = await checkDns(store.domain, store.vps_ipv4);
        if (dnsStatus !== "ready") reject(422, DNS_MESSAGES[dnsStatus]);
        await db.query(
          "DELETE FROM pairings WHERE store_id=$1 AND consumed_at IS NULL",
          [store.id],
        );
        await db.query(
          "INSERT INTO pairings(digest,store_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')",
          [digest(raw), store.id],
        );
      });
      return reply(200, {
        token: raw,
        expiresIn: 900,
        command: `(bootstrap=$(mktemp) && trap 'rm -f -- "$bootstrap"' EXIT && curl --proto '=https' --tlsv1.2 -fsS ${config.origin}/bootstrap.sh -o "$bootstrap" && sudo bash "$bootstrap")`,
        instruction:
          "Saat diminta, tempel token pairing di terminal VPS. Token tidak dimasukkan dalam perintah atau riwayat shell.",
      });
    }
    if (route === "/revoke" && req.method === "POST") {
      await tx(async (db) => {
        await db.query("SELECT id FROM stores WHERE seller_id=$1 FOR UPDATE", [user.id]);
        await db.query(`UPDATE mail_tenants SET enabled=false,token_sealed=NULL,verified_at=NULL,
          generation=generation+1 WHERE store_id IN (SELECT id FROM stores WHERE seller_id=$1)`, [user.id]);
        await db.query(`INSERT INTO mail_audit(store_id,event,generation)
          SELECT store_id,'agent-revoked',generation FROM mail_tenants
          WHERE store_id IN (SELECT id FROM stores WHERE seller_id=$1)`, [user.id]);
        const { rows } = await db.query(
          "UPDATE agents SET revoked_at=now() FROM stores WHERE agents.store_id=stores.id AND stores.seller_id=$1 RETURNING store_id", [user.id],
        );
        if (rows.length) await db.query("UPDATE stores SET admin_password_sealed=NULL WHERE id=$1", [rows[0].store_id]);
      });
      return reply(200, { ok: true });
    }
    if (route === "/retry" && req.method === "POST") {
      await pool.query(
        `UPDATE jobs SET state='queued',updated_at=now() WHERE store_id IN (SELECT id FROM stores WHERE seller_id=$1) AND state IN ('failed','waiting_dns')`,
        [user.id],
      );
      return reply(200, { ok: true });
    }
    reject(404, "Endpoint tidak ditemukan.");
  }
  const server = createServer(async (req, res) => {
    const reply = (status, value, headers = {}) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...headers,
      });
      res.end(JSON.stringify(value));
    };
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
    try {
      if (!["GET", "HEAD", "POST"].includes(req.method))
        reject(405, "Metode tidak didukung.");
      const url = new URL(req.url, config.origin);
      if (url.pathname.startsWith("/api/platform/")) {
        let data = {};
        if (req.method === "POST") {
          if (
            (req.headers["content-type"] || "").split(";")[0] !==
            "application/json"
          )
            reject(415, "Gunakan JSON.");
          let bytes = 0,
            chunks = [];
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > 16384) reject(413, "Payload terlalu besar.");
            chunks.push(chunk);
          }
          try {
            data = JSON.parse(Buffer.concat(chunks).toString());
          } catch {
            reject(400, "JSON tidak valid.");
          }
          if (!data || Array.isArray(data) || typeof data !== "object")
            reject(400, "JSON tidak valid.");
        }
        return await api(req, url, data, reply);
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        reject(405, "Metode tidak didukung.");
      const decoded = decodeURIComponent(url.pathname);
      if (decoded === "/bootstrap.sh") {
        if (!config.releases.length)
          reject(503, "Rilis installer belum disetujui.");
        const agent = await readFile(path.join(ROOT, "agent/agent.py"));
        const script = (
          await readFile(path.join(ROOT, "agent/bootstrap.sh"), "utf8")
        )
          .replaceAll("__PLATFORM_ORIGIN__", config.origin)
          .replaceAll("__AGENT_SHA256__", digest(agent));
        res.writeHead(200, {
          "Content-Type": "text/x-shellscript",
          "Cache-Control": "no-store",
        });
        return res.end(script);
      }
      if (decoded === "/agent.py") {
        if (!config.releases.length)
          reject(503, "Rilis installer belum disetujui.");
        res.writeHead(200, {
          "Content-Type": "text/plain",
          "Cache-Control": "no-store",
        });
        return res.end(await readFile(path.join(ROOT, "agent/agent.py")));
      }
      if (
        !/^\/(?:$|index\.html$|404\.html$|portal-config\.json$|assets\/|pendaftaran(?:\/|$)|masuk(?:\/|$)|daftar(?:\/|$)|panduan-instalasi(?:\/|$)|persiapan-toko(?:\/|$)|kebijakan-privasi(?:\/|$))/.test(
          decoded,
        ) ||
        decoded.split("/").some((p) => p === ".." || p.startsWith("."))
      )
        reject(404, "Tidak ditemukan.");
      let file = path.resolve(ROOT, decoded === "/" ? "index.html" : "." + decoded);
      if (!file.startsWith(ROOT)) reject(404, "Tidak ditemukan.");
      if ((await stat(file)).isDirectory())
        file = path.join(file, "index.html");
      const mime = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".webp": "image/webp",
        ".woff2": "font/woff2",
        ".pdf": "application/pdf",
      }[path.extname(file)];
      if (!mime) reject(404, "Tidak ditemukan.");
      if (file === path.join(ROOT, "panduan-instalasi", "index.html")) {
        const policy = res.getHeader("Content-Security-Policy");
        res.setHeader("Content-Security-Policy", `${policy}; frame-src https://www.youtube-nocookie.com`);
      }
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : await readFile(file));
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status =
        e.status ||
        (e.code === "ENOENT" ? 404 : e.code === "23505" ? 409 : 500);
      reply(status, {
        error: e.status
          ? e.message
          : status === 409
            ? "Domain atau data sudah digunakan."
            : status === 404
              ? "Tidak ditemukan."
              : "Layanan belum tersedia. Coba lagi nanti.",
      });
      if (status === 500)
        console.error("platform_request_failed", e.code || e.name); // never log payloads, tokens or DB errors
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 15000;
  return server;
}
