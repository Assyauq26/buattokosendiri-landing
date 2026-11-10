import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeReleases } from '../server/store-releases.mjs';
import { signCatalog, publishCatalog } from '../scripts/sign-store-catalog.mjs';

test('publisher keeps immutable release identities, revocations and monotonic history',()=>{
  const {privateKey}=generateKeyPairSync('ed25519');const pem=privateKey.export({type:'pkcs8',format:'pem'});
  const now=Math.floor(Date.now()/1000);
  const release={version:'1.7.0',sha:'a'.repeat(40),digest:'b'.repeat(64),size:100,url:'https://github.com/Assyauq26/buattokoonline/releases/download/v1.7.0/store-v1.7.0.tar.gz',channel:'pilot',minimumUpdater:2,minimumInstalledVersion:'1.6.3',maximumInstalledVersion:'1.6.3',dbContract:1,rollbackCompatible:true,notes:'Pilot'};
  const first={format:2,repository:'Assyauq26/buattokoonline',sequence:1,issuedAt:now,expiresAt:now+600,releases:[release],revoked:['c'.repeat(40)]};
  const previous=signCatalog(first,'test',pem);
  for(const change of [{sequence:1},{releases:[]},{revoked:[]},{releases:[{...release,digest:'d'.repeat(64)}]},{releases:[{...release,minimumInstalledVersion:'9.0.0'}]}]) assert.throws(()=>signCatalog({...first,sequence:2,...change},'test',pem,previous));
  assert.ok(signCatalog({...first,sequence:2},'test',pem,previous).signature);
});

test('concurrent publisher cannot overwrite catalog with a stale sequence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'catalog-publish-'));
  try {
    const {privateKey}=generateKeyPairSync('ed25519');const key=join(dir,'key.pem'),input=join(dir,'input.json'),output=join(dir,'catalog.json');
    const now=Math.floor(Date.now()/1000);
    await writeFile(key,privateKey.export({type:'pkcs8',format:'pem'}));
    await writeFile(input,JSON.stringify({format:2,repository:'Assyauq26/buattokoonline',sequence:1,issuedAt:now,expiresAt:now+600,releases:[],revoked:[]}));
    const result=await Promise.allSettled(Array.from({length:8},()=>publishCatalog(input,key,'test',output)));
    assert.equal(result.filter(r=>r.status==='fulfilled').length,1,result.filter(r=>r.status==='rejected').map(r=>r.reason.message).join('; '));
    assert.equal(JSON.parse(Buffer.from(JSON.parse(await readFile(output,'utf8')).payload,'base64')).sequence,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('catalog serves only authenticated current metadata; no key in envelope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-'));
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const roots = join(dir, 'roots.json'), file = join(dir, 'catalog.json');
    await writeFile(roots, JSON.stringify({ test: publicKey.export({ type: 'spki', format: 'pem' }) }));
    const payload = Buffer.from(JSON.stringify({ format: 2, repository: 'Assyauq26/buattokoonline', sequence: 1, issuedAt: 1000, expiresAt: 2000, releases: [], revoked: [] }));
    const envelope = { keyId: 'test', payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
    await writeFile(file, JSON.stringify(envelope));
    assert.deepEqual(await storeReleases(file, roots, 1500), envelope);
    await assert.rejects(storeReleases(file, roots, 2000));
    await assert.rejects(storeReleases(undefined, roots, 1500));
    envelope.payload = Buffer.from('{}').toString('base64');
    await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(storeReleases(file, roots, 1500));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
