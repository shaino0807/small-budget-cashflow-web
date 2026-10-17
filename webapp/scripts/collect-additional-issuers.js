const u=require('./official-text');
async function collectAdditional(client,db,asOf){
 const list=await client.get('sinopac-list','https://sitc.sinopac.com/SinopacEtfs/Funds/FundInfo');
 if(typeof list==='string')for(const etf of db.etfs.filter(e=>/永豐/.test(e.issuer))){
  const row=[...list.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>m[1]).find(s=>new RegExp('\\b'+etf.ticker+'\\b').test(u.text(s)));
  if(!row)continue;const id=row.match(/stock_id=([^&"']+)/)?.[1];if(!id)continue;
  await client.get('sinopac-pcf-'+etf.ticker,'https://sitc.sinopac.com/SinopacEtfs/Etfs/Pcf/'+etf.ticker);
  await client.get('sinopac-profile-'+etf.ticker,'https://sitc.sinopac.com/newweb/sitcFund/page.do?stock_id='+id);
  await client.get('sinopac-history-'+etf.ticker,'https://sitc.sinopac.com/SinopacEtfs/Funds/DividenEtf',
   {method:'POST',body:new URLSearchParams({fundId:id,range:'5',hdnTimeRange:'5'}).toString()});
  await client.sleep(200);
 }
 const base='https://www.nomurafunds.com.tw/API/ETFAPI/api/Fund/';
 for(const etf of db.etfs.filter(e=>/野村/.test(e.issuer))){
  await client.get('nomura-profile-'+etf.ticker,base+'GetFundDetailPage',{method:'POST',body:{FundNo:etf.ticker,IsPreview:false,SearchType:1,Year:Number(asOf.slice(0,4)),SDate:'2024-01-01',EDate:asOf}});
  await client.get('nomura-assets-'+etf.ticker,base+'GetFundAssets',{method:'POST',body:{FundID:etf.ticker,SearchDate:null}});
  await client.get('nomura-history-'+etf.ticker,base+'GetFundYield',{method:'POST',body:{Type:1,Keyword:'',FundNo:etf.ticker,StartDate:'2024-01-01',EndDate:asOf,FundType:0,PageIndex:1,PageSize:9999}});
  await client.sleep(200);
 }
 // Official anonymous website session. No token response or token-bearing URL is persisted.
 const ctbc='https://www.ctbcinvestments.com.tw/API/';
 try{
  const authUrl=new URL(ctbc+'home/AuthToken');authUrl.searchParams.set('token','www.ctbcinvestments.com');
  const response=await fetch(authUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'www.ctbcinvestments.com'}),signal:AbortSignal.timeout(20000)});
  if(response.ok){const auth=await response.json(),token=auth.Data?.token||auth.token;
   if(token){const options={method:'POST',body:{token},transientParams:{token}};
    const result=await client.get('ctbc-list',ctbc+'etf/ETFCNOList',options);
    if(result?.ResultCode===0)for(const fund of result.Data?.List||[]){
     if(!db.etfs.some(e=>e.ticker===fund.ETF_ID&&/中信|中國信託/.test(e.issuer)))continue;
     await client.get('ctbc-assets-'+fund.ETF_ID,ctbc+'etf/Buyback',{...options,body:{token,FID:fund.FID,StartDate:asOf}});
     await client.get('ctbc-profile-'+fund.ETF_ID,ctbc+'etf/ETFDetail',{...options,body:{token,CNO:fund.CNO}});
     await client.sleep(200);
    }
   }
  }
 }catch { /* Session unavailable: retain prior market data; coverage remains explicit. */ }
 await require('./collect-more-issuers').collectMore(client,db,asOf);
 await require('./collect-specialist-issuers').collectSpecialist(client,db,asOf);
 await require('./collect-session-issuers').collectSession(client,db,asOf);
 await require('./collect-last-issuers').collectLast(client,db,asOf);
 await require('./collect-history-issuers').collectHistories(client,db,asOf);
 await require('./collect-index-fields').collectIndexFields(client,db);
}
function normalizeAdditional(reference,client){
 const read=client.read,byId=new Map(client.records().map(r=>[r.id,r]));
 for(const ref of reference.items){
  const t=ref.ticker;
  if(/富邦/.test(ref.identity.issuer)){
   const profile=read('fubon-profile-'+t);
   if(typeof profile==='string'){
    const policy=u.tables(profile).flat().find(row=>row.length>=2&&/^(收益分配|配息|收益分配方式)$/.test(row[0]));
    if(policy&&/^(不配息|不分配收益|不分配|無)[。.]?$/.test(policy[1]))ref.profile.nonDistributing=true;
   }
   const historyId=['fubon-history-extended-','fubon-history-full-'].map(prefix=>prefix+t).find(id=>byId.get(id)?.path);
   const history=historyId&&read(historyId),record=historyId&&byId.get(historyId);
   if(ref.history&&typeof history==='string'){
    const input=[...history.matchAll(/<input[^>]+>/g)].find(m=>m[0].includes('hidStkId'))?.[0];
    const selected=input?.match(/value="([^"]*)"/)?.[1];
    const from=Object.entries(record.requestParameters||{}).find(([k])=>k.endsWith('$sDate'))?.[1];
    const to=Object.entries(record.requestParameters||{}).find(([k])=>k.endsWith('$eDate'))?.[1];
    ref.history.identityVerified=selected===t;
    ref.history.completeWindow=selected===t&&from==='2024/01/01'&&u.date(to)===reference.asOf&&!/Page\$[2-9]/.test(history);
    ref.history.windowFrom='2024-01-01';ref.history.windowTo=reference.asOf;
    ref.history.coverageBasis='official 2024-to-asOf form fields and matching hidden ticker; no page links';
   }
   if(!ref.history&&ref.profile.nonDistributing)ref.history={identityVerified:true,completeWindow:true,nonDistributing:true,rows:[],coverageBasis:'explicit fund-specific distribution policy'};
  }
  if(ref.assetSnapshot&&/國泰/.test(ref.identity.issuer)){
   for(const group of ref.assetSnapshot.groups){
    if(group.type==='fund')group.items=group.items.map(item=>({code:item.raw.fnNo,name:item.raw.fnName,quantity:null,weight:null,value:u.number(item.raw.ntMkval),valueBasis:'reported_market_value'}));
    if(group.type==='buy'){group.type='repo';group.items=group.items.map(item=>({code:item.raw.issueCo,name:item.raw.issueCo,quantity:null,weight:null,cost:u.number(item.raw.buyCost),valueBasis:'reported_purchase_cost'}));}
    if(group.type==='option')group.items=group.items.map(item=>({code:[item.raw.option_No,item.raw.option_Date,item.raw.callPut,item.raw.strike_Price].join(':'),name:item.raw.fT_Name,
      quantity:u.number(item.raw.volumn),weight:u.number(item.raw.weight),value:u.number(item.raw.mkval),currency:item.raw.curr}));
   }
  }
  const add=(id,date,basis)=>{if(byId.get(id)?.path)ref.sourceRefs.push({id,dataDate:date||null,dateBasis:basis});};
  const n=read('nomura-profile-'+t)?.Entries;
  if(n?.FundDetail?.CStockNo===t){
   const f=n.FundDetail;Object.assign(ref.profile,{fullName:f.CFullName,currency:/新台幣|新臺幣/.test(f.CCgCurrencyTypeName)?'TWD':f.CCgCurrencyTypeName,
    indexName:f.CIndexDescription||ref.profile.indexName,indexProvider:f.CIndexCompany||null,nonDistributing:/不分配|不配息/.test(f.CCgDividendTypeName)});
   add('nomura-profile-'+t,null,'fund-specific public detail');
   const a=read('nomura-assets-'+t)?.Entries;
   if(a?.FundID===t&&a.Data?.FundAsset){const f=a.Data.FundAsset;
    const groups=(a.Data.Table||[]).filter(x=>x.TableTitle&&!/持債特性/.test(x.TableTitle)&&x.Columns?.some(c=>/權重|比例/.test(c.Name))).map(tb=>{
     const h=tb.Columns.map(c=>c.Name),w=h.findIndex(x=>/權重|比例/.test(x)),q=h.findIndex(x=>/股數|面額|面值|口數|數量/.test(x));
     return {type:/債券/.test(tb.TableTitle)?'bond':/期貨/.test(tb.TableTitle)?'future':/基金/.test(tb.TableTitle)?'fund':'stock',items:tb.Rows.map(r=>({code:r[0],name:r[1],quantity:q<0?null:u.number(r[q]),weight:u.number(r[w])}))};
    });
    ref.assetSnapshot={date:u.date(f.NavDate),dateVerifiedForGroups:true,nav:u.number(f.Nav),navDate:u.date(f.NavDate),aum:u.number(f.Aum),units:u.number(f.Units),groups,coverage:'all official FundAssets typed tables',fullAssetReconciliation:false};
    add('nomura-assets-'+t,u.date(f.NavDate),'FundAsset.NavDate');
   }
   const history=read('nomura-history-'+t),h=history?.Entries?.find(x=>x.CFundNo===t);
   if(history?.StatusCode===0&&history.Entries.length===1&&h&&Array.isArray(h.YieldData)){
    ref.history={identityVerified:true,completeWindow:true,windowFrom:'2024-01-01',windowTo:reference.asOf,
     rows:h.YieldData.map(r=>({payDate:u.date(r.CPayableDate),exDate:u.date(r.CExDate),amount:u.number(r.CPerShare)})),coverageBasis:'fund-specific 2024-to-asOf query; nested YieldData without pagination'};
    add('nomura-history-'+t,null,'per-event CPayableDate');
   }
  }
  const c=read('ctbc-assets-'+t),f=c?.Data?.Data?.[0];
  const detail=read('ctbc-profile-'+t)?.Data,cp=detail?.FundDetail?.[0];
  if(cp?.ETF_ID===t){
   Object.assign(ref.profile,{fullName:cp.FID_NAME,currency:/新臺幣|新台幣/.test(cp.CurType)?'TWD':cp.CurType,
    indexName:u.text(cp.ExponName)||ref.profile.indexName,nonDistributing:/^(不配息|不分配收益|不分配)[。.]?$/.test(u.text(cp.DistriRate))});
   const index=detail.Expon?.[0];if(index)ref.profile.indexDetails=index;
   add('ctbc-profile-'+t,null,'official ticker-specific ETFDetail');
   if(Array.isArray(detail.DivHist)&&detail.DivHist.every(r=>r.FID===cp.FID&&r.CNO===cp.CNO)){
    ref.history={identityVerified:true,completeWindow:true,windowFrom:'1900-01-01',windowTo:reference.asOf,
      nonDistributing:ref.profile.nonDistributing,rows:detail.DivHist.map(r=>({payDate:u.date(r.RELEASE_DATE),exDate:u.date(r.DIVIDENT_DATE),amount:u.number(r.UNIT_NET)})),
      coverageBasis:'official full ETFDetail.DivHist array used by unpaginated public history view'};
   }
  }
  if(c?.ResultCode===0&&f?.ETF_ID===t&&Array.isArray(c.Data.Detail)){
   ref.profile.currency=f['幣別'];
   const date=u.date(f['淨值日期']),groups=c.Data.Detail.map(g=>({type:{STOCK:'stock',BOND:'bond',FUTURE:'future',ETF:'fund',CASH:'cash',MARGIN:'cash'}[g.Code]||'other',summaryWeight:u.number(g.Sum),
    items:(g.Data||[]).map(r=>({code:String(r.code_||r.name_)+(r.ym_?':'+r.ym_:''),name:r.name_,quantity:u.number(r.qty_),weight:u.number(r.weights_),value:u.number(r.amount_),currency:r.cur_}))}));
   ref.assetSnapshot={date,dateVerifiedForGroups:true,nav:u.number(f['每受益權單位淨資產價值']),navDate:date,aum:u.number(f['基金淨資產價值']),units:u.number(f['已發行受益權單位總數']),groups,
    coverage:'all official Buyback.Detail asset groups, including cash and margin; announcement date kept separate',fullAssetReconciliation:false};
   add('ctbc-assets-'+t,date,'explicit 淨值日期; 公告日 is a separate effective date');
  }
  const html=read('sinopac-pcf-'+t);
  if(typeof html==='string'&&new RegExp('<option[^>]*selected[^>]*value="'+t+'"').test(html)){
   const text=u.text(html),date=u.date(text.match(/資料日期[:：]\s*(\d{4}\/\d{2}\/\d{2})/)?.[1]);
   const tables=u.tables(html),groups=tables.filter(tb=>tb[0].length>=3&&/權重/.test(tb[0].join(' '))&&/代碼|代號/.test(tb[0].join(' '))).map(tb=>{
    const h=tb[0],w=h.findIndex(x=>/權重/.test(x)),q=h.findIndex(x=>/股數|面額|口數/.test(x));
    return {type:/面額|債券/.test(h.join(' '))?'bond':/口數|期貨/.test(h.join(' '))?'future':'stock',items:tb.slice(1).filter(r=>r.length===h.length&&!/合計|小計|總計/.test(r[0])).map(r=>({code:r[0],name:r[1],quantity:q<0?null:u.number(r[q]),weight:u.number(r[w])}))};
   });
   const kv=Object.fromEntries(tables.find(tb=>tb[0]?.[0]==='基金淨資產價值(元)')||[]),num=v=>u.number(String(v||'').replace(/NT\$|TWD/g,''));
   ref.profile.currency='TWD';ref.assetSnapshot={date,dateVerifiedForGroups:true,nav:num(kv['基金每單位淨值(元)']),navDate:date,aum:num(kv['基金淨資產價值(元)']),units:num(kv['基金在外流通單位數']),groups,
    coverage:'all full-width official asset tables; per-creation-unit rows excluded',fullAssetReconciliation:false};
   add('sinopac-pcf-'+t,date,'explicit 資料日期 of full fund asset section');
   const list=read('sinopac-list'),row=typeof list==='string'?[...list.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>m[1]).find(s=>new RegExp('\\b'+t+'\\b').test(u.text(s))):null;
   ref.profile.nonDistributing=!!row&&/不分配/.test(u.text(row));
   add('sinopac-profile-'+t,null,'same-fund detail');add('sinopac-list',null,'explicit distribution policy in ticker row');
   const history=read('sinopac-history-'+t),parsedHistory=require('./sinopac-payout-history').parseSinopacHistory(history,{shortName:ref.identity.shortName,asOf:reference.asOf});
   if(parsedHistory){
    ref.history={...parsedHistory,sourceId:'sinopac-history-'+t};
    add('sinopac-history-'+t,null,'each official 發放日 in all-history response');
   }else if(ref.profile.nonDistributing)ref.history={identityVerified:true,completeWindow:true,nonDistributing:true,rows:[],coverageBasis:'official ticker-row 不分配 policy'};
  }
 }
 const result=require('./collect-last-issuers').normalizeLast(require('./collect-session-issuers').normalizeSession(require('./collect-specialist-issuers').normalizeSpecialist(require('./collect-more-issuers').normalizeMore(reference,client),client),client),client);
 // Share classes use the same legal fund portfolio only when the official tax ID links them.
 for(const ref of result.items){
  const basic=ref.profile.basicRaw,name=basic?.['基金中文名稱']||'';
  if(/加掛.*美元/.test(name))ref.profile.currency='USD';
  else if(/加掛.*人民幣/.test(name))ref.profile.currency='CNY';
  if(ref.assetSnapshot||!basic?.['基金統一編號']||!/加掛/.test(name))continue;
  const parents=result.items.filter(p=>p.ticker!==ref.ticker&&p.assetSnapshot&&p.profile.basicRaw?.['基金統一編號']===basic['基金統一編號']&&!/加掛/.test(p.profile.basicRaw?.['基金中文名稱']||''));
  if(parents.length!==1)continue;
  const parent=parents[0],a=parent.assetSnapshot;
  ref.assetSnapshot={...a,nav:null,navDate:null,aum:null,units:null,portfolioParent:parent.ticker,
   coverage:'shared legal fund portfolio; official fund tax-ID match; no parent-class NAV or payout copied'};
  ref.sourceRefs.push(...parent.sourceRefs.filter(s=>/assets|portfolio|fubon-0|yuanta-/.test(s.id)));
 }
 return require('./collect-index-fields').normalizeIndexFields(require('./collect-history-issuers').normalizeHistories(result,client),client);
}
module.exports={collectAdditional,normalizeAdditional};
