"""Operator publication for four separately reviewed canonical migration paths.

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
BLU_APPROVAL = Path('/etc/btos-platform/updater-publications/v1.8.2.json')
PAYMENTS_APPROVAL = Path('/etc/btos-platform/updater-publications/v1.8.3.json')
MIDTRANS_APPROVAL = Path('/etc/btos-platform/updater-publications/v1.9.0.json')


def approved_modules(version='v1.8.0'):
    approvals={'v1.8.0':APPROVAL,'v1.8.2':BLU_APPROVAL,'v1.8.3':PAYMENTS_APPROVAL,'v1.9.0':MIDTRANS_APPROVAL}
    if version not in approvals:raise ValueError('unreviewed_migration_release')
    approval=approvals[version]
    for p in (approval, *approval.parents):
        s = p.lstat()
        if p.is_symlink() or s.st_uid != 0 or s.st_mode & 0o022:
            raise ValueError('publication_approval_permissions')
    cfg = json.loads(approval.read_text())
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
            or (cohort!=['*'] and any(not re.fullmatch('[a-f0-9]{32}', i) for i in cohort))
            or (cohort==['*'] and (version not in ('v1.8.2','v1.8.3','v1.9.0') or cfg.get('generalEligibilityReviewed') is not True))
            or cfg['channel'] not in ('pilot','stable')):
        raise ValueError('publication_cohort')
    sys.path.insert(0, str(source/'installer'))
    if version in ('v1.8.2','v1.8.3','v1.9.0') and (cfg.get('targetSha')!=sha or not re.fullmatch('[a-f0-9]{64}',cfg.get('artifactDigest',''))):
        raise ValueError('publication_target')
    operator = importlib.import_module({'v1.8.0':'update_service.policy_operator','v1.8.2':'update_service.blu_policy_operator','v1.8.3':'update_service.payment_live_policy_operator','v1.9.0':'update_service.midtrans_policy_operator'}[version])
    auth = importlib.import_module('update_service.upgrade_policy').authenticate
    return cfg, operator, auth


def migration_entry(package, release, previous, catalog, source, image, container, run, now):
    cfg, operator, authenticate = approved_modules(release['version'])
    blu=release['version']=='v1.8.2'
    payments=release['version']=='v1.8.3'
    midtrans=release['version']=='v1.9.0'
    target_sha=cfg['targetSha'] if blu or payments or midtrans else operator.TARGET_SHA
    target_digest=cfg['artifactDigest'] if blu or payments or midtrans else operator.TARGET_DIGEST
    target_version='1.9.0' if midtrans else '1.8.3' if payments else '1.8.2' if blu else '1.8.0'
    from_version='1.8.3' if midtrans else '1.8.2' if payments else '1.8.1' if blu else '1.7.4'
    if (release['version'], release['sha'], release['asset']['digest']) != (
            'v'+target_version, target_sha, target_digest):
        raise ValueError('unreviewed_migration_release')
    roots = json.loads((catalog/'trust.json').read_text())
    prior = next((r for r in previous['releases'] if r['version']==target_version), None)
    prior_policy = None
    if prior:
        # History authentication is permitted after expiry; issuedAt is used only
        # here. Worker discovery still requires current freshness.
        envelope = prior['upgradePolicy']
        import base64
        stamp = json.loads(base64.b64decode(envelope['payload']))['issuedAt']
        prior_policy, _ = authenticate(json.dumps(envelope).encode(), roots, now=stamp)
    # Worker replay protection is global across policy IDs, not per release.
    import base64
    highest=prior_policy['sequence'] if prior_policy else 0
    for item in previous['releases']:
        if not item.get('upgradePolicy'):continue
        envelope=item['upgradePolicy'];stamp=json.loads(base64.b64decode(envelope['payload']))['issuedAt']
        historical,_=authenticate(json.dumps(envelope).encode(),roots,now=stamp)
        highest=max(highest,historical['sequence'])
    sequence=highest+1
    policy = (operator.prepare(cfg['baselineArchive'],package,target_sha,target_digest,cfg['installations'],sequence,now=now)
        if blu or payments or midtrans else operator.prepare(cfg['baselineArchive'], package, cfg['installations'], sequence, now=now))
    if prior_policy:
        retained = {**prior_policy, 'sequence':sequence, 'issuedAt':now, 'expiresAt':now+86400}
        if retained == policy and prior_policy['sequence']>=highest and prior_policy['expiresAt'] > now+6*3600:
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
    return {**release['asset'], 'version':target_version,'sha':target_sha,
        'channel':cfg['channel'],'minimumUpdater':3,'dbContract':1,'rollbackCompatible':False,
        'minimumInstalledVersion':from_version,'maximumInstalledVersion':from_version,
        'notes':('Midtrans Snap resmi: kanal merchant, webhook dan rekonsiliasi backend, tanpa kode unik atau unggah bukti. Seller memasukkan key dan mengaktifkan sendiri. Memerlukan revisi worker dengan executor midtrans-snap-forward-v1 dan baseline canonical1.8.3/schema34 terverifikasi. Riwayat pembayaran lama dipertahankan.' if midtrans else 'Konfirmasi blu otomatis dan QRIS GoPay Merchant dengan OTP, unggah QRIS, nominal unik dan worker backend. Integrasi GoPay tidak resmi; koneksi serta aktivasi dilakukan per toko. Memerlukan revisi worker pembayaran resmi dan baseline1.8.2 terverifikasi.' if payments else 'Checkout blu berkode unik, pembacaan Gmail dan pemeriksaan seller. Memerlukan revisi worker blu resmi serta baseline1.8.1 terverifikasi; Google client dan aktivasi dilakukan per toko. GoPay belum tersedia.' if blu else 'Promosi Flash Sale dan voucher. Memerlukan worker v3 dan baseline 1.7.4 terverifikasi; backup serta migrasi diperiksa sebelum aktivasi.'),
        'upgradePolicy':envelope}, policy['expiresAt']
