"""Synthetic package tests; no credentials, Docker or network."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('catalog', Path(__file__).parents[1] / 'deploy/refresh-store-catalog.py')
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        catalog.CATALOG = self.root
        self.trust = {'test-key': 'public-only-fixture'}
        (self.root / 'trust.json').write_text(json.dumps(self.trust))

    def package(self, change=None, extra=None):
        files = {name: b'fixture' for name in catalog.REQUIRED}
        files['VERSION'] = b'1.7.2\n'
        files['installer/update_service/__init__.py'] = b'VERSION = 2\n'
        files['deploy/updater-trust.json'] = json.dumps(self.trust).encode()
        policy = {'db_contract': 1, 'postgres_major': 16, 'rollback_compatible': True,
                  'minimum_installed_contract': 1, 'maximum_installed_contract': 1,
                  'minimum_installed_version': '1.7.1', 'maximum_installed_version': '1.7.1'}
        files['release-policy.json'] = json.dumps(policy).encode()
        manifest = {'format': 1, 'repository': catalog.REPO, 'repository_id': 1446326256,
                    'version': '1.7.2', 'tag': 'v1.7.2', 'source_sha': 'a' * 40,
                    'compatibility': policy,
                    'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
        if change:
            change(files, manifest)
        files['release.json'] = json.dumps(manifest).encode()
        path = self.root / 'package.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            if extra:
                archive.addfile(extra)
        release = {'version': 'v1.7.2', 'sha': 'a' * 40, 'asset': {'size': path.stat().st_size,
                   'digest': hashlib.sha256(path.read_bytes()).hexdigest(), 'url': 'https://example.test/fixture'}}
        return path, release

    def test_retains_upgrade_policy(self):
        entry = catalog.validate_package(*self.package())
        self.assertEqual(entry['channel'], 'stable')
        self.assertEqual(entry['minimumInstalledVersion'], '1.7.1')
        self.assertEqual(entry['maximumInstalledVersion'], '1.7.1')

    def test_rejects_changed_bytes(self):
        path, release = self.package()
        release['asset']['digest'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'asset_integrity'):
            catalog.validate_package(path, release)

    def test_new_release_cannot_be_offered_to_older_worker(self):
        def worker3(files, manifest):
            name='installer/update_service/__init__.py'
            files[name]=b'VERSION = 3\n'
            manifest['files'][name]=hashlib.sha256(files[name]).hexdigest()
        entry=catalog.validate_package(*self.package(worker3))
        self.assertEqual(entry['minimumUpdater'],3)

    def test_ambiguous_worker_version_is_rejected(self):
        def ambiguous(files, manifest):
            name='installer/update_service/__init__.py'
            files[name]=b'VERSION = 2\nVERSION = 3\n'
            manifest['files'][name]=hashlib.sha256(files[name]).hexdigest()
        with self.assertRaisesRegex(ValueError,'worker_version_invalid'):
            catalog.validate_package(*self.package(ambiguous))

    def test_false_rollback_still_rejected_without_migration_approval(self):
        def forward(files,manifest):
            manifest['compatibility']['rollback_compatible']=False
            files['release-policy.json']=json.dumps(manifest['compatibility']).encode()
            manifest['files']['release-policy.json']=hashlib.sha256(files['release-policy.json']).hexdigest()
        package=self.package(forward)
        with self.assertRaisesRegex(ValueError,'contract_incompatible'):
            catalog.validate_package(*package)
        entry=catalog.validate_package(*package,migration=True)
        self.assertIs(entry['rollbackCompatible'],False)

    def test_migration_mode_never_skips_integrity(self):
        path,release=self.package();release['asset']['digest']='0'*64
        with self.assertRaisesRegex(ValueError,'asset_integrity'):
            catalog.validate_package(path,release,migration=True)

    def test_rejects_wrong_commit(self):
        with self.assertRaisesRegex(ValueError, 'manifest_identity'):
            catalog.validate_package(*self.package(lambda f, m: m.update(source_sha='b' * 40)))

    def test_rejects_unhashed_file_change(self):
        with self.assertRaisesRegex(ValueError, 'file_integrity'):
            catalog.validate_package(*self.package(lambda f, m: f.update(VERSION=b'wrong')))

    def test_rejects_missing_worker(self):
        with self.assertRaisesRegex(ValueError, 'updater_files_missing'):
            catalog.validate_package(*self.package(lambda f, m: f.pop('installer/update_service/new_install.py')))

    def test_rejects_traversal_and_links(self):
        for name, kind in [('../evil', tarfile.REGTYPE), ('link', tarfile.SYMTYPE), ('VERSION', tarfile.REGTYPE)]:
            extra = tarfile.TarInfo(name)
            extra.type = kind
            with self.assertRaisesRegex(ValueError, 'unsafe_archive'):
                catalog.validate_package(*self.package(extra=extra))

    def test_rejects_different_trust(self):
        path, release = self.package()
        (self.root / 'trust.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'updater_trust_mismatch'):
            catalog.validate_package(path, release)


if __name__ == '__main__':
    unittest.main()
