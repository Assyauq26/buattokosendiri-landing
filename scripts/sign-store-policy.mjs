// Operator only; invoked in the existing networkless signing container.
import {createPrivateKey, sign} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
const [input,keyPath,keyId,output]=process.argv.slice(2);
const policy=JSON.parse(await readFile(input,'utf8'));
if(policy.format!==2 || policy.id!=='canonical-v174-to-v180' || policy.fromVersion!=='1.7.4' || policy.toVersion!=='1.8.0' || !/^[a-z0-9-]{1,64}$/.test(keyId)) throw Error('Unreviewed policy');
const key=createPrivateKey(await readFile(keyPath));
if(key.asymmetricKeyType!=='ed25519') throw Error('Ed25519 required');
const payload=Buffer.from(JSON.stringify(policy));
await writeFile(output,JSON.stringify({keyId,payload:payload.toString('base64'),signature:sign(null,payload,key).toString('base64')}),{mode:0o600});
