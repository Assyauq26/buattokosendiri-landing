import {readFileSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const required=['index.html','pendaftaran/index.html','assets/js/platform.js','server/app.mjs','server/schema.sql','agent/agent.py','agent/bootstrap.sh','panduan-instalasi/index.html','panduan-instalasi/panduan-instalasi.pdf','persiapan-toko/index.html'];
for(const f of required){if(!existsSync(f))throw Error('Missing '+f);}
for(const f of ['server/config.mjs','server/app.mjs','server/main.mjs','server/migrate.mjs','assets/js/platform.js'])execFileSync(process.execPath,['--check',f]);
for(const f of ['index.html','pendaftaran/index.html','panduan-instalasi/index.html','persiapan-toko/index.html']){
 const content=readFileSync(f,'utf8');
 if(/staging\.buattokosendiri\.web\.id/.test(content))throw Error('Retired host reference');
 for(const match of content.matchAll(/(?:src|href)="(\/(?:assets|panduan-instalasi\/assets)\/[^"?#]+)"/g)){if(!existsSync('.'+match[1]))throw Error('Missing asset '+match[1]);}
}
mkdirSync('.local',{recursive:true});
writeFileSync('.local/build-manifest.json',JSON.stringify({builtAt:new Date().toISOString(),files:required.map(file=>({file,sha256:createHash('sha256').update(readFileSync(file)).digest('hex')}))},null,2));
console.log('Platform source, JavaScript and public assets verified.');
