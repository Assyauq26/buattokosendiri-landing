"""Operator publication for the reviewed canonical 1.7.4 -> 1.8.0 path only.

The root-owned approval pins a separate worker checkout and a cohort. The app
cannot enable this path. Keys stay in the existing networkless signer container.
"""
import importlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

APPROVAL = Path('/etc/btos-platform/updater-publication.json')


def approved_modules():
    for p in (APPROVAL, *APPROVAL.parents):
        s = p.lstat()
        if p.is_symlink() or s.st_uid != 0 or s.st_mode & 0o022:
            raise ValueError('publication_approval_permissions')
    cfg = json.loads(APPROVAL.read_text())
    source = Path(cfg['source'])
    sha = cfg['sha']
    if not source.is_absolute() or not re.fullmatch('[a-f0-9]{40}', sha):
        raise ValueError('publication_source')
    for p in (source, *source.parents):
        s = p.lstat()
        if p.is_symlink() or s.st_uid != 0 or s.st_mode & 0o022:
            raise ValueError('publication_source_permissions')
    # Authenticate code before importing it, including the full installer tree.
    def git(*args):
        return subprocess.check_output(['git', '-C', str(source), *args],
            env={**os.environ, 'GIT_NO_REPLACE_OBJECTS':'1', 'GIT_CONFIG_NOSYSTEM':'1', 'GIT_CONFIG_GLOBAL':os.devnull})
    if git('rev-parse', 'HEAD').decode().strip() != sha:
        raise ValueError('publication_source')
    for record in git('ls-tree', '-rz', sha, 'installer').split(b'\0'):
        if not record: continue
        head, name = record.split(b'\t'); name = name.decode()
        if head.split()[0] not in (b'100644', b'100755'):
            raise ValueError('publication_source_type')
        p = source / name
        if p.is_symlink() or p.read_bytes() != git('show', sha+':'+name):
            raise ValueError('publication_source_bytes')
    cohort = cfg['installations']
    if (not isinstance(cohort,list) or not 1 <= len(cohort) <= 1000 or len(set(cohort)) != len(cohort)
            or any(not re.fullmatch('[a-f0-9]{32}', i) for i in cohort)
            or cfg['channel'] not in ('pilot','stable')):
        raise ValueError('publication_cohort')
    sys.path.insert(0, str(source/'installer'))
    operator = importlib.import_module('update_service.policy_operator')
    auth = importlib.import_module('update_service.upgrade_policy').authenticate
    return cfg, operator, auth


def migration_entry(package, release, previous, catalog, source, image, container, run, now):
    cfg, operator, authenticate = approved_modules()
    if (release['version'], release['sha'], release['asset']['digest']) != (
            'v1.8.0', operator.TARGET_SHA, operator.TARGET_DIGEST):
        raise ValueError('unreviewed_migration_release')
    roots = json.loads((catalog/'trust.json').read_text())
    prior = next((r for r in previous['releases'] if r['version']=='1.8.0'), None)
    prior_policy = None
    if prior:
        # History authentication is permitted after expiry; issuedAt is used only
        # here. Worker discovery still requires current freshness.
        envelope = prior['upgradePolicy']
        import base64
        stamp = json.loads(base64.b64decode(envelope['payload']))['issuedAt']
        prior_policy, _ = authenticate(json.dumps(envelope).encode(), roots, now=stamp)
    sequence = prior_policy['sequence']+1 if prior_policy else 1
    policy = operator.prepare(cfg['baselineArchive'], package, cfg['installations'], sequence, now=now)
    if prior_policy:
        retained = {**prior_policy, 'sequence':sequence, 'issuedAt':now, 'expiresAt':now+86400}
        if retained == policy and prior_policy['expiresAt'] > now+6*3600:
            policy = prior_policy
    if not prior_policy or policy != prior_policy:
        (catalog/'policy-input.json').write_text(json.dumps(policy))
        run(container + ['--network','none','--user','0:0','--mount',
            'type=bind,src=/etc/btos-release-signing,dst=/run/signing,readonly','--mount',
            f'type=bind,src={catalog},dst=/output','--mount',
            f'type=bind,src={source}/scripts/sign-store-policy.mjs,dst=/operator/policy.mjs,readonly',
            image,'node','/operator/policy.mjs','/output/policy-input.json',
            '/run/signing/btos-release-202611.pem','btos-release-202611','/output/policy.json'])
        envelope = json.loads((catalog/'policy.json').read_text())
        verified, _ = authenticate(json.dumps(envelope).encode(), roots, now=now)
        if verified != policy: raise ValueError('signed_policy_identity')
    else:
        envelope = prior['upgradePolicy']
    return {**release['asset'], 'version':'1.8.0','sha':operator.TARGET_SHA,
        'channel':cfg['channel'],'minimumUpdater':3,'dbContract':1,'rollbackCompatible':False,
        'minimumInstalledVersion':'1.7.4','maximumInstalledVersion':'1.7.4',
        'notes':'Promosi Flash Sale dan voucher. Memerlukan worker v3 dan baseline 1.7.4 terverifikasi; backup serta migrasi diperiksa sebelum aktivasi.',
        'upgradePolicy':envelope}, policy['expiresAt']
