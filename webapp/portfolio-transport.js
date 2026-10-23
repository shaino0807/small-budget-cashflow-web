// The issuer serves only its leaf certificate. Supply its public intermediate
// after verifying that intermediate against Node's existing trusted roots.
// Hostname, expiry and server-chain verification remain enabled in HTTPS.
const https = require('node:https');
const tls = require('node:tls');
const {X509Certificate} = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
let issuerAgent;
function getIssuerAgent() {
  if (issuerAgent) return issuerAgent;
  const pem = fs.readFileSync(path.join(__dirname, 'certificates/chunghwa-gcc-r46-ov-tls-2025.pem'), 'utf8');
  const intermediate = new X509Certificate(pem);
  const root = tls.rootCertificates.map(p => new X509Certificate(p)).find(r => intermediate.checkIssued(r) && intermediate.verify(r.publicKey));
  if (!root || Date.parse(intermediate.validTo) <= Date.now() || Date.parse(intermediate.validFrom) > Date.now()) throw Error('官方來源中繼憑證未通過信任鏈驗證');
  issuerAgent = new https.Agent({ca: [...tls.rootCertificates, pem], rejectUnauthorized: true, keepAlive: true});
  return issuerAgent;
}
async function officialFetch(url, options = {}) {
  const target = new URL(url);
  if (target.hostname !== 'www.uobam.com.tw') return fetch(url, options);
  if (target.protocol !== 'https:' || target.port && target.port !== '443' || target.username || target.password || options.body || options.method && options.method !== 'GET') throw Error('官方憑證鏈傳輸只允許匿名 HTTPS GET');
  if (Object.keys(options.headers || {}).some(k => /authorization|cookie/i.test(k))) throw Error('官方憑證鏈傳輸不接受登入資訊');
  return new Promise((resolve, reject) => {
    const req = https.get(target, {agent: getIssuerAgent(), signal: options.signal, headers: options.headers}, res => {
      const chunks = []; let length = 0;
      res.on('data', chunk => {
        length += chunk.length;
        if (length > 6 * 1024 * 1024) res.destroy(Error('官方來源超出資料大小上限'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400) { reject(Error('官方來源重新導向，需重新核對')); return; }
        resolve(new Response(Buffer.concat(chunks), {status: res.statusCode, headers: res.headers}));
      });
    });
    req.on('error', reject);
  });
}
module.exports = {officialFetch, getIssuerAgent};
