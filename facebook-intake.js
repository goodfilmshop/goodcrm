const { intakeDate, requireStoredIntakeAccess } = require('./line-intake');
const { requireIntakeAccess } = require('./intake-permissions');
const ACCOUNTS = {"gfs-fb-125106670932394":{"company":"GFS","pageId":"125106670932394"},"gfs-fb-101634951180913":{"company":"GFS","pageId":"101634951180913"},"mhl-fb-109607531869658":{"company":"MHL","pageId":"109607531869658"}};
async function getIntake(client,membership,input) {
 const account = input.account || 'gfs-fb-125106670932394';
 requireIntakeAccess(membership, 'facebook', 'view', account);
 if (!Object.hasOwn(ACCOUNTS,account)) throw new Error('เพจ Facebook ไม่ถูกต้อง');
 const date=intakeDate(input.date);
 const status=['pending','imported','dismissed'].includes(input.status)?input.status:'pending';
 const page=Math.max(0,Math.min(100000,Number.parseInt(input.page,10)||0));
 let enabled=false, connectionStatus='not-configured';
 try {const r=await fetch(process.env.SUPABASE_URL+'/functions/v1/facebook-intake/health',{signal:AbortSignal.timeout(3000)}); if(!r.ok) throw new Error(); const h=await r.json(); enabled=h.configured===true && h.pages?.includes(ACCOUNTS[account].pageId); connectionStatus=enabled?'ready':'not-configured';} catch {connectionStatus='unreachable';}
 const [rows,totals]=await Promise.all([
 client.from('facebook_intake_contacts').select('*',{count:'exact'}).eq('account_key',account).eq('status',status).order('last_seen_at',{ascending:false}).order('id').range(page*30,page*30+29),
 client.rpc('facebook_intake_daily_summary',{p_account:account,p_day:date})]);
 if(rows.error||totals.error) throw new Error('ยังอ่านรายการ Facebook ไม่ได้ กรุณาตรวจฐานข้อมูล');
 return {success:true,accountKey:account,company:ACCOUNTS[account].company,enabled,connectionStatus,date,page,contacts:rows.data,total:rows.count,summary:totals.data};
}
async function resolveIntake(client, membership, input) {
  requireIntakeAccess(membership, 'facebook', 'manage');
  if (!['create', 'link', 'dismiss'].includes(input.decision)) throw new Error('เลือกการดำเนินการไม่ถูกต้อง');
  if (input.decision !== 'dismiss' && input.replied !== true) throw new Error('กรุณายืนยันว่าตอบลูกค้าใน Meta Business Suite แล้ว');
  const name = String(input.customerName || '').trim();
  const customer = String(input.customerId || '').trim();
  if (input.decision === 'create' && (!name || name.length > 200)) throw new Error('กรุณากรอกชื่อลูกค้าไม่เกิน 200 ตัวอักษร');
  if (input.decision === 'link' && !customer) throw new Error('กรุณาระบุรหัสลูกค้าเดิม');
  await requireStoredIntakeAccess(client, membership, 'facebook', input);
  const { data, error } = await client.rpc('resolve_intake_with_details', {
    p_platform:'facebook', p_details:input.customerDetails || {},
    p_id: input.id, p_decision: input.decision, p_name: name, p_customer: customer,
  });
  if (error) throw new Error('คัดรายชื่อไม่สำเร็จ กรุณาตรวจรหัสลูกค้าหรือรีเฟรชรายการ');
  return { success: true, result: data };
}

async function refreshNames(membership, input, authorization, fetchImpl = fetch) {
  requireIntakeAccess(membership, 'facebook', 'manage', input.account);
  if (!Object.hasOwn(ACCOUNTS, input.account) || !Array.isArray(input.users) || input.users.length > 30 || input.users.some(id => typeof id !== 'string' || !/^[0-9]{5,30}$/.test(id))) throw new Error('รายการ Facebook ไม่ถูกต้อง');
  if (!/^Bearer \S+$/.test(authorization || '')) throw new Error('กรุณาเข้าสู่ระบบอีกครั้ง');
  const response = await fetchImpl(process.env.SUPABASE_URL + '/functions/v1/facebook-intake/profiles/refresh', {
    method:'POST', headers:{Authorization:authorization, 'Content-Type':'application/json'},
    body:JSON.stringify({account:input.account, users:input.users}), signal:AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error('ดึงชื่อ Facebook ไม่สำเร็จ กรุณาตรวจสิทธิ์การคัดรายชื่อและการเชื่อมต่อ');
  return response.json();
}

module.exports={getIntake,resolveIntake,refreshNames,ACCOUNTS};
