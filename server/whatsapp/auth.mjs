import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { installerPasswordVault } from "../store-setup.mjs";
import {
  normalizePhone,
  incomingIdentity,
  verifyWebhook,
  GatewayError,
} from "./openwa.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = (code) => {
  throw new GatewayError(code);
};
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  HEX.test(a) &&
  HEX.test(b) &&
  timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

// No HTTP route is enabled by importing this module. Pilot admission, separate
// tenant credentials and the operator flag must all be satisfied at each step.
export class WhatsAppAuth {
  constructor({
    pool,
    secret,
    webhookSecret,
    centralPhone,
    enabled = false,
    allowedRecipients = [],
    publicAuth = false,
  }) {
    if (
      typeof secret !== "string" ||
      secret.length < 32 ||
      typeof webhookSecret !== "string" ||
      webhookSecret.length < 32
    )
      fail("auth_configuration");
    this.pool = pool;
    this.secret = secret;
    this.webhookSecret = webhookSecret;
    this.centralPhone = normalizePhone(centralPhone);
    this.enabled = enabled;
    this.publicAuth = publicAuth === true;
    this.allowed = new Set(allowedRecipients.map(normalizePhone));
    this.vault = installerPasswordVault("whatsapp-auth-reply-v1:" + secret);
  }
  mac(value) {
    return createHmac("sha256", this.secret).update(value).digest("hex");
  }
  accepts(phone) {
    return this.publicAuth || this.allowed.has(phone);
  }
  gate() {
    if (!this.enabled || (!this.publicAuth && !this.allowed.size))
      fail("whatsapp_unavailable");
  }
  async tx(fn) {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const value = await fn(db);
      await db.query("COMMIT");
      return value;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  async tenant(db, token) {
    this.gate();
    if (!HEX.test(token || "")) fail("access_denied");
    const {
      rows: [tenant],
    } = await db.query(
      "SELECT * FROM wa_tenants WHERE token_digest=$1 AND auth_enabled AND NOT paused",
      [digest(token)],
    );
    if (!tenant) fail("access_denied");
    return tenant;
  }
  async limit(db, scope, maximum, seconds) {
    const {
      rows: [r],
    } = await db.query(
      `INSERT INTO wa_limits(scope,hits,expires_at) VALUES($1,1,now()+$2*interval '1 second')
      ON CONFLICT(scope) DO UPDATE SET hits=CASE WHEN wa_limits.expires_at<=now() THEN 1 ELSE wa_limits.hits+1 END,
      expires_at=CASE WHEN wa_limits.expires_at<=now() THEN EXCLUDED.expires_at ELSE wa_limits.expires_at END RETURNING hits`,
      [this.mac(scope), seconds],
    );
    if (r.hits > maximum) fail("rate_limited");
  }
  async start(token, { phone, browserProof, purpose = "login" }) {
    phone = normalizePhone(phone);
    if (!HEX.test(browserProof || "") || !["login", "link"].includes(purpose))
      fail("invalid_request");
    this.gate();
    if (!this.accepts(phone)) fail("pilot_recipient_required");
    return this.tx(async (db) => {
      const tenant = await this.tenant(db, token);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        this.mac("phone:" + phone),
      ]);
      const {
        rows: [recent],
      } = await db.query(
        "SELECT id FROM wa_challenges WHERE phone=$1 AND created_at>now()-interval '60 seconds' LIMIT 1",
        [phone],
      );
      if (recent) fail("cooldown");
      await this.limit(db, "phone:" + phone, 3, 3600);
      await this.limit(db, "tenant:" + tenant.id, 60, 3600);
      // Shared provider budget remains bounded even with public admission.
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('btos-wa-public-budget',0))",
      );
      await this.limit(db, "global:auth", 120, 3600);
      const {
        rows: [central],
      } = await db.query(
        "SELECT provider_id,generation FROM wa_sessions WHERE purpose='central' AND connected_phone=$1 AND connection_enabled AND state='ready' AND expected_phone=$1",
        [this.centralPhone],
      );
      if (!central) fail("central_disconnected");
      const challenge = randomBytes(32).toString("hex"),
        id = randomUUID();
      const {
        rows: [row],
      } = await db.query(
        `INSERT INTO wa_challenges(id,tenant_id,purpose,phone,browser_digest,public_digest,tenant_generation,session_id,session_generation,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '3 minutes') RETURNING expires_at`,
        [
          id,
          tenant.id,
          purpose,
          phone,
          digest(browserProof),
          digest(challenge),
          tenant.generation,
          central.provider_id,
          central.generation,
        ],
      );
      const message = "BTOS " + purpose.toUpperCase() + " " + challenge;
      return {
        id,
        expiresAt: row.expires_at,
        whatsappUrl:
          "https://wa.me/" +
          this.centralPhone.slice(1) +
          "?text=" +
          encodeURIComponent(message),
      };
    });
  }
  async receive(raw, headers) {
    this.gate();
    const event = verifyWebhook(raw, headers, this.webhookSecret);
    const incoming = incomingIdentity(event, this.centralPhone);
    if (!this.accepts(incoming.phone)) fail("pilot_recipient_required");
    const command = /^BTOS (LOGIN|LINK) ([a-f0-9]{64})$/.exec(incoming.body);
    if (!command) return { ignored: true }; // Never store unrelated private messages.
    return this.tx(async (db) => {
      const {
        rows: [central],
      } = await db.query(
        "SELECT provider_id FROM wa_sessions WHERE provider_id=$1 AND purpose='central' AND connected_phone=$2 AND expected_phone=$2 AND connection_enabled AND state='ready'",
        [event.sessionId, this.centralPhone],
      );
      if (!central) fail("session_mismatch");
      const {
        rows: [challenge],
      } = await db.query(
        `SELECT c.*,t.brand,t.origin FROM wa_challenges c JOIN wa_tenants t ON t.id=c.tenant_id
        WHERE c.public_digest=$1 AND c.phone=$2 AND c.purpose=$3 AND c.state='waiting' AND c.expires_at>now()
        AND t.auth_enabled AND NOT t.paused AND t.generation=c.tenant_generation
        AND c.session_id=$4 AND c.session_generation=(SELECT generation FROM wa_sessions WHERE provider_id=$4)
        FOR UPDATE OF c`,
        [
          digest(command[2]),
          incoming.phone,
          command[1].toLowerCase(),
          event.sessionId,
        ],
      );
      if (!challenge) return { ignored: true };
      const receipt = await db.query(
        "INSERT INTO wa_receipts(session_id,message_id,idempotency_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING message_id",
        [event.sessionId, incoming.messageId, event.idempotencyKey],
      );
      if (!receipt.rowCount) return { ignored: true };
      const code = String(randomInt(0, 1000000)).padStart(6, "0"),
        delivery = randomUUID();
      const brand = String(challenge.brand)
        .replace(/[\r\n\x00-\x1f]/g, " ")
        .slice(0, 80);
      const replyDigest = this.mac(challenge.id + ":" + code);
      const confirmation = this.mac(
        "confirm-link:" + challenge.id + ":" + replyDigest,
      );
      const origin = new URL(challenge.origin);
      if (origin.protocol !== "https:" || origin.origin !== challenge.origin)
        fail("auth_configuration");
      const url =
        origin.origin +
        "/whatsapp#confirm=" +
        challenge.id +
        "." +
        confirmation;
      const text = `${brand}\nKonfirmasi & Lanjutkan:\n${url}\n\nBuka di browser tempat Anda mulai.\nKode cadangan: ${code}\nSegera konfirmasi. Jangan bagikan tautan atau kode ini.`;
      await db.query(
        "UPDATE wa_challenges SET state='reply_queued',reply_digest=$2 WHERE id=$1",
        [challenge.id, this.mac(challenge.id + ":" + code)],
      );
      await db.query(
        "INSERT INTO wa_auth_deliveries(id,challenge_id,session_id,phone,payload_sealed,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
        [
          delivery,
          challenge.id,
          event.sessionId,
          incoming.phone,
          this.vault.seal(delivery, text),
          challenge.expires_at,
        ],
      );
      return { queued: true }; // Incoming message alone never produces a session/exchange.
    });
  }
  async status(token, { id, browserProof }) {
    if (!UUID.test(id || "") || !HEX.test(browserProof || ""))
      fail("invalid_request");
    const tenant = await this.tenant(this.pool, token);
    const {
      rows: [c],
    } = await this.pool.query(
      "SELECT state,expires_at FROM wa_challenges WHERE id=$1 AND tenant_id=$2 AND browser_digest=$3",
      [id, tenant.id, digest(browserProof)],
    );
    if (!c) fail("challenge_invalid");
    return {
      state: c.expires_at <= new Date() ? "expired" : c.state,
      expiresAt: c.expires_at,
    };
  }
  async finish(token, { id, browserProof, code, confirmationToken }) {
    if (
      !UUID.test(id || "") ||
      !HEX.test(browserProof || "") ||
      !(confirmationToken === undefined
        ? /^\d{6}$/.test(code || "")
        : code === undefined && HEX.test(confirmationToken))
    )
      fail("challenge_invalid");
    const result = await this.tx(async (db) => {
      const tenant = await this.tenant(db, token);
      const {
        rows: [c],
      } = await db.query(
        "SELECT * FROM wa_challenges WHERE id=$1 AND tenant_id=$2 AND browser_digest=$3 FOR UPDATE",
        [id, tenant.id, digest(browserProof)],
      );
      if (
        !c ||
        c.tenant_generation !== tenant.generation ||
        c.expires_at <= new Date() ||
        c.state !== "reply_sent" ||
        c.attempts >= 5 ||
        !this.accepts(c.phone)
      )
        return null;
      const {
        rows: [session],
      } = await db.query(
        "SELECT provider_id FROM wa_sessions WHERE provider_id=$1 AND generation=$2 AND connection_enabled AND state='ready' AND connected_phone=$3 AND expected_phone=$3",
        [c.session_id, c.session_generation, this.centralPhone],
      );
      if (!session) return null;
      const valid =
        confirmationToken === undefined
          ? same(c.reply_digest, this.mac(id + ":" + code))
          : typeof c.reply_digest === "string" &&
            same(
              confirmationToken,
              this.mac("confirm-link:" + id + ":" + c.reply_digest),
            );
      if (!valid) {
        await db.query(
          "UPDATE wa_challenges SET attempts=attempts+1,state=CASE WHEN attempts+1>=5 THEN 'locked' ELSE state END WHERE id=$1",
          [id],
        );
        return null;
      }
      const exchange = randomBytes(32).toString("hex");
      await db.query(
        "UPDATE wa_challenges SET state='consumed',consumed_at=now(),reply_digest=NULL WHERE id=$1",
        [id],
      );
      await db.query(
        "INSERT INTO wa_exchanges(digest,tenant_id,challenge_id,browser_digest,phone,purpose,tenant_generation,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,LEAST($8,now()+interval '60 seconds'))",
        [
          digest(exchange),
          tenant.id,
          id,
          c.browser_digest,
          c.phone,
          c.purpose,
          c.tenant_generation,
          c.expires_at,
        ],
      );
      return { exchange }; // S2S only; store route must consume before returning to browser.
    });
    if (!result) fail("challenge_invalid");
    return result;
  }
  async exchange(token, { exchange, browserProof }) {
    if (!HEX.test(exchange || "") || !HEX.test(browserProof || ""))
      fail("exchange_invalid");
    return this.tx(async (db) => {
      const tenant = await this.tenant(db, token);
      const {
        rows: [row],
      } = await db.query(
        `UPDATE wa_exchanges e SET consumed_at=now() FROM wa_challenges c,wa_sessions s
        WHERE e.digest=$1 AND e.tenant_id=$2 AND e.browser_digest=$3 AND e.tenant_generation=$4
        AND e.expires_at>now() AND e.consumed_at IS NULL AND c.id=e.challenge_id
        AND s.provider_id=c.session_id AND s.generation=c.session_generation AND s.connection_enabled AND s.state='ready'
        AND s.expected_phone=$5 AND s.connected_phone=$5 RETURNING e.phone,e.purpose,e.challenge_id`,
        [
          digest(exchange),
          tenant.id,
          digest(browserProof),
          tenant.generation,
          this.centralPhone,
        ],
      );
      if (!row || !this.accepts(row.phone)) fail("exchange_invalid");
      return {
        phone: row.phone,
        purpose: row.purpose,
        transaction: row.challenge_id,
        tenant: tenant.id,
        audience: tenant.origin,
      };
    });
  }
}
