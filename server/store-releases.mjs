import { readFile, stat } from 'node:fs/promises';
import { createPublicKey, verify } from 'node:crypto';

// Publication is an operator action. No private signing key enters the app.
export async function storeReleases(file, trustFile, now = Math.floor(Date.now() / 1000)) {
  if (!file || !trustFile) throw new Error('catalog_unavailable');
  if ((await stat(file)).size > 1024 * 1024 || (await stat(trustFile)).size > 65536) throw new Error('catalog_unavailable');
  const envelope = JSON.parse(await readFile(file, 'utf8'));
  const roots = JSON.parse(await readFile(trustFile, 'utf8'));
  if (Object.keys(envelope).sort().join(',') !== 'keyId,payload,signature' || !Object.hasOwn(roots, envelope.keyId)) throw new Error('catalog_unavailable');
  const key = createPublicKey(roots[envelope.keyId]);
  const payload = Buffer.from(envelope.payload, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, payload, key, signature)) throw new Error('catalog_unavailable');
  const catalog = JSON.parse(payload);
  if (catalog.format !== 2 || catalog.repository !== 'Assyauq26/buattokoonline' || !Number.isSafeInteger(catalog.sequence) || catalog.sequence < 1 || !Number.isSafeInteger(catalog.issuedAt) || !Number.isSafeInteger(catalog.expiresAt) || catalog.issuedAt > now + 60 || catalog.expiresAt <= now || catalog.expiresAt - catalog.issuedAt > 7 * 86400) throw new Error('catalog_unavailable');
  return envelope;
}
