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
export function createApp({ pool, config, sendMail }) {
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
       WHERE a.digest=$1 AND a.revoked_at IS NULL AND a.store_id=s.id AND u.email=ANY($2::text[]) RETURNING a.*`,
      [digest(raw), installerTestEmails],
    );
    if (!row) reject(401, "Otorisasi agent tidak valid.");
    return row;
  }
  async function mail(to, code, id) {
    if (sendMail) return sendMail(to, code, id);
    if (!config.resendKey || !config.resendFrom)
      reject(503, "OTP belum tersedia. Konfigurasi email menunggu operator.");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${config.resendKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": id,
      },
      body: JSON.stringify({
        from: config.resendFrom,
        to: [to],
        subject: "Kode masuk Buat Toko Online Sendiri",
        text: `Kode masuk Anda: ${code}\nBerlaku 10 menit. Jangan bagikan kode ini. Abaikan jika Anda tidak meminta kode.`,
      }),
    });
    if (!response.ok)
      reject(503, "Email belum dapat dikirim. Coba lagi nanti.");
  }
  async function api(req, url, data, reply) {
    const route = url.pathname.replace("/api/platform", "");
    const peer = req.socket.remoteAddress.replace(/^::ffff:/, "");
    const forwarded = req.headers["x-forwarded-for"]?.split(",").at(-1).trim();
    const ip = peer === config.trustedProxyIp && isIP(forwarded || "") ? forwarded : peer;
    if (route === "/health" && req.method === "GET") {
      await pool.query("SELECT 1");
      return reply(200, {
        ok: true,
        otpConfigured: !!(config.resendKey && config.resendFrom),
        installerEnabled: config.releases.length > 0,
      });
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
          `SELECT s.id, u.email FROM stores s JOIN sellers u ON u.id=s.seller_id
           WHERE s.id=$1 FOR UPDATE OF s`, [candidate.store_id],
        );
        if (!store || !installerTestEmails.includes(store.email))
          reject(403, "Instalasi terbatas untuk akun uji yang diotorisasi.");
        const {
          rows: [pair],
        } = await db.query(
          "SELECT * FROM pairings WHERE digest=$1 FOR UPDATE",
          [tokenDigest],
        );
        if (!pair || pair.expires_at < new Date())
          reject(410, "Token pairing kedaluwarsa.");
        if (pair.consumed_at) {
          const {
            rows: [existing],
          } = await db.query(
            "SELECT id FROM agents WHERE id=$1 AND digest=$2 AND revoked_at IS NULL",
            [pair.agent_id, digest(data.credential)],
          );
          if (!existing) reject(409, "Token pairing telah dipakai.");
          return { agentId: existing.id };
        }
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
          "INSERT INTO jobs(id,store_id,agent_id,release) VALUES($1,$2,$3,$4)",
          [randomUUID(), store.id, id, release],
        );
        return { agentId: id };
      });
      return reply(200, result);
    }
    if (route.startsWith("/agent/")) {
      const a = await agent(req);
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
          "SELECT name,domain,admin_email FROM stores WHERE id=$1",
          [a.store_id],
        );
        return reply(200, { job, store });
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
          if (
            data.state === "complete" &&
            (data.stage !== "complete" ||
              evidence.https !== "PUBLIC_CERTIFICATE_VALID" ||
              evidence.application !== "healthy" ||
              evidence.source_sha !== job.release.sha ||
              evidence.version !== job.release.version)
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
          return { ok: true, sequence: data.sequence };
        });
        return reply(200, result);
      }
      reject(404, "Endpoint tidak ditemukan.");
    }
    const user = await seller(req);
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
        const {
          rows: [store],
        } = await db.query(
          `INSERT INTO stores(id,seller_id,name,domain,admin_email) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(seller_id) DO UPDATE SET name=$3,domain=$4,admin_email=$5 RETURNING *`,
          [randomUUID(), user.id, data.name, d, admin],
        );
        return store;
      });
      return reply(200, { store: row });
    }
    if (route === "/store" && req.method === "GET") {
      const {
        rows: [store],
      } = await pool.query("SELECT * FROM stores WHERE seller_id=$1", [
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
      return reply(200, { store, job: job || null, agent: a || null });
    }
    if (route === "/pairing" && req.method === "POST") {
      await rate("pairing-seller:" + user.id, 10, 3600);
      if (!config.releases.length)
        reject(
          503,
          "Installer belum dibuka: operator perlu menetapkan rilis yang disetujui.",
        );
      if (!installerTestEmails.includes(user.email))
        reject(403, "Instalasi terbatas untuk akun uji yang diotorisasi.");
      const raw = token();
      await tx(async (db) => {
        const {
          rows: [store],
        } = await db.query(
          "SELECT * FROM stores WHERE seller_id=$1 FOR UPDATE",
          [user.id],
        );
        if (!store) reject(422, "Lengkapi informasi toko.");
        if (
          (
            await db.query("SELECT id FROM agents WHERE store_id=$1", [
              store.id,
            ])
          ).rowCount
        )
          reject(409, "VPS sudah dipasangkan.");
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
      await pool.query(
        "UPDATE agents SET revoked_at=now() WHERE store_id IN (SELECT id FROM stores WHERE seller_id=$1)",
        [user.id],
      );
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
        !/^\/(?:$|index\.html$|404\.html$|portal-config\.json$|assets\/|pendaftaran(?:\/|$)|masuk(?:\/|$)|daftar(?:\/|$)|panduan-instalasi(?:\/|$)|kebijakan-privasi(?:\/|$))/.test(
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
