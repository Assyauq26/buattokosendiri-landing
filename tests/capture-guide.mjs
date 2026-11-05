// Real UI screenshots on an isolated local database. Mail is a local test adapter.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
const release = { repository: "Assyauq26/buattokoonline", version: "v1.0.0", sha: "a".repeat(40), approved: true };
const origin = "http://127.0.0.1:18182";
const app = createApp({
  pool,
  config: {
    origin,
    local: true,
    secret: "capture-local-only-".repeat(3),
    releases: [release],
    installerTestEmails: ["rani@example.com"],
  },
  checkDns: async () => "ready",
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
  await page.locator("#vps-ipv4").fill("203.0.113.10");
  await page.screenshot({
    path: "panduan-instalasi/assets/m1-store.png",
    fullPage: true,
  });
  await page.locator("#vps-ipv4").fill("8.8.4.4");
  await page.locator("#admin-password").fill("Capture-test-only-2026!");
  await page.locator("#admin-password-confirmation").fill("Capture-test-only-2026!");
  await page.getByRole("button", { name: "Simpan & lanjutkan" }).click();
  await page.locator('[data-panel="3"]').waitFor({ state: "visible" });
  await page.screenshot({
    path: "panduan-instalasi/assets/m1-pair.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Buat perintah pairing" }).click();
  await page.locator("#pairing").waitFor({ state: "visible" });
  const credential = randomBytes(32).toString("hex");
  async function agent(path, body) {
    const response = await fetch(origin + "/api/platform/agent/" + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: "Bearer " + credential, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw Error("Local agent " + path + " returned " + response.status);
    return response.json();
  }
  await agent("pair", { credential, token: await page.locator("#pair-token").inputValue(), protocol: 2, ipv4: "8.8.4.4" });
  const { job } = await agent("job");
  await agent("event", { jobId: job.id, stage: "database", state: "running", sequence: 1 });
  await page.getByRole("progressbar", { name: "Progres instalasi" }).waitFor({ state: "visible" });
  if (await page.locator("#install-percent").textContent() !== "72%") throw Error("Unexpected progress");
  await page.setViewportSize({ width: 390, height: 844 });
  mkdirSync(".local/ui", { recursive: true });
  await page.screenshot({ path: ".local/ui/mobile.png", fullPage: true });
  if (
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  )
    throw Error("Mobile overflow");
  if (errors.length) throw Error(errors.join("\n"));
  await agent("event", {
    jobId: job.id, stage: "complete", state: "complete", sequence: 2,
    evidence: { https: "PUBLIC_CERTIFICATE_VALID", application: "healthy", version: release.version, source_sha: release.sha },
  });
  await page.locator("#chosen-password").waitFor({ state: "visible" });
  if (await page.locator("#legacy-password").isVisible()) throw Error("Unexpected legacy password instructions");
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
    "Real UI: email → OTP → store → pairing → progress → dashboard; mobile layout checked.",
  );
} finally {
  await browser.close();
  await new Promise((r) => app.close(r));
  await pool.end();
}
