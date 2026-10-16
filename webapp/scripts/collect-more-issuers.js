const u=require('./official-text');
function firstgoldFunds(html){
 if(typeof html!=='string')return [];
 const input=[...html.matchAll(/<input[^>]+>/g)].find(m=>m[0].includes('HiddenField_FundName'))?.[0];
 try{return JSON.parse(u.decode(u.decode(input?.match(/value="([^"]*)"/)?.[1])));}catch{return [];}
}
async function collectMore(c,db,asOf){
 const first=await c.get('firstgold-catalog','https://www.fsitc.com.tw/FundDetail.aspx?ID=183');
 for(const fund of firstgoldFunds(first).filter(f=>db.etfs.some(e=>e.ticker===f.cETFStockCode&&/第一金/.test(e.issuer)))){
  await c.get('firstgold-profile-'+fund.cETFStockCode,'https://www.fsitc.com.tw/FundDetail.aspx?ID='+fund.cNo);
  await c.get('firstgold-assets-'+fund.cETFStockCode,'https://www.fsitc.com.tw/WebAPI.aspx/Get_hd',{method:'POST',body:{pStrFundID:fund.cNo,pStrDate:asOf.replaceAll('-','/')}});
  await c.sleep(150);
 }
 const home=await c.get('usitc-home','https://www.usitc.com.tw/');
 if(typeof home==='string'){
  const links=[...new Set([...home.matchAll(/href="(\/Fund\/FundPage\?FundNo=[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].filter(m=>/ETF/.test(u.text(m[2]))).map(m=>u.decode(m[1])))];
  for(const link of links){
   const html=await c.get('usitc-fund-'+new URL(link,'https://www.usitc.com.tw').searchParams.get('FundNo'),'https://www.usitc.com.tw'+link);
   if(typeof html!=='string')continue;
   const text=u.text(html),ticker=text.match(/證券代碼\s*(0\d{3,5}[A-Z]?)/)?.[1];
   if(!db.etfs.some(e=>e.ticker===ticker&&/聯邦/.test(e.issuer)))continue;
   const FundNo=new URL(link,'https://www.usitc.com.tw').searchParams.get('FundNo');
   await c.get('usitc-pcf-'+ticker,'https://www.usitc.com.tw/CustCenter/BuyBackList',{method:'POST',body:new URLSearchParams({FundNo:ticker,sDate:asOf}).toString()});
   await c.get('usitc-history-'+ticker,'https://www.usitc.com.tw/Fund/FundDividend_ETF',{method:'POST',body:new URLSearchParams({FundNo:ticker,sDate:'2024-01-01',eDate:asOf}).toString()});
  }
 }
}
function normalizeMore(ref,c){
 const records=c.records(),read=c.read,byTicker=new Map(ref.items.map(r=>[r.ticker,r]));
 const add=(ref,id,date,basis)=>{if(records.find(r=>r.id===id)?.path)ref.sourceRefs.push({id,dataDate:date||null,dateBasis:basis});};
 for(const f of firstgoldFunds(read('firstgold-catalog'))){
  const r=byTicker.get(f.cETFStockCode);if(!r)continue;
  Object.assign(r.profile,{fullName:f.cName,currency:/台幣|臺幣|TWD/.test(f.cETFCurrency)?'TWD':f.cETFCurrency,
    indexName:f.cIndexName||r.profile.indexName,indexProvider:f.cIndexCompany||null,nonDistributing:/不配息|不分配/.test(f.IsDividend)});
  add(r,'firstgold-catalog',u.date(f.cUpdateDT),'profile update date; not a position date');
  let rows;try{rows=JSON.parse(read('firstgold-assets-'+r.ticker)?.d);}catch{continue;}
  if(!Array.isArray(rows)||!rows.length||!rows.every(x=>x.fundid===f.cNo))continue;
  const dates=[...new Set(rows.map(x=>u.date(x.sdate)))];if(dates.length!==1||!dates[0])continue;
  const groups=[];
  for(const group of [...new Set(rows.map(x=>x.group))]){
   const type={'1':'stock','2':'future','3':'cash','4':'other','6':'bond'}[group];if(!type)continue;
   groups.push({type,items:rows.filter(x=>x.group===group).map(x=>group==='1'?{code:x.A,name:x.B,weight:u.number(x.C),quantity:u.number(x.D)}:
    group==='2'?{code:x.A+':'+x.D,name:x.A,weight:u.number(x.B),quantity:u.number(x.C)}:
    group==='6'?{code:x.A,name:x.B,quantity:u.number(x.C),value:u.number(x.D),weight:u.number(x.E)}:
    {code:x.A,name:x.A,value:u.number(String(x.B).replace(/^[A-Z]{3}\s*/,'')),weight:u.number(x.C),quantity:null,currency:x.B.match(/^[A-Z]{3}/)?.[0]||null})});
  }
  r.assetSnapshot={date:dates[0],dateVerifiedForGroups:true,nav:null,navDate:null,groups,coverage:'all official Get_hd typed asset groups; group5 summary excluded',fullAssetReconciliation:false};
  add(r,'firstgold-assets-'+r.ticker,dates[0],'each Get_hd.sdate');
  if(r.profile.nonDistributing)r.history={identityVerified:true,completeWindow:true,nonDistributing:true,rows:[],coverageBasis:'explicit firstgold distribution policy'};
 }
 for(const r of ref.items){
  const html=read('usitc-pcf-'+r.ticker);if(typeof html!=='string')continue;
  const text=u.text(html);if(!text.includes('('+r.ticker+')')&&!text.includes('( '+r.ticker+' )'))continue;
  const date=u.date(text.match(/資料日期[:：]\s*(\d{4}-\d{2}-\d{2})/)?.[1]),tables=u.tables(html);
  const groups=tables.filter(t=>t[0]?.length>=3&&/權重/.test(t[0].join(' '))).map(t=>{
   const head=t[0],w=head.findIndex(h=>/權重/.test(h)),q=head.findIndex(h=>/股數|口數|面額/.test(h)),type=/期貨/.test(head.join(' '))?'future':/債券/.test(head.join(' '))?'bond':'stock';
   return {type,items:t.slice(1).filter(row=>row.length===head.length&&!/合計|小計/.test(row[0])).map(row=>({code:row[0],name:row[1],quantity:u.number(row[q]),weight:u.number(row[w])}))};
  });
  r.profile.currency='TWD';r.assetSnapshot={date,dateVerifiedForGroups:true,nav:null,navDate:date,groups,coverage:'all official full-fund asset tables; creation-unit summary excluded',fullAssetReconciliation:false};
  add(r,'usitc-pcf-'+r.ticker,date,'explicit 基金資產 資料日期');
  const source=records.find(x=>x.id.startsWith('usitc-fund-')&&typeof read(x.id)==='string'&&u.text(read(x.id)).includes(r.ticker));
  if(source){const profile=u.text(read(source.id));r.profile.indexProvider=profile.match(/編製公司\s*(.*?)\s*成份檔數/)?.[1]||null;add(r,source.id,null,'official fund detail');}
 }
 // Normalize the saved full Mega asset tables, keeping the fund-specific visible date.
 for(const source of records.filter(r=>/^mega-detail-id-/.test(r.id)&&r.path)){
  const html=read(source.id);if(typeof html!=='string')continue;
  const text=u.text(html),codes=[...new Set([...text.matchAll(/\b(0\d{3,5}[A-Z]?)\s+TT Equity\b/g)].map(m=>m[1]))];if(codes.length!==1)continue;
  const r=byTicker.get(codes[0]);if(!r||!/兆豐/.test(r.identity.issuer))continue;
  const section=html.slice(html.indexOf('<h2 class="unit-title">持股比重'));
  const date=u.date(u.text(section).match(/資料來源：兆豐投信，(\d{4}\/\d{2}\/\d{2})/)?.[1]);
  const groups=[];
  for(const match of section.matchAll(/<div id="fund_content_list_(\d+)"[\s\S]*?(?=<div id="fund_content_list_|<div style="display: none;" id="fund-content-|<a name=|$)/g)){
   const chunk=match[0],headers=[...chunk.matchAll(/<div class="filed-name[^\"]*">([^<]+)<\/div>/g)].map(m=>u.text(m[1]));
   const rows=[...chunk.matchAll(/<div class="fund-info content-list-\d+">([\s\S]*?)<\/div>\s*<\/div>/g)].map(m=>[...m[1].matchAll(/<div class="fund-content[^\"]*">([\s\S]*?)(?:<\/div>|$)/g)].map(c=>u.text(c[1])));
   const type=/債券|債劵|面額/.test(headers.join(' '))?'bond':/期貨|口數/.test(headers.join(' '))?'future':/股票/.test(headers.join(' '))?'stock':'other',w=headers.findIndex(x=>/權重|比重|比例/.test(x)),q=headers.findIndex(x=>/股數|面額|口數/.test(x));
   groups.push({type,items:rows.filter(row=>row.length===headers.length&&row[0]).map(row=>({code:row[0],name:row[1],quantity:q<0?null:u.number(row[q]),weight:w<0?null:u.number(row[w])}))});
  }
  r.assetSnapshot={date,dateVerifiedForGroups:true,nav:null,navDate:date,groups,coverage:'all desktop full fund_content_list groups',fullAssetReconciliation:false};add(r,source.id,date,'fund-specific visible 持股比重 date');
 }
 return ref;
}
module.exports={collectMore,normalizeMore,firstgoldFunds};
