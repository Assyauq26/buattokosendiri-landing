import {createLatestInstallerResolver} from './latest-installer.mjs';
try { console.log(JSON.stringify(await createLatestInstallerResolver()())); }
catch { console.error('LATEST_STABLE_LOOKUP_FAILED'); process.exitCode = 1; }
