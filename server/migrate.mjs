import pg from "pg";
import { readFileSync } from "node:fs";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(
    readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
  );
  console.log("Platform schema ready");
} finally {
  await pool.end();
}
