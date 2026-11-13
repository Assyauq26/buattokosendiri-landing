import { GatewayError } from "./openwa.mjs";

// A single PostgreSQL advisory lock serializes workers across processes. Queue
// state is committed BEFORE calling the provider; interrupted sends are unknown,
// never retried automatically. OTPs are never sent late after reconnect.
export class AuthDelivery {
  constructor({ auth, gateway }) {
    this.auth = auth;
    this.gateway = gateway;
  }
  async tick() {
    this.auth.gate();
    const db = await this.auth.pool.connect();
    let locked = false;
    try {
      locked = (
        await db.query(
          "SELECT pg_try_advisory_lock(hashtextextended('btos-wa-auth-worker',0)) AS locked",
        )
      ).rows[0].locked;
      if (!locked) return { state: "busy" };
      // No other worker holding this lock can still own a sending record.
      await db.query(
        "UPDATE wa_auth_deliveries SET state='unknown',payload_sealed=NULL,updated_at=now() WHERE state='sending'",
      );
      await db.query(
        "UPDATE wa_auth_deliveries SET state='expired',payload_sealed=NULL,updated_at=now() WHERE state='queued' AND expires_at<=now()+interval '20 seconds'",
      );
      await db.query(
        `UPDATE wa_auth_deliveries d SET state='cancelled',payload_sealed=NULL,updated_at=now()
        FROM wa_challenges c,wa_tenants t,wa_sessions s WHERE d.challenge_id=c.id AND t.id=c.tenant_id AND s.provider_id=d.session_id
        AND d.state='queued' AND (t.paused OR NOT t.auth_enabled OR t.generation<>c.tenant_generation
          OR NOT s.connection_enabled OR s.generation<>c.session_generation OR s.expected_phone<>$1 OR s.connected_phone IS DISTINCT FROM $1
          OR c.state<>'reply_queued')`,
        [this.auth.centralPhone],
      );
      const {
        rows: [delivery],
      } =
        await db.query(`SELECT d.* FROM wa_auth_deliveries d JOIN wa_sessions s ON s.provider_id=d.session_id
        WHERE d.state='queued' AND s.connection_enabled AND s.state='ready' ORDER BY d.created_at,d.id LIMIT 1`);
      if (!delivery) return { state: "idle" };
      if (!this.auth.accepts(delivery.phone)) {
        await db.query(
          "UPDATE wa_auth_deliveries SET state='cancelled',payload_sealed=NULL WHERE id=$1",
          [delivery.id],
        );
        return { state: "cancelled" };
      }
      const current = await this.gateway.status(delivery.session_id);
      if (
        current.status !== "ready" ||
        !current.loaded ||
        current.phone !== this.auth.centralPhone
      )
        return { state: "disconnected" };
      this.auth.gate();
      // Recheck registry and expiry after the potentially slow status request.
      const claim = await db.query(
        `UPDATE wa_auth_deliveries d SET state='sending',updated_at=now()
        FROM wa_challenges c,wa_tenants t,wa_sessions s WHERE d.id=$1 AND d.challenge_id=c.id AND t.id=c.tenant_id AND s.provider_id=d.session_id
        AND d.state='queued' AND d.expires_at>now()+interval '20 seconds' AND c.state='reply_queued'
        AND t.auth_enabled AND NOT t.paused AND t.generation=c.tenant_generation AND s.generation=c.session_generation
        AND s.connection_enabled AND s.state='ready' AND s.connected_phone=$2 AND s.expected_phone=$2 RETURNING d.id`,
        [delivery.id, this.auth.centralPhone],
      );
      if (!claim.rowCount) return { state: "cancelled" };
      let result;
      try {
        const text = this.auth.vault.open(delivery.id, delivery.payload_sealed);
        result = await this.gateway.sendText(
          delivery.session_id,
          delivery.phone,
          text,
          delivery.id,
        );
      } catch {
        await db.query(
          "UPDATE wa_auth_deliveries SET state='unknown',payload_sealed=NULL,updated_at=now() WHERE id=$1",
          [delivery.id],
        );
        return { state: "unknown" };
      }
      // Persist acknowledgement and challenge transition atomically. A crash
      // before commit remains unknown, with no automatic duplicate submission.
      await db.query("BEGIN");
      try {
        await db.query(
          "UPDATE wa_auth_deliveries SET state='submitted',provider_message_id=$2,payload_sealed=NULL,updated_at=now() WHERE id=$1",
          [delivery.id, result.messageId],
        );
        await db.query(
          "UPDATE wa_challenges SET state='reply_sent' WHERE id=$1 AND state='reply_queued' AND expires_at>now()",
          [delivery.challenge_id],
        );
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      return { state: "submitted" };
    } finally {
      if (locked) {
        try {
          await db.query(
            "SELECT pg_advisory_unlock(hashtextextended('btos-wa-auth-worker',0))",
          );
        } catch {
          db.release(true);
          throw new GatewayError("worker_database_unavailable");
        }
      }
      db.release();
    }
  }
}
