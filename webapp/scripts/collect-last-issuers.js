const u=require('./official-text');
const abDate=v=>{const m=String(v||'').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);return m?u.date(m[3]+'-'+m[1]+'-'+m[2]):u.date(v);};
async function collectLast(c,db,asOf){
 const catalog=await c.get('uob-catalog','https://www.uobam.com.tw/fund/etf',{nativeTransport:true});
 if(typeof catalog==='string')for(const link of [...new Set(catalog.match(/\/fund\/etf\/\d+/g)||[])]){
  const id=link.split('/').at(-1),a=await c.get('uob-pcf-id-'+id,'https://www.uobam.com.tw/json/reply/WebSitePcfRequest?fundID='+id+'&pcfDate=',{nativeTransport:true});
  if(!db.etfs.some(e=>e.ticker===a?.etf002&&/大華銀/.test(e.issuer)))continue;
  await c.get('uob-profile-'+a.etf002,'https://www.uobam.com.tw'+link,{nativeTransport:true});await c.sleep(150);
  await c.get('uob-history-'+a.etf002,'https://www.uobam.com.tw/json/reply/WebSiteStockDividendRequest?ec001=&mfundID=&fundID='+id+'&year=&start=202401&end='+asOf.slice(0,7).replace('-',''),{nativeTransport:true});
 }
 const abPage=await c.get('ab-pcf-00980D','https://www.abfunds.com.tw/zh-tw/etfs/pcf.TW00000980D8.html',{nativeTransport:true});
 for(const isin of typeof abPage==='string'?[...new Set(abPage.match(/TW0000[0-9A-Z]{6}/g)||[])]:[]){
  const base='https://webapi.alliancebernstein.com/v2/funds/tw/zh-tw/investor/'+isin;
  const profile=await c.get('ab-profile-'+isin,base);
  const code=profile?.secId||profile?.ticker||profile?.bloombergTicker?.split(' ')[0]||isin.match(/^TW000(0\d{3,5}[A-Z])\d$/)?.[1];
  if(!db.etfs.some(e=>e.ticker===code&&/聯博/.test(e.issuer)))continue;
  await c.get('ab-basket-'+code,base+'/basket');await c.get('ab-assets-'+code,base+'/holdings');
  await c.get('ab-history-'+code,base+'/distributions');await c.sleep(150);
 }
 // Same anonymous system session used by the official public site. Never store its token.
 const hn='https://www.hnfunds.com.tw/WEB_API/HN_OW_PROD/',headers={Client_Id:'WFPAPIPublicClient','Accept-Language':'zh-TW','Content-Type':'application/json','X-Origin-Time':new Date().toISOString()};
 try{const response=await fetch(hn+'Auth/SysLogin',{method:'POST',headers,signal:AbortSignal.timeout(20000)});
  if(response.ok){const session=await response.json();if(session.access_token)for(const etf of db.etfs.filter(e=>/華南永昌/.test(e.issuer))){
   await c.get('hn-assets-'+etf.ticker,hn+'ETF/BuyBack',{method:'POST',body:{ETFID:etf.ticker,DataDate:''},transientHeaders:{...headers,Authorization:'Bearer '+session.access_token}});
   await c.sleep(150);
  }}
 }catch{/* Prior verified data is retained when the public session is unavailable. */}
}
function normalizeLast(ref,c){
 const read=c.read,records=c.records(),byTicker=new Map(ref.items.map(r=>[r.ticker,r]));
 const add=(r,id,date,basis)=>{if(records.some(s=>s.id===id&&s.path))r.sourceRefs.push({id,dataDate:date||null,dateBasis:basis});};
 const money=v=>u.number(String(v??'').replace(/^(?:NT\$|[A-Z]{3})\s*/,''));
 for(const source of records.filter(x=>/^uob-pcf-id-/.test(x.id)&&x.path)){
  const a=read(source.id),r=byTicker.get(a?.etf002);if(!r||!/大華銀/.test(r.identity.issuer))continue;
  const groups=[];for(const kind of [...new Set((a.result||[]).map(x=>x.kind))])groups.push({type:kind==='stock'?'stock':kind==='bond'?'bond':/future/.test(kind)?'future':'other',
   items:a.result.filter(x=>x.kind===kind).map(x=>({code:x.code+(x.dym?':'+x.dym:''),name:x.cName,quantity:u.number(x.qty),weight:u.number(x.weight),value:money(x.amt),currency:x.ec006,valueBasis:/NT\$|TWD/.test(x.amt||'')?'reported_TWD_market_value':'reported_value_currency_not_verified',date:u.date(x.dataDate)}))});
  const dates=[...new Set(groups.flatMap(g=>g.items).map(x=>x.date))];
  r.profile.currency='TWD';r.profile.fullName=a.twName;
  r.assetSnapshot={date:dates.length===1?dates[0]:null,dateVerifiedForGroups:dates.length===1&&!!dates[0],positionDatesVerified:true,nav:money(a.nav),navDate:u.date(a.datadate),aum:money(a.totalAV),units:u.number(a.totalIssues),groups,
   coverage:'all official WebSitePcfRequest.result groups; per-position dataDate, announcement and valuation dates separate',fullAssetReconciliation:false};
  add(r,source.id,u.date(a.datadate),'individual result.dataDate');add(r,'uob-profile-'+r.ticker,null,'official fund profile');
  const historyId='uob-history-'+r.ticker,h=read(historyId),record=records.find(x=>x.id===historyId);
  const fundID=new URL(source.url).searchParams.get('fundID');
  if(h?.status===0&&Array.isArray(h.fundresult)&&h.fundresult.length&&h.nextPage==null&&h.totalPage<=1&&h.fundresult.every(x=>x.fundID===fundID)&&record?.url.includes('start=202401')){
   r.history={identityVerified:true,completeWindow:true,windowFrom:'2024-01-01',windowTo:ref.asOf,sourceId:historyId,
    rows:h.fundresult.map(x=>({payDate:u.date(x.ec01031),exDate:u.date(x.ec01034),amount:u.number(x.ec01022),currency:/新台幣|新臺幣/.test(x.ec006)?'TWD':x.ec006})),
    coverageBasis:'official public date-range query; exact fundID matched to ticker-specific PCF; no next page'};
   add(r,historyId,null,'individual official ex-date and payment date');
  }
 }
 for(const r of ref.items){
  const a=read('hn-assets-'+r.ticker)?.Data;if(a?.ETFID!==r.ticker)continue;
  r.profile.fullName=a.FundName;r.profile.currency=a.FundCurrency;
  const groups=[];
  for(const [key,rows] of Object.entries(a).filter(([key,value])=>/^(StockList|Futures|Bonds|Rps|OtherAsset)$/.test(key)&&Array.isArray(value)&&value.length)){
   const type=key==='StockList'?'stock':key==='Bonds'?'bond':key==='Futures'?'future':key==='Rps'?'repo':'cash';
   groups.push({type,items:rows.map(x=>({code:x.StockNo||x.BondNo||[x.TxID,x.FutureYM].filter(Boolean).join(':')||x.ItemAsset,
    name:x.StockName||x.BondName||x.TxName||x.ItemAsset,
    quantity:u.number(x.Share??x.FaceValue??x.Lot),weight:x.Weight==null?null:u.number(x.Weight)*100,value:u.number(x.AssetAmt??x.Amount??x.LotAmt),currency:x.Currency||null}))});
  }
  r.assetSnapshot={date:null,dateVerifiedForGroups:false,nav:u.number(a.Pcf?.Punit),navDate:u.date(a.Pcf?.BalDate),aum:u.number(a.Pcf?.FundSize),units:u.number(a.Pcf?.TotUnit),groups,
   coverage:'all published typed lists; DataDate is announcement date and BalDate is NAV date, neither invented as position date',fullAssetReconciliation:false};
  add(r,'hn-assets-'+r.ticker,u.date(a.Pcf?.BalDate),'Pcf.BalDate is NAV date; positions date not independently declared');
 }
 for(const r of ref.items){
  const a=read('ab-assets-'+r.ticker),b=read('ab-basket-'+r.ticker);if(!a||!b||(a.otherAsset?.secID||a.fundAssetTotal?.secID)!==r.ticker)continue;
  const groups=(a.domesticHoldings||[]).map(g=>({type:/bond/.test(g.holdingCategory)?'bond':/future/.test(g.holdingCategory)?'future':/option/.test(g.holdingCategory)?'option':/etf|fund/.test(g.holdingCategory)?'fund':'stock',
   items:(g.holdings||[]).map(x=>({code:x.holdingCode||(/future|option/.test(g.holdingCategory)?x.holding:null),name:x.holding,quantity:u.number(x.holdingShares),weight:u.number(x.holdingPerc),value:u.number(x.holdingValue),date:abDate(g.asOfDate)}))}));
  if(a.otherAsset?.allocationObjSecType?.length)groups.push({type:'other',items:a.otherAsset.allocationObjSecType.map(x=>({code:x.allocationObjSecType+':'+x.allocationObjCCY,name:x.allocationObjSecType,quantity:null,weight:null,value:u.number(x.allocationObjValue),currency:x.allocationObjCCY?.split('-').at(-1)?.toUpperCase()}))});
  const dates=[...new Set((a.domesticHoldings||[]).map(g=>abDate(g.asOfDate)))];r.profile.currency=b.currency;
  r.assetSnapshot={date:dates.length===1?dates[0]:null,dateVerifiedForGroups:dates.length===1&&!!dates[0],nav:u.number(b.nav),navDate:u.date(b.navAsOfDate),aum:u.number(b.aum),units:u.number(b.shares),groups,
   coverage:'all domesticHoldings and otherAsset groups from official API; matching otherAsset.secID; no top-ten substitution',fullAssetReconciliation:false};
  add(r,'ab-assets-'+r.ticker,dates[0],'each official holdings group.asOfDate');add(r,'ab-basket-'+r.ticker,u.date(b.navAsOfDate),'navAsOfDate separate from announcementDate');
  const profileSource=records.find(x=>x.id.startsWith('ab-profile-')&&read(x.id)?.fundNumber===r.ticker),profile=profileSource&&read(profileSource.id);
  if(profile){r.profile.fullName=profile.fundName;add(r,profileSource.id,null,'fundNumber and ISIN from official fund profile');
   const h=read('ab-history-'+r.ticker);if(Array.isArray(h?.distributions)){
    r.history={identityVerified:true,completeWindow:true,windowFrom:u.date(profile.shareclassInceptionDate),windowTo:ref.asOf,
     rows:h.distributions.map(x=>({payDate:u.date(x.payableDate),exDate:u.date(x.exDate),amount:u.number(x.amount)})),coverageBasis:'official ISIN-scoped full distributions endpoint; public UI paginates the returned array locally'};
    add(r,'ab-history-'+r.ticker,u.date(h.asOfDate),'each payableDate; response asOfDate separately retained');
   }
  }
 }
 return ref;
}
module.exports={collectLast,normalizeLast,abDate};
