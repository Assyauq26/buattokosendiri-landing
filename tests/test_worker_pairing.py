"""Integration boundaries: a store installer must not silently retain worker v2."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('agent',Path(__file__).parents[1]/'agent/agent.py')
agent=importlib.util.module_from_spec(spec);spec.loader.exec_module(agent)


class WorkerPairing(unittest.TestCase):
    def test_unknown_app_digest_rejected_before_mutation(self):
        with patch.object(agent,'run') as command:
            with self.assertRaisesRegex(RuntimeError,'UNREVIEWED_WORKER_PAIRING'):
                agent.install_v180_worker({'sha':agent.APP_V180_SHA,'asset':{'digest':'0'*64}})
            command.assert_not_called()

    def test_worker_failure_cannot_report_completion(self):
        with patch.object(agent,'run',side_effect=RuntimeError('unit failed')):
            with self.assertRaises(RuntimeError):agent.finish_v180_worker()

    def test_receipt_must_match_reviewed_source(self):
        with patch.object(agent,'run'),patch.object(agent,'read',return_value={'phase':'complete','sourceSha':'0'*40}):
            with self.assertRaisesRegex(RuntimeError,'WORKER_PROVISIONING_INCOMPLETE'):agent.finish_v180_worker()

    def test_timer_and_agent_share_systemd_serialization(self):
        with patch.object(agent,'run') as command,patch.object(agent,'verify_v180_worker') as verify,patch.object(agent,'read',return_value={'phase':'complete','sourceSha':agent.WORKER_V3_SHA}):
            agent.finish_v180_worker()
            command.assert_called_once_with(['systemctl','start','single-store-worker-v3-bootstrap.service'],timeout=180)
            verify.assert_called_once_with()


if __name__=='__main__':unittest.main()
