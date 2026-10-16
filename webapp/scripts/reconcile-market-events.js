const u=require('./official-text');
const splitReference=require('./official-split-reference.json');
const {monthsBefore}=require('../etf-data');
async function collectEvents(c,db,asOf){
 await c.get('twse-payout-all-history','https://www.twse.com.tw/zh/ETFortune/dividendList?startDate=2003&endDate='+asOf.slice(0,4));
 await c.get('twse-splits-2024-2026','https://www.twse.com.tw/rwd/zh/split/TWTCAU?startDate=20240101&endDate='+asOf.replaceAll('-','')+'&response=json');
 await c.get('twse-split-notices','https://www.twse.com.tw/rwd/zh/split/TWTC9U?response=json');
 for(const s of splitReference)await c.get('split-proof-'+s.ticker,s.sourceUrl);
 const funds=db.etfs.filter(e=>e.listingMarket==='TPEx');let next=0;
 await Promise.all(Array.from({length:2},async()=>{while(next<funds.length){const e=funds[next++];
  await c.get('tpex-payout-'+e.ticker,'https://info.tpex.org.tw/api/etfExDivPopup',{method:'POST',body:new URLSearchParams({stkNo:e.ticker,lang:'zh-tw'}).toString()});await c.sleep(200);
 }}));
}
function reconcileEvents(reference,c){
 const read=c.read,receipts=new Map(c.records().map(r=>[r.id,r])),asOf=reference.asOf,from=monthsBefore(asOf,12);
 const html=read('twse-payout-all-history'),table=typeof html==='string'?u.tables(html).find(t=>t[0]?.[0]==='證券代號'):null;
 const allWindow=!!table&&html.includes('Start_Year option[value="2003"]')&&html.includes('End_Year option[value="'+asOf.slice(0,4)+'"]')&&!/[?&](page|PageIndex)=/.test(html);
 for(const ref of reference.items){
  const id=ref.market==='TWSE'?'twse-payout-all-history':'tpex-payout-'+ref.ticker;
  const records=ref.market==='TWSE'?(table||[]).slice(1).filter(row=>row[0]===ref.ticker).map(row=>({payDate:u.date(row[4]),exDate:u.date(row[2]),amount:u.number(row[5])})):
   (Array.isArray(read(id))?read(id):[]).filter(row=>row.stockNo===ref.ticker).map(row=>({payDate:u.date(row.inDate),exDate:u.date(row.divDate),amount:u.number(row.amount)}));
  if(!receipts.get(id)?.path)continue;
  const paid=records.filter(row=>!(row.payDate&&row.payDate>asOf||row.exDate&&row.exDate>asOf));
  const malformed=paid.filter(row=>!row.payDate||!row.exDate||!(row.amount>0)),valid=paid.filter(row=>row.payDate&&row.exDate&&row.amount>0);
  const h=ref.history,issuer=(h?.rows||[]).filter(row=>!row.estimated&&row.payDate>from&&row.payDate<=asOf&&row.exDate&&row.amount>0),other=valid.filter(row=>row.payDate>from);
  const conflicts=[];
  for(const row of issuer){const match=other.find(r=>r.exDate===row.exDate);if(match&&(row.payDate!==match.payDate||Math.abs(row.amount-match.amount)>1e-8))conflicts.push({exDate:row.exDate,issuer:{payDate:row.payDate,amount:row.amount},exchange:{payDate:match.payDate,amount:match.amount}});}
  const complete=ref.market==='TWSE'&&allWindow&&!malformed.length;
  const issuerWindowValid=h?.completeWindow&&(h.rows||[]).every(row=>row.payDate&&row.exDate&&row.amount>0&&!row.estimated);
  if(complete&&issuerWindowValid){
   for(const row of issuer)if(!other.some(r=>r.exDate===row.exDate))conflicts.push({exDate:row.exDate,reason:'paid_event_missing_from_exchange',issuer:row});
   for(const row of other)if(!issuer.some(r=>r.exDate===row.exDate))conflicts.push({exDate:row.exDate,reason:'paid_event_missing_from_complete_issuer_window',exchange:row});
  }
  const sameWindow=complete&&issuer.length===other.length&&issuer.every(row=>other.some(r=>r.exDate===row.exDate&&r.payDate===row.payDate&&Math.abs(r.amount-row.amount)<=1e-8));
  if(h){h.comparisonPerformed=true;h.conflicts=conflicts;h.independentlyReconciled=issuerWindowValid&&sameWindow&&issuer.length>0&&conflicts.length===0;h.comparisonCoverage=complete?'whole TWSE history query':'TPEx recent overlap only; not a full payout window';if(complete&&sameWindow&&!issuer.length)h.confirmedEmpty=true;}
  // The issuer's incomplete history can be filled by the exchange's complete
  // query only when the paid records do not contradict one another.
  if(complete&&!conflicts.length&&(!h?.completeWindow||(h.rows||[]).some(row=>!row.payDate||!row.exDate||!(row.amount>0)))){
   ref.history={identityVerified:true,completeWindow:true,windowFrom:'2003-01-01',windowTo:asOf,rows:valid,sourceId:id,sourceKind:'exchange',confirmedEmpty:!valid.length,
    conflicts:[],comparisonPerformed:!!h,independentlyReconciled:!!h&&sameWindow&&issuer.length>0,
    coverageBasis:'official complete 2003-to-current-year TWSE announcement history; future payments excluded; no pagination'};
  }
  ref.sourceRefs.push({id,dataDate:null,dateBasis:complete?'full announcement history; individual actual pay dates':'recent records only; no completeness claim'});
  ref.payoutCrossCheck={sourceId:id,completeWindow:complete,paidRecords:valid.length,malformedRecords:malformed.length,conflicts:conflicts.length,independentWindowMatched:!!ref.history?.independentlyReconciled};
 }
 const actual=read('twse-splits-2024-2026');
 reference.splits=[];
 if(actual?.stat==='OK')for(const row of actual.data||[]){
  const date=u.date(row[0]),ticker=row[1];if(!date||date>asOf)continue;
  const known=splitReference.find(s=>s.ticker===ticker&&s.date===date),proof=known&&receipts.get('split-proof-'+ticker);
  reference.splits.push({ticker,date,ratio:proof?.path?known.ratio:null,numerator:proof?.path?known.numerator:null,denominator:proof?.path?known.denominator:null,source:'twse-official-split-announcement',sourceUrl:known?.sourceUrl||receipts.get('twse-splits-2024-2026')?.url,
   sourceSha256:proof?.sha256||null,status:proof?.path?'announcement_ratio_and_effective_date_verified':'ratio_pending_verification'});
 }
 reference.splitCoverage={from:'2024-01-01',to:asOf,TWSE:actual?.stat==='OK'?'official_effective_event_list':'unavailable',TPEx:'historical_window_not_verified'};
 return reference;
}
module.exports={collectEvents,reconcileEvents};
