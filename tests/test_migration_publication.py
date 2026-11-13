"""Run on the disposable QA VM: real immutable archives and Ed25519 signer.

Only a disposable key is generated; no production signing key is read.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('publication',Path(__file__).parents[1]/'deploy/migration-publication.py')
publication=importlib.util.module_from_spec(spec);spec.loader.exec_module(publication)


@unittest.skipUnless(os.environ.get('UPDATER_PUBLICATION_QA')=='1','Explicit disposable Linux QA required')
class Publication(unittest.TestCase):
    def test_real_policy_identity_signature_refresh_and_denials(self):
        with tempfile.TemporaryDirectory(prefix='/root/catalog-test-') as directory:
            root=Path(directory);keys=root/'keys';keys.mkdir();key=keys/'btos-release-202611.pem'
            subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(key)],check=True,capture_output=True)
            key.chmod(0o600)
            public=subprocess.check_output(['openssl','pkey','-in',str(key),'-pubout']).decode()
            (root/'trust.json').write_text(json.dumps({'btos-release-202611':public}))
            cfg={'source':'/opt/store-worker-final-1239bec','sha':'1239bec7b8c769810841a4aeb8f719e4770db8fa',
                'baselineArchive':'/tmp/updater-baseline-v174.tar.gz','channel':'pilot','installations':['a'*32]}
            approval=root/'approval.json';approval.write_text(json.dumps(cfg));approval.chmod(0o600)
            release={'version':'v1.8.0','sha':'7e81f8e60b27ab5695ac50ac6b653b63095e36d1','asset':{
                'url':'https://github.com/Assyauq26/buattokoonline/releases/download/v1.8.0/store-v1.8.0.tar.gz',
                'digest':'2e15208d27a87a4aeae4446404d45a1f91b55fcc5d28da3714dc064aeeaa9223','size':4398817}}
            def run(args):
                args=[a.replace('src=/etc/btos-release-signing,','src='+str(keys)+',') for a in args]
                return subprocess.check_output(args,stderr=subprocess.PIPE).decode()
            container=['docker','run','--rm','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges']
            now=int(time.time());source=Path(__file__).parents[1]
            with patch.object(publication,'APPROVAL',approval):
                entry,expiry=publication.migration_entry(Path('/tmp/updater-target-v180.tar.gz'),release,{'releases':[]},root,source,'single-store-app:installed',container,run,now)
                _,_,auth=publication.approved_modules()
                policy,_=auth(json.dumps(entry['upgradePolicy']).encode(),{'btos-release-202611':public},now=now)
                self.assertEqual(len(policy['beforeMigrations']),29);self.assertEqual(len(policy['afterMigrations']),30)
                self.assertIs(entry['rollbackCompatible'],False);self.assertEqual(entry['minimumUpdater'],3)
                self.assertEqual(policy['installations'],['a'*32]);self.assertEqual(expiry,now+86400)
                again,_=publication.migration_entry(Path('/tmp/updater-target-v180.tar.gz'),release,{'releases':[entry]},root,source,'single-store-app:installed',container,run,now+60)
                self.assertEqual(again,entry)
                refreshed,_=publication.migration_entry(Path('/tmp/updater-target-v180.tar.gz'),release,{'releases':[entry]},root,source,'single-store-app:installed',container,run,now+20*3600)
                next_policy,_=auth(json.dumps(refreshed['upgradePolicy']).encode(),{'btos-release-202611':public},now=now+20*3600)
                self.assertEqual(next_policy['sequence'],2)
                bad={**release,'sha':'0'*40}
                with self.assertRaisesRegex(ValueError,'unreviewed_migration_release'):
                    publication.migration_entry(Path('/tmp/updater-target-v180.tar.gz'),bad,{'releases':[]},root,source,'unused',[],run,now)
                approval.chmod(0o666)
                with self.assertRaisesRegex(ValueError,'publication_approval_permissions'):publication.approved_modules()


if __name__=='__main__':unittest.main()
