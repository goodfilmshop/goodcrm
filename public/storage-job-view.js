/* Read-only Storage panel. All requests use the existing CRM login. */
(() => {
  let cleanup = () => {};
  window.cleanupStorageJob = () => cleanup();
  window.mountStorageJob = function(caseRef) {
    cleanup();
    const panel = document.getElementById('storageJobPanel');
    if (!panel) return;
    let alive = true;
    const scope = getCrmScopeKey(), version = crmScopeVersion, urls = new Set();
    const current = () => alive && panel.isConnected && version === crmScopeVersion && scope === getCrmScopeKey();
    cleanup = () => { alive = false; for (const url of urls) URL.revokeObjectURL(url); panel.replaceChildren(); };
    const node = (tag,text,className='') => { const el=document.createElement(tag);el.textContent=text;el.className=className;return el; };
    const heading=node('h3','ข้อมูลหน้างานจาก Storage','font-bold text-blue-800');
    const description=node('p','ดูอย่างเดียว · รายละเอียดที่แก้ไขและรูปภาพเก็บใน Storage','text-sm text-slate-500');
    const refresh=node('button','โหลดข้อมูล Storage','mt-3 rounded-lg border border-blue-200 px-3 py-2 text-sm font-semibold text-blue-700');
    refresh.type='button';
    const content=node('div','','mt-3 space-y-3');
    panel.replaceChildren(heading,description,refresh,content);
    const statusNames={survey:'สำรวจหน้างาน',install:'กำลังติดตั้ง',review:'กำลังติดตั้ง',closed:'ปิดงาน'};
    const stageNames={before:'ก่อนติดตั้ง',during:'ระหว่างติดตั้ง',after:'หลังติดตั้ง',sheet:'ใบส่งงาน'};
    async function photo(photoId,label,container){
      const button=node('button',label,'rounded-lg border border-slate-200 px-3 py-2 text-sm text-blue-700');button.type='button';container.append(button);
      button.onclick=async()=>{
        button.disabled=true;button.textContent='กำลังโหลดรูป…';
        try{
          const url=new URL('/api/storage-bridge/photo',location.origin);url.search=new URLSearchParams({caseRef,photoId}).toString();
          const response=await crmFetch(url.toString(),{cache:'no-store',signal:AbortSignal.timeout(30000)});
          if(!response.ok)throw new Error('เปิดรูปไม่สำเร็จ');
          const blob=await response.blob();if(!current())return;
          const src=URL.createObjectURL(blob);urls.add(src);const img=document.createElement('img');img.src=src;img.alt=label;img.style.cssText='display:block;max-width:100%;max-height:480px;object-fit:contain;margin-top:8px';container.append(img);button.remove();
        }catch{if(current()){button.disabled=false;button.textContent='โหลดรูปอีกครั้ง';}}
      };
    }
    async function load(){
      refresh.disabled=true;content.replaceChildren(node('p','กำลังอ่านข้อมูลล่าสุด…','text-sm text-slate-500'));
      try{
        const url=new URL(config.crmApiUrl);url.searchParams.set('action','getStorageJob');url.searchParams.set('caseRef',caseRef);
        const {response,result}=await fetchJsonWithTimeout(url.toString(),{cache:'no-store'});
        if(!current())return;
        if(!response.ok||!result.success)throw new Error(result.error||'อ่านข้อมูล Storage ไม่สำเร็จ');
        for(const value of urls)URL.revokeObjectURL(value);urls.clear();
        content.replaceChildren();
        if(!result.connected){panel.hidden=true;return;}
        if(!result.job){content.append(node('p','เคสนี้ยังไม่มีงานใน Storage','text-sm text-slate-500'));return;}
        const job=result.job, details=[['รหัสงาน',job.id],['สถานะ',statusNames[job.status]||job.status],['ลูกค้า',job.customer],['เบอร์โทร',job.phone],['บริษัท',job.company],['สถานที่',job.location],['วันนัด',job.date],['แอดมิน',job.admin],['ฝ่ายขาย',job.sales],['ทีมช่าง',job.team],['รายละเอียด',job.notes],['ใบเสนอราคา',job.quoteRef],['บันทึกล่าสุด',job.updatedAt?new Date(job.updatedAt).toLocaleString('th-TH'):'']];
        const dl=node('dl','','grid grid-cols-1 gap-2 sm:grid-cols-2');
        for(const [label,value] of details){const cell=node('div');cell.append(node('dt',label,'text-xs text-slate-500'),node('dd',String(value||'—'),'whitespace-pre-line break-words text-sm text-slate-800'));dl.append(cell);}content.append(dl);
        if(job.localFields?.length)content.append(node('p','งานนี้มีรายละเอียดที่ปรับใน Storage โดยข้อมูลต้นฉบับ CRM ยังคงเดิม','text-sm text-amber-700'));
        for(const film of job.films||[])content.append(node('p',`${film.brand} · ${film.model} · ${film.area}`,'text-sm text-slate-700'));
        const images=node('div','','space-y-3');content.append(images);
        for(const item of job.photos||[]){const card=node('div','','rounded-xl border border-slate-100 p-3');card.append(node('p',`${stageNames[item.stage]||''} · ${item.caption||item.name||'รูปหน้างาน'}`,'text-sm font-semibold'));images.append(card);void photo(item.id,'ดูรูปภาพ',card);}
        if(job.jobSheetId)void photo(job.jobSheetId,'ดูใบส่งงาน',images);
        if(!job.photos?.length&&!job.jobSheetId)images.append(node('p','ยังไม่มีรูปภาพ','text-sm text-slate-500'));
      }catch(error){if(current())content.replaceChildren(node('p',error.message,'text-sm text-rose-700'));}
      finally{if(current()){refresh.disabled=false;refresh.textContent='รีเฟรชข้อมูล Storage';}}
    }
    refresh.onclick=()=>void load();
    void load();
  };
})();
