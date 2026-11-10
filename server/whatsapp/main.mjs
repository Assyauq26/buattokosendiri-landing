import pg from "pg";
import { OpenWA } from "./openwa.mjs";
import { WhatsAppAuth } from "./auth.mjs";
import { SellerSessions } from "./sessions.mjs";
import { Notifications } from "./notifications.mjs";
import { AuthDelivery } from "./auth-delivery.mjs";
import { NotificationDelivery } from "./notification-delivery.mjs";
import { createWhatsAppServer } from "./http.mjs";
import { centralPairing } from "./central-pairing.mjs";

const pool = new pg.Pool({
  connectionString: process.env.WA_DATABASE_URL,
  max: 8,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
});
const gateway = new OpenWA({
  origin: process.env.OPENWA_PRIVATE_ORIGIN,
  apiKey: process.env.OPENWA_API_KEY,
});
const auth = new WhatsAppAuth({
  pool,
  secret: process.env.WA_SECRET,
  webhookSecret: process.env.OPENWA_WEBHOOK_SECRET,
  centralPhone: process.env.WA_CENTRAL_PHONE,
  enabled: process.env.WA_AUTH_ENABLED === "1",
  allowedRecipients: (process.env.WA_ALLOWED_RECIPIENTS || "")
    .split(",")
    .filter(Boolean),
});
const sessions = new SellerSessions({
  auth,
  gateway,
  enabled: process.env.WA_SERVICE_ENABLED === "1",
});
const notifications = new Notifications({
  auth,
  sessions,
  gateway,
  enabled: process.env.WA_NOTIFICATIONS_ENABLED === "1",
});
const authWorker = new AuthDelivery({ auth, gateway }),
  notificationWorker = new NotificationDelivery({ notifications });
let stopping = false;
async function syncCentral() {
  const {
    rows: [s],
  } = await pool.query("SELECT * FROM wa_sessions WHERE purpose='central'");
  if (!s || !s.connection_enabled) return;
  let actual;
  try {
    actual = await gateway.status(s.provider_id);
  } catch {
    actual = { status: "disconnected" };
  }
  if (actual.phone && actual.phone !== auth.centralPhone) {
    await pool.query(
      "UPDATE wa_sessions SET state='failed',connected_phone=NULL,generation=generation+1,connection_enabled=false WHERE provider_id=$1",
      [s.provider_id],
    );
    try {
      await gateway.logout(s.provider_id);
    } catch {}
    return;
  }
  const ready =
    actual.status === "ready" &&
    actual.loaded &&
    actual.phone === auth.centralPhone &&
    s.expected_phone === auth.centralPhone;
  if (!ready && s.state === "ready")
    await pool.query(
      "UPDATE wa_sessions SET state='disconnected',connected_phone=NULL,generation=generation+1 WHERE provider_id=$1 AND state='ready'",
      [s.provider_id],
    );
  else if (ready)
    await pool.query(
      "UPDATE wa_sessions SET state='ready',connected_phone=$2 WHERE provider_id=$1",
      [s.provider_id, actual.phone],
    );
}
async function loop() {
  while (!stopping) {
    // Only fixed error categories are logged. Provider payloads, phone numbers,
    // bodies, tokens, QR, and raw exceptions never enter process logs.
    try {
      await syncCentral();
      if (auth.enabled) await authWorker.tick();
      if (notifications.enabled) await notificationWorker.tick();
    } catch {
      console.error("whatsapp_worker_unavailable");
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
const port = Number(process.env.WA_PORT || 8092),
  host = process.env.WA_BIND_HOST || "127.0.0.1";
if (
  !["127.0.0.1", "0.0.0.0"].includes(host) ||
  !Number.isSafeInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw Error("invalid_listener");
const server = createWhatsAppServer({ auth, sessions, notifications });
const pairing =
  process.env.WA_OPERATOR_PAIRING === "1"
    ? centralPairing({ pool, gateway, centralPhone: auth.centralPhone })
    : null;
server.listen(port, host, () => console.log("whatsapp_private_service_ready"));
void loop();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
    server.close();
    pairing?.close();
    setTimeout(() => pool.end().finally(() => process.exit(0)), 15000).unref();
  });
