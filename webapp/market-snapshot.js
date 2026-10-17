const fs = require('node:fs');
const path = require('node:path');
const { sha256, checkContent } = require('./scripts/data-batch');
const { atomicWriteJson } = require('./scripts/update-safety');
const { validatePreservation } = require('./scripts/refresh-official-database');

const validId = id => typeof id === 'string' && /^[A-Za-z0-9-]{10,100}$/.test(id);
function verifyEnvelope(bytes, manifest, db) {
  const batch = db.metadata?.dataBatch;
  if (!validId(batch?.batchId) || manifest.batchId !== batch.batchId || manifest.schemaVersion !== 1
    || manifest.promotion !== 'validated_candidate' || !['pass', 'pass_with_gaps'].includes(manifest.status)
    || !['pass', 'pass_with_gaps'].includes(manifest.checks?.status) || manifest.checks.errors?.length !== 0
    || manifest.outputFileSha256 !== sha256(bytes)) throw new Error('Snapshot receipt mismatch');
  if (JSON.stringify(batch.version) !== JSON.stringify(manifest.version) || batch.finishedAt !== manifest.finishedAt
    || !Number.isFinite(Date.parse(batch.finishedAt)) || Date.parse(batch.finishedAt) > Date.now() + 60000) throw new Error('Invalid batch version/date');
}
function verifySnapshot(bytes, manifest, previous) {
  const db = JSON.parse(bytes);
  verifyEnvelope(bytes,manifest,db);
  const batch=db.metadata.dataBatch;
  if (previous) {
    if (batch.finishedAt < previous.metadata?.dataBatch?.finishedAt) throw new Error('Snapshot rollback rejected');
    validatePreservation(previous, db);
  }
  if (!db.etfs?.length || checkContent(previous || db, db).errors.length) throw new Error('Invalid snapshot content');
  return db;
}

function createMarketSnapshot({ bundledPath, directory, sourceBase = '', fetchImpl = fetch, ttlMs = 60000 }) {
  const enabled = Boolean(sourceBase);
  if (enabled) {
    const url = new URL(sourceBase);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Snapshot source must be a public HTTPS base');
  }
  let pending, checkedAt = 0, lastError = null, cached, cachedKey;
  function bundled() {
    const bytes = fs.readFileSync(bundledPath);
    const db = JSON.parse(bytes), id = db.metadata?.dataBatch?.batchId;
    const manifest = validId(id) ? JSON.parse(fs.readFileSync(path.join(path.dirname(bundledPath), 'batches', id + '.json'))) : null;
    return { bytes, db, manifest, persistent: false };
  }
  function read() {
    if (enabled) {
      try {
        const pointer = JSON.parse(fs.readFileSync(path.join(directory, 'current.json')));
        if (!validId(pointer.batchId)) throw new Error('Invalid pointer');
        const bytes = fs.readFileSync(path.join(directory, pointer.batchId + '.data.json'));
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, pointer.batchId + '.manifest.json')));
        const db = verifySnapshot(bytes, manifest);
        return { bytes, db, manifest, persistent: true };
      } catch (error) { if (error.code !== 'ENOENT') lastError = 'persistent_snapshot_unreadable'; }
    }
    return bundled();
  }
  function current() {
    // Immutable batches are parsed once. Status/readback still independently reads disk.
    const pointer = enabled ? path.join(directory, 'current.json') : bundledPath;
    let key;
    try { const stat = fs.statSync(pointer); key = `${stat.mtimeMs}:${stat.size}`; }
    catch { key = 'bundled'; }
    if (!cached || key !== cachedKey) { cached = read(); cachedKey = key; }
    return cached;
  }
  function requestSync() {
    if (enabled && Date.now() - checkedAt >= ttlMs && !pending) void sync().catch(() => {});
  }
  function info() {
    return { status:lastError?'preserved_previous':enabled&&!checkedAt?'not_checked':'current',
      batchId:current().db.metadata?.dataBatch?.batchId||null };
  }
  async function download(relative, limit) {
    const response = await fetchImpl(new URL(relative, sourceBase.replace(/\/?$/, '/')), {
      signal: AbortSignal.timeout(20000), cache: 'no-store', redirect: 'error'
    });
    if (!response.ok) throw new Error('Snapshot source HTTP ' + response.status);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('Snapshot source too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function sync({ force = false } = {}) {
    if (!enabled) return status();
    if (pending) return pending;
    if (Date.now() - checkedAt < (force ? 5000 : ttlMs)) return describe(current());
    pending = (async () => {
      try {
        const manifest = JSON.parse(await download('data/latest-batch.json', 8000000));
        const available = current();
        if (manifest.batchId === available.manifest?.batchId && manifest.outputFileSha256 === available.manifest?.outputFileSha256) {
          verifyEnvelope(available.bytes, manifest, available.db);
          // Check persisted bytes without reparsing an already validated immutable batch.
          const file=available.persistent?path.join(directory,manifest.batchId+'.data.json'):bundledPath;
          if(sha256(fs.readFileSync(file))!==manifest.outputFileSha256)throw new Error('Persisted bytes mismatch');
          lastError = null; checkedAt = Date.now(); return describe(available);
        }
        const bytes = await download('data/etf-database.json', 64000000);
        const before = current();
        const db = verifySnapshot(bytes, manifest, before.db);
        if (db.metadata.dataBatch.batchId === before.db.metadata?.dataBatch?.batchId && sha256(bytes) !== sha256(before.bytes)) throw new Error('Immutable batch changed');
        fs.mkdirSync(directory, { recursive: true });
        const id = manifest.batchId;
        const dataPath = path.join(directory, id + '.data.json');
        if (!fs.existsSync(dataPath)) fs.writeFileSync(dataPath, bytes, { flag: 'wx' });
        if (sha256(fs.readFileSync(dataPath)) !== manifest.outputFileSha256) throw new Error('Persisted bytes mismatch');
        atomicWriteJson(path.join(directory, id + '.manifest.json'), manifest);
        atomicWriteJson(path.join(directory, 'current.json'), { batchId: id });
        cached = { bytes, db, manifest, persistent: true };
        const pointerStat=fs.statSync(path.join(directory,'current.json'));
        cachedKey = `${pointerStat.mtimeMs}:${pointerStat.size}`;
        lastError = null;
      } catch (error) { lastError = error.message === 'Persisted bytes mismatch' ? 'persistent_snapshot_unreadable' : 'source_unavailable_or_validation_failed'; }
      checkedAt = Date.now();
      return describe(current());
    })().finally(() => { pending = null; });
    return pending;
  }
  function describe(current) {
    return { mode: enabled ? 'published_snapshot' : 'local', source: enabled ? sourceBase : null,
      status: lastError ? 'preserved_previous' : enabled && !checkedAt ? 'not_checked' : 'current',
      checkedAt: checkedAt ? new Date(checkedAt).toISOString() : null, error: lastError,
      batchId: current.db.metadata?.dataBatch?.batchId || null, sha256: sha256(current.bytes),
      persistentReadback: current.persistent && lastError !== 'persistent_snapshot_unreadable', manifestVerified: current.manifest?.outputFileSha256 === sha256(current.bytes),
      batch: current.manifest };
  }
  // Explicit diagnostics independently read and validate disk; customer reads and
  // sync completion reuse the already verified immutable in-memory batch.
  function status() { return describe(read()); }
  return { enabled, sync, requestSync, current, info, read, status, databasePath: () => {
    const current = read();
    return current.persistent ? path.join(directory, current.manifest.batchId + '.data.json') : bundledPath;
  } };
}
module.exports = { createMarketSnapshot, verifySnapshot };
