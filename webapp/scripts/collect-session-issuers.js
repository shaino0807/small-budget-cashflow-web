// These public sites require their normal anonymous cookies / anti-forgery flow.
const u=require('./official-text');
function uniFunds(html){try{return JSON.parse(u.decode(html?.match(/id="DataFundList" data-content="([^"]+)"/)?.[1]||'[]'));}catch{return [];}}
async function collectSession(c,db,asOf){
 const base='https://etf.allianzgi.com.tw/webapi/api/',session={anonymousSession:true,bootstrapUrl:base+'AntiForgery/GetAntiForgeryToken'};
 const list=await c.get('allianz-list',base+'Category/GetFundDropdownOptions',{...session,method:'POST',body:{TypeID:-1,IsAddAllOption:false}});
 for(const f of list?.StatusCode===0?list.Entries:[]){
  if(!db.etfs.some(e=>e.ticker===f.SecuritiesCode&&/安聯/.test(e.issuer)))continue;
  await c.get('allianz-assets-'+f.SecuritiesCode,base+'Fund/GetFundTradeInfo',{...session,method:'POST',body:{Date:null,FundNo:f.FundNo}});
  await c.get('allianz-history-'+f.SecuritiesCode,base+'Fund/GetFundYield',{...session,method:'POST',body:{Keyword:'',FundNo:f.FundNo,FundType:-1,SDate:'2024-01-01T00:00:00',EDate:asOf+'T23:59:59'}});
  await c.sleep(150);
 }
 const html=await c.get('uni-pcf','https://www.ezmoney.com.tw/ETF/Transaction/PCF',{anonymousSession:true});
 const roc=(Number(asOf.slice(0,4))-1911)+asOf.slice(4).replaceAll('-','/');
 for(const f of uniFunds(html)){
  const ticker=f.sStockNo?.trim();if(!db.etfs.some(e=>e.ticker===ticker&&/統一/.test(e.issuer)))continue;
  await c.get('uni-assets-'+ticker,'https://www.ezmoney.com.tw/ETF/Transaction/GetPCF',{anonymousSession:true,method:'POST',body:{fundCode:f.sFundCode,date:roc,specificDate:false}});
  await c.get('uni-history-'+ticker,'https://www.ezmoney.com.tw/ETF/Fund/Div',{anonymousSession:true,formState:true,method:'POST',body:{Fund:f.sFundCode,start:'113/01',end:roc.slice(0,6)}});
  await c.sleep(150);
 }
}
function normalizeSession(ref,c){
 const read=c.read,records=c.records(),byTicker=new Map(ref.items.map(r=>[r.ticker,r]));
 const add=(r,id,date,basis)=>{if(records.some(s=>s.id===id&&s.path))r.sourceRefs.push({id,dataDate:date||null,dateBasis:basis});};
 const list=read('allianz-list');
 if(list?.StatusCode===0)for(const f of list.Entries){
  const r=byTicker.get(f.SecuritiesCode),a=read('allianz-assets-'+f.SecuritiesCode)?.Entries;if(!r||a?.CSecuritiesCode!==r.ticker||a.CFundId!==f.FundNo)continue;
  Object.assign(r.profile,{fullName:a.CFullName,currency:a.CEtfindexCurrency});add(r,'allianz-list',null,'official SecuritiesCode and FundNo mapping');
  const groups=(a.DynamicTableData||[]).map(t=>{
   const h=t.Columns.map(x=>x.Name),code=h.findIndex(x=>/代號|代碼/.test(x)),name=h.findIndex(x=>/名稱/.test(x)),w=h.findIndex(x=>/權重|比例/.test(x)),q=h.findIndex(x=>/股數|口數|面額/.test(x));
   if(/附買回/.test(t.TableTitle)){const amount=h.findIndex(x=>/金額/.test(x));return {type:'repo',items:t.Rows.map(row=>({code:row[name],name:row[name],weight:null,quantity:null,cost:u.number(row[amount]?.replace(/^[A-Z]{3}\s*\$\s*/,'')),currency:row[amount]?.match(/^[A-Z]{3}/)?.[0]||null,valueBasis:'reported_repo_amount'}))};}
   return {type:/債券/.test(t.TableTitle)?'bond':/期貨/.test(t.TableTitle)?'future':'stock',items:t.Rows.map(row=>({code:row[code],name:row[name],weight:u.number(row[w]),quantity:q<0?null:u.number(row[q])}))};
  });
  r.assetSnapshot={date:u.date(a.CNavDt),dateVerifiedForGroups:false,nav:u.number(a.CAnceNav),navDate:u.date(a.CNavDt),aum:u.number(a.CAnceTotalAv),units:u.number(a.CAnceTotalIssues),groups,
   coverage:'all official DynamicTableData; cash not separately published, CNavDt not asserted as a position date',fullAssetReconciliation:false};
  add(r,'allianz-assets-'+r.ticker,u.date(a.CNavDt),'CNavDt is NAV date; CPcfdate is announcement date');
  const history=read('allianz-history-'+r.ticker),h=history?.Entries?.find(x=>x.CSecuritiesCode===r.ticker&&x.CFundNo===f.FundNo);
  if(history?.StatusCode===0&&h&&Array.isArray(h.FundYieldList)){
   r.history={identityVerified:true,completeWindow:true,windowFrom:'2024-01-01',windowTo:ref.asOf,
    rows:h.FundYieldList.map(x=>({payDate:u.date(x.CPayableDate),exDate:u.date(x.CExDate),amount:u.number(x.CPerShare)})),coverageBasis:'fund-specific 2024-to-asOf request; full unpaginated FundYieldList'};
   add(r,'allianz-history-'+r.ticker,null,'each CPayableDate');
  }
 }
 for(const f of uniFunds(read('uni-pcf'))){
  const ticker=f.sStockNo?.trim(),r=byTicker.get(ticker),a=read('uni-assets-'+ticker);if(!r||a?.fund?.sStockNo?.trim()!==ticker||a.fund.sFundCode!==f.sFundCode)continue;
  const indexRows=u.tables(a.fund.mIndexIntro||'').flat(),introRows=u.tables(a.fund.mFundIntro||'').flat();
  Object.assign(r.profile,{fullName:a.fund.sFundName,currency:'TWD',indexProvider:indexRows.find(row=>/^指數編[製制]公司$/.test(row[0]))?.[1]||null,
   nonDistributing:introRows.some(row=>row.some((x,i)=>x==='收益分配'&&/不分配|不配息/.test(row[i+1]||'')))});
  const date=u.date(a.pcf?.find(x=>x.PCFCode==='P_UNIT')?.ValueDate?.trim());
  const groups=(a.asset||[]).map(g=>({type:/期貨/.test(g.AssetName)?'future':/債券/.test(g.AssetName)?'bond':/股票/.test(g.AssetName)?'stock':/基金|ETF/.test(g.AssetName)?'fund':/現金|保證金/.test(g.AssetName)?'cash':'other',
   items:(g.Details||[]).map(x=>({code:[x.DetailCode?.trim(),x.MTH?.trim()].filter(Boolean).join(':'),name:x.DetailName?.trim(),quantity:u.number(x.Share),weight:u.number(x.NavRate),value:u.number(x.Amount),currency:x.MoneyType==='NTD'?'TWD':x.MoneyType,
    date:u.date(x.TranDate)}))}));
  const dates=[...new Set(groups.flatMap(g=>g.items).map(x=>x.date))];
  r.assetSnapshot={date:dates.length===1?dates[0]:null,dateVerifiedForGroups:dates.length===1&&!!dates[0],nav:u.number(a.pcf?.find(x=>x.PCFCode==='P_UNIT')?.Amount),navDate:date,
   aum:u.number(a.pcf?.find(x=>x.PCFCode==='NAV')?.Amount),units:u.number(a.pcf?.find(x=>x.PCFCode==='OUT_UNIT')?.Amount),groups,
   coverage:'all official GetPCF.asset.Details groups with individual TranDate; creation baskets excluded',fullAssetReconciliation:false};
  add(r,'uni-assets-'+ticker,date,'per-position TranDate kept separate from PCF PostDate');
  const html=read('uni-history-'+ticker);if(typeof html!=='string')continue;
  const tables=u.tables(html),t=tables.find(t=>/除息/.test(t[0]?.join(' '))&&/發放|給付/.test(t[0]?.join(' ')));
  if(t){const h=t[0],ex=h.findIndex(x=>/除息/.test(x)),pay=h.findIndex(x=>/發放|給付/.test(x)),amount=h.findIndex(x=>/每.*單位|配息金額/.test(x));
   const strip=(value,label)=>value?.startsWith(label)?value.slice(label.length).trim():value;
   const receipt=records.find(x=>x.id==='uni-history-'+ticker),params=receipt?.requestParameters||{};
   r.history={identityVerified:t.slice(1).every(row=>row.some(x=>x.includes(ticker))),completeWindow:params.Fund===f.sFundCode&&params.start==='113/01'&&params.end===(Number(ref.asOf.slice(0,4))-1911)+'/'+ref.asOf.slice(5,7)&&!/[?&](page|PageIndex)=|Page\$[2-9]/.test(html),
    windowFrom:'2024-01-01',windowTo:ref.asOf,
    rows:t.slice(1).map(row=>({payDate:u.date(strip(row[pay],h[pay])),exDate:u.date(strip(row[ex],h[ex])),amount:u.number(strip(row[amount],h[amount]))})),coverageBasis:'official 2024-to-asOf history form; all result rows carry matching ticker; no pagination'};
   add(r,'uni-history-'+ticker,null,'per-event payout dates');
  }else if(r.profile.nonDistributing){r.history={identityVerified:true,completeWindow:true,nonDistributing:true,rows:[],coverageBasis:'explicit same-fund distribution policy'};add(r,'uni-assets-'+ticker,null,'explicit distribution policy');}
 }
 return ref;
}
module.exports={collectSession,normalizeSession,uniFunds};
