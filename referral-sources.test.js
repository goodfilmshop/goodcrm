const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { getReferralSources, saveReferralSource, referralSourceWritePayload } = require('./server');
function clientMock(result) {
  const calls = [];
  const client = { calls, from(table) {
    calls.push(['from', table]);
    const query = {};
    for (const method of ['select','order','eq','update','insert']) query[method] = (...args) => { calls.push([method,...args]); return query; };
    query.then = (resolve,reject) => Promise.resolve(result).then(resolve,reject);
    query.single = query.maybeSingle = async () => result;
    return query;
  }};
  return client;
}
test('only administrators can change sources or read inactive directory', async () => {
  const client = clientMock({ data: [], error: null });
  for (const role of ['sales','member','manager']) {
    await assert.rejects(saveReferralSource(client,'user',{role},{name:'Instagram'}), e => e.code === 'REFERRAL_SOURCE_ADMIN_REQUIRED');
    await assert.rejects(getReferralSources(client,{role},true), e => e.code === 'REFERRAL_SOURCE_ADMIN_REQUIRED');
  }
  assert.equal(client.calls.length,0);
  await getReferralSources(client,{role:'sales'});
  assert.ok(client.calls.some(c=>c[0]==='eq' && c[1]==='is_active' && c[2]===true));
});
test('create, rename, deactivate and reactivate only write master data, never customers', async () => {
  for (const body of [{name:'Instagram'}, {referralSourceId:'source-id',name:'Instagram ใหม่'}, {referralSourceId:'source-id',name:'Instagram',isActive:false}, {referralSourceId:'source-id',name:'Instagram',isActive:true}]) {
    const client = clientMock({data:{id:'source-id',name:body.name,is_active:body.isActive},error:null});
    const result = await saveReferralSource(client,'admin',{role:'admin'},body);
    assert.equal(result.success,true);
    assert.deepEqual(client.calls.filter(c=>c[0]==='from'),[['from','referral_sources']]);
    assert.equal(client.calls.find(c=>['insert','update'].includes(c[0]))[1].is_active,body.isActive !== false);
  }
});
test('blank names, invalid order, duplicate names and missing records are rejected', async () => {
  assert.throws(()=>referralSourceWritePayload({name:'   '},'u'));
  assert.throws(()=>referralSourceWritePayload({name:'Facebook',sortOrder:-1},'u'));
  assert.equal(referralSourceWritePayload({name:'  New   Source  '},'u').name,'New Source');
  await assert.rejects(saveReferralSource(clientMock({error:{code:'23505'}}),'u',{role:'admin'},{name:'Facebook'}),e=>e.code==='DUPLICATE_REFERRAL_SOURCE');
  await assert.rejects(saveReferralSource(clientMock({data:null,error:null}),'u',{role:'admin'},{referralSourceId:'missing',name:'Facebook'}),e=>e.code==='REFERRAL_SOURCE_NOT_FOUND');
});
const html = fs.readFileSync('public/index.html','utf8');
const code = html.slice(html.indexOf('    function getReferralSourceOptions'),html.indexOf('    function getContactTopicOptions'));
function frontend() {
  const select = {value:'',innerHTML:'',disabled:false};
  const context = vm.createContext({ console, URL, document:{getElementById:id=>id==='referralDate'?select:null}, config:{crmApiUrl:'https://crm.test/api/crm'}, currentCrmMember:{}, escapeHtml:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;') });
  vm.runInContext('let referralSources = []; let referralSourcesLoaded = false; let referralSourcesRequestId = 0;'+code,context);
  return {context,select,run:s=>vm.runInContext(s,context)};
}
test('old and inactive customer values survive editing; new customers only see active choices', () => {
  const {run,select} = frontend();
  run("referralSources = [{name:'Facebook ใหม่',isActive:true},{name:'Tiktok',isActive:false},{name:'WalkIn',isActive:true}]");
  run("renderReferralSourceSelect('Facebook')");
  assert.equal(select.value,'Facebook');
  assert.match(select.innerHTML,/value="Facebook" selected/);
  run("renderReferralSourceSelect('Tiktok')");
  assert.equal(select.value,'Tiktok');
  run("renderReferralSourceSelect('')");
  assert.doesNotMatch(select.innerHTML,/value="Facebook"|value="Tiktok"/);
  assert.match(select.innerHTML,/value="WalkIn"[^>]*>หน้าร้าน \(Walk In\)/);
});
test('late option loads preserve the customer opened during the request', async () => {
  const {run,select,context} = frontend();
  let resolve;
  context.crmFetch = () => new Promise(r=>resolve=r);
  const loading = run('loadReferralSources()');
  run("renderReferralSourceSelect('Historical source')");
  resolve({ok:true,json:async()=>({success:true,referralSources:[{name:'Facebook'}]})});
  await loading;
  assert.equal(select.value,'Historical source');
  assert.match(select.innerHTML,/Historical source/);
});
test('all inline browser scripts parse', () => {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc=|application\/ld\+json/.test(match[1])) new vm.Script(match[2]);
  }
});
