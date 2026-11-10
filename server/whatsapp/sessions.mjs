import { createHash } from "node:crypto";
import { normalizePhone, GatewayError } from "./openwa.mjs";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => {
  throw new GatewayError(code);
};

// Session IDs and expected numbers are provisioned by the operator registry.
// No request may choose another provider session or supply gateway credentials.
export class SellerSessions {
  constructor({ auth, gateway, enabled = false }) {
    this.auth = auth;
    this.gateway = gateway;
    this.enabled = enabled;
  }
  async tenant(db, token) {
    if (!this.enabled || !this.auth.allowed.size) fail("whatsapp_unavailable");
    if (!/^[a-f0-9]{64}$/.test(token || "")) fail("access_denied");
    const {
      rows: [tenant],
    } = await db.query(
      "SELECT * FROM wa_tenants WHERE token_digest=$1 AND NOT paused",
      [hash(token)],
    );
    if (!tenant) fail("access_denied");
    return tenant;
  }
  async locked(token, fn) {
    const db = await this.auth.pool.connect();
    let key;
    try {
      const tenant = await this.tenant(db, token);
      key = "btos-wa-session:" + tenant.id;
      const {
        rows: [lock],
      } = await db.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
        [key],
      );
      if (!lock.locked) {
        key = null;
        fail("session_busy");
      }
      const {
        rows: [session],
      } = await db.query(
        "SELECT * FROM wa_sessions WHERE tenant_id=$1 AND purpose='seller'",
        [tenant.id],
      );
      if (!session) fail("session_not_provisioned");
      if (normalizePhone(session.expected_phone) === this.auth.centralPhone)
        fail("central_number_reserved");
      return await fn(db, tenant, session);
    } finally {
      if (key) {
        try {
          await db.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
            key,
          ]);
        } catch {
          db.release(true);
          throw new GatewayError("session_database_unavailable");
        }
      }
      db.release();
    }
  }
  async refresh(db, session) {
    if (!session.connection_enabled)
      return {
        status: "disconnected",
        phone: null,
        expectedPhone: session.expected_phone,
      };
    const actual = await this.gateway.status(session.provider_id);
    if (actual.phone && actual.phone !== session.expected_phone) {
      await db.query(
        "UPDATE wa_sessions SET state='failed',connected_phone=NULL,generation=generation+1,connection_enabled=false WHERE provider_id=$1",
        [session.provider_id],
      );
      // Quarantine first. Even if provider logout fails, authentication and all
      // queued messages remain fenced by the generation change.
      try {
        await this.gateway.logout(session.provider_id);
      } catch {}
      fail("paired_number_mismatch");
    }
    const state =
      actual.status === "ready" && !actual.loaded
        ? "initializing"
        : actual.status;
    const ready = state === "ready" && actual.phone === session.expected_phone;
    if (state === "ready" && !ready) fail("paired_number_unresolved");
    await db.query(
      "UPDATE wa_sessions SET state=$2,connected_phone=$3 WHERE provider_id=$1",
      [session.provider_id, state, ready ? actual.phone : null],
    );
    return {
      status: state,
      phone: ready ? actual.phone : null,
      expectedPhone: session.expected_phone,
    };
  }
  async status(token) {
    return this.locked(token, (db, tenant, session) =>
      this.refresh(db, session),
    );
  }
  async qr(token) {
    return this.locked(token, async (db, tenant, session) => {
      await this.auth.limit(db, "qr:" + tenant.id, 30, 60);
      const actual = await this.refresh(db, session);
      if (actual.status !== "qr_ready") fail("qr_unavailable");
      return this.gateway.qr(session.provider_id);
    });
  }
  async connect(token) {
    return this.locked(token, async (db, tenant, session) => {
      await this.auth.limit(db, "connect:" + tenant.id, 3, 300);
      if (!session.connection_enabled) {
        // Reconnect must clear the former provider connection before enabling.
        // A failed logout leaves this session fenced, even if the provider is ready.
        await this.gateway.logout(session.provider_id);
        await db.query(
          "UPDATE wa_sessions SET connection_enabled=true WHERE provider_id=$1",
          [session.provider_id],
        );
        session.connection_enabled = true;
      }
      const actual = await this.refresh(db, session);
      if (
        ["ready", "qr_ready", "authenticating", "initializing"].includes(
          actual.status,
        )
      )
        return actual;
      await this.gateway.start(session.provider_id);
      return this.refresh(db, session);
    });
  }
  async disconnect(token) {
    return this.locked(token, async (db, tenant, session) => {
      // Durable fence BEFORE any external operation; reconnect cannot revive
      // messages prepared for the former connection.
      await db.query(
        "UPDATE wa_sessions SET generation=generation+1,state='disconnected',connected_phone=NULL,connection_enabled=false WHERE provider_id=$1",
        [session.provider_id],
      );
      await this.gateway.logout(session.provider_id);
      return {
        status: "disconnected",
        phone: null,
        expectedPhone: session.expected_phone,
      };
    });
  }
}
