const u=require('./official-text');
async function collectSpecialist(c,db,asOf){
 const jko='https://www.jkoam.com/webapi/api/Fund/';
 const list=await c.get('jko-list',jko+'GetFundSelectList',{method:'POST',body:{TypeID:0}});
 if(list?.StatusCode===0)for(const f of list.Entries.filter(f=>f.IsETF)){
  const p=await c.get('jko-profile-'+f.FundNo,jko+'GetFundDetailPage',{method:'POST',body:{FundNo:f.FundNo,SearchType:1,Year:0,SDate:'2024-01-01',EDate:asOf,IsPreview:false}});
  const ticker=p?.Entries?.FundDetail?.BasicInfo?.StockNo;
  if(!db.etfs.some(e=>e.ticker===ticker&&/街口/.test(e.issuer)))continue;
  await c.get('jko-assets-'+ticker,jko+'GetFundConstituent',{method:'POST',body:{FundNo:f.FundNo}});
  await c.sleep(150);
 }
 const ftft='https://www.ftft.com.tw/official/api/';
 const funds=await c.get('ftft-catalog',ftft+'etf/indicative-navs');
 if(Array.isArray(funds))for(const f of funds){
  if(!db.etfs.some(e=>e.ticker===f.StockCode&&/華美/.test(e.issuer)))continue;
  const id=await c.get('ftft-id-'+f.StockCode,ftft+'newetf/Fund/GetFundId?FtftId='+f.FundId);
  const p=id?.fundId?await c.get('ftft-profile-'+f.StockCode,ftft+'newetf/Fund/Detail/'+id.fundId):null;
  if(p?.code!==f.StockCode)continue;
  await c.get('ftft-basic-'+f.StockCode,ftft+'newetf/Fund0/Detail/'+p.fund0Id);
  await c.get('ftft-trade-'+f.StockCode,ftft+'newetf/Fund1/Detail/'+p.fund1Id);
  await c.get('ftft-assets-'+f.StockCode,ftft+'etf/shares/'+f.FundId+'?date=');
  await c.get('ftft-history-'+f.StockCode,ftft+'etf/dividend/'+f.FundId);
  await c.sleep(150);
 }
}
function normalizeSpecialist(ref,c){
 const records=c.records(),read=c.read,byTicker=new Map(ref.items.map(r=>[r.ticker,r]));
 const add=(r,id,date,basis)=>{if(records.some(x=>x.id===id&&x.path))r.sourceRefs.push({id,dataDate:date||null,dateBasis:basis});};
 const list=read('jko-list');
 if(list?.StatusCode===0)for(const f of list.Entries.filter(f=>f.IsETF)){
  const p=read('jko-profile-'+f.FundNo)?.Entries,b=p?.FundDetail?.BasicInfo,r=byTicker.get(b?.StockNo);if(!r||b.FundNo!==f.FundNo)continue;
  Object.assign(r.profile,{fullName:b.FundFullName,currency:/新臺幣|新台幣/.test(b.FundCurrencyTypeStr)?'TWD':b.FundCurrencyTypeStr,
   category:b.FundTypeStr,indexName:b.StockIndex||r.profile.indexName,
   indexProvider:p.FundDetail.CIndexDescription?.find(x=>/指數編[制製]公司/.test(x.Name))?.Val||null,
   nonDistributing:b.FundDividendStr==='不配息'});
  add(r,'jko-profile-'+f.FundNo,null,'official BasicInfo.StockNo and FundNo match');
  const a=read('jko-assets-'+r.ticker)?.Entries?.FundConstituentData;
  if(a?.Date){const groups=(a.Tables||[]).filter(t=>! /持債特性/.test(t.TableTitle)).map(t=>{
   const headers=t.Columns.map(c=>c.ColumnsName),weight=headers.findIndex(h=>/比例|權重|比重/.test(h)),quantity=headers.findIndex(h=>/股數|口數|面額|數量|票面值/.test(h));
   return {type:/期貨/.test(t.TableTitle)?'future':/債券/.test(t.TableTitle)?'bond':/ETF|基金/.test(t.TableTitle)?'fund':'stock',
    items:(t.RowDetails||[]).map(row=>({code:row[0],name:row[1],quantity:quantity<0?null:u.number(row[quantity]),weight:weight<0?null:u.number(row[weight]),currency:headers.findIndex(h=>/幣別/.test(h))<0?null:row[headers.findIndex(h=>/幣別/.test(h))]}))};
   });
   if(a.Item3?.length)groups.push({type:'cash',items:a.Item3.map(row=>({code:row.Item,name:row.Item,value:u.number(row.Amt),weight:u.number(row.Rate),quantity:null,
    currency:row.Item.match(/\(([A-Z]{3})\)/)?.[1]||null}))});
   const nav=a.Item1?.[0];r.assetSnapshot={date:u.date(a.Date),dateVerifiedForGroups:true,nav:u.number(nav?.Fund_NAV),navDate:u.date(a.Date),aum:u.number(nav?.Fund_Size),units:u.number(nav?.Fund_Unit),groups,coverage:'all FundConstituentData.Tables and cash Item3; aggregates Item2 excluded',fullAssetReconciliation:false};
   add(r,'jko-assets-'+r.ticker,u.date(a.Date),'explicit FundConstituentData.Date');
  }
  if(r.profile.nonDistributing)r.history={identityVerified:true,completeWindow:true,nonDistributing:true,rows:[],coverageBasis:'official BasicInfo.FundDividendStr=不配息'};
 }
 const funds=read('ftft-catalog');
 if(Array.isArray(funds))for(const f of funds){
  const r=byTicker.get(f.StockCode),p=read('ftft-profile-'+f.StockCode),basic=read('ftft-basic-'+f.StockCode),trade=read('ftft-trade-'+f.StockCode);
  if(!r||p?.code!==r.ticker)continue;
  r.profile.fullName=p.name1;
  if(/現金\(新[臺台]幣\)/.test(trade?.creationRedemptionType||''))r.profile.currency='TWD';
  r.profile.nonDistributing=basic?.distribution==='無';
  add(r,'ftft-profile-'+r.ticker,null,'official code matches');add(r,'ftft-basic-'+r.ticker,null,'official distribution policy');add(r,'ftft-trade-'+r.ticker,null,'explicit trading currency');
  const a=read('ftft-assets-'+r.ticker);
  if(a?.StockCode===r.ticker&&a.FundID===f.FundId){
   const groups=[];
   const securities=a.Secs?.length?a.Secs:a.Equities||[];
   for(const securityType of [...new Set(securities.map(row=>row.SecuritiesType))]){
    groups.push({type:securityType==='S'||!a.Secs?.length?'stock':securityType==='B'?'bond':'other',
     items:securities.filter(row=>row.SecuritiesType===securityType).map(row=>({code:row.SecuritiesCode,name:row.SecuritiesName,
      quantity:u.number(row.Shares),weight:u.number(row.WeightingPercentage),value:u.number(row.MarketValue),currency:row.Currency}))});
   }
   const futures=a.Futs?.length?a.Futs:a.Futures||[];
   if(futures.length)groups.push({type:'future',items:futures.map(row=>({code:[row.FutCode||row.FutureCode||row.FuturesCode,row.ContractDate].filter(Boolean).join(':'),name:row.FutName||row.FutureName||row.FuturesName,
    quantity:u.number(row.Lot??row.Contracts??row.Contract),weight:u.number(row.WeightingPercentage),value:u.number(row.MarketValue),currency:row.Currency}))});
   if(a.Bonds?.length)groups.push({type:'bond',items:a.Bonds.map(row=>({code:row.BondCode||row.SecuritiesCode,name:row.BondName||row.SecuritiesName,
    quantity:u.number(row.FaceValue??row.ParValue),weight:u.number(row.WeightingPercentage),value:u.number(row.MarketValue),currency:row.Currency}))});
   const cash=(a.Categories||[]).filter(x=>x.AssetSorting==='2');
   if(cash.length)groups.push({type:'cash',items:cash.map(row=>({code:row.AssetCategory+':'+row.AssetCurrency,name:row.AssetCategory,
    quantity:null,weight:null,value:u.number(row.AssetValue),currency:row.AssetCurrency}))});
   r.assetSnapshot={date:u.date(a.AssetDate),dateVerifiedForGroups:true,nav:u.number(a.NetAssetValuePerUnit),navDate:u.date(a.AssetDate),aum:u.number(a.FundNetAssetValue),units:u.number(a.TotalUnitsOutstanding),groups,coverage:'full official shares response; canonical security arrays and cash categories, aggregates excluded',fullAssetReconciliation:false};
   add(r,'ftft-assets-'+r.ticker,u.date(a.AssetDate),'AssetDate UTC timestamp rendered in Asia/Taipei');
  }
  const h=read('ftft-history-'+r.ticker);
  if(h?.StockCode===r.ticker&&h.FundID===f.FundId&&Array.isArray(h.Dividends)){
   r.history={identityVerified:true,completeWindow:true,nonDistributing:r.profile.nonDistributing,windowFrom:'1900-01-01',windowTo:ref.asOf,
    rows:h.Dividends.map(row=>({payDate:u.date(row.PaymentDate),exDate:u.date(row.ExDividendDate),amount:u.number(row.DividendPerShare),currency:/新[臺台]幣/.test(row.FundCurrencyDesc)?'TWD':row.FundCurrency})),
    coverageBasis:'official full dividend response with matching FundID and StockCode; no pagination'};
   add(r,'ftft-history-'+r.ticker,null,'each PaymentDate');
  }
 }
 return ref;
}
module.exports={collectSpecialist,normalizeSpecialist};
