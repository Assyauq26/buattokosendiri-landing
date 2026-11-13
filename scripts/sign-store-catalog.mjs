// Operator CLI only. Private key remains outside application mounts and releases.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, writeFile, rename, open, mkdir, rmdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function signCatalog(catalog, keyId, pem, previous) {
  const now = Math.floor(Date.now() / 1000);
  if (!/^[a-z0-9-]{1,64}$/.test(keyId)) throw Error('Invalid key ID');
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Ed25519 required');
  if (catalog.format !== 2 || catalog.repository !== 'Assyauq26/buattokoonline' || !Number.isSafeInteger(catalog.sequence) || catalog.sequence < 1 || !Number.isSafeInteger(catalog.issuedAt) || !Number.isSafeInteger(catalog.expiresAt) || catalog.issuedAt > now || catalog.expiresAt <= now || catalog.expiresAt - catalog.issuedAt > 7 * 86400 || !Array.isArray(catalog.releases) || catalog.releases.length > 50 || !Array.isArray(catalog.revoked) || catalog.revoked.some(s => !/^[a-f0-9]{40}$/.test(s))) throw Error('Invalid catalog');
  const seen = new Set();
  for (const r of catalog.releases) {
    const semver=/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
    if(!semver.test(r.minimumInstalledVersion||'')||!semver.test(r.maximumInstalledVersion||'')) throw Error('Installed version range required');
    const minimum=r.minimumInstalledVersion.split('.').map(Number),maximum=r.maximumInstalledVersion.split('.').map(Number);
    const differing=minimum.findIndex((n,i)=>n!==maximum[i]);
    if(differing>=0&&minimum[differing]>maximum[differing])throw Error('Invalid installed version range');
    if (!/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.test(r.version) || seen.has(r.version) || !/^[a-f0-9]{40}$/.test(r.sha) || !/^[a-f0-9]{64}$/.test(r.digest) || !Number.isSafeInteger(r.size) || r.size <= 0 || r.size > 300 * 1024 * 1024 || r.url !== `https://github.com/Assyauq26/buattokoonline/releases/download/v${r.version}/store-v${r.version}.tar.gz` || !['pilot','stable'].includes(r.channel) || !Number.isSafeInteger(r.minimumUpdater) || r.minimumUpdater < 2 || r.dbContract !== 1 || typeof r.rollbackCompatible !== 'boolean' || typeof r.notes !== 'string' || r.notes.length > 12000) throw Error('Invalid release');
    seen.add(r.version);
  }
  if (previous) {
    if (!verify(null, Buffer.from(previous.payload, 'base64'), createPublicKey(key), Buffer.from(previous.signature, 'base64'))) throw Error('Previous catalog not authenticated; rotation needs explicit operator migration');
    const old = JSON.parse(Buffer.from(previous.payload,'base64'));
    if (catalog.sequence <= old.sequence) throw Error('Sequence must increase');
    if(old.releases.some(r=>!catalog.releases.some(next=>next.version===r.version)) || old.revoked.some(sha=>!catalog.revoked.includes(sha))) throw Error('Retain release history and revocations; catalog compaction needs operator migration');
    for (const r of catalog.releases) {
      const prior = old.releases.find(x => x.version === r.version);
      if (prior && (prior.sha !== r.sha || prior.digest !== r.digest)) throw Error('Released artifacts are immutable');
    }
  }
  const payload = Buffer.from(JSON.stringify(catalog));
  return { keyId, payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') };
}

export async function publishCatalog(input,keyFile,keyId,destination) {
  const lock=destination+'.lock';
  await mkdir(lock,{mode:0o700}); // Fail closed on concurrent/crashed publisher.
  try {
  let previous;
  try { previous = JSON.parse(await readFile(destination,'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = signCatalog(JSON.parse(await readFile(input,'utf8')), keyId, await readFile(keyFile,'utf8'), previous);
  const temporary = destination+'.new';
  await writeFile(temporary,JSON.stringify(result),{mode:0o600,flag:'wx'});
  const file=await open(temporary,'r+');try { await file.sync(); } finally { await file.close(); }
  await rename(temporary,destination);
  if (process.platform !== 'win32') { const dir=await open(dirname(destination),'r');try {await dir.sync();}finally{await dir.close();} }
  } finally { await rmdir(lock); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, keyFile, keyId, destination] = process.argv.slice(2);
  if (!input || !keyFile || !destination) throw Error('Use input.json private-key.pem key-id output.json');
  await publishCatalog(input,keyFile,keyId,destination);
  console.log('Signed catalog published. Private key was not copied.');
}
