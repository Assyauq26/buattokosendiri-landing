import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createApp } from "../server/app.mjs";
import { session, hash } from "./operations-fixture.mjs";
import { installerPasswordVault } from "../server/store-setup.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "@playwright/test");
const database = new URL(process.env.TEST_DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(database.hostname));
assert.equal(database.pathname, "/platform_m1_test");
const pool = new pg.Pool({ connectionString: database.href });
const origin = "http://127.0.0.1:18184";
const fixtures = [];
const secret = "local-browser-only".repeat(3);
const server = createApp({
  pool, config: { origin, local: true, secret, installerLatest: true, releases: [] },
  resolveInstallerRelease: async () => ({ repository:"Assyauq26/buattokoonline", version:"v1.7.2", sha:"a".repeat(40), approved:true }),
  checkDns: async () => "ready",
  sendMail: async () => { throw Error("No mail in browser tests"); },
});
let browser;
try {
  const operator = await session(pool, randomUUID() + "@example.test", "super_admin");
  fixtures.push(operator.id);
  const owner = await session(pool, randomUUID() + "@example.test");
  fixtures.push(owner.id);
  const id = randomUUID();
  await pool.query(`INSERT INTO stores(id,seller_id,name,domain,admin_email,vps_ipv4,admin_password_sealed)
    VALUES($1,$2,'Hubify Demo',$3,'owner@example.test','8.8.4.4',$4)`,
    [id, owner.id, randomUUID() + ".example.test", installerPasswordVault(secret).seal(id, "Disposable-password-2026!")]);
  await new Promise(resolve => server.listen(18184, "127.0.0.1", resolve));
  await mkdir("output/operations", { recursive: true });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin + "/admin/");
  await page.getByRole("heading", { name: "Masuk dengan email operator" }).waitFor();
  await context.addCookies([{ name: "btos_session", value: operator.cookie.split("=")[1], url: origin, httpOnly: true, sameSite: "Strict" }]);
  for (const width of [360, 390, 430, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin + "/admin/?q=Hubify%20Demo");
    await page.getByRole("link", { name: "Lihat detail", exact: true }).waitFor();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) {
      console.log(await page.locator("*").evaluateAll(nodes => nodes.filter(node =>
        node.getBoundingClientRect().right > innerWidth + 1).map(node => ({
        tag: node.tagName, id: node.id, className: node.className,
        right: node.getBoundingClientRect().right,
      })).slice(-15)));
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: `output/operations/tenants-${width}.png`, fullPage: true });
    await page.getByRole("link", { name: "Lihat detail", exact: true }).click();
    await page.getByRole("heading", { name: "Tenant dan pemilik" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.equal(await page.locator("#actions").isVisible(), true);
    assert.equal(await page.locator("#action").inputValue(), "release-ip");
    await page.getByLabel("Alasan", { exact: true }).fill("Periksa fokus pada tindakan");
    await page.getByLabel("Ketik ID tenant", { exact: true }).fill(id);
    await page.screenshot({ path: `output/operations/detail-${width}.png`, fullPage: true });
  }
  await page.goto(origin + "/admin/?q=nama-yang-tidak-ada");
  await page.getByText("Tenant tidak ditemukan.", { exact: true }).waitFor();
  await context.clearCookies();
  await context.addCookies([{ name: "btos_session", value: owner.cookie.split("=")[1], url: origin, httpOnly: true, sameSite: "Strict" }]);
  for (const width of [360,390,430,1440]) {
    await page.setViewportSize({width,height:950});
    await page.goto(origin + "/pendaftaran/");
    await page.getByRole("button",{name:"Siapkan instalasi",exact:true}).waitFor();
    assert.equal(await page.locator("#service-requests").count(),0);
    assert.equal(await page.locator("#pair-token").count(),0);
    await page.getByRole("button",{name:"Siapkan instalasi",exact:true}).click();
    await page.locator("#pairing").waitFor({state:"visible"});
    await page.getByText("Versi v1.7.2 siap dipasang.", {exact:true}).waitFor();
    assert.match(await page.locator("#command").inputValue(),/--enroll <<'BTOS_ENROLLMENT'/);
    assert.equal(await page.getByRole("button",{name:"Salin perintah",exact:true}).count(),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await page.screenshot({path:`output/operations/one-paste-${width}.png`,fullPage:true,mask:[page.locator("#command")]});
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ responsive: [360, 390, 430, 1440], anonymousLogin: "PASS",
    realDatabaseSearchAndDetail: "PASS", missingTenant: "PASS", publicOnePaste: "PASS", noSeparateTokenOrServiceCard:"PASS", messagesSent: 0 }));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await pool.query("DELETE FROM sessions WHERE seller_id=ANY($1::uuid[])", [fixtures]);
  await pool.query("DELETE FROM pairings WHERE store_id IN (SELECT id FROM stores WHERE seller_id=ANY($1::uuid[]))", [fixtures]);
  await pool.query("DELETE FROM stores WHERE seller_id=ANY($1::uuid[])", [fixtures]);
  await pool.query("DELETE FROM platform_admins WHERE seller_id=ANY($1::uuid[])", [fixtures]);
  await pool.query("DELETE FROM sellers WHERE id=ANY($1::uuid[])", [fixtures]);
  await pool.end();
}
