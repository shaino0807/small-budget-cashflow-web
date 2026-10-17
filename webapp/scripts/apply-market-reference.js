const {isoDate,trailingYield}=require('../etf-data');
const u=require('./official-text');
const {amendExchangePayments}=require('./payout-corrections');
const validDate=(d,asOf)=>isoDate(d)&&d<=asOf;
const merge=(old,rows,key)=>[...new Map([...old,...rows].map(r=>[key(r),r])).values()];
function applyMarketReference(db,{reference,receipts,read},{observedAt=new Date().toISOString()}={}) {
 const asOf=reference.asOf,receipt=new Map(receipts.map(r=>[r.id,r]));
 db.holdings||={items:[]};db.priceSeries||={items:[]};db.navSeries||={items:[]};db.distributions||=[];
 if(reference.priceHistory){db.priceSeries.items=merge(db.priceSeries.items||[],reference.priceHistory.items,r=>r.ticker+':'+r.date);db.priceSeries.sessions=reference.priceHistory.sessions;}
 db.holdingsCoverage||={};db.distributionHistory||={};
 const previousSplits=new Map((db.splits||[]).map(s=>[s.ticker+':'+s.date,s]));
 db.splits=merge(db.splits||[],(reference.splits||[]).map(s=>s.ratio>0?s:previousSplits.get(s.ticker+':'+s.date)?.ratio>0?{...previousSplits.get(s.ticker+':'+s.date),refreshStatus:'preserved_previous_proof'}:s),s=>s.ticker+':'+s.date);
 if(reference.splitCoverage)db.splitCoverage=reference.splitCoverage;
 const stocks=new Map((db.stocks?.items||[]).map(s=>[s.ticker,s]));
 const checks=[];
 for(const ref of reference.items){
  const etf=db.etfs.find(e=>e.ticker===ref.ticker);if(!etf)continue;
  etf.listingStatus=etf.listingDate&&etf.listingDate>asOf?'upcoming':'listed';
  const sources=ref.sourceRefs.map(s=>({...s,url:receipt.get(s.id)?.url,sha256:receipt.get(s.id)?.sha256,observedAt:receipt.get(s.id)?.retrievedAt})).filter(s=>s.sha256);
  const profile=ref.profile,basic=profile.basicRaw;
  if(profile.fullName)etf.fundName=basic?.['基金中文名稱']||profile.fullName;
  etf.currency=['TWD','USD','CNY','JPY','HKD','EUR'].includes(profile.currency)?profile.currency:etf.currency||null;
  etf.profileSourceDate=basic?u.date(basic['出表日期']):null;
  etf.profileObservedAt=sources.filter(s=>/basic|profile|info|detail|product|yuanta/.test(s.id)).map(s=>s.observedAt).filter(Boolean).sort().at(-1)||etf.profileObservedAt||null;
  etf.indexName=basic?.['標的指數/追蹤指數名稱']||profile.indexName||etf.indexName||null;
  etf.indexProvider=profile.indexProvider||etf.indexProvider||null;
  etf.managerType=profile.active?'主動式ETF':etf.managerType;
  etf.benchmark=basic?.['績效指標中文名稱']||profile.benchmark||null;
  etf.benchmarkStatus=basic?.['是否設有績效指標']==='否'?'official_explicit_none':etf.benchmark?'official_field':'not_verified';
  etf.indexStatus=profile.active?'not_applicable_active':etf.indexName&&!/^(無|不適用)$/.test(etf.indexName)?'official_field':'not_verified';
  etf.profileEvidence=sources.filter(s=>/basic|profile|info|introduce|detail|product|yuanta/.test(s.id));
  if(ref.price?.close>0&&validDate(ref.price.date,asOf)){
   const row={ticker:etf.ticker,date:ref.price.date,close:ref.price.close,currency:etf.currency,
    source:ref.market==='TWSE'?'twse-stock-day-all':'tpex-mainboard-daily-close-quotes',
    sourceUrl:receipt.get(ref.market==='TWSE'?'twse-daily':'tpex-daily')?.url};
   const existing=(db.priceSeries.items||[]).find(p=>p.ticker===row.ticker&&p.date===row.date);
   db.priceSeries.items=merge(db.priceSeries.items,[{...existing,...row}],r=>r.ticker+':'+r.date);
   etf.close=row.close;
  }
  const a=ref.assetSnapshot;
  if(a?.aum!=null&&etf.currency&&validDate(a.navDate,asOf))etf.fundAum={value:a.aum,currency:etf.currency,asOfDate:a.navDate};
  const assetSource=sources.find(s=>/assets|portfolio|yuanta-|fubon-0|pcf|mega-detail|taishin-detail|capital-detail/.test(s.id));
  let date=a?.date,dated=a?.dateVerifiedForGroups;
  let dateBasis=dated?'official_position_date':'position_date_not_independently_declared';
  // PCF effective dates can be the next dealing day, not the position date.
  // Preserve them separately instead of presenting a future announcement as holdings.
  if(a&&/元大/.test(etf.issuer)){
   const html=read('yuanta-'+etf.ticker);
   if(typeof html==='string'){
    const text=u.text(html),dates=[...text.matchAll(/基金權重[^:：]{0,40}交易日期[:：]\s*(\d{4}\/\d{2}\/\d{2})/g)].map(m=>u.date(m[1]));
    if(dates.length&&new Set(dates).size===1){date=dates[0];dated=true;dateBasis='official_position_date';}
   }
  }
  const rows=[];let invalid=0;
  if(a&&(!dated||validDate(date,asOf))){
   for(const group of a.groups||[])for(const [position,holding] of (group.items||[]).entries()){
    if(a.positionDatesVerified&&holding.date&&!validDate(holding.date,asOf)){invalid++;continue;}
    const derivative=['future','option','buy','cash','other'].includes(group.type);
    const unweighted=['cash','other','fund','repo'].includes(group.type)&&holding.weight===null&&(Number.isFinite(holding.value)||Number.isFinite(holding.cost));
    const code=holding.code||(['cash','other'].includes(group.type)?holding.name:null);
    if(!code||!holding.name||!unweighted&&(!Number.isFinite(holding.weight)||!derivative&&(holding.weight<0||holding.weight>100))){invalid++;continue;}
    const comparable=n=>u.name(n).replace(/股份有限公司$/,'').replace(/金融控股$/,'金控');
    const stock=stocks.get(code),sameName=stock&&[stock.name,stock.shortName,stock.fullName].filter(Boolean).some(n=>comparable(n)===comparable(holding.name));
    const positionDate=a.positionDatesVerified&&validDate(holding.date,asOf)?holding.date:dated?date:null;
    rows.push({ticker:etf.ticker,holdingTicker:code,positionId:[group.type,code,holding.currency||'',position].join(':'),holdingName:holding.name,weight:holding.weight,
      shares:group.type==='stock'?holding.quantity:null,quantity:holding.quantity,assetType:group.type,
      quantityUnit:group.type==='stock'?'股':group.type==='bond'?'面額':group.type==='future'?'口':null,
      marketValue:holding.value??null,
      purchaseCost:holding.cost??null,valueBasis:holding.valueBasis||null,
      sector:group.type==='stock'&&sameName?stock.industry||stock.sector||null:null,
      asOfDate:positionDate,effectiveDate:a.effectiveDate||null,valuationDate:a.navDate||null,
      dateStatus:positionDate?(dated?dateBasis:'official_individual_position_date'):'official_position_date_not_declared',
      observedAt:assetSource?.observedAt||null,currency:holding.currency||null,source:'issuer-official-full-published-positions',
      sourceUrl:assetSource?.url||etf.sourceUrl});
   }
   const unique=new Set(rows.map(r=>r.positionId));
   if(rows.length&&invalid===0&&unique.size===rows.length){
    const oldDate=(db.holdings.items||[]).filter(r=>r.ticker===etf.ticker).map(r=>r.asOfDate).sort().at(-1);
    const allDated=rows.every(r=>r.asOfDate),newest=rows.map(r=>r.asOfDate).filter(Boolean).sort().at(-1);
    if(!oldDate||allDated&&newest>=oldDate){db.holdings.items=db.holdings.items.filter(r=>r.ticker!==etf.ticker).concat(rows);
     db.holdingsCoverage[etf.ticker]={complete:false,publishedPositionsRead:true,rows:rows.length,asOfDate:dated?date:null,dateBasis,
       positionDateFrom:allDated?rows.map(r=>r.asOfDate).sort()[0]:null,positionDateTo:allDated?newest:null,
       fullAssetReconciliation:false,coverage:a.coverage,portfolioParent:a.portfolioParent||null,
       status:'published_positions_loaded_reconciliation_pending',
       sourceUrl:rows[0].sourceUrl};}
   }
  }
  if(a?.nav>0&&validDate(a.navDate,asOf)&&etf.currency){
   const price=(db.priceSeries.items||[]).find(r=>r.ticker===etf.ticker&&r.date===a.navDate&&r.currency===etf.currency);
   db.navSeries.items=merge(db.navSeries.items,[{ticker:etf.ticker,date:a.navDate,nav:a.nav,currency:etf.currency,close:price?.close||null,
     premiumDiscountPercent:price?Number(((price.close/a.nav-1)*100).toFixed(4)):null,
     source:'issuer-official-nav',sourceUrl:assetSource?.url||etf.sourceUrl}],r=>r.ticker+':'+r.date);
  }
  const h=ref.history;
  // A recent-only exchange response cannot resolve an older recorded conflict.
  const previousHistory=db.distributionHistory[etf.ticker];
  // Revalidate recorded resolutions on every refresh. A recent-only response
  // must neither erase old conflicts nor lose their amendment provenance.
  const priorConflicts=[...new Map([...(previousHistory?.conflicts||[]),...(previousHistory?.resolvedConflicts||[]).map(r=>r.priorConflict)]
   .map(c=>[c.exDate+':'+(c.reason||'values'),c])).values()];
  const resolvedConflicts=[],unresolvedPrior=[];
  for(const prior of priorConflicts){
   const old=prior.exchange&&{...prior.exchange,exDate:prior.exDate};
   const amendment=old&&amendExchangePayments([old],ref,{read,records:()=>receipts},asOf);
   const changed=amendment?.applied?.[0],matched=changed&&h?.identityVerified===true&&h.rows?.some(r=>r.exDate===prior.exDate&&r.payDate===changed.correctedPayDate&&Math.abs(r.amount-old.amount)<=1e-8&&!r.estimated);
   if(matched){
    resolvedConflicts.push({priorConflict:prior,proof:changed});
    if(ref.payoutCrossCheck&&!ref.payoutCrossCheck.officialCorrections?.some(p=>p.sourceId===changed.sourceId&&p.exDate===changed.exDate)){
     (ref.payoutCrossCheck.officialCorrections||=[]).push(changed);
    }
    if(!sources.some(s=>s.id===changed.sourceId)){
     const r=receipt.get(changed.sourceId),s={id:r.id,url:r.url,sha256:r.sha256,observedAt:r.retrievedAt,dataDate:changed.announcementDate,dateBasis:'explicit payout amendment resolving a recorded conflict'};
     sources.push(s);ref.sourceRefs.push(s);
    }
   }else unresolvedPrior.push(prior);
  }
  if(h&&ref.payoutCrossCheck?.completeWindow!==true&&unresolvedPrior.length){
   h.conflicts=[...new Map([...unresolvedPrior,...(h.conflicts||[])].map(c=>[c.exDate+':'+(c.reason||'values'),c])).values()];
   h.independentlyReconciled=false;
  }
  const historySource=sources.find(s=>s.id===h?.sourceId)||sources.find(s=>/dividend|history/.test(s.id))||sources.find(s=>/profile|yuanta|sinopac-list|firstgold-catalog/.test(s.id));
  if(h?.comparisonPerformed&&h.conflicts?.length)db.distributionHistory[etf.ticker]={...db.distributionHistory[etf.ticker],acceptance:'conflict',conflicts:h.conflicts};
  if(h?.identityVerified&&h.completeWindow&&historySource&&etf.currency){
   const historyRows=(h.rows||[]).filter(r=>isoDate(r.payDate)&&isoDate(r.exDate)&&r.amount>0||!(r.payDate>asOf||r.exDate>asOf));
   const valid=historyRows.every(r=>isoDate(r.payDate)&&isoDate(r.exDate)&&r.amount>0&&!r.estimated&&(!r.currency||r.currency===etf.currency));
   const events=new Map();let conflict=false;
   for(const r of historyRows){const key=r.exDate,prior=events.get(key);if(prior&&(prior.payDate!==r.payDate||Math.abs(prior.amount-r.amount)>1e-8))conflict=true;events.set(key,r);}
   if((h.nonDistributing===true&&!events.size||h.nonDistributing!==true&&valid&&(events.size||h.confirmedEmpty))&&!conflict){
    const distributions=[...events.values()].map(r=>({ticker:etf.ticker,payDate:r.payDate,exDividendDate:r.exDate,
      amountPerUnit:r.amount,currency:etf.currency,source:h.sourceKind==='exchange'?'exchange-official-distribution-history':'issuer-official-distribution-history',sourceUrl:historySource.url}));
    db.distributions=db.distributions.filter(r=>r.ticker!==etf.ticker).concat(distributions);
    db.distributionHistory[etf.ticker]={complete:true,nonDistributing:!!h.nonDistributing,from:h.windowFrom||'1900-01-01',to:asOf,
      currency:etf.currency,updatedAt:historySource.observedAt||null,sourceUrl:historySource.url,coverageBasis:h.coverageBasis,
      acceptance:h.conflicts?.length?'conflict':h.independentlyReconciled?'independent_window_matched':'single_source',conflicts:h.conflicts||[],
      independentCrossSourceVerified:!!h.independentlyReconciled,officialCorrections:ref.payoutCrossCheck?.officialCorrections||[],resolvedConflicts};
   }
  }
  const yieldResult=trailingYield(db,etf.ticker,asOf);
  const currentHoldings=db.holdingsCoverage[etf.ticker];
  etf.qualityFlags=(etf.qualityFlags||[]).filter(flag=>!['holdings_missing','holdings_partial','price_series_missing','nav_series_missing'].includes(flag));
  const holdingRows=db.holdings.items.filter(r=>r.ticker===etf.ticker).length;
  if(!holdingRows)etf.qualityFlags.push('holdings_missing');
  else if(!currentHoldings?.complete)etf.qualityFlags.push('holdings_partial');
  if(!db.priceSeries.items.some(r=>r.ticker===etf.ticker))etf.qualityFlags.push('price_series_missing');
  if(!db.navSeries.items.some(r=>r.ticker===etf.ticker))etf.qualityFlags.push('nav_series_missing');
  checks.push({ticker:etf.ticker,issuer:etf.issuer,profile:etf.fundName&&etf.currency?'official_fields_loaded':'pending',
    index:etf.indexStatus,provider:etf.indexProvider?'official_field':'pending',
    holdings:currentHoldings?.publishedPositionsRead?'positions_loaded_acceptance_pending':currentHoldings?.complete?'previously_accepted':'pending',
    holdingsRows:holdingRows,
    holdingsDate:currentHoldings?.asOfDate||null,invalidHoldingRows:invalid,
    yield:yieldResult.status,yieldValue:yieldResult.value,yieldPriceDate:yieldResult.priceDate,
    historyIndependent:!!db.distributionHistory[etf.ticker]?.independentCrossSourceVerified,
    sourceRefs:sources});
 }
 const currencies=new Map(db.etfs.map(e=>[e.ticker,e.currency]));
 for(const row of db.priceSeries.items||[])if(!row.currency&&currencies.get(row.ticker))row.currency=currencies.get(row.ticker);
 db.marketCoverage={asOf,checkedAt:observedAt,population:db.etfs.length,items:checks,
   status:'partial_acceptance',notVerified:['all-fund asset reconciliation','all index-provider/version changes','full independent distribution-window reconciliation']};
 db.holdings.status='official_published_positions_with_explicit_acceptance_gaps';
 db.holdings.updatedAt=observedAt;db.navSeries.updatedAt=observedAt;
 db.metadata.sources=merge(db.metadata.sources||[],[{id:'official-full-market',name:'交易所與各發行投信官方來源',url:'https://www.twse.com.tw/zh/ETFortune/products',usage:'逐檔來源及涵蓋狀態見 marketCoverage'}],r=>r.id);
 return db;
}
module.exports={applyMarketReference};
