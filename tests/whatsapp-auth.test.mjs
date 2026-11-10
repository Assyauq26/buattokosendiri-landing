import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { WhatsAppAuth } from "../server/whatsapp/auth.mjs";
import { AuthDelivery } from "../server/whatsapp/auth-delivery.mjs";

const database = process.env.WA_TEST_DATABASE_URL;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const secret = "local-synthetic-secret-".repeat(3);
const phone = "+6281575652263",
  central = "+6282211700060";

test(
  "WhatsApp auth transactions on isolated PostgreSQL schema",
  { skip: !database },
  async (t) => {
    // An explicit loopback test URL is required. Never accept production DATABASE_URL.
    const url = new URL(database);
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
    const schema = "wa_test_" + randomBytes(12).toString("hex");
    const root = new pg.Pool({ connectionString: database });
    await root.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: database,
      options: `-c search_path=${schema}`,
    });
    try {
      await pool.query("CREATE TABLE stores(id uuid PRIMARY KEY)");
      await pool.query(
        await readFile(
          new URL("../server/whatsapp/schema.sql", import.meta.url),
          "utf8",
        ),
      );
      const tenant = randomUUID(),
        otherTenant = randomUUID(),
        session = randomUUID();
      const token = randomBytes(32).toString("hex"),
        otherToken = randomBytes(32).toString("hex");
      const browserProof = randomBytes(32).toString("hex");
      await pool.query("INSERT INTO stores(id) VALUES($1),($2)", [
        tenant,
        otherTenant,
      ]);
      for (const [id, key] of [
        [tenant, token],
        [otherTenant, otherToken],
      ]) {
        await pool.query(
          "INSERT INTO wa_tenants(id,origin,brand,token_digest,auth_enabled,paused) VALUES($1,$2,$3,$4,true,false)",
          [id, "https://" + id + ".test", "Toko Uji", hash(key)],
        );
      }
      await pool.query(
        "INSERT INTO wa_sessions(provider_id,purpose,expected_phone,connected_phone,state) VALUES($1,'central',$2,$2,'ready')",
        [session, central],
      );
      const service = new WhatsAppAuth({
        pool,
        secret,
        webhookSecret: secret,
        centralPhone: central,
        enabled: true,
        allowedRecipients: [phone],
      });
      const start = () => service.start(token, { phone, browserProof });
      const reset = async () => {
        await pool.query(
          "TRUNCATE wa_exchanges,wa_auth_deliveries,wa_challenges,wa_receipts,wa_limits",
        );
        await pool.query(
          "UPDATE wa_tenants SET paused=false,auth_enabled=true",
        );
      };
      const envelope = (challenge, identity = {}) => {
        const message = new URL(challenge.whatsappUrl).searchParams.get("text");
        const body = {
          event: "message.received",
          sessionId: session,
          timestamp: new Date().toISOString(),
          idempotencyKey: randomUUID(),
          deliveryId: randomUUID(),
          data: {
            id: randomUUID(),
            from: phone.slice(1) + "@c.us",
            to: central.slice(1) + "@c.us",
            chatId: phone.slice(1) + "@c.us",
            fromMe: false,
            isGroup: false,
            type: "text",
            timestamp: Math.floor(Date.now() / 1000),
            body: message,
            ...identity,
          },
        };
        const raw = Buffer.from(JSON.stringify(body));
        return {
          raw,
          headers: {
            "x-openwa-signature":
              "sha256=" +
              createHmac("sha256", secret).update(raw).digest("hex"),
            "x-openwa-event": body.event,
            "x-openwa-idempotency-key": body.idempotencyKey,
            "x-openwa-delivery-id": body.deliveryId,
          },
        };
      };
      const reply = async (challenge) => {
        const event = envelope(challenge);
        assert.deepEqual(await service.receive(event.raw, event.headers), {
          queued: true,
        });
        const {
          rows: [delivery],
        } = await pool.query(
          "SELECT * FROM wa_auth_deliveries WHERE challenge_id=$1",
          [challenge.id],
        );
        const plaintext = service.vault.open(
          delivery.id,
          delivery.payload_sealed,
        );
        const code = /verifikasi Toko Uji: (\d{6})/.exec(plaintext)[1];
        assert.ok(!delivery.payload_sealed.includes(code));
        return { code, event };
      };
      const sent = (id) =>
        pool.query("UPDATE wa_challenges SET state='reply_sent' WHERE id=$1", [
          id,
        ]);

      await t.test(
        "closed by default and recipient admission is explicit",
        async () => {
          const disabled = new WhatsAppAuth({
            pool,
            secret,
            webhookSecret: secret,
            centralPhone: central,
          });
          await assert.rejects(
            disabled.start(token, { phone, browserProof }),
            /whatsapp_unavailable/,
          );
          await assert.rejects(
            service.start(token, { phone: "+6281234567890", browserProof }),
            /pilot_recipient_required/,
          );
        },
      );
      await t.test(
        "resolved LID queues only the challenge bound to its proven phone",
        async () => {
          await reset();
          const challenge = await start();
          const identity = {
            from: "999999999999999@lid",
            chatId: "999999999999999@lid",
            isLidSender: true,
            senderPhone: phone.slice(1),
          };
          const wrong = envelope(challenge, {
            ...identity,
            senderPhone: "6289999999999",
          });
          await assert.rejects(
            service.receive(wrong.raw, wrong.headers),
            /pilot_recipient_required/,
          );
          const event = envelope(challenge, identity);
          assert.deepEqual(await service.receive(event.raw, event.headers), {
            queued: true,
          });
          assert.deepEqual(await service.receive(event.raw, event.headers), {
            ignored: true,
          });
          const result = await pool.query(
            "SELECT state,phone FROM wa_challenges WHERE id=$1",
            [challenge.id],
          );
          assert.equal(result.rows[0].state, "reply_queued");
          assert.equal(result.rows[0].phone, phone);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS n FROM wa_auth_deliveries",
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (await pool.query("SELECT count(*)::int AS n FROM wa_exchanges"))
              .rows[0].n,
            0,
          );
        },
      );
      await t.test(
        "incoming challenge alone never logs browser in; hash-only secret and durable dedup",
        async () => {
          await reset();
          const challenge = await start(),
            { code, event } = await reply(challenge);
          assert.deepEqual(await service.receive(event.raw, event.headers), {
            ignored: true,
          });
          assert.equal(
            (await pool.query("SELECT count(*) FROM wa_auth_deliveries"))
              .rows[0].count,
            "1",
          );
          await assert.rejects(
            service.finish(token, { id: challenge.id, browserProof, code }),
            /challenge_invalid/,
          );
          assert.equal(
            (await pool.query("SELECT count(*) FROM wa_exchanges")).rows[0]
              .count,
            "0",
          );
          const stored = (await pool.query("SELECT * FROM wa_challenges"))
            .rows[0];
          assert.notEqual(stored.reply_digest, code);
          assert.equal(
            stored.public_digest,
            hash(
              new URL(challenge.whatsappUrl).searchParams
                .get("text")
                .split(" ")[2],
            ),
          );
        },
      );
      await t.test(
        "tenant/browser binding, race consumption and one-time audience exchange",
        async () => {
          await reset();
          const challenge = await start(),
            { code } = await reply(challenge);
          await sent(challenge.id);
          await assert.rejects(
            service.status(otherToken, { id: challenge.id, browserProof }),
            /challenge_invalid/,
          );
          await assert.rejects(
            service.finish(token, {
              id: challenge.id,
              browserProof: "f".repeat(64),
              code,
            }),
            /challenge_invalid/,
          );
          const results = await Promise.allSettled(
            Array.from({ length: 8 }, () =>
              service.finish(token, { id: challenge.id, browserProof, code }),
            ),
          );
          assert.equal(
            results.filter((r) => r.status === "fulfilled").length,
            1,
          );
          const exchange = results.find((r) => r.status === "fulfilled").value
            .exchange;
          await assert.rejects(
            service.exchange(otherToken, { exchange, browserProof }),
            /exchange_invalid/,
          );
          await assert.rejects(
            service.exchange(token, { exchange, browserProof: "f".repeat(64) }),
            /exchange_invalid/,
          );
          const values = await Promise.allSettled(
            Array.from({ length: 8 }, () =>
              service.exchange(token, { exchange, browserProof }),
            ),
          );
          assert.equal(
            values.filter((r) => r.status === "fulfilled").length,
            1,
          );
          assert.deepEqual(values.find((r) => r.status === "fulfilled").value, {
            phone,
            purpose: "login",
            transaction: challenge.id,
            tenant,
            audience: "https://" + tenant + ".test",
          });
        },
      );
      await t.test(
        "five wrong attempts persist and lock even with correct code afterwards",
        async () => {
          await reset();
          const challenge = await start(),
            { code } = await reply(challenge);
          await sent(challenge.id);
          const wrong = code === "000000" ? "000001" : "000000";
          for (let i = 0; i < 5; i++)
            await assert.rejects(
              service.finish(token, {
                id: challenge.id,
                browserProof,
                code: wrong,
              }),
            );
          await assert.rejects(
            service.finish(token, { id: challenge.id, browserProof, code }),
          );
          const stored = (
            await pool.query("SELECT attempts,state FROM wa_challenges")
          ).rows[0];
          assert.deepEqual(stored, { attempts: 5, state: "locked" });
        },
      );
      await t.test(
        "expiration and tenant pause invalidate completion",
        async () => {
          await reset();
          const challenge = await start(),
            { code } = await reply(challenge);
          await sent(challenge.id);
          await pool.query("UPDATE wa_tenants SET paused=true WHERE id=$1", [
            tenant,
          ]);
          await assert.rejects(
            service.finish(token, { id: challenge.id, browserProof, code }),
            /access_denied/,
          );
          await pool.query("UPDATE wa_tenants SET paused=false WHERE id=$1", [
            tenant,
          ]);
          await pool.query(
            "UPDATE wa_challenges SET expires_at=now()-interval '1 second'",
          );
          await assert.rejects(
            service.finish(token, { id: challenge.id, browserProof, code }),
            /challenge_invalid/,
          );
          assert.equal(
            (await service.status(token, { id: challenge.id, browserProof }))
              .state,
            "expired",
          );
        },
      );
      await t.test(
        "concurrent start has global phone cooldown and three per hour cap",
        async () => {
          await reset();
          const results = await Promise.allSettled(
            Array.from({ length: 8 }, start),
          );
          assert.equal(
            results.filter((r) => r.status === "fulfilled").length,
            1,
          );
          for (let i = 0; i < 2; i++) {
            await pool.query(
              "UPDATE wa_challenges SET created_at=now()-interval '61 seconds'",
            );
            await start();
          }
          await pool.query(
            "UPDATE wa_challenges SET created_at=now()-interval '61 seconds'",
          );
          await assert.rejects(start(), /rate_limited/);
        },
      );
      await t.test(
        "queued OTP sends once with stable key; plaintext erased after submission",
        async () => {
          await reset();
          const challenge = await start(),
            { code } = await reply(challenge);
          let calls = 0;
          const gateway = {
            status: async () => ({
              status: "ready",
              loaded: true,
              phone: central,
            }),
            sendText: async (id, to, text, key) => {
              calls++;
              assert.equal(id, session);
              assert.equal(to, phone);
              assert.ok(text.includes(code));
              assert.match(key, /^[a-f0-9-]{36}$/);
              return { messageId: "provider-test", state: "submitted" };
            },
          };
          const worker = new AuthDelivery({ auth: service, gateway });
          await Promise.all([worker.tick(), worker.tick(), worker.tick()]);
          assert.equal(calls, 1);
          assert.equal((await worker.tick()).state, "idle");
          const delivery = (
            await pool.query("SELECT * FROM wa_auth_deliveries")
          ).rows[0];
          assert.equal(delivery.state, "submitted");
          assert.equal(delivery.payload_sealed, null);
          assert.ok(
            (
              await service.finish(token, {
                id: challenge.id,
                browserProof,
                code,
              })
            ).exchange,
          );
        },
      );
      await t.test(
        "timeout after submit is unknown and not resent; restart also fences sending",
        async () => {
          await reset();
          const challenge = await start();
          await reply(challenge);
          let calls = 0;
          const worker = new AuthDelivery({
            auth: service,
            gateway: {
              status: async () => ({
                status: "ready",
                loaded: true,
                phone: central,
              }),
              sendText: async () => {
                calls++;
                throw Error("network lost");
              },
            },
          });
          assert.equal((await worker.tick()).state, "unknown");
          assert.equal((await worker.tick()).state, "idle");
          assert.equal(calls, 1);
          await pool.query("UPDATE wa_auth_deliveries SET state='sending'");
          await worker.tick();
          assert.equal(
            (await pool.query("SELECT state FROM wa_auth_deliveries")).rows[0]
              .state,
            "unknown",
          );
          assert.equal(calls, 1);
        },
      );
      await t.test(
        "expiry, pause and changed central session cancel queued codes",
        async () => {
          for (const mutation of [
            "UPDATE wa_challenges SET expires_at=now()-interval '1 second'; UPDATE wa_auth_deliveries SET expires_at=now()-interval '1 second'",
            "UPDATE wa_tenants SET paused=true",
            "UPDATE wa_sessions SET generation=generation+1",
          ]) {
            await reset();
            const challenge = await start();
            await reply(challenge);
            await pool.query(mutation);
            const worker = new AuthDelivery({
              auth: service,
              gateway: {
                status: async () => {
                  throw Error("should not contact provider");
                },
                sendText: async () => {
                  throw Error("should not send");
                },
              },
            });
            assert.equal((await worker.tick()).state, "idle");
            assert.equal(
              (
                await pool.query(
                  "SELECT payload_sealed FROM wa_auth_deliveries",
                )
              ).rows[0].payload_sealed,
              null,
            );
          }
        },
      );
      await t.test(
        "token generation rotation invalidates completed but unconsumed exchange",
        async () => {
          await reset();
          const challenge = await start(),
            { code } = await reply(challenge);
          await sent(challenge.id);
          const { exchange } = await service.finish(token, {
            id: challenge.id,
            browserProof,
            code,
          });
          await pool.query(
            "UPDATE wa_tenants SET generation=generation+1 WHERE id=$1",
            [tenant],
          );
          await assert.rejects(
            service.exchange(token, { exchange, browserProof }),
            /exchange_invalid/,
          );
        },
      );
      await t.test(
        "central session rotation invalidates a completed exchange before consumption",
        async () => {
          await reset();
          const challenge = await start(),
            { code } = await reply(challenge);
          await sent(challenge.id);
          const { exchange } = await service.finish(token, {
            id: challenge.id,
            browserProof,
            code,
          });
          await pool.query(
            "UPDATE wa_sessions SET generation=generation+1 WHERE provider_id=$1",
            [session],
          );
          await assert.rejects(
            service.exchange(token, { exchange, browserProof }),
            /exchange_invalid/,
          );
        },
      );
    } finally {
      await pool.end();
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
    }
  },
);
