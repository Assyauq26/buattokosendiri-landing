import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLatestInstallerResolver,STORE_REPOSITORY,STORE_REPOSITORY_ID} from '../server/latest-installer.mjs';
const web=`https://github.com/${STORE_REPOSITORY}`,api=`https://api.github.com/repos/${STORE_REPOSITORY}`;
function fixture(overrides={}){
 const state={tag:'v1.7.2',sha:'a'.repeat(40),digest:'b'.repeat(64),...overrides};const calls=[];
 const json=x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
 const fetcher=async(url,options)=>{
  calls.push(url);assert.ok(options.signal);assert.ok(['manual','error'].includes(options.redirect));
  if(url===web+'/releases/latest'){
   if(state.offline)throw Error('offline');
   return new Response(null,{status:302,headers:{Location:state.location||web+'/releases/tag/'+state.tag}});
  }
  if(url===api)return json({id:state.badRepo?1:STORE_REPOSITORY_ID,full_name:STORE_REPOSITORY});
  if(url===api+'/releases/tags/'+state.tag)return json({tag_name:state.tag,draft:!!state.draft,prerelease:!!state.prerelease,published_at:'2026-11-11T00:00:00Z',html_url:web+'/releases/tag/'+state.tag,
   assets:[{name:'store-'+state.tag+'.tar.gz',state:'uploaded',size:1000,digest:state.missingDigest?null:'sha256:'+state.digest,browser_download_url:web+'/releases/download/'+state.tag+'/store-'+state.tag+'.tar.gz'}]});
  if(url===api+'/git/ref/tags/'+state.tag)return json({ref:'refs/tags/'+state.tag,object:{type:state.annotated?'tag':state.wrongType?'tree':'commit',sha:state.sha}});
  if(url.startsWith(api+'/git/tags/'))return json({object:{type:state.cycle?'tag':'commit',sha:state.sha}});
  if(url.endsWith('/VERSION'))return new Response(state.wrongVersion?'1.4.1':state.tag.slice(1));
  throw Error('Unexpected fixed endpoint');
 };
 return {state,calls,latest:createLatestInstallerResolver({fetcher})};
}
test('latest stable resolves official repository, asset, exact tag commit and VERSION',async()=>{
 const f=fixture();const r=await f.latest();assert.equal(r.version,'v1.7.2');assert.equal(r.sha,'a'.repeat(40));assert.equal(r.approved,true);assert.equal(r.asset.digest,'b'.repeat(64));
 await f.latest();assert.equal(f.calls.filter(u=>u.endsWith('/releases/latest')).length,2,'each issuance checks current latest');
 assert.equal(f.calls.filter(u=>u.includes('/git/ref/')).length,1,'verified immutable descriptor reused');
 f.state.tag='v1.7.3';f.state.sha='c'.repeat(40);assert.equal((await f.latest()).version,'v1.7.3');
});
test('GitHub outage never returns a previously discovered old version',async()=>{
 const f=fixture();await f.latest();f.state.offline=true;await assert.rejects(f.latest());
});
for(const [label,overrides] of [
 ['draft',{draft:true}],['prerelease',{prerelease:true}],['wrong repository',{badRepo:true}],
 ['foreign redirect',{location:'https://evil.example/releases/tag/v1.7.2'}],
 ['branch redirect',{location:web+'/tree/main'}],['malformed tag',{tag:'v1.7.2-beta'}],
 ['missing digest',{missingDigest:true}],['noncommit ref',{wrongType:true}],['wrong VERSION',{wrongVersion:true}],['tag cycle',{annotated:true,cycle:true}],
])test('rejects '+label,async()=>{await assert.rejects(fixture(overrides).latest());});
test('annotated tag resolves to a bounded commit',async()=>{assert.equal((await fixture({annotated:true}).latest()).sha,'a'.repeat(40));});
