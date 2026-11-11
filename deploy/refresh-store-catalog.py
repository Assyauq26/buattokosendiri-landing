"""Operator-only stable catalog publisher. Never installs or updates a shop.

Public discovery and package validation have no credentials. Signing runs in a
separate networkless container; the application cannot access the signing key.
"""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from urllib.parse import urlparse

REPO = 'Assyauq26/buattokoonline'
CATALOG = Path('/etc/btos-release-catalog')
REQUIRED = {'VERSION', 'app/Dockerfile', 'deploy/compose.yaml', 'installer/core.py',
            'installer/update_service/new_install.py', 'installer/update_service/bootstrap.py',
            'installer/update_service/server.py', 'deploy/updater-trust.json',
            'deploy/single-store-updater.service', 'release-policy.json'}


def validate_package(path, release):
    """Validate without extracting or executing any code from the archive."""
    if path.stat().st_size != release['asset']['size'] or hashlib.sha256(path.read_bytes()).hexdigest() != release['asset']['digest']:
        raise ValueError('asset_integrity')
    with tarfile.open(path, 'r:gz') as archive:
        names, total = set(), 0
        for member in archive:
            p = PurePosixPath(member.name)
            if (not member.isfile() or p.is_absolute() or '..' in p.parts or p.as_posix() != member.name
                    or '\\' in member.name or ':' in member.name or not member.name or len(member.name) > 300 or member.name in names):
                raise ValueError('unsafe_archive')
            names.add(member.name)
            total += member.size
            if len(names) > 10000 or total > 500 * 1024 * 1024:
                raise ValueError('archive_limit')
        if not REQUIRED | {'release.json'} <= names or archive.getmember('release.json').size > 2 * 1024 * 1024:
            raise ValueError('updater_files_missing')
        manifest = json.load(archive.extractfile('release.json'))
        if (manifest.get('format') != 1 or manifest.get('repository') != REPO or manifest.get('repository_id') != 1446326256
                or manifest.get('source_sha') != release['sha'] or manifest.get('tag') != release['version']
                or manifest.get('version') != release['version'][1:] or names != set(manifest['files']) | {'release.json'}):
            raise ValueError('manifest_identity')
        for name, digest in manifest['files'].items():
            if not re.fullmatch('[a-f0-9]{64}', digest) or hashlib.sha256(archive.extractfile(name).read()).hexdigest() != digest:
                raise ValueError('file_integrity')
        if archive.extractfile('VERSION').read().decode().strip() != manifest['version']:
            raise ValueError('version_identity')
        policy = manifest['compatibility']
        if policy != json.load(archive.extractfile('release-policy.json')):
            raise ValueError('policy_integrity')
        if (policy.get('db_contract') != 1 or policy.get('postgres_major') != 16 or policy.get('rollback_compatible') is not True
                or not policy.get('minimum_installed_contract', 999) <= 1 <= policy.get('maximum_installed_contract', -1)):
            raise ValueError('contract_incompatible')
        for key in ['minimum_installed_version', 'maximum_installed_version']:
            if not re.fullmatch(r'(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})', policy.get(key, '')):
                raise ValueError('upgrade_range_missing')
        if tuple(map(int, policy['minimum_installed_version'].split('.'))) > tuple(map(int, policy['maximum_installed_version'].split('.'))):
            raise ValueError('upgrade_range_invalid')
        # Public trust carried by a new installation must match the operator key.
        if json.load(archive.extractfile('deploy/updater-trust.json')) != json.loads((CATALOG / 'trust.json').read_text()):
            raise ValueError('updater_trust_mismatch')
        return {**{k: release['asset'][k] for k in ['url', 'digest', 'size']},
                'version': manifest['version'], 'sha': release['sha'], 'channel': 'stable',
                'minimumUpdater': 2, 'dbContract': 1, 'rollbackCompatible': True,
                'minimumInstalledVersion': policy['minimum_installed_version'],
                'maximumInstalledVersion': policy['maximum_installed_version'],
                'notes': 'Rilis stabil resmi. Instalasi baru menyertakan Update Versi satu tombol; upgrade mengikuti kompatibilitas paket.'}


class AssetRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        u = urlparse(newurl)
        if u.scheme != 'https' or u.hostname not in {'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'} or u.username or u.password or u.port:
            raise ValueError('asset_redirect_rejected')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def run(args, timeout=90):
    p = subprocess.run(list(map(str, args)), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if p.returncode:
        raise RuntimeError('operator_command_failed')
    return p.stdout.decode().strip()


def main():
    import fcntl
    if os.geteuid() != 0:
        raise RuntimeError('operator_required')
    os.umask(0o077)
    with open('/run/btos-store-catalog-refresh.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        source = Path(__file__).resolve().parent.parent
        sha = run(['git', '-C', source, 'rev-parse', 'HEAD'])
        if not re.fullmatch('[a-f0-9]{40}', sha):
            raise ValueError('source_identity')
        image = 'btos-platform:' + sha
        # Reviewed immutable image; no runtime environment or application secret.
        container = ['docker', 'run', '--rm', '--read-only', '--cap-drop', 'ALL', '--security-opt',
                     'no-new-privileges', '--memory', '128m', '--pids-limit', '32']
        release = json.loads(run(container + [image, 'node', 'server/latest-installer-cli.mjs']))
        expected = f"https://github.com/{REPO}/releases/download/{release['version']}/store-{release['version']}.tar.gz"
        if (release['repository'] != REPO or release['asset']['url'] != expected or not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', release['version'])
                or not re.fullmatch('[a-f0-9]{40}', release['sha']) or not re.fullmatch('[a-f0-9]{64}', release['asset']['digest'])
                or not isinstance(release['asset']['size'], int) or not 0 < release['asset']['size'] <= 300 * 1024 * 1024):
            raise ValueError('discovery_identity')
        # Authenticate existing history even when its short freshness window has expired.
        script = "import{readFileSync as r}from'node:fs';import{createPublicKey,verify}from'node:crypto';let e=JSON.parse(r('/catalog/catalog.json')),t=JSON.parse(r('/catalog/trust.json'));if(!Object.hasOwn(t,e.keyId)||!verify(null,Buffer.from(e.payload,'base64'),createPublicKey(t[e.keyId]),Buffer.from(e.signature,'base64')))process.exit(1);console.log(Buffer.from(e.payload,'base64').toString())"
        old = json.loads(run(container + ['--network', 'none', '--mount', f'type=bind,src={CATALOG},dst=/catalog,readonly', image, 'node', '--input-type=module', '-e', script]))
        if release['sha'] in old['revoked']:
            raise ValueError('release_revoked')
        with tempfile.TemporaryDirectory(prefix='btos-stable-') as work:
            package = Path(work) / 'release.tar.gz'
            opener = urllib.request.build_opener(AssetRedirects())
            with opener.open(expected, timeout=60) as response, package.open('wb') as out:
                count = 0
                while chunk := response.read(1024 * 1024):
                    count += len(chunk)
                    if count > release['asset']['size']:
                        raise ValueError('asset_limit')
                    out.write(chunk)
            entry = validate_package(package, release)
        prior = next((r for r in old['releases'] if r['version'] == entry['version']), None)
        if prior and (prior['sha'] != entry['sha'] or prior['digest'] != entry['digest']):
            raise ValueError('immutable_release_changed')
        now = int(time.time())
        if prior == entry and old['expiresAt'] > now + 6 * 3600:
            print('STABLE_CATALOG_CURRENT ' + release['version'])
            return
        payload = {**old, 'sequence': old['sequence'] + 1, 'issuedAt': now, 'expiresAt': now + 2 * 86400,
                   'releases': [r for r in old['releases'] if r['version'] != entry['version']] + [entry]}
        backup = CATALOG / ('catalog.sequence-' + str(old['sequence']) + '.json')
        if not backup.exists():
            backup.write_bytes((CATALOG / 'catalog.json').read_bytes())
        (CATALOG / 'input.json').write_text(json.dumps(payload))
        run(container + ['--network', 'none', '--user', '0:0', '--mount',
            'type=bind,src=/etc/btos-release-signing,dst=/run/signing,readonly', '--mount',
            f'type=bind,src={CATALOG},dst=/output', '--mount',
            f'type=bind,src={source}/scripts/sign-store-catalog.mjs,dst=/operator/sign.mjs,readonly',
            image, 'node', '/operator/sign.mjs', '/output/input.json', '/run/signing/btos-release-202611.pem',
            'btos-release-202611', '/output/catalog.json'])
        (CATALOG / 'catalog.json').chmod(0o644)
        print('SIGNED_STABLE_CATALOG_PUBLISHED ' + release['version'] + ' sequence=' + str(payload['sequence']))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('STABLE_CATALOG_REFRESH_FAILED ' + type(error).__name__ + '; operator review required', file=sys.stderr)
        sys.exit(1)
