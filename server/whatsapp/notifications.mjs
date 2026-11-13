import { randomUUID } from "node:crypto";
import {
  normalizePhone,
  incomingIdentity,
  verifyWebhook,
  GatewayError,
} from "./openwa.mjs";
const fail = (code) => {
  throw new GatewayError(code);
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LABELS = {
  created: "Pesanan dibuat.",
  payment_revision:
    "Bukti pembayaran perlu diperbaiki. Silakan periksa di website.",
  paid: "Pembayaran telah diverifikasi.",
  preparing: "Pesanan sedang disiapkan.",
  awb_created: "Resi dibuat. Menunggu paket diterima kurir.",
  shipped: "Paket telah diterima kurir dan sedang dikirim.",
  delivered: "Paket telah diterima berdasarkan tracking kurir.",
  cancelled: "Pesanan dibatalkan.",
  returned: "Paket dalam proses retur.",
  refund_pending: "Pengembalian dana sedang diproses.",
  refund_recorded:
    "Penjual telah mencatat transfer pengembalian dana. Periksa rekening Anda.",
};
const clean = (s) =>
  String(s)
    .replace(/[\r\n\x00-\x1f\x7f]/g, " ")
    .slice(0, 80);
export class Notifications {
  constructor({ auth, sessions, gateway, enabled = false }) {
    Object.assign(this, { auth, sessions, gateway, enabled });
  }
  gate() {
    if (!this.enabled || !this.auth.allowed.size) fail("whatsapp_unavailable");
  }
  async tenant(db, token) {
    this.gate();
    const t = await this.sessions.tenant(db, token);
    if (!t.notifications_enabled) fail("notifications_disabled");
    return t;
  }
  async consent(token, { phone, granted, occurredAt }) {
    phone = normalizePhone(phone);
    const at = new Date(occurredAt);
    if (
      typeof granted !== "boolean" ||
      !Number.isFinite(+at) ||
      at > Date.now() + 60000 ||
      (granted && Date.now() - at > 300000) ||
      !this.auth.allowed.has(phone)
    )
      fail("invalid_consent");
    return this.auth.tx(async (db) => {
      const tenant = await this.sessions.tenant(db, token);
      if (granted) {
        this.gate();
        if (!tenant.notifications_enabled) fail("notifications_disabled");
      }
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "wa-recipient:" + tenant.id + ":" + phone,
      ]);
      const changed = await db.query(
        `INSERT INTO wa_consents(tenant_id,phone,granted,changed_at,source) VALUES($1,$2,$3,$4,'website')
    ON CONFLICT(tenant_id,phone) DO UPDATE SET granted=EXCLUDED.granted,changed_at=EXCLUDED.changed_at,source='website'
    WHERE wa_consents.changed_at<EXCLUDED.changed_at OR (wa_consents.changed_at=EXCLUDED.changed_at AND NOT EXCLUDED.granted) RETURNING granted`,
        [tenant.id, phone, granted, at],
      );
      if (!granted)
        await db.query(
          "UPDATE wa_notifications SET state='cancelled',payload_sealed=NULL WHERE tenant_id=$1 AND phone=$2 AND state='queued'",
          [tenant.id, phone],
        );
      const current = await db.query(
        "SELECT granted,changed_at FROM wa_consents WHERE tenant_id=$1 AND phone=$2",
        [tenant.id, phone],
      );
      return {
        saved:
          changed.rowCount > 0 ||
          (current.rows[0]?.granted === granted &&
            +current.rows[0].changed_at === +at),
      };
    });
  }
  async enqueue(token, event) {
    const keys = ["id", "orderId", "revision", "type", "phone", "occurredAt"];
    if (
      !event ||
      Object.keys(event).some((k) => !keys.includes(k)) ||
      !UUID.test(event.id || "") ||
      !/^ORD-[A-Z0-9-]{4,64}$/.test(event.orderId || "") ||
      !Number.isSafeInteger(event.revision) ||
      event.revision < 1 ||
      !Object.hasOwn(LABELS, event.type)
    )
      fail("invalid_event");
    const phone = normalizePhone(event.phone),
      at = new Date(event.occurredAt);
    if (
      !Number.isFinite(+at) ||
      at > Date.now() + 60000 ||
      Date.now() - at > 3600000 ||
      !this.auth.allowed.has(phone)
    )
      fail("event_expired_or_not_authorized");
    return this.auth.tx(async (db) => {
      const tenant = await this.tenant(db, token);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "wa-order:" + tenant.id + ":" + event.orderId,
      ]);
      const prior = await db.query(
        "SELECT id,state FROM wa_notifications WHERE tenant_id=$1 AND event_id=$2",
        [tenant.id, event.id],
      );
      if (prior.rowCount)
        return { id: prior.rows[0].id, state: prior.rows[0].state };
      const {
        rows: [head],
      } = await db.query(
        "SELECT revision FROM wa_order_heads WHERE tenant_id=$1 AND order_id=$2",
        [tenant.id, event.orderId],
      );
      if (head && Number(head.revision) >= event.revision)
        return { state: "superseded" };
      await db.query(
        "INSERT INTO wa_order_heads(tenant_id,order_id,revision) VALUES($1,$2,$3) ON CONFLICT(tenant_id,order_id) DO UPDATE SET revision=EXCLUDED.revision",
        [tenant.id, event.orderId, event.revision],
      );
      await db.query(
        "UPDATE wa_notifications SET state='superseded',payload_sealed=NULL WHERE tenant_id=$1 AND order_id=$2 AND state='queued'",
        [tenant.id, event.orderId],
      );
      if (event.type === "preparing" && !tenant.preparing_enabled)
        return { state: "disabled" };
      const {
        rows: [consent],
      } = await db.query(
        "SELECT granted FROM wa_consents WHERE tenant_id=$1 AND phone=$2",
        [tenant.id, phone],
      );
      if (!consent?.granted) return { state: "no_consent" };
      const {
        rows: [session],
      } = await db.query(
        "SELECT * FROM wa_sessions WHERE tenant_id=$1 AND purpose='seller'",
        [tenant.id],
      );
      if (!session || session.expected_phone === this.auth.centralPhone)
        fail("session_not_provisioned");
      await this.auth.limit(db, "notifications:" + tenant.id, 30, 3600);
      await this.auth.limit(db, "notification-phone:" + phone, 12, 3600);
      const id = randomUUID(),
        origin = new URL(tenant.origin);
      if (origin.protocol !== "https:" || origin.origin !== tenant.origin)
        fail("tenant_origin_invalid");
      // Template and link are server-selected. No arbitrary body, URL or recipient
      // list can enter this service; only registered transactional event types.
      const text = `${clean(tenant.brand)}\n${event.orderId}\n${LABELS[event.type]}\nLihat pesanan di ${origin.origin}/account/orders\nBalas STOP untuk menghentikan notifikasi toko ini.`;
      await db.query(
        `INSERT INTO wa_notifications(id,tenant_id,event_id,order_id,revision,event_type,phone,session_id,session_generation,tenant_generation,payload_sealed,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          tenant.id,
          event.id,
          event.orderId,
          event.revision,
          event.type,
          phone,
          session.provider_id,
          session.generation,
          tenant.generation,
          this.auth.vault.seal(id, text),
          new Date(Math.min(+at + 3600000, Date.now() + 3600000)),
        ],
      );
      return { id, state: "queued" };
    });
  }
  async receive(raw, headers) {
    this.gate();
    const event = verifyWebhook(raw, headers, this.auth.webhookSecret);
    const {
      rows: [session],
    } = await this.auth.pool.query(
      "SELECT * FROM wa_sessions WHERE provider_id=$1 AND purpose='seller'",
      [event.sessionId],
    );
    if (!session) fail("session_mismatch");
    if (event.event === "message.received") {
      const incoming = incomingIdentity(event, session.expected_phone);
      if (incoming.body.trim().toUpperCase() !== "STOP")
        return { ignored: true };
      return this.auth.tx(async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "wa-recipient:" + session.tenant_id + ":" + incoming.phone,
        ]);
        const receipt = await db.query(
          "INSERT INTO wa_receipts(session_id,message_id,idempotency_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING message_id",
          [session.provider_id, incoming.messageId, event.idempotencyKey],
        );
        if (!receipt.rowCount) return { ignored: true };
        await db.query(
          "INSERT INTO wa_consents(tenant_id,phone,granted,changed_at,source) VALUES($1,$2,false,now(),'STOP') ON CONFLICT(tenant_id,phone) DO UPDATE SET granted=false,changed_at=now(),source='STOP'",
          [session.tenant_id, incoming.phone],
        );
        await db.query(
          "UPDATE wa_notifications SET state='cancelled',payload_sealed=NULL WHERE tenant_id=$1 AND phone=$2 AND state='queued'",
          [session.tenant_id, incoming.phone],
        );
        return { stopped: true };
      });
    }
    const m = event.data;
    if (
      !["message.ack", "message.failed"].includes(event.event) ||
      !["delivered", "read", "failed"].includes(m.status) ||
      typeof m.id !== "string" ||
      !m.id ||
      m.id.length > 256
    )
      return { ignored: true };
    // Store receipts that arrive before the send response. Monotonic updates
    // cannot downgrade read/delivered on a late failed or older ACK.
    await this.auth.pool.query(
      `INSERT INTO wa_delivery_receipts(session_id,message_id,state) VALUES($1,$2,$3)
   ON CONFLICT(session_id,message_id) DO UPDATE SET state=CASE
   WHEN wa_delivery_receipts.state='read' OR EXCLUDED.state='read' THEN 'read'
   WHEN wa_delivery_receipts.state='delivered' OR EXCLUDED.state='delivered' THEN 'delivered' ELSE EXCLUDED.state END`,
      [session.provider_id, m.id, m.status],
    );
    await this.reconcileReceipts();
    return { accepted: true };
  }
  async reconcileReceipts() {
    await this.auth.pool
      .query(`UPDATE wa_notifications n SET state=r.state,updated_at=now()
   FROM wa_delivery_receipts r WHERE n.session_id=r.session_id AND n.provider_message_id=r.message_id
   AND n.state IN ('submitted','unknown','delivered','failed') AND (n.state<>'delivered' OR r.state='read')`);
  }
  async history(token) {
    const tenant = await this.sessions.tenant(this.auth.pool, token);
    const { rows } = await this.auth.pool.query(
      "SELECT id,order_id,event_type,state,right(phone,4) AS recipient_suffix,created_at,updated_at,(state='failed' AND submission_started_at IS NULL AND provider_message_id IS NULL AND manual_retries=0 AND expires_at>now()+interval '30 seconds') AS retryable FROM wa_notifications WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 30",
      [tenant.id],
    );
    return rows;
  }
  async retry(token, { id }) {
    if (!UUID.test(id || "")) fail("invalid_event");
    return this.auth.tx(async (db) => {
      const tenant = await this.tenant(db, token);
      await this.auth.limit(db, "retry:" + tenant.id, 3, 300);
      const {
        rows: [n],
      } = await db.query(
        `SELECT n.* FROM wa_notifications n
    JOIN wa_order_heads h ON h.tenant_id=n.tenant_id AND h.order_id=n.order_id AND h.revision=n.revision
    JOIN wa_sessions s ON s.provider_id=n.session_id AND s.tenant_id=n.tenant_id AND s.generation=n.session_generation
    JOIN wa_consents c ON c.tenant_id=n.tenant_id AND c.phone=n.phone AND c.granted
    WHERE n.id=$1 AND n.tenant_id=$2 AND n.state='failed' AND n.submission_started_at IS NULL
    AND n.provider_message_id IS NULL AND n.manual_retries=0 AND n.expires_at>now()+interval '30 seconds'
    AND n.tenant_generation=$3 AND s.connection_enabled AND s.expected_phone<>$4 FOR UPDATE OF n`,
        [id, tenant.id, tenant.generation, this.auth.centralPhone],
      );
      if (
        !n ||
        !this.auth.allowed.has(n.phone) ||
        !Object.hasOwn(LABELS, n.event_type)
      )
        fail("retry_not_safe");
      const origin = new URL(tenant.origin);
      if (origin.protocol !== "https:" || origin.origin !== tenant.origin)
        fail("tenant_origin_invalid");
      const text = `${clean(tenant.brand)}\n${n.order_id}\n${LABELS[n.event_type]}\nLihat pesanan di ${origin.origin}/account/orders\nBalas STOP untuk menghentikan notifikasi toko ini.`;
      await db.query(
        "UPDATE wa_notifications SET state='queued',attempts=0,manual_retries=1,next_at=now(),updated_at=now(),payload_sealed=$2 WHERE id=$1",
        [id, this.auth.vault.seal(id, text)],
      );
      return { state: "queued" };
    });
  }
  async preferences(token, input = {}) {
    return this.auth.tx(async (db) => {
      const tenant = await this.sessions.tenant(db, token);
      if (Object.keys(input).length) {
        if (
          Object.keys(input).some(
            (k) => !["enabled", "preparing"].includes(k),
          ) ||
          typeof input.enabled !== "boolean" ||
          typeof input.preparing !== "boolean"
        )
          fail("invalid_request");
        if (input.enabled) this.gate();
        await db.query(
          "UPDATE wa_tenants SET notifications_enabled=$2,preparing_enabled=$3 WHERE id=$1",
          [tenant.id, input.enabled, input.preparing],
        );
        if (!input.enabled)
          await db.query(
            "UPDATE wa_notifications SET state='cancelled',payload_sealed=NULL WHERE tenant_id=$1 AND state='queued'",
            [tenant.id],
          );
        return input;
      }
      return {
        enabled: tenant.notifications_enabled,
        preparing: tenant.preparing_enabled,
      };
    });
  }
}
