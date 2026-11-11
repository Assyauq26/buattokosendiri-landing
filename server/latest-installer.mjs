// Published stable releases from this exact repository are the installation policy.
// Discovery never supplies shell commands, arbitrary URLs, or a mutable branch to an agent.
export const STORE_REPOSITORY = 'Assyauq26/buattokoonline';
export const STORE_REPOSITORY_ID = 1446326256;
const web = `https://github.com/${STORE_REPOSITORY}`;
const api = `https://api.github.com/repos/${STORE_REPOSITORY}`;
const tagPattern = /^v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const shaPattern = /^[a-f0-9]{40}$/;
const invalid = () => { throw Error('latest_stable_unavailable'); };
async function bounded(response, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) { invalid(); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export function createLatestInstallerResolver({ fetcher = fetch } = {}) {
  const descriptors = new Map(), loading = new Map();
  let discovering, repositoryChecked = 0;
  async function getJson(url, signal) {
    const r = await fetcher(url, { redirect: 'error', cache: 'no-store', signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'BTOS-Installer/2', 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!r.ok) { await r.body?.cancel(); invalid(); }
    return JSON.parse(await bounded(r, 1024 * 1024));
  }
  async function discover(signal) {
    const r = await fetcher(web + '/releases/latest', { redirect: 'manual', cache: 'no-store', signal,
      headers: { 'User-Agent': 'BTOS-Installer/2' } });
    const location = r.headers.get('location');
    await r.body?.cancel();
    if (![301,302,303,307,308].includes(r.status) || !location?.startsWith(web + '/releases/tag/')) invalid();
    const tag = location.slice((web + '/releases/tag/').length);
    if (!tagPattern.test(tag)) invalid();
    return tag;
  }
  async function describe(tag, signal) {
    if (Date.now() - repositoryChecked > 6 * 3600_000) {
      const repository = await getJson(api, signal);
      if (repository.id !== STORE_REPOSITORY_ID || repository.full_name?.toLowerCase() !== STORE_REPOSITORY.toLowerCase()) invalid();
      repositoryChecked = Date.now();
    }
    const release = await getJson(api + '/releases/tags/' + tag, signal);
    if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false || !release.published_at ||
        release.html_url !== web + '/releases/tag/' + tag) invalid();
    const asset = release.assets?.find(a => a.name === `store-${tag}.tar.gz`);
    if (!asset || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 300 * 1024 * 1024 ||
        asset.browser_download_url !== web + `/releases/download/${tag}/store-${tag}.tar.gz` || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) invalid();
    const ref = await getJson(api + '/git/ref/tags/' + tag, signal);
    if (ref.ref !== 'refs/tags/' + tag) invalid();
    let object = ref.object;
    for (let depth = 0; object?.type === 'tag' && depth < 3; depth++) {
      if (!shaPattern.test(object.sha || '')) invalid();
      object = (await getJson(api + '/git/tags/' + object.sha, signal)).object;
    }
    if (object?.type !== 'commit' || !shaPattern.test(object.sha || '')) invalid();
    const r = await fetcher(`https://raw.githubusercontent.com/${STORE_REPOSITORY}/${object.sha}/VERSION`,
      { redirect: 'error', cache: 'no-store', signal });
    if (!r.ok || (await bounded(r, 128)).trim() !== tag.slice(1)) invalid();
    return Object.freeze({ repository: STORE_REPOSITORY, version: tag, sha: object.sha, approved: true,
      source: 'github-stable', publishedAt: release.published_at,
      asset: Object.freeze({ url: asset.browser_download_url, digest: asset.digest.slice(7), size: asset.size }) });
  }
  return async function latest() {
    const signal = AbortSignal.timeout(12000);
    // Share only simultaneous requests. Each subsequent call checks GitHub latest again.
    if (!discovering) discovering = discover(signal).finally(() => { discovering = undefined; });
    const tag = await discovering;
    const known = descriptors.get(tag);
    if (known) return known;
    if (!loading.has(tag)) {
      loading.set(tag, describe(tag, signal).then(value => {
        if (descriptors.size >= 32) descriptors.delete(descriptors.keys().next().value);
        descriptors.set(tag, value); return value;
      }).finally(() => loading.delete(tag)));
    }
    return loading.get(tag);
  };
}
