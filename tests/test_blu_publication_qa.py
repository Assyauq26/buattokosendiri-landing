"""Actual archive/Git/signature proof in the already authorized disposable VM."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
ROOT=Path(__file__).parents[1]
spec=importlib.util.spec_from_file_location('publication',ROOT/'deploy/migration-publication.py')
publication=importlib.util.module_from_spec(spec);spec.loader.exec_module(publication)

@unittest.skipUnless(os.environ.get('UPDATER_BLU_PUBLICATION_QA')=='1','Explicit disposable Linux QA required')
class BluPublicationQA(unittest.TestCase):
    def test_real_canonical_archive_signature_refresh_and_denials(self):
        source=Path(os.environ['UPDATER_BLU_SOURCE']);archive=Path(os.environ['UPDATER_BLU_ARTIFACT'])
        sha=os.environ['UPDATER_BLU_SHA'];digest=os.environ['UPDATER_BLU_DIGEST'];image=os.environ['UPDATER_BLU_IMAGE']
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(),digest)
        with tempfile.TemporaryDirectory(prefix='/root/blu-catalog-qa-') as directory:
            root=Path(directory);keys=root/'keys';keys.mkdir();key=keys/'btos-release-202611.pem'
            subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(key)],check=True,capture_output=True);key.chmod(0o600)
            public=subprocess.check_output(['openssl','pkey','-in',str(key),'-pubout']).decode()
            (root/'trust.json').write_text(json.dumps({'btos-release-202611':public}))
            cfg={'source':str(source),'sha':sha,'targetSha':sha,'artifactDigest':digest,
                'baselineArchive':'/tmp/updater-baseline-v181.tar.gz','channel':'stable',
                'installations':['*'],'generalEligibilityReviewed':True}
            approval=root/'approval.json';approval.write_text(json.dumps(cfg));approval.chmod(0o600)
            release={'version':'v1.8.2','sha':sha,'asset':{'digest':digest,'size':archive.stat().st_size,
                'url':'https://github.com/Assyauq26/buattokoonline/releases/download/v1.8.2/store-v1.8.2.tar.gz'}}
            def run(args):
                args=[str(a).replace('src=/etc/btos-release-signing,','src='+str(keys)+',') for a in args]
                return subprocess.check_output(args,stderr=subprocess.PIPE).decode()
            container=['docker','run','--rm','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges']
            now=int(time.time())
            with patch.object(publication,'BLU_APPROVAL',approval):
                entry,expiry=publication.migration_entry(archive,release,{'releases':[]},root,ROOT,image,container,run,now)
                _,_,auth=publication.approved_modules('v1.8.2')
                policy,_=auth(json.dumps(entry['upgradePolicy']).encode(),{'btos-release-202611':public},now=now)
                self.assertEqual((len(policy['beforeMigrations']),len(policy['afterMigrations'])),(31,33))
                self.assertEqual(policy['installations'],['*']);self.assertEqual(policy['executor'],'blu-checkout-forward-v1')
                self.assertEqual(policy['sourceSha'],sha);self.assertEqual(policy['artifactDigest'],digest)
                self.assertEqual(expiry,now+86400)
                retained,_=publication.migration_entry(archive,release,{'releases':[entry]},root,ROOT,image,container,run,now+60)
                self.assertEqual(retained,entry)
                renewed,_=publication.migration_entry(archive,release,{'releases':[entry]},root,ROOT,image,container,run,now+20*3600)
                p,_=auth(json.dumps(renewed['upgradePolicy']).encode(),{'btos-release-202611':public},now=now+20*3600)
                self.assertEqual(p['sequence'],2)
                bad={**release,'asset':{**release['asset'],'digest':'f'*64}}
                with self.assertRaisesRegex(ValueError,'unreviewed_migration_release'):
                    publication.migration_entry(archive,bad,{'releases':[]},root,ROOT,image,container,run,now)
                approval.write_text(json.dumps({**cfg,'generalEligibilityReviewed':False}))
                with self.assertRaisesRegex(ValueError,'publication_cohort'):publication.approved_modules('v1.8.2')
                approval.chmod(0o666)
                with self.assertRaisesRegex(ValueError,'publication_approval_permissions'):publication.approved_modules('v1.8.2')

if __name__=='__main__':unittest.main()
