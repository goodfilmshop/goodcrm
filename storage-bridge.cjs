// Installed in Good_CRM. Export is read-only; Storage edits never write CRM tables.
const {Readable} = require('node:stream');
const protocol = require('./crm-bridge-protocol.cjs');
const DEFAULT_STATUSES = ['นัดวัดพื้นที่','นัดคิวติดตั้ง'];
const enabled = env => env.STORAGE_BRIDGE_ENABLED === 'true' && protocol.validSecret(env.CRM_BRIDGE_SECRET);
const fail = (status,message) => { throw Object.assign(new Error(message),{status}); };
const text = value => typeof value === 'string' ? value.trim() : '';
const unwrap = value => Array.isArray(value) ? value[0] : value;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function pages(makeQuery) {
  const all=[];
  for(let start=0;start<=10000;start+=500){
    const {data,error}=await makeQuery().range(start,start+499);
    if(error||!Array.isArray(data))fail(503,'อ่านข้อมูล CRM สำหรับ Storage ไม่สำเร็จ');
    all.push(...data);if(all.length>10000)fail(503,'จำนวนข้อมูลเกินขอบเขตการเชื่อมต่อ');
    if(data.length<500)return all;
  }
}
async function exportSnapshot(client, env={}) {
  const employees=await pages(()=>client.from('crm_employees').select('id,nickname,status').order('id'));
  const statuses=text(env.STORAGE_BRIDGE_CASE_STATUSES).split(',').map(text).filter(Boolean);
  const cases=await pages(()=>client.from('cases')
    .select('id,legacy_case_id,customer_id,admin_name,salesperson_employee_id,company,status,site_address,location_url,job_details,updated_at,customers(customer_name,phone),latest_follow_up:lead_follow_up_history(next_follow_up_at,current_status,followed_at,created_at,id)')
    .in('status',statuses.length?statuses:DEFAULT_STATUSES).order('id')
    .order('followed_at',{referencedTable:'latest_follow_up',ascending:false})
    .order('created_at',{referencedTable:'latest_follow_up',ascending:false})
    .order('id',{referencedTable:'latest_follow_up',ascending:false})
    .limit(1,{referencedTable:'latest_follow_up'}));
  const nameId=name=>{const matched=employees.filter(e=>e.status==='active'&&text(e.nickname)===text(name));return matched.length===1?matched[0].id:'';};
  const date=value=>{const d=new Date(value||'');return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(d):'';};
  return {version:1,generatedAt:new Date().toISOString(),employees:employees.map(e=>({id:e.id,name:e.nickname,active:e.status==='active'})),cases:cases.map(row=>{
    const customer=unwrap(row.customers)||{},followUp=unwrap(row.latest_follow_up)||{};
    const appointmentDate=date(followUp.next_follow_up_at);
    const queueType=appointmentDate&&followUp.current_status===row.status?(row.status==='นัดวัดพื้นที่'?'measurement':row.status==='นัดคิวติดตั้ง'?'installation':null):null;
    return {id:row.id,caseRef:row.legacy_case_id,customerId:row.customer_id,customer:customer.customer_name,phone:customer.phone,company:row.company,status:row.status,location:row.site_address,mapLink:row.location_url,notes:row.job_details,date:queueType?appointmentDate:'',queueType,updatedAt:row.updated_at,adminEmployeeId:nameId(row.admin_name),salesEmployeeId:row.salesperson_employee_id||''};
  })};
}
async function exportRestrictedSnapshot(client,env){
  const headers=protocol.sign(env.CRM_BRIDGE_SECRET,'/rpc/storage_bridge_snapshot');
  const {data,error}=await client.rpc('storage_bridge_snapshot',{request_time:headers['x-crm-time'],request_nonce:headers['x-crm-nonce'],request_signature:headers['x-crm-signature']});
  if(error||data?.version!==1||!Array.isArray(data.cases)||!Array.isArray(data.employees))fail(503,'อ่านข้อมูล CRM สำหรับ Storage ไม่สำเร็จ');
  return data;
}
function createExportHandler({getClient,environment=process.env,getSnapshot=exportRestrictedSnapshot}) {
  const verify=protocol.verifier(enabled(environment)?environment.CRM_BRIDGE_SECRET:'');
  return async(req,res)=>{
    res.set('Cache-Control','no-store, private');
    if(!enabled(environment))return res.status(404).json({error:'ไม่ได้เปิดการเชื่อม Storage'});
    if(!verify(req))return res.status(403).json({error:'ไม่มีสิทธิ์เชื่อมต่อ'});
    try{const client=getClient();if(!client)fail(503,'ยังไม่ได้ตั้งค่าบัญชีอ่านข้อมูลของการเชื่อมต่อ');return res.json(await getSnapshot(client,environment));}
    catch(error){return res.status(error.status||503).json({error:'อ่านข้อมูลสำหรับ Storage ไม่สำเร็จ'});}
  };
}
async function visibleCase(client,caseRef){
  if(!text(caseRef)||caseRef.length>100)fail(400,'รหัสเคสไม่ถูกต้อง');
  // This client carries the CRM user's token. Existing RLS remains authoritative.
  const {data,error}=await client.from('cases').select('id').eq('legacy_case_id',caseRef).maybeSingle();
  if(error)fail(503,'ตรวจสิทธิ์เคสไม่สำเร็จ');
  if(!data||!uuid.test(data.id))fail(404,'ไม่พบเคสหรือไม่มีสิทธิ์');
  return data.id;
}
async function bridgeRead(env,relay,kind,caseId,photoId,fetchImpl){
  const response=env.STORAGE_BRIDGE_TRANSPORT==='outbound'
    ? await relay.request(kind,caseId,photoId)
    : await protocol.request(env.STORAGE_APP_URL,env.CRM_BRIDGE_SECRET,`/api/crm-bridge/${kind}?${new URLSearchParams({caseId,...(photoId?{photoId}:{})})}`,fetchImpl);
  if(!response.ok){await response.body?.cancel();fail(response.status===404?404:503,'Storage ไม่พร้อมใช้งาน');}
  return response;
}
async function readJob(client,caseRef,env=process.env,fetchImpl=fetch,relay){
  if(!enabled(env)||!(env.STORAGE_BRIDGE_TRANSPORT==='outbound'?relay:env.STORAGE_APP_URL))return {success:true,connected:false,job:null};
  const caseId=await visibleCase(client,caseRef);
  try{
    const response=await bridgeRead(env,relay,'job',caseId,undefined,fetchImpl);
    const result=await response.json();
    if(!result.success||result.job?.caseId!==caseId)fail(503,'ข้อมูล Storage ไม่ตรงกับเคส');
    return {success:true,connected:true,job:result.job};
  }catch(error){if(error.status===404)return {success:true,connected:true,job:null};throw error;}
}
function createPhotoHandler({environment=process.env,fetchImpl=fetch,relay}={}){
  return async(req,res)=>{
    res.set('Cache-Control','no-store, private');
    try{
      if(!enabled(environment)||!(environment.STORAGE_BRIDGE_TRANSPORT==='outbound'?relay:environment.STORAGE_APP_URL))fail(404,'ไม่ได้เปิดการเชื่อม Storage');
      const photoId=text(req.query.photoId);if(!uuid.test(photoId))fail(400,'รหัสรูปไม่ถูกต้อง');
      const caseId=await visibleCase(req.crmUser.client,text(req.query.caseRef));
      const response=await bridgeRead(environment,relay,'photo',caseId,photoId,fetchImpl);
      const type=response.headers.get('content-type')?.split(';')[0];
      if(!['image/jpeg','image/png','image/webp'].includes(type))fail(502,'ชนิดรูปไม่ถูกต้อง');
      res.set('Content-Type',type);const stream=Readable.fromWeb(response.body);res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
    }catch(error){if(!res.headersSent)res.status(error.status||503).json({error:'ไม่สามารถเปิดรูปจาก Storage ได้'});else res.destroy();}
  };
}
module.exports={exportSnapshot,exportRestrictedSnapshot,createExportHandler,readJob,visibleCase,createPhotoHandler};
