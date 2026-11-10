"""Operator-only Tencent pilot. No application replacement, DNS or public signup.

Invoke as root with an exact reviewed source commit and prepare/activate/rollback.
Secrets are generated on this host and never included in output or argv.
Rollback removes only the pilot route and stops the two new services; keeps data.
"""
import fcntl
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path('/etc/btos-whatsapp')
STATE = Path('/var/lib/btos-whatsapp')
JOURNAL = ROOT / 'pilot.json'
CADDY = Path('/etc/single-store/Caddyfile')
IMAGE = 'ghcr.io/rmyndharis/openwa@sha256:3902f1bc22744dd46b07f010653e345001832d8b79fdbe76d057869b378d186c'
RELAY_IMAGE = 'sha256:164354e7f1b4a0a385bb3feec5ea830404cd41c717294b91576efb7b0f3ebedd'
TENANT = '97c986b8-ce29-46d4-9cb3-26c61cd21b77'
NAMES = ['single-store-app-1', 'single-store-db-1', 'single-store-proxy-1',
         'btos-platform-app-1', 'btos-platform-db-1', 'btos-platform-router',
         'btos-mail-relay-relay-1']
ROUTE = '''  # BEGIN BTOS WHATSAPP PILOT
  @whatsapp_pilot {
    method POST
    path /api/platform/whatsapp/*
  }
  handle @whatsapp_pilot {
    reverse_proxy btos-whatsapp-relay-1:8092
  }
  # END BTOS WHATSAPP PILOT
'''


def run(args, data=None, timeout=120):
    r = subprocess.run([str(a) for a in args], input=data, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, timeout=timeout)
    if r.returncode:
        raise RuntimeError('operator_step_failed:' + str(args[0]))
    return r.stdout


def write(path, content, mode=0o600):
    path.write_text(content)
    path.chmod(mode)


def save(j):
    write(JOURNAL, json.dumps(j, indent=2))


def snapshot():
    return {n: run(['docker', 'inspect', '--format', '{{.Id}} {{.State.StartedAt}} {{.State.Running}}', n]).decode().strip() for n in NAMES}


def health():
    for url in ['https://hubify.web.id/api/v1/ready', 'https://buattokosendiri.web.id/api/platform/health']:
        value = json.loads(run(['curl', '-fsS', '--max-time', '15', url]))
        if not isinstance(value, dict):
            raise RuntimeError('health_failed')


def dc(*args):
    return run(['docker', 'compose', '-p', 'btos-whatsapp', '-f', ROOT / 'compose.json', *args], timeout=180)


def sql(text):
    return run(['docker', 'exec', '-i', 'btos-platform-db-1', 'psql', '-U', 'platform_owner', '-d', 'platform', '-v', 'ON_ERROR_STOP=1', '-At'], text.encode())


def reload_caddy(content):
    # Validate before changing the live bind-mounted file. Do not rename it:
    # Docker's existing bind mount references this inode.
    candidate = ROOT / 'candidate.Caddyfile'
    write(candidate, content)
    run(['docker', 'cp', candidate, 'single-store-proxy-1:/tmp/whatsapp-candidate.Caddyfile'])
    run(['docker', 'exec', 'single-store-proxy-1', 'caddy', 'validate', '--config', '/tmp/whatsapp-candidate.Caddyfile', '--adapter', 'caddyfile'])
    CADDY.write_text(content)
    run(['docker', 'exec', 'single-store-proxy-1', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'])


def rollback(j):
    current = CADDY.read_text()
    if ROUTE in current:
        reload_caddy(current.replace(ROUTE, '', 1))
    dc('stop')
    health()
    j['state'] = 'stopped'; save(j)
    print('WHATSAPP_PILOT_STOPPED_DATA_PRESERVED')


def prepare(sha):
    if JOURNAL.exists():
        raise RuntimeError('existing_pilot_requires_review')
    health()
    if 'APP_ORIGIN=https://hubify.web.id' not in Path('/etc/single-store/runtime.env').read_text().splitlines():
        raise RuntimeError('target_mismatch')
    mem = dict((a.rstrip(':'), int(b)) for a, b, *_ in (l.split() for l in Path('/proc/meminfo').read_text().splitlines()))
    if mem['MemAvailable'] < 650 * 1024 or os.statvfs('/').f_bavail * os.statvfs('/').f_frsize < 5 * 1024**3:
        raise RuntimeError('insufficient_capacity')
    ROOT.mkdir(mode=0o700, exist_ok=True); STATE.mkdir(mode=0o700, exist_ok=True)
    source = Path('/opt/btos-whatsapp/releases') / sha
    run(['git', 'clone', '--no-checkout', 'https://github.com/Assyauq26/buattokosendiri-landing.git', source], timeout=180)
    run(['git', '-C', source, 'checkout', '--detach', sha])
    if run(['git', '-C', source, 'rev-parse', 'HEAD']).decode().strip() != sha:
        raise RuntimeError('source_mismatch')
    # Reviewed public source only; secrets remain in the separate root-only dir.
    mounted_source = source / 'server/whatsapp'
    mounted_source.chmod(0o755)
    for entry in mounted_source.rglob('*'):
        entry.chmod(0o755 if entry.is_dir() else 0o644)
    labels = json.loads(run(['docker', 'image', 'inspect', IMAGE]))[0]['Config']['Labels']
    if labels.get('org.opencontainers.image.revision') != '79d7f865e0518cb2d210deb28a84dcb0f4f39e66':
        raise RuntimeError('provider_revision_mismatch')
    run(['docker', 'image', 'inspect', RELAY_IMAGE])
    backup = Path('/var/backups/btos-platform') / ('whatsapp-' + str(int(time.time())))
    backup.mkdir(mode=0o700)
    write(backup / 'Caddyfile', CADDY.read_text())
    with open(backup / 'platform.dump', 'wb') as out:
        subprocess.run(['docker', 'exec', 'btos-platform-db-1', 'pg_dump', '-U', 'platform_owner', '-d', 'platform', '-Fc'], stdout=out, stderr=subprocess.DEVNULL, check=True, timeout=120)
    run(['docker', 'exec', '-i', 'btos-platform-db-1', 'pg_restore', '--list'], (backup / 'platform.dump').read_bytes())
    j = {'sha': sha, 'source': str(source), 'backup': str(backup), 'services': snapshot(), 'state': 'preparing', 'caddyBefore': hashlib.sha256(CADDY.read_bytes()).hexdigest()}
    save(j)
    print('PILOT_BACKUP_RECORDED', flush=True)
    if sql("SELECT id FROM stores WHERE id='" + TENANT + "' AND domain='hubify.web.id';").decode().strip() != TENANT:
        raise RuntimeError('tenant_mismatch')
    if sql("SELECT nspname FROM pg_namespace WHERE nspname='whatsapp_pilot';").strip():
        raise RuntimeError('schema_exists')
    dbpass, master, pepper, webhook, vault, token = [secrets.token_hex(32) for _ in range(6)]
    sql("CREATE ROLE btos_whatsapp LOGIN PASSWORD '" + dbpass + "' NOSUPERUSER NOCREATEDB NOCREATEROLE; CREATE SCHEMA whatsapp_pilot; SET search_path=whatsapp_pilot,public;\n" + (source / 'server/whatsapp/schema.sql').read_text() + "\nGRANT USAGE ON SCHEMA whatsapp_pilot TO btos_whatsapp; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA whatsapp_pilot TO btos_whatsapp; ALTER ROLE btos_whatsapp SET search_path=whatsapp_pilot,public;")
    print('PILOT_SCHEMA_ISOLATED', flush=True)
    data = STATE / 'openwa'; data.mkdir(mode=0o700); os.chown(data, 1000, 1000)
    write(ROOT / 'hubify-token', token + '\n', 0o440); os.chown(ROOT / 'hubify-token', 0, 1000)
    provider = {
        'NODE_ENV': 'production', 'PORT': '2785', 'API_PORT': '2785', 'API_MASTER_KEY': master,
        'API_KEY_PEPPER': pepper, 'ENGINE_TYPE': 'baileys', 'MAX_CONCURRENT_SESSIONS': '2',
        'AUTO_START_SESSIONS': 'false', 'RESOLVE_LID_TO_PHONE': 'true', 'BAILEYS_SYNC_FULL_HISTORY': 'false',
        'BAILEYS_LOG_LEVEL': 'silent', 'LOG_LEVEL': 'error', 'DATABASE_LOGGING': 'false',
        'QUEUE_ENABLED': 'false', 'CACHE_ENABLED': 'false', 'SEARCH_ENABLED': 'false', 'UPDATE_CHECK_ENABLED': 'false',
        'DATABASE_TYPE': 'sqlite', 'DATABASE_NAME': '/app/data/openwa.sqlite', 'MAIN_DATABASE_NAME': '/app/data/main.sqlite',
        'DATABASE_SYNCHRONIZE': 'false', 'MAIN_DATABASE_SYNCHRONIZE': 'false',
        'WEBHOOK_SSRF_PROTECT': 'true', 'SSRF_ALLOWED_HOSTS': 'relay',
        'WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS': '0', 'MESSAGE_RETENTION_DAYS': '1', 'WEBHOOK_MEDIA_INLINE_MAX_BYTES': '0',
    }
    relay = {
        'WA_DATABASE_URL': 'postgresql://btos_whatsapp:' + dbpass + '@db:5432/platform',
        'OPENWA_PRIVATE_ORIGIN': 'http://openwa:2785', 'OPENWA_API_KEY': master, 'OPENWA_WEBHOOK_SECRET': webhook,
        'WA_SECRET': vault, 'WA_CENTRAL_PHONE': '+6282211700060', 'WA_ALLOWED_RECIPIENTS': '+6281575652263',
        'WA_AUTH_ENABLED': '1', 'WA_SERVICE_ENABLED': '1', 'WA_NOTIFICATIONS_ENABLED': '1',
        'WA_BIND_HOST': '0.0.0.0', 'WA_PORT': '8092', 'WA_OPERATOR_PAIRING': '1', 'WA_PILOT_STORE_ID': TENANT,
    }
    for name, env in [('provider.env', provider), ('relay.env', relay)]:
        write(ROOT / name, ''.join(k + '=' + v + '\n' for k, v in env.items()))
    common = {'restart': 'unless-stopped', 'read_only': True, 'user': '1000:1000', 'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'], 'pids_limit': 100, 'tmpfs': ['/tmp:size=64m,mode=1777']}
    compose = {'services': {
        'openwa': {**common, 'image': IMAGE, 'env_file': [str(ROOT / 'provider.env')], 'mem_limit': '384m', 'cpus': 0.6, 'volumes': [str(data) + ':/app/data'], 'networks': ['gateway'], 'logging': {'driver': 'none'}, 'ports': ['127.0.0.1:2785:2785']},
        'relay': {**common, 'image': RELAY_IMAGE, 'env_file': [str(ROOT / 'relay.env')], 'mem_limit': '128m', 'cpus': 0.3, 'working_dir': '/app', 'command': ['node', 'server/whatsapp/main.mjs'], 'volumes': [str(source / 'server/whatsapp') + ':/app/server/whatsapp:ro', str(ROOT / 'hubify-token') + ':/run/hubify-whatsapp-token:ro'], 'networks': ['gateway', 'database', 'edge'], 'ports': ['127.0.0.1:8092:8092', '127.0.0.1:8093:8093'], 'logging': {'driver': 'local', 'options': {'max-size': '1m', 'max-file': '2'}}, 'healthcheck': {'disable': True}},
    }, 'networks': {'gateway': {}, 'database': {'external': True, 'name': 'btos-platform_database'}, 'edge': {'external': True, 'name': 'single-store_web'}}}
    write(ROOT / 'compose.json', json.dumps(compose, indent=2))
    dc('config', '--quiet')
    dc('up', '-d', '--no-build', 'openwa')
    print('PILOT_PROVIDER_STARTING', flush=True)
    for _ in range(30):
        try:
            run(['curl', '-fsS', '--max-time', '4', 'http://127.0.0.1:2785/api/health/ready']); break
        except Exception:
            time.sleep(2)
    else:
        dc('stop'); raise RuntimeError('provider_not_ready')
    # One-time registry setup: does not connect sessions or send any message.
    dc('run', '--rm', '--no-deps', 'relay', 'node', 'server/whatsapp/provision-pilot.mjs')
    print('PILOT_REGISTRY_READY', flush=True)
    dc('up', '-d', '--no-build', 'relay')
    time.sleep(3)
    if run(['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', 'http://127.0.0.1:8092/api/platform/whatsapp/session/status', '-X', 'POST', '-H', 'Content-Type: application/json', '--data', '{}']).decode() != '401':
        raise RuntimeError('relay_auth_smoke_failed')
    health()
    if snapshot() != j['services']:
        raise RuntimeError('production_service_changed')
    j['state'] = 'private-ready'; save(j)
    print('WHATSAPP_PRIVATE_READY_NO_PAIRING_NO_MESSAGES')


def activate(j):
    if j['state'] != 'private-ready' or snapshot() != j['services'] or hashlib.sha256(CADDY.read_bytes()).hexdigest() != j['caddyBefore']:
        raise RuntimeError('preparation_changed')
    old = CADDY.read_text(); marker = '  @store_mail {'
    if old.count(marker) != 1:
        raise RuntimeError('route_target_ambiguous')
    try:
        reload_caddy(old.replace(marker, ROUTE + marker, 1))
        health()
        status = run(['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', 'https://buattokosendiri.web.id/api/platform/whatsapp/session/status', '-X', 'POST', '-H', 'Content-Type: application/json', '--data', '{}']).decode()
        if status != '401' or snapshot() != j['services']:
            raise RuntimeError('public_smoke_failed')
        j['state'] = 'route-active'; save(j)
        print('WHATSAPP_PILOT_ROUTE_ACTIVE_EXISTING_SERVICES_UNCHANGED')
    except Exception:
        reload_caddy(old); dc('stop'); health(); raise


if __name__ == '__main__':
    try:
        os.umask(0o077)
        if os.geteuid() != 0 or len(sys.argv) != 3 or not re.fullmatch('[a-f0-9]{40}', sys.argv[2]):
            raise RuntimeError('operator_arguments_required')
        with open('/run/btos-whatsapp-operation.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            action, sha = sys.argv[1:]
            if action == 'prepare': prepare(sha)
            elif action in ['activate', 'rollback']:
                j = json.loads(JOURNAL.read_text())
                if j['sha'] != sha: raise RuntimeError('source_mismatch')
                activate(j) if action == 'activate' else rollback(j)
            else: raise RuntimeError('unknown_action')
    except Exception as error:
        # Do not print subprocess output/SQL/env/provider payloads.
        print('WHATSAPP_OPERATOR_STOPPED ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
