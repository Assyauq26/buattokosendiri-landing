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
import unicodedata
import sqlite3
from datetime import datetime, timezone

BASE = Path('/etc/btos-agent')
WORK = Path('/opt/btos-agent')
REPOSITORY = 'Assyauq26/buattokoonline'
ORIGIN = 'https://buattokosendiri.web.id'
AGENT_VERSION = '1.1.0'


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


def sync_mail(config, store, core):
    """Only paired agent receives a tenant token; never browser or shell arguments."""
    # A controller without provisioning enabled retains the legacy install flow.
    # It must not claim OTP readiness; the new controller gates completion itself.
    if store.get('mailRequired') is not True:
        return
    try:
        provisioning = api(config, 'mail', {})
    except urllib.error.HTTPError as error:
        if error.code == 403:
            raise RuntimeError('MAIL_DISABLED') from None
        raise
    token = provisioning.get('token', '')
    generation = provisioning.get('generation')
    if (not re.fullmatch('[a-f0-9]{64}', token) or not isinstance(generation, int)
            or provisioning.get('origin') != 'https://' + store['domain']):
        raise RuntimeError('MAIL_IDENTITY_MISMATCH')
    runtime = Path('/etc/single-store/runtime.env')
    content = runtime.read_text()
    if 'APP_ORIGIN=' + provisioning['origin'] not in content.splitlines():
        raise RuntimeError('MAIL_ORIGIN_MISMATCH')
    # Obtain the published identity directly from the local store database, not
    # from browser parameters. Relay compares it against the approved registry.
    brand = core.sql('SELECT published->\'identity\'->>\'name\' FROM "StoreAppearance";')
    brand = ''.join(c if unicodedata.category(c)[0] in 'LMN' or c in " .&'()-" else ' '
                    for c in unicodedata.normalize('NFKC', brand))
    brand = re.sub(r'\s+', ' ', brand).strip()[:80].strip() or 'Toko Online'
    request = urllib.request.Request(ORIGIN + '/api/platform/store-mail/status',
        data=json.dumps({'origin': provisioning['origin'], 'brand': brand}).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
            if response.status != 200:
                raise RuntimeError('MAIL_NOT_READY')
            receipt = json.load(response)['receipt']
    except urllib.error.HTTPError:
        raise RuntimeError('MAIL_NOT_READY') from None
    line = 'STORE_MAIL_RELAY_TOKEN=' + token
    if line not in content.splitlines():
        updated = re.sub(r'^STORE_MAIL_(?:RELAY_TOKEN|MODE)=.*\n?', '', content, flags=re.M)
        updated = updated.rstrip() + '\n' + line + '\n'
        temp = runtime.with_suffix('.mail.tmp')
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as out:
            out.write(updated)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, runtime)
        directory = os.open(runtime.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    # Recreate even after an interrupted prior env write; Compose reconciles config.
    core.dc(['up', '-d', '--no-deps', '--wait', 'app'])
    core.healthy(False)
    api(config, 'mail-ack', {'generation': generation, 'receipt': receipt})


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
            # Keep the previous outbox for diagnostics without replaying it into a new job.
            self.path.rename(BASE / ('progress.previous-' + str(time.time_ns()) + '.json'))
            self.state = {'job': job['id'], 'sequence': job['sequence']}

    def flush(self):
        if self.state.get('pending'):
            result = api(self.config, 'event', self.state['pending'])
            self.state['sequence'] = result['sequence']
            self.state.pop('pending')
            save(self.path, self.state)

    def event(self, stage, state='running', evidence=None):
        self.flush()
        self.state['stage'] = stage
        self.state['pending'] = {'jobId': self.job['id'], 'sequence': self.state['sequence'] + 1,
            'stage': stage, 'state': state, 'evidence': evidence or {}}
        save(self.path, self.state)
        self.flush()


def installed_store():
    config_dir = Path('/etc/single-store')
    if not (config_dir / 'installed').is_file():
        return None
    state = read(config_dir / 'setup.json')
    domain = state.get('domain', '')
    if (not state.get('complete') or state.get('local_test') or not isinstance(domain, str)
            or not re.fullmatch(r'[a-z0-9.-]{1,253}', domain)
            or f'APP_ORIGIN=https://{domain}' not in (config_dir / 'runtime.env').read_text().splitlines()):
        raise RuntimeError('EXISTING_STORE_REQUIRES_OPERATOR')
    return state


def reconnect_store(config, state, store, report):
    if state['domain'] != store['domain']:
        report.event('preflight', 'failed', {'error_code': 'EXISTING_STORE_DOMAIN_MISMATCH'})
        return
    report.event('preflight')
    sys.path.insert(0, '/opt/single-store/manager')
    core = importlib.import_module('core')
    if store.get('vps_ipv4') and core.discover_ips()['ipv4'] != store['vps_ipv4']:
        report.event('dns', 'failed', {'error_code': 'WRONG_VPS_IP'})
        return
    version = read(Path('/etc/single-store/version.json'))
    if not re.fullmatch(r'[a-f0-9]{40}', version.get('source_sha', '')) or not re.fullmatch(r'\d+\.\d+\.\d+', version.get('version', '')):
        raise RuntimeError('INSTALLATION_IDENTITY_MISMATCH')
    report.event('health')
    core.healthy(False)
    core.public_health(state)
    sync_mail(config, store, core)
    report.event('complete', 'complete', {
        'https': 'PUBLIC_CERTIFICATE_VALID', 'application': 'healthy',
        'version': 'v' + version['version'], 'source_sha': version['source_sha'],
        'installation': 'reattached',
    })


def install(config, job, store, report):
    existing = installed_store()
    if existing:
        reconnect_store(config, existing, store, report)
        return
    if config.get('passwordFromWizard') and not store.get('vps_ipv4'):
        raise RuntimeError('PLATFORM_WIZARD_PROTOCOL_UNAVAILABLE')
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
        if store.get('vps_ipv4'):
            actual_ip = core.discover_ips()['ipv4']
            if actual_ip != store['vps_ipv4']:
                report.event('dns', 'failed', {'ipv4': actual_ip, 'error_code': 'WRONG_VPS_IP'})
                return
        status, evidence = core.verify_domain(state)
        state.update(status=status, evidence=evidence)
        core.atomic_json(core.STATE, state)
        if status != 'Domain berhasil terhubung':
            report.event('https' if status == 'Sedang mengaktifkan HTTPS' else 'dns', 'waiting_dns',
                {'ipv4': state.get('ips', {}).get('ipv4', ''), 'error_code': 'CHECK_DNS_AND_PORTS'})
            return
        report.event('https', evidence={'https': evidence['https'], 'ipv4': state['ips']['ipv4']})
        if store.get('vps_ipv4'):
            password = api(config, 'admin-password')['password']
        else:
            # Jobs paired before the Info Toko password flow keep their recovery path.
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
    sync_mail(config, store, core)
    report.event('complete', 'complete', {'https': 'PUBLIC_CERTIFICATE_VALID', 'application': 'healthy',
        'version': release['version'], 'source_sha': release['sha']})


def setup(token_stdin=False):
    existing = installed_store()
    if not existing and not (BASE / 'config.json').exists():
        if any(path.exists() or path.is_symlink() for path in (
                Path('/etc/single-store'), Path('/opt/single-store'), Path('/var/lib/single-store'))):
            raise SystemExit('Data instalasi toko lama belum dikenali. Periksa pemulihan instalasi di VPS.')
        for port in (80, 443, 3000, 8787):
            if run(['ss', '-H', '-ltn', f'sport = :{port}']):
                raise SystemExit(f'Port {port} sedang digunakan. Kosongkan port tersebut sebelum memasang toko.')
    for directory in [BASE, WORK]:
        if directory.is_symlink():
            raise RuntimeError('UNSAFE_DIRECTORY')
        directory.mkdir(mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
    config_path = BASE / 'config.json'
    config = read(config_path) if config_path.exists() else {'credential': secrets.token_hex(32)}
    pairing = (sys.stdin.readline(66).strip() if token_stdin else
               getpass.getpass('Token pairing dari wizard (input disembunyikan): '))
    if not re.fullmatch('[a-f0-9]{64}', pairing):
        raise RuntimeError('INVALID_PAIRING_TOKEN')
    pairing_hash = hashlib.sha256(pairing.encode()).hexdigest()
    if config_path.exists():
        try:
            previous = api(config, 'job')
        except urllib.error.HTTPError as error:
            if error.code != 401:
                raise
            if config.get('pairingHash') != pairing_hash:
                config = {'credential': secrets.token_hex(32)}
        else:
            if not previous.get('store') or (existing and previous['store']['domain'] != existing['domain']):
                raise RuntimeError('ENROLLMENT_CONFLICT')
            if not existing and (previous.get('job') or {}).get('state') == 'complete':
                raise RuntimeError('LOCAL_INSTALLATION_MISSING_RESET_REQUIRED')
            # The current installation already owns its slot. A new token does
            # not reassign this VPS or overwrite local data.
            config['passwordFromWizard'] = bool(previous['store'].get('vps_ipv4'))
            if (previous.get('job') or {}).get('agent_id'):
                config['installationId'] = previous['job']['agent_id']
            config['storeOrigin'] = 'https://' + previous['store']['domain']
            save(config_path, config)
            print('VPS sudah terhubung. Kembali ke wizard untuk memantau instalasi.')
            return
    config['pairingHash'] = pairing_hash
    save(config_path, config)  # Persist before network for lost-response retries.
    ipv4 = run(['curl', '-4', '--noproxy', '*', '--proto', '=https', '-fsS', '--max-time', '8',
                'https://api.ipify.org'], timeout=10)
    try:
        request = {'token': pairing, 'credential': config['credential'], 'protocol': 2, 'ipv4': ipv4}
        if existing:
            request['existingDomain'] = existing['domain']
        result = api(config, 'pair', request)
    except urllib.error.HTTPError as error:
        if error.code in (409, 410, 422):
            detail = json.load(error).get('error')
            raise SystemExit(detail if isinstance(detail, str) else 'Pairing ditolak oleh platform.')
        raise
    if not isinstance(result.get('passwordFromWizard'), bool):
        raise SystemExit('Platform belum mendukung wizard terbaru. Coba lagi setelah platform siap.')
    config['passwordFromWizard'] = result['passwordFromWizard']
    config['installationId'] = result['agentId']
    save(config_path, config)
    print('VPS terhubung. Kembali ke wizard untuk memantau instalasi.')


def report_observation(config):
    data = {'agentVersion': AGENT_VERSION}
    try:
        version = read(Path('/etc/single-store/version.json'))
        if re.fullmatch(r'\d{1,3}\.\d{1,3}\.\d{1,3}', version.get('version', '')):
            data['appVersion'] = 'v' + version['version']
        if re.fullmatch(r'[a-f0-9]{40}', version.get('source_sha', '')):
            data['sourceSha'] = version['source_sha']
        data['updater'] = ('available' if Path('/run/single-store-updater').is_dir()
                           else 'unavailable')
        updater_config = read(Path('/etc/single-store/updater/config.json'))
        if re.fullmatch(r'[a-f0-9]{32}', updater_config.get('installation', '')):
            data['updaterInstallationId'] = updater_config['installation']
    except (OSError, ValueError, TypeError):
        pass
    try:
        request = urllib.request.Request('http://127.0.0.1:3000/api/v1/ready')
        # Fixed local endpoint only, with redirects forbidden.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_):
                return None
        with urllib.request.build_opener(NoRedirect).open(request, timeout=3) as response:
            result = json.load(response)
            data['application'] = 'ready' if result.get('data', {}).get('status') == 'ready' else 'unavailable'
    except (OSError, ValueError):
        data['application'] = 'unavailable'
    try:
        state = Path('/var/lib/single-store/updater/state.sqlite')
        if state.is_file() and not state.is_symlink():
            with sqlite3.connect(state.as_uri() + '?mode=ro', uri=True, timeout=1) as db:
                row = db.execute('SELECT state,updated FROM jobs ORDER BY created DESC LIMIT 1').fetchone()
                if row:
                    data['updateState'] = row[0]
                    data['updateAt'] = datetime.fromtimestamp(row[1], timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        backups = Path('/var/backups/single-store')
        manifests = list(backups.glob('*/backup.json'))
        if manifests:
            newest = max(path.stat().st_mtime for path in manifests if not path.is_symlink())
            data['backupAt'] = datetime.fromtimestamp(newest, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    except (OSError, ValueError, sqlite3.Error):
        pass
    api(config, 'observation', data)


def main():
    if os.geteuid() != 0:
        raise SystemExit('Jalankan sebagai root.')
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--setup', action='store_true')
    parser.add_argument('--token-stdin', action='store_true')
    args = parser.parse_args()
    if args.setup:
        with open('/run/btos-agent-enrollment.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            setup(args.token_stdin)
        return
    config = read(BASE / 'config.json')
    next_mail_sync = 0
    next_observation = 0
    with open('/run/btos-agent.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        while True:
            try:
                payload = api(config, 'job')
                job = payload.get('job')
                if payload.get('store') and config.get('storeOrigin') != 'https://' + payload['store']['domain']:
                    config['storeOrigin'] = 'https://' + payload['store']['domain']
                    save(BASE / 'config.json', config)
                if time.monotonic() >= next_observation:
                    next_observation = time.monotonic() + 60
                    try:
                        report_observation(config)
                    except (OSError, ValueError):
                        pass  # Older controllers do not have the observation route.
                if job and job['state'] == 'complete' and time.monotonic() >= next_mail_sync:
                    next_mail_sync = time.monotonic() + 120
                    sys.path.insert(0, '/opt/single-store/manager')
                    with open('/run/single-store-operation.lock', 'w') as operation:
                        fcntl.flock(operation, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        sync_mail(config, payload['store'], importlib.import_module('core'))
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
                            report.event(report.state.get('stage', job['stage']), 'failed', {'error_code': 'LOCAL_OPERATION_FAILED'})
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
