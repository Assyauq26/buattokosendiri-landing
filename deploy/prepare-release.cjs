// Static landing artifact builder. No CI, network, Docker, or VPS mutation.
const {execFileSync} = require('node:child_process');
const {mkdirSync, writeFileSync, existsSync} = require('node:fs');
const {createHash} = require('node:crypto');
const path = require('node:path');

// The landing is a standalone repository. Every public path is at repo root.
const repository = path.resolve(__dirname, '..');
const rootFiles = new Set(['index.html', '404.html', 'portal-config.json']);
const publicDirectories = ['assets/', 'daftar/', 'masuk/', 'pendaftaran/', 'kebijakan-privasi/', 'panduan-instalasi/'];
const extensions = new Set(['.html', '.css', '.js', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff2', '.txt', '.pdf']);
const required = [
  'index.html', '404.html', 'portal-config.json', 'daftar/index.html', 'masuk/index.html',
  'kebijakan-privasi/index.html', 'pendaftaran/index.html', 'panduan-instalasi/index.html',
  'panduan-instalasi/panduan-instalasi.pdf', 'assets/img/hero-desktop.png', 'assets/img/hero-mobile.png'
];
const maxBytes = 30 * 1024 * 1024;

function prepare(sha, destination, releaseMode = 'source') {
  if (!['source', 'registration'].includes(releaseMode)) throw new Error('Retired preview or unknown release mode');
  if (!/^[0-9a-f]{40}$/.test(sha || '') || !destination || !path.isAbsolute(destination)) {
    throw new Error('Exact 40-character commit SHA and absolute output directory are required');
  }
  const git = args => execFileSync('git', ['-C', repository, ...args], {maxBuffer: maxBytes + 1024 * 1024});
  const actual = git(['rev-parse', sha + '^{commit}']).toString().trim();
  if (actual !== sha) throw new Error('Commit SHA is unavailable');
  const entries = git(['ls-tree', '-r', '-z', sha]).toString('utf8').split('\0').filter(Boolean);
  const selected = [];
  for (const entry of entries) {
    const match = entry.match(/^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/);
    if (!match) throw new Error('Unexpected Git tree entry');
    const [, mode, type, , relative] = match;
    const allowed = rootFiles.has(relative) || publicDirectories.some(dir => relative.startsWith(dir));
    if (!allowed) continue;
    if (relative === 'assets/img/PROVENANCE.md') continue;
    if (!relative || relative.startsWith('/') ||
        relative.split('/').some(part => part === '.' || part === '..' || part.startsWith('.'))) {
      throw new Error('Unsafe tracked path');
    }
    if (!extensions.has(path.posix.extname(relative))) throw new Error('Unsupported public asset: ' + relative);
    if (type !== 'blob' || mode !== '100644' && mode !== '100755') throw new Error('Symlinks and special files are forbidden: ' + relative);
    selected.push(relative);
  }
  selected.sort();
  for (const file of required) if (!selected.includes(file)) throw new Error('Missing required landing asset: ' + file);
  const output = path.join(destination, sha);
  if (existsSync(output)) throw new Error('Release exists; never overwrite a release directory');
  const payload = selected.map(file => [file, git(['show', sha + ':' + file])]);
  const total = payload.reduce((n, [,bytes]) => n + bytes.length, 0);
  if (total > maxBytes) throw new Error('Landing release exceeds 30 MiB');
  const refPattern = /(?:href|src)="\/(assets\/[^"?#]+|panduan-instalasi\/(?:assets\/[^"?#]+|panduan-instalasi\.pdf))(?:[?#][^"]*)?"/g;
  for (const [file, bytes] of payload.filter(([name]) => name.endsWith('.html'))) {
    const html = bytes.toString('utf8');
    if (/release-preview-notice|Pratinjau terbatas|dashboard\.buattokosendiri\.web\.id/.test(html)) throw new Error('Retired registration/preview content in public artifact');
    for (const [, referenced] of html.matchAll(refPattern)) {
      if (!selected.includes(referenced)) throw new Error('Unpackaged reference in ' + file + ': ' + referenced);
    }
  }
  const manifest = {
    product: 'Buat Toko Online Sendiri',
    deployment: 'NOT_DEPLOYED',
    mode: 'static-landing',
    canonical_origin: 'https://buattokosendiri.web.id',
    commit: sha,
    release_mode: releaseMode,
    public_registration: releaseMode === 'registration',
    central_accounts: false,
    public_installer: false,
    files: []
  };
  mkdirSync(output, {recursive: true});
  for (const [file, bytes] of payload) {
    const target = path.join(output, file);
    mkdirSync(path.dirname(target), {recursive: true});
    writeFileSync(target, bytes, {flag: 'wx'});
    manifest.files.push({file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
  }
  writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});
  return manifest;
}
module.exports = {prepare};
if (require.main === module) {
  try { console.log(JSON.stringify(prepare(process.argv[2], process.argv[3], process.argv[4]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
