const u=require('./official-text');
const input=(html,id)=>[...html.matchAll(/<input\b[^>]*>/gi)].find(m=>new RegExp('\\bid=["\']'+id+'["\']').test(m[0]))?.[0].match(/\bvalue=["']([^"']*)["']/)?.[1];
async function collectHistories(c,db,asOf){
 for(const etf of db.etfs){const t=etf.ticker;
  if(/凱基/.test(etf.issuer)){
   const html=c.read('kgi-detail-'+t);if(typeof html!=='string')continue;
   const fundID=input(html,'DFundID'),setup=input(html,'SetUpDT1');
   if(!fundID||!/^\d{4}\/\d{2}$/.test(setup||''))continue;
   await c.get('kgi-history-'+t,'https://www.kgifund.com.tw/Fund/DividendRecordVC',{method:'POST',body:new URLSearchParams({sDate:'2024/01',eDate:asOf.slice(0,7).replace('-','/'),fundID,isETF:input(html,'IsETF')||'',isAllocCash:input(html,'IsAllocCash')||'',SetUpDT1:setup,isMobile:'False'}).toString()});
   await c.sleep(300);
  }
  if(/台新/.test(etf.issuer)){
   const html=c.read('taishin-detail-'+t);if(typeof html!=='string'||input(html,'ETF_ID')!==t)continue;
   await c.get('taishin-history-'+t,'https://www.tsit.com.tw/ETF/Home/PartialSeriesDetailDiv',{method:'POST',body:new URLSearchParams({etf_id:t,select_year:'ALL',select_begin_date:'2024/01/01',select_end_date:asOf.replaceAll('-','/')}).toString()});
   await c.sleep(300);
  }
 }
}
function normalizeHistories(reference,c){
 const receipts=new Map(c.records().map(r=>[r.id,r]));
 for(const ref of reference.items){const t=ref.ticker;
  const prefix=/凱基/.test(ref.identity.issuer)?'kgi':/台新/.test(ref.identity.issuer)?'taishin':null;if(!prefix)continue;
  const id=prefix+'-history-'+t,html=c.read(id),record=receipts.get(id);if(typeof html!=='string'||!record?.path)continue;
  let rows,verified=false;
  if(prefix==='kgi'){
   const detail=c.read('kgi-detail-'+t),params=record.requestParameters||{};
   verified=typeof detail==='string'&&params.fundID===input(detail,'DFundID')&&params.isETF==='True'&&params.sDate==='2024/01'&&input(html,'DividendSdate')==='2024/01'&&input(html,'DividendEdate')===params.eDate;
   rows=[...html.matchAll(/<li\b[^>]*name=["']DividendRecords["'][^>]*>([\s\S]*?)<\/li>/gi)].map(m=>[...m[1].matchAll(/<div\b[^>]*>([\s\S]*?)<\/div>/gi)].map(v=>u.text(v[1]))).map(r=>({exDate:u.date(r[4]),payDate:u.date(r[5]),amount:u.number(r[1])}));
  }else{
   const params=record.requestParameters||{},table=u.tables(html).find(tb=>tb[0]?.some(h=>/配息發放日/.test(h))&&tb[0].some(h=>/每單位/.test(h)));
   verified=params.etf_id===t&&params.select_year==='ALL'&&params.select_begin_date==='2024/01/01'&&u.date(params.select_end_date)===reference.asOf&&!!table&&!/PageIndex|page-link|pagination/i.test(html);
   if(table){const h=table[0],ex=h.findIndex(x=>x==='除息日'),pay=h.findIndex(x=>/配息發放日/.test(x)),amount=h.findIndex(x=>/每單位/.test(x));
    rows=table.slice(1).filter(r=>r.length===h.length).map(r=>({exDate:u.date(r[ex]),payDate:u.date(r[pay]),amount:u.number(r[amount])}));}
  }
  // Empty output is not evidence of a non-distributing policy.
  if(verified&&rows?.length){ref.history={identityVerified:true,completeWindow:true,windowFrom:'2024-01-01',windowTo:reference.asOf,rows,sourceId:id,coverageBasis:'official same-fund 2024-to-asOf query; all returned rows, no server pagination'};
   ref.sourceRefs.push({id,dataDate:null,dateBasis:'individual official ex-dividend and payment dates'});}
 }
 return reference;
}
module.exports={collectHistories,normalizeHistories};
