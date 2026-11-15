"""Policy identity/renewal tests; production credentials are never used."""
import base64
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('blu_publication',Path(__file__).parents[1]/'deploy/migration-publication.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def envelope(p):return {'payload':base64.b64encode(json.dumps(p).encode()).decode(),'signature':'fixture','keyId':'fixture'}

class BluPublication(unittest.TestCase):
    def test_other_migrations_are_not_approved(self):
        with self.assertRaisesRegex(ValueError,'unreviewed_migration_release'):module.approved_modules('v1.8.4')
    def test_blu_target_cohort_global_sequence_and_refresh(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'trust.json').write_text('{}')
            cfg={'targetSha':'a'*40,'artifactDigest':'b'*64,'baselineArchive':'fixture','installations':['*'],'channel':'stable'}
            release={'version':'v1.8.2','sha':'a'*40,'asset':{'digest':'b'*64,'size':123,'url':'fixture'}}
            now=10000
            def prepare(old,new,sha,digest,cohort,sequence,now):
                self.assertEqual((sha,digest,cohort),('a'*40,'b'*64,['*']))
                return dict(id='canonical-v181-to-v182-blu',sequence=sequence,issuedAt=now,expiresAt=now+86400)
            operator=types.SimpleNamespace(prepare=prepare)
            def authenticate(raw,roots,now):return json.loads(base64.b64decode(json.loads(raw)['payload'])), 'fixture'
            def run(args):
                policy=json.loads((root/'policy-input.json').read_text());(root/'policy.json').write_text(json.dumps(envelope(policy)))
            prior={'version':'1.8.0','upgradePolicy':envelope(dict(sequence=7,issuedAt=1,expiresAt=2))}
            with patch.object(module,'approved_modules',return_value=(cfg,operator,authenticate)):
                entry,expiry=module.migration_entry(root/'archive',release,{'releases':[prior]},root,root,'fixture',[],run,now)
                policy,_=authenticate(json.dumps(entry['upgradePolicy']).encode(),{},now)
                self.assertEqual(policy['sequence'],8)
                self.assertEqual(entry['minimumInstalledVersion'],'1.8.1');self.assertIs(entry['rollbackCompatible'],False)
                self.assertEqual(entry['minimumUpdater'],3);self.assertEqual(expiry,now+86400)
                retained,_=module.migration_entry(root/'archive',release,{'releases':[prior,entry]},root,root,'fixture',[],run,now+60)
                self.assertEqual(retained,entry)
                renewed,_=module.migration_entry(root/'archive',release,{'releases':[prior,entry]},root,root,'fixture',[],run,now+20*3600)
                p,_=authenticate(json.dumps(renewed['upgradePolicy']).encode(),{},now)
                self.assertEqual(p['sequence'],9)
                for bad in ({**release,'sha':'c'*40},{**release,'asset':{**release['asset'],'digest':'c'*64}}):
                    with self.assertRaisesRegex(ValueError,'unreviewed_migration_release'):
                        module.migration_entry(root/'archive',bad,{'releases':[]},root,root,'fixture',[],run,now)

if __name__=='__main__':unittest.main()
