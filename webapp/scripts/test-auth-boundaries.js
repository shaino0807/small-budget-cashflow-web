// Synthetic loopback-only regression for browser-bound OAuth and request parsing.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const app = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-auth-boundaries-'));
Object.assign(process.env, {
  CUSTOMER_DATA_DIR: dataDir, CUSTOMER_DATA_KEY: crypto.randomBytes(32).toString('base64'),
  ACCESS_CODE_PEPPER: crypto.randomBytes(32).toString('hex'), ADMIN_API_KEY: crypto.randomBytes(32).toString('hex'),
  SMOKE_TEST: '1', LINE_REPLY_DISABLED: '1', LINE_RICH_MENU_AUTO_DEPLOY: '0', LINE_AI_PARSER_ENABLED: '0', LINE_IMAGE_PARSER_ENABLED: '0'
});
const { createStore } = require('../customer-store');
const store = createStore();
const victim = store.findOrCreateUserByLineId('U' + '2'.repeat(32));
const victimToken = store.createUserSession(victim.id).token;
const victimCookie = '__Host-cashflow_session=' + victimToken;
const providerUser = 'U' + '9'.repeat(32);
const db = new DatabaseSync(path.join(dataDir, 'customers.sqlite'));
const codes = new Map(), tokens = new Map(), tests = [];
let exchanges = 0, base, child, stderr = '';
const cookiePair = value => value.split(';')[0];
const sessionCookie = response => response.headers.getSetCookie().find(c => c.startsWith('__Host-cashflow_session='));
const provider = http.createServer(async (req, res) => {
  let raw = ''; for await (const b of req) raw += b;
  const form = new URLSearchParams(raw);
  res.setHeader('Content-Type', 'application/json');
  function invalid() { res.writeHead(400); res.end(JSON.stringify({ error: 'synthetic_invalid_grant' })); }
  if (req.url === '/oauth2/v2.1/token') {
    const tx = codes.get(form.get('code')); codes.delete(form.get('code'));
    const digest = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
    if (!tx || tx.challenge !== digest || form.get('client_id') !== 'test-boundaries' || form.get('redirect_uri') !== base + '/api/auth/line/callback') return invalid();
    exchanges++; const token = crypto.randomUUID(); tokens.set(token, tx);
    res.end(JSON.stringify({ id_token: token })); return;
  }
  if (req.url === '/oauth2/v2.1/verify') {
    const tx = tokens.get(form.get('id_token'));
    if (!tx || form.get('client_id') !== 'test-boundaries' || form.get('nonce') !== tx.nonce) return invalid();
    res.end(JSON.stringify({ sub: providerUser, name: 'Synthetic' })); return;
  }
  res.writeHead(404); res.end('{}');
});
async function request(route, cookie = '') {
  const response = await fetch(base + route, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(5000) });
  const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = null; }
  return { status: response.status, headers: response.headers, body };
}
async function issue(options = {}) {
  const start = await request('/api/auth/line/start?returnTo=inputView');
  assert.equal(start.status, 302);
  const url = new URL(start.headers.get('location')), state = url.searchParams.get('state'), code = crypto.randomUUID();
  codes.set(code, { challenge: options.badPkce ? 'wrong' : url.searchParams.get('code_challenge'), nonce: options.badNonce ? 'wrong' : url.searchParams.get('nonce') });
  const rawCookie = start.headers.getSetCookie().find(c => c.startsWith('__Host-cashflow_oauth_')) || '';
  return { state, rawCookie, cookie: cookiePair(rawCookie), callback: '/api/auth/line/callback?state=' + state + '&code=' + code };
}
function rejected(r) { assert.equal(r.status, 303); assert.ok(r.headers.get('location').includes('authError=')); assert.equal(sessionCookie(r), undefined); }
async function valid(tx, extra = '') {
  const r = await request(tx.callback, [tx.cookie, extra].filter(Boolean).join('; '));
  assert.equal(r.status, 303); assert.ok(r.headers.get('location').includes('auth=line'));
  assert.ok(sessionCookie(r));
  const identity = await request('/api/auth/session', cookiePair(sessionCookie(r)));
  assert.equal(identity.body.user.id, store.findOrCreateUserByLineId(providerUser).id);
  return r;
}
async function test(name, fn) { try { await fn(); tests.push({ name, pass: true }); } catch (e) { tests.push({ name, pass: false, error: e.message }); } }
async function main() {
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const reserve = http.createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r));
  const port = reserve.address().port; await new Promise(r => reserve.close(r)); base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, [path.join(app, 'server.js')], { cwd: app, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, PORT: String(port), ALLOWED_ORIGINS: base, API_PUBLIC_BASE_URL: base, SITE_PUBLIC_BASE_URL: base,
    LINE_LOGIN_CHANNEL_ID: 'test-boundaries', LINE_LOGIN_CHANNEL_SECRET: crypto.randomBytes(24).toString('hex'),
    LINE_LOGIN_API_BASE: 'http://127.0.0.1:' + provider.address().port, LINE_LOGIN_AUTHORIZE_URL: 'http://127.0.0.1:' + provider.address().port + '/authorize'
  } });
  child.stderr.on('data', b => stderr += b);
  try {
    let ready = false; for (let i = 0; i < 60; i++) { try { if ((await request('/api/health')).status === 200) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.ok(ready, 'local server ready');
    await test('OAuth start sets short-lived host-only secret cookie', async () => {
      const tx = await issue(); assert.match(tx.rawCookie, /^__Host-cashflow_oauth_[A-Za-z0-9_-]{32}=[A-Za-z0-9_-]{43};/);
      for (const flag of ['Path=/', 'Max-Age=600', 'HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(tx.rawCookie.includes(flag));
      assert.ok(!/Domain=/i.test(tx.rawCookie));
      assert.ok(!JSON.stringify(db.prepare('SELECT * FROM auth_challenges').all()).includes(tx.cookie.split('=')[1]));
    });
    await test('transferred callback cannot replace existing victim session or consume owner transaction', async () => {
      const tx = await issue(), before = exchanges; rejected(await request(tx.callback, victimCookie)); assert.equal(exchanges, before);
      assert.equal((await request('/api/auth/session', victimCookie)).body.user.id, victim.id); await valid(tx);
    });
    await test('forged binding rejected before exchange, legitimate retry succeeds', async () => {
      const tx = await issue(), before = exchanges; rejected(await request(tx.callback, tx.cookie.split('=')[0] + '=' + 'A'.repeat(43))); assert.equal(exchanges, before); await valid(tx);
    });
    await test('another transaction cookie cannot authorize the callback', async () => {
      const a = await issue(), b = await issue(); rejected(await request(a.callback, b.cookie)); await valid(a); await valid(b);
    });
    await test('two tabs complete independently without clearing each other', async () => {
      const a = await issue(), b = await issue(); const r = await valid(a, b.cookie);
      assert.ok(r.headers.getSetCookie().some(c => c.startsWith(a.cookie.split('=')[0] + '=;') && c.includes('Max-Age=0')));
      assert.ok(!r.headers.getSetCookie().some(c => c.startsWith(b.cookie.split('=')[0] + '='))); await valid(b);
    });
    await test('replay and unknown state cannot issue a session', async () => {
      const tx = await issue(); await valid(tx); rejected(await request(tx.callback, tx.cookie)); rejected(await request('/api/auth/line/callback?state=missing&code=missing'));
    });
    await test('expired binding cannot issue a session', async () => {
      const tx = await issue(); db.prepare('UPDATE auth_challenges SET expires_at=?').run('2000-01-01T00:00:00Z'); rejected(await request(tx.callback, tx.cookie));
    });
    await test('wrong nonce and PKCE still fail after browser validation', async () => {
      for (const options of [{ badNonce: true }, { badPkce: true }]) { const tx = await issue(options); rejected(await request(tx.callback, tx.cookie)); }
    });
    await test('cancelled callback does not change current login', async () => {
      const tx = await issue(); rejected(await request(tx.callback + '&error=access_denied', tx.cookie + '; ' + victimCookie)); assert.equal((await request('/api/auth/session', victimCookie)).body.user.id, victim.id);
    });
    await test('malformed binding is rejected without consuming transaction', async () => {
      const tx = await issue(); rejected(await request(tx.callback, tx.cookie.split('=')[0] + '=%')); await valid(tx);
    });
    await test('malformed URL returns 400 and same process serves subsequent requests', async () => {
      const pid = child.pid;
      for (const suffix of ['%', '%GG', '%E0%A4%A', '%FF']) { assert.equal((await request('/api/auth/line/' + suffix)).status, 400); assert.equal(child.exitCode, null); assert.equal(child.pid, pid); assert.equal((await request('/api/health')).status, 200); }
      await valid(await issue());
    });
    console.log(JSON.stringify({ node: process.version, checks: tests.length, passed: tests.filter(t => t.pass).length, tests, scope: 'synthetic loopback HTTP, not live LINE or production proxy' }));
    if (tests.some(t => !t.pass)) process.exitCode = 1;
  } finally {
    if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
    await new Promise(r => provider.close(r)); db.close(); store.close();
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
