#!/usr/bin/env python3
"""Initialize only the platform's new secret directory; never read/modify Hubify secrets."""
import os
from pathlib import Path
import secrets
os.umask(0o077)
root = Path('/etc/btos-platform')
if os.geteuid() != 0:
    raise SystemExit('Root required')
if root.exists():
    required = ['runtime.env', 'postgres.env', 'migration.env', 'init.sql', 'approved-releases.json', 'initialized']
    if not all((root / name).is_file() for name in required):
        raise SystemExit('Partial config: operator must inspect; never regenerate credentials')
    pilot = root / 'pilot-releases.json'
    if not pilot.exists():
        with pilot.open('x') as file:
            file.write('[]\n')
        os.chmod(pilot, 0o644)
    print('Existing platform secrets preserved')
    raise SystemExit(0)
root.mkdir(mode=0o700)
owner, app, secret = [secrets.token_hex(32) for _ in range(3)]
files = {
    'postgres.env': f'POSTGRES_USER=platform_owner\nPOSTGRES_DB=platform\nPOSTGRES_PASSWORD={owner}\n',
    'migration.env': f'DATABASE_URL=postgresql://platform_owner:{owner}@db:5432/platform\n',
    'runtime.env': f'APP_ORIGIN=https://buattokosendiri.web.id\nDATABASE_URL=postgresql://platform_app:{app}@db:5432/platform\nAUTH_SECRET={secret}\nRESEND_API_KEY=\nTRUST_PROXY=0\n',
    'init.sql': f"CREATE ROLE platform_app LOGIN PASSWORD '{app}' NOSUPERUSER NOCREATEDB NOCREATEROLE;\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;\nREVOKE CONNECT ON DATABASE platform FROM PUBLIC;\nGRANT CONNECT ON DATABASE platform TO platform_app;\n",
    'approved-releases.json': '[]\n',
    'pilot-releases.json': '[]\n',
    'initialized': 'platform-m1\n',
}
for name, text in files.items():
    (root / name).write_text(text)
    os.chmod(root / name, 0o644 if name in ['init.sql', 'approved-releases.json', 'pilot-releases.json'] else 0o600)
print('Platform-only secrets generated. OTP and installer remain disabled until configured.')
