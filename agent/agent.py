#!/usr/bin/env python3
"""Outbound-only central pairing adapter. Executes only the existing pinned installer.

No shell command payloads, SSH access, remote DB credentials, or remote updates.
The platform may request installation/retry; root controls the local credential.
"""
import argparse
import fcntl
import getpass
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

BASE = Path('/etc/btos-agent')
WORK = Path('/opt/btos-agent')
REPOSITORY = 'Assyauq26/buattokoonline'
ORIGIN = 'https://buattokosendiri.web.id'


def save(path, data):
    temp = path.with_suffix('.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(data, out)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp, path)


def read(path):
    return json.loads(path.read_text())


def api(config, route, data=None):
    request = urllib.request.Request(ORIGIN + '/api/platform/agent/' + route,
        data=None if data is None else json.dumps(data).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['credential']})
    # HTTPS certificate validation remains enabled. Redirects are forbidden for credentials.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_):
            return None
    with urllib.request.build_opener(NoRedirect).open(request, timeout=25) as response:
        return json.load(response)


def run(args, timeout=300):
    # Log only generic operation failures; installer stdout may contain setup tokens.
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        raise RuntimeError('LOCAL_OPERATION_FAILED')
    return result.stdout.decode().strip()


def validate_release(release):
    if (release.get('repository') != REPOSITORY or release.get('approved') is not True
        or not re.fullmatch(r'v\d+\.\d+\.\d+', release.get('version', ''))
        or not re.fullmatch(r'[a-f0-9]{40}', release.get('sha', ''))):
        raise RuntimeError('RELEASE_NOT_APPROVED')


class Reporter:
    def __init__(self, config, job):
        self.config, self.job = config, job
        self.path = BASE / 'progress.json'
        self.state = read(self.path) if self.path.exists() else {'job': job['id'], 'sequence': job['sequence']}
        if self.state['job'] != job['id']:
            raise RuntimeError('JOB_ID_CHANGED')

    def flush(self):
        if self.state.get('pending'):
            result = api(self.config, 'event', self.state['pending'])
            self.state['sequence'] = result['sequence']
            self.state.pop('pending')
            save(self.path, self.state)

    def event(self, stage, state='running', evidence=None):
        self.flush()
        self.state['pending'] = {'jobId': self.job['id'], 'sequence': self.state['sequence'] + 1,
            'stage': stage, 'state': state, 'evidence': evidence or {}}
        save(self.path, self.state)
        self.flush()


def install(config, job, store, report):
    release = job['release']
    validate_release(release)
    source = WORK / ('source-' + release['sha'])
    report.event('preflight')
    if not source.exists():
        source.mkdir(mode=0o700)
        run(['git', 'init', '-q', str(source)])
    run(['git', '-C', str(source), 'fetch', '--depth=1', 'https://github.com/' + REPOSITORY + '.git', 'refs/tags/' + release['version']])
    if run(['git', '-C', str(source), 'rev-parse', 'FETCH_HEAD^{commit}']) != release['sha']:
        raise RuntimeError('RELEASE_SHA_MISMATCH')
    run(['git', '-C', str(source), 'checkout', '--detach', release['sha']])
    if (source / 'VERSION').read_text().strip() != release['version'][1:]:
        raise RuntimeError('RELEASE_VERSION_MISMATCH')
    report.event('runtime')
    run(['bash', str(source / 'install.sh')], timeout=1200)
    # The local recovery wizard is stopped while the agent owns the installer lock.
    run(['systemctl', 'stop', 'single-store-setup.service'])
    sys.path.insert(0, '/opt/single-store/manager')
    core = importlib.import_module('core')
    state = core.read_json(core.STATE)
    if state['source_sha'] != release['sha'] or state.get('local_test'):
        raise RuntimeError('INSTALLATION_IDENTITY_MISMATCH')
    name = core.validate_name(store['name'])
    domain = core.validate_domain(store['domain'])
    if state.get('bootstrap_started') and (state.get('name') != name or state.get('domain') != domain):
        raise RuntimeError('STORE_IDENTITY_CHANGED')
    state.update(name=name, domain=domain, admin_email=store['admin_email'], www=False)
    if state.get('complete'):
        core.healthy(False)
        core.public_health(state)
    else:
        core.atomic_json(core.STATE, state)
        core.create_secrets(domain)
        report.event('dns')
        status, evidence = core.verify_domain(state)
        state.update(status=status, evidence=evidence)
        core.atomic_json(core.STATE, state)
        if status != 'Domain berhasil terhubung':
            report.event('https' if status == 'Sedang mengaktifkan HTTPS' else 'dns', 'waiting_dns',
                {'ipv4': state.get('ips', {}).get('ipv4', ''), 'error_code': 'CHECK_DNS_AND_PORTS'})
            return
        report.event('https', evidence={'https': evidence['https'], 'ipv4': state['ips']['ipv4']})
        password_path = BASE / 'admin-password'
        if not password_path.exists():
            fd = os.open(password_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as out:
                out.write('Bt!' + secrets.token_urlsafe(24))
                out.flush()
                os.fsync(out.fileno())
        password = password_path.read_text()
        core.validate_admin(store['admin_email'], password, password)
        state.update(bootstrap_started=True, step=3, verified_at=int(time.time()))
        core.atomic_json(core.STATE, state)
        # Observe actual existing core operations without duplicating them.
        original_dc = core.dc
        def observed_dc(args, *pos, **kw):
            if args[:1] == ['build']:
                report.event('application')
            elif args[:1] == ['up'] and args[-1] == 'db':
                report.event('database')
            elif 'bootstrap' in args:
                report.event('admin')
            elif args[:1] == ['up'] and args[-1] == 'app':
                report.event('health')
            return original_dc(args, *pos, **kw)
        core.dc = observed_dc
        try:
            core.initialize_store(state, password)
        finally:
            core.dc = original_dc
        del password
    run(['systemctl', 'disable', '--now', 'single-store-setup.service'])
    report.event('complete', 'complete', {'https': 'PUBLIC_CERTIFICATE_VALID', 'application': 'healthy',
        'version': release['version'], 'source_sha': release['sha']})


def setup():
    if (Path('/etc/single-store').exists() or Path('/opt/single-store').exists()) and not (BASE / 'config.json').exists():
        raise RuntimeError('EXISTING_STORE_REQUIRES_OPERATOR')
    for directory in [BASE, WORK]:
        if directory.is_symlink():
            raise RuntimeError('UNSAFE_DIRECTORY')
        directory.mkdir(mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
    config_path = BASE / 'config.json'
    config = read(config_path) if config_path.exists() else {'credential': secrets.token_hex(32)}
    save(config_path, config)  # persisted before network for idempotent pairing retries
    pairing = getpass.getpass('Token pairing dari wizard (input disembunyikan): ')
    if not re.fullmatch('[a-f0-9]{64}', pairing):
        raise RuntimeError('INVALID_PAIRING_TOKEN')
    api(config, 'pair', {'token': pairing, 'credential': config['credential']})
    print('Pairing berhasil. Pantau wizard. Password admin hanya tersimpan di VPS:')
    print('sudo cat /etc/btos-agent/admin-password')


def main():
    if os.geteuid() != 0:
        raise SystemExit('Jalankan sebagai root.')
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--setup', action='store_true')
    args = parser.parse_args()
    if args.setup:
        setup()
        return
    config = read(BASE / 'config.json')
    with open('/run/btos-agent.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        while True:
            try:
                payload = api(config, 'job')
                job = payload.get('job')
                if job and job['state'] in ['queued', 'running']:
                    report = Reporter(config, job)
                    stop = threading.Event()
                    def heartbeat():
                        while not stop.wait(30):
                            try:
                                api(config, 'job')
                            except Exception:
                                pass
                    worker = threading.Thread(target=heartbeat, daemon=True)
                    worker.start()
                    try:
                        report.flush()
                        install(config, job, payload['store'], report)
                    except Exception:
                        try:
                            report.event('preflight', 'failed', {'error_code': 'LOCAL_OPERATION_FAILED'})
                        except Exception:
                            pass  # durable outbox replays on reconnect
                        print('Instalasi tertunda. Periksa journal dan log installer root-only.', flush=True)
                    finally:
                        stop.set()
                        worker.join(timeout=1)
            except urllib.error.HTTPError as error:
                if error.code in [401, 403]:
                    raise SystemExit('Agent dicabut. Layanan berhenti.')
                print('Platform belum tersedia; akan mencoba kembali.', flush=True)
            except Exception:
                print('Koneksi tertunda; progres lokal dipertahankan.', flush=True)
            time.sleep(15)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Agent gagal. Periksa konfigurasi lokal root-only; tidak ada data yang dihapus.')
