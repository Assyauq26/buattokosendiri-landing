// Explicit opt-in live provider verification, not part of ordinary CI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { createApp, CONSENT } from '../server/app.mjs';
const url = new URL(process.env.MAIL_TEST_DATABASE_URL || '');
const recipient = process.env.MAIL_LIVE_RECIPIENT, host = process.env.MAIL_LIVE_SSH_HOST;
if (url.hostname !== '127.0.0.1' || url.pathname !== '/postgres' || !recipient || !/^[a-z][a-z0-9-]+$/.test(host || ''))
  throw Error('Explicit isolated DB, authorized recipient and SSH alias required');
const admin = new pg.Pool({ connectionString: url.href });
const dbName = 'platform_m1_live_mail_test';
let pool, server, created = false, otp;
const original = globalThis.fetch;
try {
  await admin.query('CREATE DATABASE ' + dbName); created = true;
  url.pathname = '/' + dbName;
  pool = new pg.Pool({ connectionString: url.href });
  await pool.query(readFileSync(new URL('../server/schema.sql', import.meta.url), 'utf8'));
  globalThis.fetch = async (input, init) => {
    if (input !== 'https://api.resend.com/emails') return original(input, init);
    const message = JSON.parse(init.body);
    assert.deepEqual(message.to, [recipient]);
    assert.equal(message.from, 'Buattokosendiri <otp@buattokosendiri.web.id>');
    const child = spawn('ssh', ['-o', 'BatchMode=yes', host, 'sudo', '-n', '/opt/btos-mail-candidate-test/send'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.resume();
    child.stdin.end(init.body);
    assert.equal((await once(child, 'exit'))[0], 0);
    const evidence = JSON.parse(output);
    assert.match(evidence.id, /^[a-f0-9-]{36}$/);
    otp = message.text.match(/Anda: (\d{6})/)[1];
    console.log(JSON.stringify({ providerAccepted: true, id: evidence.id, from: message.from, subject: message.subject }));
    return new Response('{}', { status: 200 });
  };
  const origin = 'http://127.0.0.1:18183';
  server = createApp({ pool, config: { local: true, origin, secret: randomBytes(32).toString('hex'),
    releases: [], resendKey: 'operator-stdin-adapter-not-a-provider-key', sellerPilotOnly: false } });
  await new Promise(r => server.listen(18183, '127.0.0.1', r));
  async function request(path, body, cookie) {
    const response = await original(origin + '/api/platform' + path, { method: body ? 'POST' : 'GET',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const challenge = await request('/otp/request', { email: recipient, consent: CONSENT });
  assert.equal(challenge.status, 200);
  const verification = { challenge: challenge.body.challenge, code: otp };
  const login = await request('/otp/verify', verification);
  assert.equal(login.status, 200);
  assert.equal((await request('/otp/verify', verification)).status, 401);
  assert.equal((await request('/session', null, login.cookie)).status, 200);
  assert.equal((await request('/logout', {}, login.cookie)).status, 200);
  assert.equal((await request('/session', null, login.cookie)).status, 401);
  console.log('PASS: real-provider platform OTP, replay rejection, session and logout');
} finally {
  globalThis.fetch = original;
  if (server) await new Promise(r => server.close(r));
  if (pool) await pool.end();
  if (created) await admin.query('DROP DATABASE ' + dbName);
  await admin.end();
}
