// Read-only deployment verification. Never print runtime-config credentials.
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const origins=['http://localhost:3000','https://goodcrm.onrender.com'];
const get=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw new Error('HTTP '+r.status+' at '+new URL(url).pathname);return r;};
const digest=s=>createHash('sha256').update(s.replace(/\r\n/g,'\n')).digest('hex');
(async()=>{
 const configs=await Promise.all(origins.map(async origin=>(await get(origin+'/api/runtime-config')).json()));
 const result={commit,sameCommit:configs.every(c=>c.releaseCommit===commit),sameDatabase:configs[0].url===configs[1].url,databaseProject:new URL(configs[1].url).hostname.split('.')[0],assets:[],unauthenticatedAccess:[]};
 for(const asset of ['/','/line-intake.js','/facebook-intake.js','/storage.js','/storage-job-view.js']){
   const hashes=await Promise.all(origins.map(async origin=>digest(await(await get(origin+asset)).text())));
   result.assets.push({path:asset,equal:hashes[0]===hashes[1],sha256:hashes[1]});
 }
 for(const origin of origins){const r=await fetch(origin+'/api/crm?action=getCases',{signal:AbortSignal.timeout(15000)});result.unauthenticatedAccess.push({origin,status:r.status});}
 result.passed=result.sameCommit&&result.sameDatabase&&result.assets.every(a=>a.equal)&&result.unauthenticatedAccess.every(a=>a.status===401);
 console.log(JSON.stringify(result,null,2));
 if(!result.passed)process.exitCode=1;
})().catch(()=>{console.error('Deployment verification failed. Check service availability and configuration; credentials were not logged.');process.exitCode=1;});
