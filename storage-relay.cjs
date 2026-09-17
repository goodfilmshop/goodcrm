// Reverse read-only transport: Storage polls outward over HTTPS. Nothing is persisted here.
const crypto=require('node:crypto');
const {PassThrough,Readable}=require('node:stream');
const protocol=require('./crm-bridge-protocol.cjs');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const types=new Set(['application/json','image/jpeg','image/png','image/webp']);
function createRelay({environment=process.env,pollMs=20000,requestMs=120000,now=Date.now}={}){
 const enabled=environment.STORAGE_BRIDGE_ENABLED==='true'&&environment.STORAGE_BRIDGE_TRANSPORT==='outbound'&&protocol.validSecret(environment.CRM_BRIDGE_SECRET);
 const verifyPoll=protocol.verifier(enabled?environment.CRM_BRIDGE_SECRET:''),verifyReply=protocol.verifier(enabled?environment.CRM_BRIDGE_SECRET:'',{method:'POST'});
 const pending=new Map(),waiting=new Set();let lastPoll=0;
 const fail=message=>Object.assign(new Error(message),{status:503});
 const json=(res,status,value)=>res.status(status).json(value);
 function forget(item){clearTimeout(item.timer);pending.delete(item.id);}
 function reject(item,error){forget(item);item.reject(error);item.stream.destroy(error);}
 function wake(){for(const send of [...waiting])send();}
 function poll(req,res){
  res.set('Cache-Control','no-store');
  if(!enabled)return json(res,404,{error:'Bridge disabled'});
  if(!verifyPoll(req))return json(res,403,{error:'Forbidden'});
  if(waiting.size>=2)return json(res,429,{error:'Too many polls'});
  lastPoll=now();let timer,finished=false;
  const send=(force=false)=>{if(finished)return;const items=[...pending.values()].filter(item=>!item.dispatched).slice(0,2);if(!items.length&&!force)return;finished=true;clearTimeout(timer);waiting.delete(send);for(const item of items)item.dispatched=true;json(res,200,{tasks:items.map(({id,kind,caseId,photoId})=>({id,kind,caseId,photoId}))});};
  waiting.add(send);timer=setTimeout(()=>send(true),pollMs);timer.unref?.();res.on('close',()=>{finished=true;clearTimeout(timer);waiting.delete(send);});send();
 }
 async function reply(req,res){
  res.set('Cache-Control','no-store');
  if(!enabled)return json(res,404,{error:'Bridge disabled'});
  if(!verifyReply(req))return json(res,403,{error:'Forbidden'});
  let body;try{body=JSON.parse(req.body.toString('utf8'));}catch{return json(res,400,{error:'Invalid response'});}
  const item=pending.get(body?.id);if(!item||!item.dispatched)return json(res,410,{error:'Request expired'});
  if(body.seq!==item.seq||item.writing)return json(res,409,{error:'Unexpected sequence'});
  if(body.error===true){reject(item,fail('Storage อ่านข้อมูลไม่สำเร็จ'));return json(res,200,{ok:true});}
  if(![200,404,503].includes(body.status)||!types.has(body.type)||typeof body.done!=='boolean'||typeof body.chunk!=='string'||body.chunk.length>1400000||body.chunk.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.chunk))return json(res,400,{error:'Invalid response'});
  if(item.kind==='job'&&body.type!=='application/json'||body.status!==200&&body.type!=='application/json'||item.kind==='photo'&&body.status===200&&!body.type.startsWith('image/'))return json(res,400,{error:'Invalid media type'});
  if(item.seq&& (body.status!==item.status||body.type!==item.type))return json(res,409,{error:'Response changed'});
  const chunk=Buffer.from(body.chunk,'base64');if(item.kind==='job'&&item.bytes+chunk.length>1048576){reject(item,fail('ข้อมูลรายละเอียดงานใหญ่เกินกำหนด'));return json(res,413,{error:'Too large'});}
  item.writing=true;item.seq++;item.bytes+=chunk.length;
  if(!item.started){item.started=true;item.status=body.status;item.type=body.type;item.resolve(new Response(Readable.toWeb(item.stream),{status:body.status,headers:{'Content-Type':body.type}}));}
  try{
   // One verified chunk in memory; acknowledge only after backpressure clears.
   if(chunk.length&&!item.stream.write(chunk))await new Promise((resolve,rejectWrite)=>{const cleanup=()=>{item.stream.off('drain',drain);item.stream.off('error',error);item.stream.off('close',closed);};const drain=()=>{cleanup();resolve();};const error=e=>{cleanup();rejectWrite(e);};const closed=()=>error(fail('Reader disconnected'));item.stream.once('drain',drain);item.stream.once('error',error);item.stream.once('close',closed);});
   if(body.done){forget(item);item.stream.end();}item.writing=false;return json(res,200,{ok:true});
  }catch{reject(item,fail('อ่านข้อมูล Storage ถูกยกเลิก'));if(!res.headersSent)return json(res,410,{error:'Reader disconnected'});}
 }
 function request(kind,caseId,photoId){
  if(!enabled||!lastPoll||now()-lastPoll>45000)return Promise.reject(fail('Storage ออฟไลน์ กรุณาเปิดเครื่องและแอป Storage'));
  if(!['job','photo'].includes(kind)||!uuid.test(caseId)||kind==='photo'&&!uuid.test(photoId))return Promise.reject(fail('Invalid request'));
  if(pending.size>=16)return Promise.reject(fail('Storage กำลังอ่านหลายงาน กรุณาลองอีกครั้ง'));
  return new Promise((resolve,rejectRequest)=>{const id=crypto.randomUUID(),stream=new PassThrough({highWaterMark:1048576});stream.on('error',()=>{});const item={id,kind,caseId,photoId,stream,resolve,reject:rejectRequest,seq:0,bytes:0,started:false,dispatched:false,writing:false};item.timer=setTimeout(()=>reject(item,fail('Storage ไม่ตอบกลับภายในเวลาที่กำหนด')),requestMs);item.timer.unref?.();stream.on('close',()=>{if(pending.has(id)){forget(item);rejectRequest(fail('Reader disconnected'));}});pending.set(id,item);wake();});
 }
 function close(){for(const item of [...pending.values()])reject(item,fail('Bridge stopped'));for(const send of [...waiting])send(true);}
 return {poll,reply,request,close,status:()=>({enabled,connected:!!lastPoll&&now()-lastPoll<=45000,pending:pending.size})};
}
module.exports={createRelay};
