// Companion file for the existing Line+FB_Chat Apps Script project.
// Add queueGoodfilmCrm_(data, e) after handleLineWebhook(data, brand, accountId).
// For both configured accounts, call authorizeGoodfilmCrm_(e) BEFORE handling data.
// Deploy with *_ENABLED=false; set keys/trigger and LINE URL keys before enabling.
const GOODCRM_QUEUE_SHEET = '_GOODCRM_LINE_QUEUE';
const GOODCRM_ACCOUNTS = {
  '1654307361': {prefix:'GOODCRM_GFS_', endpoint:'line-goodfilm-intake'},
  '1621123913': {prefix:'GOODCRM_MHL_', endpoint:'line-mhl-intake'}
};
function goodcrmAccount_(id) { return Object.prototype.hasOwnProperty.call(GOODCRM_ACCOUNTS,id) ? GOODCRM_ACCOUNTS[id] : null; }

function authorizeGoodfilmCrm_(e) {
  const accountId = String(e.parameter && e.parameter.account);
  const config = goodcrmAccount_(accountId);
  if (!config) return;
  if (PropertiesService.getScriptProperties().getProperty(config.prefix+'ENABLED') !== 'true') return;
  const key = PropertiesService.getScriptProperties().getProperty(config.prefix+'WEBHOOK_KEY');
  if (!key || !e.parameter.crm_key || e.parameter.crm_key !== key) throw new Error('Invalid CRM webhook key');
}

function queueGoodfilmCrm_(data, e) {
  const accountId = String(e.parameter && e.parameter.account);
  const config = goodcrmAccount_(accountId);
  if (!config) return;
  if (PropertiesService.getScriptProperties().getProperty(config.prefix+'ENABLED') !== 'true') return;
  authorizeGoodfilmCrm_(e);
  const expected = PropertiesService.getScriptProperties().getProperty(config.prefix+'BOT_USER_ID');
  if (!expected || data.destination !== expected) throw new Error('Wrong LINE destination');
  const events = data.events.filter(v => v.type === 'message' && v.source && v.source.type === 'user')
    .map(v => ({type:'message',webhookEventId:v.webhookEventId,timestamp:v.timestamp,
      source:{type:'user',userId:v.source.userId}}));
  if (!events.length) return;
  if (events.length > 100 || events.some(v => !/^U[0-9a-f]{32}$/.test(v.source.userId)
    || typeof v.webhookEventId !== 'string' || !v.webhookEventId || v.webhookEventId.length > 128
    || !Number.isSafeInteger(v.timestamp) || v.timestamp < 0 || v.timestamp > Date.now()+300000)) throw new Error('Invalid CRM events');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let sheet = ss.getSheetByName(GOODCRM_QUEUE_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(GOODCRM_QUEUE_SHEET);
      sheet.appendRow(['queued_at','metadata','sent_at','attempts','last_error','account']);
      sheet.hideSheet();
    }
    // One bounded event per row; no message text, attachments or reply tokens.
    const rows = events.map(v => [new Date(),JSON.stringify({destination:data.destination,events:[v]}),'',0,'',accountId]);
    sheet.getRange(sheet.getLastRow()+1,1,rows.length,6).setValues(rows);
  } finally { lock.releaseLock(); }
}

function flushGoodfilmCrmQueue() {
  const props = PropertiesService.getScriptProperties();
  // User lock prevents overlapping timer executions without blocking webhook's script lock.
  const lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) return;
  try {
    const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(GOODCRM_QUEUE_SHEET);
    if (!sheet || sheet.getLastRow() < 2) return;
    const rows = sheet.getRange(2,1,sheet.getLastRow()-1,6).getValues();
    let processed = 0;
    const started = Date.now();
    for (let i=0;i<rows.length;i++) {
      if (rows[i][2]) continue;
      if (processed++ >= 50 || Date.now()-started > 240000) break;
      const config = goodcrmAccount_(String(rows[i][5]));
      const secret = config && props.getProperty(config.prefix+'BRIDGE_SECRET');
      if (!secret) { sheet.getRange(i+2,5).setValue('CRM configuration missing'); continue; }
      const endpoint = 'https://mbxuebqqglaeechltkyl.supabase.co/functions/v1/'+config.endpoint;
      const raw = String(rows[i][1]);
      const signature = Utilities.base64Encode(Utilities.computeHmacSha256Signature(raw,secret,Utilities.Charset.UTF_8));
      try {
        const response = UrlFetchApp.fetch(endpoint,{method:'post',contentType:'application/json',
          payload:raw,headers:{'x-goodcrm-signature':signature},muteHttpExceptions:true});
        if (response.getResponseCode() !== 200 || JSON.parse(response.getContentText()).received !== true) throw new Error('Receiver rejected');
        sheet.getRange(i+2,3,1,3).setValues([[new Date(),Number(rows[i][3])+1,'']]);
      } catch (_) {
        sheet.getRange(i+2,4,1,2).setValues([[Number(rows[i][3])+1,'CRM delivery failed; will retry']]);
      }
    }
  } finally { lock.releaseLock(); }
}

function installGoodfilmCrmTrigger() {
  const props = PropertiesService.getScriptProperties();
  for (const config of Object.values(GOODCRM_ACCOUNTS)) for (const key of ['WEBHOOK_KEY','BRIDGE_SECRET','BOT_USER_ID']) {
    if (!props.getProperty(config.prefix+key)) throw new Error('Missing '+config.prefix+key);
  }
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'flushGoodfilmCrmQueue')) {
    ScriptApp.newTrigger('flushGoodfilmCrmQueue').timeBased().everyMinutes(1).create();
  }
}

function testGoodcrmConnections() {
  const props = PropertiesService.getScriptProperties();
  for (const [account, config] of Object.entries(GOODCRM_ACCOUNTS)) {
    const raw = JSON.stringify({destination:props.getProperty(config.prefix+'BOT_USER_ID'),events:[]});
    const signature = Utilities.base64Encode(Utilities.computeHmacSha256Signature(raw,props.getProperty(config.prefix+'BRIDGE_SECRET'),Utilities.Charset.UTF_8));
    const response = UrlFetchApp.fetch('https://mbxuebqqglaeechltkyl.supabase.co/functions/v1/'+config.endpoint,
      {method:'post',contentType:'application/json',payload:raw,headers:{'x-goodcrm-signature':signature},muteHttpExceptions:true});
    if (response.getResponseCode()!==200 || JSON.parse(response.getContentText()).received!==true) throw new Error('CRM connection failed: '+account);
    console.log('PASS CRM connection '+account);
  }
}
