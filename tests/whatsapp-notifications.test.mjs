import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { WhatsAppAuth } from "../server/whatsapp/auth.mjs";
import { SellerSessions } from "../server/whatsapp/sessions.mjs";
import { Notifications } from "../server/whatsapp/notifications.mjs";
import { NotificationDelivery } from "../server/whatsapp/notification-delivery.mjs";
const database = process.env.WA_TEST_DATABASE_URL;
const hash = (v) => createHash("sha256").update(v).digest("hex");
test(
  "seller session isolation and transactional notification queue",
  { skip: !database },
  async (t) => {
    assert.ok(["127.0.0.1", "localhost"].includes(new URL(database).hostname));
    const schema = "wa_notify_" + randomBytes(12).toString("hex"),
      root = new pg.Pool({ connectionString: database });
    await root.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: database,
      options: `-c search_path=${schema}`,
    });
    const tenant = randomUUID(),
      other = randomUUID(),
      session = randomUUID(),
      otherSession = randomUUID(),
      token = randomBytes(32).toString("hex"),
      otherToken = randomBytes(32).toString("hex");
    const central = "+6282211700060",
      phone = "+6281575652263",
      secret = "synthetic-notification-secret-".repeat(3);
    try {
      await pool.query("CREATE TABLE stores(id uuid PRIMARY KEY)");
      await pool.query(
        await readFile(
          new URL("../server/whatsapp/schema.sql", import.meta.url),
          "utf8",
        ),
      );
      for (const [id, key, sid, number] of [
        [tenant, token, session, phone],
        [other, otherToken, otherSession, "+6281234567890"],
      ]) {
        await pool.query("INSERT INTO stores(id) VALUES($1)", [id]);
        await pool.query(
          "INSERT INTO wa_tenants(id,origin,brand,token_digest,auth_enabled,notifications_enabled,paused) VALUES($1,$2,'Toko Uji',$3,true,true,false)",
          [id, "https://" + id + ".test", hash(key)],
        );
        await pool.query(
          "INSERT INTO wa_sessions(provider_id,tenant_id,purpose,expected_phone,connected_phone,state) VALUES($1,$2,'seller',$3,$3,'ready')",
          [sid, id, number],
        );
      }
      const auth = new WhatsAppAuth({
        pool,
        secret,
        webhookSecret: secret,
        centralPhone: central,
        enabled: true,
        allowedRecipients: [phone],
      });
      let provider = { status: "ready", loaded: true, phone },
        calls = 0,
        send,
        stopDuringStatus = false;
      const gateway = {
        status: async (id) => {
          assert.ok([session, otherSession].includes(id));
          if (stopDuringStatus)
            await pool.query("UPDATE wa_consents SET granted=false");
          return {
            ...provider,
            phone: id === otherSession ? "+6281234567890" : provider.phone,
          };
        },
        qr: async (id) => ({ qrCode: "private-" + id, status: "qr_ready" }),
        start: async () => {},
        logout: async () => {},
        sendText: async (...args) => {
          calls++;
          return send ? send(...args) : { messageId: "message-" + calls };
        },
      };
      const sessions = new SellerSessions({ auth, gateway, enabled: true }),
        service = new Notifications({ auth, sessions, gateway, enabled: true }),
        worker = new NotificationDelivery({ notifications: service });
      const event = (revision = 1, type = "created") => ({
        id: randomUUID(),
        orderId: "ORD-TEST-1234",
        revision,
        type,
        phone,
        occurredAt: new Date().toISOString(),
      });
      const reset = async () => {
        calls = 0;
        send = null;
        stopDuringStatus = false;
        provider = { status: "ready", loaded: true, phone };
        await pool.query(
          "TRUNCATE wa_notifications,wa_order_heads,wa_consents,wa_delivery_receipts,wa_receipts,wa_limits",
        );
        await pool.query(
          "UPDATE wa_tenants SET paused=false,notifications_enabled=true",
        );
        await pool.query(
          "UPDATE wa_sessions SET state='ready',connected_phone=expected_phone,generation=1,connection_enabled=true",
        );
      };
      const consent = () =>
        service.consent(token, {
          phone,
          granted: true,
          occurredAt: new Date().toISOString(),
        });
      const webhook = (data, eventName = "message.received") => {
        const e = {
          sessionId: session,
          event: eventName,
          timestamp: new Date().toISOString(),
          idempotencyKey: randomUUID(),
          deliveryId: randomUUID(),
          data,
        };
        const raw = Buffer.from(JSON.stringify(e));
        return [
          raw,
          {
            "x-openwa-signature":
              "sha256=" +
              createHmac("sha256", secret).update(raw).digest("hex"),
            "x-openwa-event": e.event,
            "x-openwa-idempotency-key": e.idempotencyKey,
            "x-openwa-delivery-id": e.deliveryId,
          },
        ];
      };
      await t.test(
        "session/QR determined by authenticated tenant, no central reuse",
        async () => {
          await reset();
          provider.status = "qr_ready";
          assert.equal((await sessions.qr(token)).qrCode, "private-" + session);
          assert.equal(
            (await sessions.qr(otherToken)).qrCode,
            "private-" + otherSession,
          );
          await assert.rejects(sessions.qr("a".repeat(64)), /access_denied/);
          await pool.query(
            "UPDATE wa_sessions SET expected_phone=$1 WHERE provider_id=$2",
            [central, session],
          );
          await assert.rejects(
            sessions.status(token),
            /central_number_reserved/,
          );
          await pool.query(
            "UPDATE wa_sessions SET expected_phone=$1 WHERE provider_id=$2",
            [phone, session],
          );
        },
      );
      await t.test(
        "wrong paired number quarantines and rotates generation",
        async () => {
          await reset();
          provider.phone = "+6281000000000";
          await assert.rejects(
            sessions.status(token),
            /paired_number_mismatch/,
          );
          const s = (
            await pool.query(
              "SELECT state,generation,connected_phone FROM wa_sessions WHERE provider_id=$1",
              [session],
            )
          ).rows[0];
          assert.deepEqual(s, {
            state: "failed",
            generation: 2,
            connected_phone: null,
          });
        },
      );
      await t.test(
        "consent and explicit recipient allowlist required; arbitrary text/URL rejected",
        async () => {
          await reset();
          assert.equal(
            (await service.enqueue(token, event())).state,
            "no_consent",
          );
          await consent();
          await assert.rejects(
            service.enqueue(token, { ...event(2), text: "arbitrary" }),
            /invalid_event/,
          );
          await assert.rejects(
            service.enqueue(token, { ...event(2), phone: "+6281234567890" }),
            /event_expired_or_not_authorized/,
          );
          await service.enqueue(token, event(2));
          assert.equal((await service.history(otherToken)).length, 0);
        },
      );
      await t.test(
        "duplicates and out-of-order events never queue twice; newer event supersedes backlog",
        async () => {
          await reset();
          await consent();
          const one = event(),
            r = await service.enqueue(token, one);
          assert.deepEqual(await service.enqueue(token, one), r);
          const newer = await service.enqueue(token, event(3, "awb_created"));
          assert.equal(
            (await service.enqueue(token, event(2, "paid"))).state,
            "superseded",
          );
          assert.equal(
            (
              await pool.query(
                "SELECT state FROM wa_notifications WHERE id=$1",
                [r.id],
              )
            ).rows[0].state,
            "superseded",
          );
          send = async (id, to, text, key) => {
            assert.equal(key, newer.id);
            assert.equal(to, phone);
            assert.ok(text.includes("Menunggu paket diterima kurir"));
            assert.ok(!text.includes("sedang dikirim"));
            return { messageId: "ack-1" };
          };
          assert.equal((await worker.tick()).state, "submitted");
          await worker.tick();
          assert.equal(calls, 1);
        },
      );
      await t.test(
        "STOP cancels queued messages and stale website opt-in cannot restore consent",
        async () => {
          await reset();
          await consent();
          await service.enqueue(token, event());
          const old = new Date(Date.now() - 1000).toISOString();
          const w = webhook({
            id: randomUUID(),
            from: phone.slice(1) + "@c.us",
            to: phone.slice(1) + "@c.us",
            chatId: phone.slice(1) + "@c.us",
            fromMe: false,
            isGroup: false,
            type: "text",
            timestamp: Math.floor(Date.now() / 1000),
            body: "STOP",
          });
          assert.deepEqual(await service.receive(...w), { stopped: true });
          assert.deepEqual(await service.receive(...w), { ignored: true });
          assert.deepEqual(
            await service.consent(token, {
              phone,
              granted: true,
              occurredAt: old,
            }),
            { saved: false },
          );
          await worker.tick();
          assert.equal(calls, 0);
        },
      );
      await t.test(
        "consent revoked during provider status request prevents send",
        async () => {
          await reset();
          await consent();
          await service.enqueue(token, event());
          stopDuringStatus = true;
          assert.equal((await worker.tick()).state, "cancelled");
          assert.equal(calls, 0);
        },
      );
      await t.test(
        "consent retries acknowledge the same grant; equal-time revoke wins permanently",
        async () => {
          await reset();
          const occurredAt = new Date().toISOString();
          const grant = { phone, granted: true, occurredAt };
          assert.deepEqual(await service.consent(token, grant), {
            saved: true,
          });
          assert.deepEqual(await service.consent(token, grant), {
            saved: true,
          });
          assert.deepEqual(
            await service.consent(token, { ...grant, granted: false }),
            { saved: true },
          );
          assert.deepEqual(await service.consent(token, grant), {
            saved: false,
          });
          assert.equal(
            (await service.enqueue(token, event())).state,
            "no_consent",
          );
        },
      );
      await t.test(
        "disconnect generation and paused tenant cancel waiting messages",
        async () => {
          await reset();
          await consent();
          await service.enqueue(token, event());
          await sessions.disconnect(token);
          await worker.tick();
          assert.equal(calls, 0);
          assert.equal((await service.history(token))[0].state, "cancelled");
          await reset();
          await consent();
          await service.enqueue(token, event());
          await pool.query("UPDATE wa_tenants SET paused=true");
          await worker.tick();
          assert.equal(calls, 0);
        },
      );
      await t.test(
        "unknown submit is never resent and plaintext is erased",
        async () => {
          await reset();
          await consent();
          await service.enqueue(token, event());
          send = async () => {
            throw Error("timeout after acceptance");
          };
          assert.equal((await worker.tick()).state, "unknown");
          await worker.tick();
          assert.equal(calls, 1);
          const n = (
            await pool.query(
              "SELECT state,payload_sealed FROM wa_notifications",
            )
          ).rows[0];
          assert.deepEqual(n, { state: "unknown", payload_sealed: null });
        },
      );
      await t.test(
        "failed logout cannot silently reconnect or release waiting messages",
        async () => {
          await reset();
          await consent();
          await service.enqueue(token, event());
          const logout = gateway.logout;
          gateway.logout = async () => {
            throw Error("provider unavailable");
          };
          try {
            await assert.rejects(sessions.disconnect(token));
            assert.equal((await sessions.status(token)).status, "disconnected");
            await assert.rejects(sessions.connect(token));
            await worker.tick();
            assert.equal(calls, 0);
            assert.equal(
              (
                await pool.query(
                  "SELECT connection_enabled FROM wa_sessions WHERE provider_id=$1",
                  [session],
                )
              ).rows[0].connection_enabled,
              false,
            );
          } finally {
            gateway.logout = logout;
          }
        },
      );
      await t.test(
        "ACK before submission response reconciles and delivery status cannot regress",
        async () => {
          await reset();
          await consent();
          await service.enqueue(token, event());
          send = async () => {
            await service.receive(
              ...webhook({ id: "race-ack", status: "read" }, "message.ack"),
            );
            return { messageId: "race-ack" };
          };
          await worker.tick();
          assert.equal((await service.history(token))[0].state, "read");
          await service.receive(
            ...webhook({ id: "race-ack", status: "failed" }, "message.failed"),
          );
          assert.equal((await service.history(token))[0].state, "read");
        },
      );
      await t.test(
        "expired backlog and exhausted pre-submit retries are never sent",
        async () => {
          await reset();
          await consent();
          await service.enqueue(token, event());
          await pool.query(
            "UPDATE wa_notifications SET expires_at=now()-interval '1 second'",
          );
          await worker.tick();
          assert.equal(calls, 0);
          await reset();
          await consent();
          await service.enqueue(token, event());
          provider.status = "disconnected";
          for (let i = 0; i < 6; i++) {
            await pool.query("UPDATE wa_notifications SET next_at=now()");
            await worker.tick();
          }
          assert.equal((await service.history(token))[0].state, "failed");
          assert.equal(calls, 0);
          const id = (await service.history(token))[0].id;
          await assert.rejects(
            service.retry(otherToken, { id }),
            /retry_not_safe/,
          );
          assert.equal((await service.retry(token, { id })).state, "queued");
          provider.status = "ready";
          await worker.tick();
          assert.equal(calls, 1);
          await assert.rejects(service.retry(token, { id }), /retry_not_safe/);
        },
      );
      await t.test(
        "unknown submission cannot be manually retried even if provider ID is missing",
        async () => {
          await reset();
          await consent();
          const { id } = await service.enqueue(token, event());
          send = async () => {
            throw Error("timeout after acceptance");
          };
          await worker.tick();
          await assert.rejects(service.retry(token, { id }), /retry_not_safe/);
          assert.equal(calls, 1);
        },
      );
    } finally {
      await pool.end();
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
    }
  },
);
