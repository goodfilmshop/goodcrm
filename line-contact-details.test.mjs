import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {extractLineContactDetails as extract, sanitizeLineContactDetails as sanitize} from './supabase/functions/_shared/line-contact-details.mjs';
test('extracts explicit contact details without retaining message text', () => {
  assert.deepEqual(extract('ชื่อ: สมชาย ใจดี\nเบอร์ ๐๘๑-๒๓๔-๕๖๗๘\nEmail: SOMCHAI@example.com\nเพศ: ชาย\nสนใจฟิล์มครับ'), {
    phone:['0812345678'],email:['somchai@example.com'],name:['สมชาย ใจดี'],gender:['ชาย']
  });
  assert.deepEqual(extract('ติดต่อ +66 81 234 5678'), {phone:['0812345678']});
});
test('does not infer gender or names from polite particles, names, quotes or third parties', () => {
  for (const text of ['ราคาเท่าไรครับ','สนใจค่ะ','คะ','สมชาย','แฟนผมเป็นผู้หญิงครับ','ลูกค้าชื่อ สมชาย','ชื่อบริษัท กู๊ดฟิล์ม','เขาบอกว่า เพศ: หญิง']) {
    assert.deepEqual(extract(text), {});
  }
});
test('keeps multiple candidates for review; ignores IDs and non-text input', () => {
  assert.deepEqual(extract('0812345678\n0891234567'), {phone:['0812345678','0891234567']});
  assert.deepEqual(extract('U0812345678abc 1081234567899'), {});
  assert.deepEqual(extract(null), {});
  assert.deepEqual(sanitize({phone:['bad','0812345678'],gender:['ครับ'],name:['<script>'],unknown:'private'}), {phone:['0812345678']});
});
test('signed direct and forwarded messages preserve only validated suggestions', async () => {
  for (const direct of [true,false]) {
    const {createHandler} = await import(`./supabase/functions/${direct?'line-gfs-intake':'line-maholan-intake'}/handler.mjs`);
    const prefix = direct?'LINE_GFS_':'LINE_MAHOLAN_';
    const destination='U'+'a'.repeat(32);
    const env = {[prefix+'INTAKE_ENABLED']:'true',[prefix+'BOT_USER_ID']:destination,[prefix+(direct?'CHANNEL_SECRET':'BRIDGE_SECRET')]:'test-secret'};
    let captured;
    const handler=createHandler({getEnv:k=>env[k],persist:async(_,events)=>{captured=events;}});
    const body=JSON.stringify({destination,events:[{type:'message',source:{type:'user',userId:'U'+'b'.repeat(32)},timestamp:Date.now(),webhookEventId:'details-test',message:{type:'text',text:'0812345678\nสนใจครับ'},contactDetails:{phone:['0812345678'],gender:['ครับ'],unexpected:'PRIVATE'}}]});
    const response=await handler(new Request('https://example.com/webhook',{method:'POST',body,headers:{[direct?'x-line-signature':'x-goodcrm-signature']:crypto.createHmac('sha256','test-secret').update(body).digest('base64')}}));
    assert.equal(response.status,200);
    assert.deepEqual(captured[0].details,{phone:['0812345678']});
    assert.ok(!JSON.stringify(captured).includes('สนใจ'));
  }
});
test('intake form prefills unique suggestions and leaves conflicting values for review', () => {
  const elements={};
  const el=id=>elements[id]??=( {value:'',textContent:'',classList:{add(){},remove(){},toggle(){}},prepend(node){elements[node.id]=node;},scrollIntoView(){},reset(){for(const [key,e] of Object.entries(elements))if(key!=='line-intake-account')e.value='';}} );
  el('line-intake-account').value='gfs-line-249izgyn';
  const ctx=vm.createContext({document:{getElementById:el,createElement:()=>({})},IntakeDrawer:{open(){},close(){}},canViewIntakeChannel:(channel,account)=>channel==='line'&&account==='gfs-line-249izgyn',canManageIntakeChannel:(channel,account)=>channel==='line'&&account==='gfs-line-249izgyn',crmScopeVersion:1,getCrmScopeKey:()=> 'fixture-line-manager',loadReferralSources:()=>Promise.resolve(),getReferralSourceOptions:()=>''});
  vm.runInContext(fs.readFileSync('public/line-intake.js','utf8'),ctx);
  vm.runInContext(`lineIntakeRows=[{status:'pending',account_key:'gfs-line-249izgyn',display_name:'Profile',contact_suggestions:{name:['สมชาย'],phone:['0812345678'],email:['test@example.com'],gender:['ชาย']}}]; selectLineIntake(0);`,ctx);
  assert.equal(el('line-intake-name').value,'สมชาย');
  assert.equal(el('line-intake-phone').value,'0812345678');
  assert.equal(el('line-intake-handle').value,'Profile');
  assert.equal(el('line-intake-gender').value,'ชาย');
  vm.runInContext(`lineIntakeRows=[{status:'pending',account_key:'gfs-line-249izgyn',display_name:'Next',contact_suggestions:{phone:['0812345678','0891234567']}}]; selectLineIntake(0);`,ctx);
  assert.equal(el('line-intake-name').value,'Next');
  assert.equal(el('line-intake-phone').value,'');
  assert.equal(elements['line-intake-autofill-note'], undefined);
});
