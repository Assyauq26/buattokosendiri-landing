// Real UI screenshots on an isolated local database. Mail is a local test adapter.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
import pg from "pg";
import { createApp } from "../server/app.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
if (!process.env.TEST_DATABASE_URL?.endsWith("/platform_m1_test"))
  throw Error("Dedicated test DB required");
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
await pool.query(
  readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8"),
);
await pool.query(
  "TRUNCATE sellers,otp_challenges,sessions,rate_limits,stores,agents,pairings,jobs,job_events CASCADE",
);
let code;
const origin = "http://127.0.0.1:18182";
const app = createApp({
  pool,
  config: {
    origin,
    local: true,
    secret: "capture-local-only-".repeat(3),
    releases: [],
  },
  sendMail: async (_email, value) => {
    code = value;
  },
});
await new Promise((r) => app.listen(18182, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 1000 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/pendaftaran");
  await page.locator('[data-panel="1"]').waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: "panduan-instalasi/assets/m1-email.png",
    fullPage: true,
  });
  await page.locator("#email").fill("rani@example.com");
  await page.locator("#consent").check();
  await page
    .getByRole("button", { name: "Kirim kode OTP", exact: true })
    .click();
  await page.locator("#otp-form").waitFor({ state: "visible" });
  await page.locator("#otp").fill(code);
  await page.getByRole("button", { name: "Verifikasi & lanjutkan" }).click();
  await page.locator('[data-panel="2"]').waitFor({ state: "visible" });
  await page.locator("#store-name").fill("Toko Ceria");
  await page.locator("#domain").fill("tokoceria.example.com");
  await page.screenshot({
    path: "panduan-instalasi/assets/m1-store.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Simpan & lanjutkan" }).click();
  await page.locator('[data-panel="3"]').waitFor({ state: "visible" });
  await page.screenshot({
    path: "panduan-instalasi/assets/m1-pair.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Buat perintah pairing" }).click();
  await page.locator("#error").waitFor({ state: "visible" });
  if (!(await page.locator("#error").innerText()).includes("rilis"))
    throw Error("Unapproved installer must be blocked");
  await page.setViewportSize({ width: 390, height: 844 });
  mkdirSync(".local/ui", { recursive: true });
  await page.screenshot({ path: ".local/ui/mobile.png", fullPage: true });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw Error("Mobile overflow");
  if (errors.length) throw Error(errors.join("\n"));
  if (process.env.GENERATE_PDF === "1") {
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(origin + "/panduan-instalasi/");
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((i) => i.decode()));
    });
    await page.pdf({
      path: "panduan-instalasi/panduan-instalasi.pdf",
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="font-size:8px;width:100%;padding:0 16mm;color:#666;display:flex;justify-content:space-between"><span>Buat Toko Online Sendiri · Panduan M1</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    });
  }
  console.log(
    "Real UI: email → OTP → store → pairing; unavailable release blocked; mobile layout checked.",
  );
} finally {
  await browser.close();
  await new Promise((r) => app.close(r));
  await pool.end();
}
