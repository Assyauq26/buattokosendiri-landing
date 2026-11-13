import { GatewayError } from "./openwa.mjs";

export class NotificationDelivery {
  constructor({ notifications }) {
    this.service = notifications;
  }
  async tick() {
    const service = this.service;
    service.gate();
    const db = await service.auth.pool.connect();
    let locked = false;
    try {
      locked = (
        await db.query(
          "SELECT pg_try_advisory_lock(hashtextextended('btos-wa-notification-worker',0)) AS locked",
        )
      ).rows[0].locked;
      if (!locked) return { state: "busy" };
      await db.query(
        "UPDATE wa_notifications SET state='unknown',payload_sealed=NULL,updated_at=now() WHERE state='sending'",
      );
      await db.query(
        "UPDATE wa_notifications SET state='expired',payload_sealed=NULL WHERE state='queued' AND expires_at<=now()",
      );
      await db.query(
        `UPDATE wa_notifications n SET state='cancelled',payload_sealed=NULL FROM wa_tenants t,wa_sessions s
    WHERE n.tenant_id=t.id AND n.session_id=s.provider_id AND n.state='queued'
    AND (t.paused OR NOT t.notifications_enabled OR t.generation<>n.tenant_generation OR s.generation<>n.session_generation
    OR NOT s.connection_enabled OR s.purpose<>'seller' OR s.tenant_id<>n.tenant_id OR s.expected_phone=$1
    OR NOT EXISTS(SELECT 1 FROM wa_consents c WHERE c.tenant_id=n.tenant_id AND c.phone=n.phone AND c.granted))`,
        [service.auth.centralPhone],
      );
      const {
        rows: [item],
      } = await db.query(
        "SELECT n.*,s.expected_phone FROM wa_notifications n JOIN wa_sessions s ON s.provider_id=n.session_id WHERE n.state='queued' AND n.next_at<=now() ORDER BY n.created_at,n.id LIMIT 1",
      );
      if (!item) {
        await service.reconcileReceipts();
        return { state: "idle" };
      }
      if (!service.auth.allowed.has(item.phone)) {
        await db.query(
          "UPDATE wa_notifications SET state='cancelled',payload_sealed=NULL WHERE id=$1",
          [item.id],
        );
        return { state: "cancelled" };
      }
      let status;
      try {
        status = await service.gateway.status(item.session_id);
      } catch {}
      if (
        !status ||
        status.status !== "ready" ||
        !status.loaded ||
        status.phone !== item.expected_phone
      ) {
        // No send attempted: bounded backoff is safe. Exhaustion is a dead-letter,
        // never an implicit resend after the provider may have accepted a message.
        await db.query(
          `UPDATE wa_notifications SET attempts=attempts+1,next_at=now()+LEAST(900,30*power(2,attempts))*interval '1 second',
     state=CASE WHEN attempts>=5 THEN 'failed' ELSE state END,
     payload_sealed=CASE WHEN attempts>=5 THEN NULL ELSE payload_sealed END,updated_at=now() WHERE id=$1`,
          [item.id],
        );
        return { state: "disconnected" };
      }
      service.gate();
      // One atomic predicate rechecks consent, connection generation, tenant flags,
      // expiry and supersession immediately before committing the send intent.
      const claim = await db.query(
        `UPDATE wa_notifications n SET state='sending',submission_started_at=now(),attempts=attempts+1,updated_at=now()
    FROM wa_tenants t,wa_sessions s,wa_consents c,wa_order_heads h
    WHERE n.id=$1 AND n.state='queued' AND n.expires_at>now()+interval '20 seconds'
    AND t.id=n.tenant_id AND NOT t.paused AND t.notifications_enabled AND t.generation=n.tenant_generation
    AND s.provider_id=n.session_id AND s.tenant_id=n.tenant_id AND s.purpose='seller' AND s.generation=n.session_generation
    AND s.connection_enabled AND s.expected_phone=$2 AND s.connected_phone=$2 AND s.state='ready'
    AND c.tenant_id=n.tenant_id AND c.phone=n.phone AND c.granted
    AND h.tenant_id=n.tenant_id AND h.order_id=n.order_id AND h.revision=n.revision RETURNING n.id`,
        [item.id, status.phone],
      );
      if (!claim.rowCount) return { state: "cancelled" };
      let sent;
      try {
        sent = await service.gateway.sendText(
          item.session_id,
          item.phone,
          service.auth.vault.open(item.id, item.payload_sealed),
          item.id,
        );
      } catch {
        await db.query(
          "UPDATE wa_notifications SET state='unknown',payload_sealed=NULL,updated_at=now() WHERE id=$1",
          [item.id],
        );
        return { state: "unknown" };
      }
      await db.query(
        "UPDATE wa_notifications SET state='submitted',provider_message_id=$2,payload_sealed=NULL,updated_at=now() WHERE id=$1",
        [item.id, sent.messageId],
      );
      await service.reconcileReceipts();
      return { state: "submitted" };
    } finally {
      if (locked) {
        try {
          await db.query(
            "SELECT pg_advisory_unlock(hashtextextended('btos-wa-notification-worker',0))",
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
