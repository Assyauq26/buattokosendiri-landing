import pg from "pg";
import { config } from "./config.mjs";
import { createApp } from "./app.mjs";
const cfg = config();
const pool = new pg.Pool({
  connectionString: cfg.database,
  max: 8,
  statement_timeout: 15000,
});
const app = createApp({ pool, config: cfg });
await pool.query("SELECT id FROM sellers LIMIT 0");
app.listen(cfg.port, cfg.host, () => console.log("Central platform listening"));
const cleanup = setInterval(async () => {
  try {
    await pool.query(
      "DELETE FROM sessions WHERE expires_at<now(); DELETE FROM otp_challenges WHERE expires_at<now()-interval '1 day'; DELETE FROM rate_limits WHERE expires_at<now()-interval '1 day'; DELETE FROM pairings WHERE expires_at<now()-interval '1 day'",
    );
  } catch {
    console.error("retention_cleanup_failed");
  }
}, 3600000);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    clearInterval(cleanup);
    app.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
