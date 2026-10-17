// Compact public catalog: portfolios and full histories are fetched per selected ETF.
function latestPerTicker(rows=[]) {
 const map=new Map();for(const row of rows)if(!map.has(row.ticker)||row.date>map.get(row.ticker).date)map.set(row.ticker,row);
 return [...map.values()];
}
function marketCatalog(db) {
 const {today,financialAsOf,trailingYield}=require('./etf-data'),asOf=financialAsOf(db);
 return {metadata:db.metadata,etfs:(db.etfs||[]).map(({profileEvidence,...etf})=>etf),etfMaster:{status:db.etfMaster?.status,observedAt:db.etfMaster?.observedAt},classificationRules:db.classificationRules,
   priceSeries:{status:db.priceSeries?.status,items:latestPerTicker(db.priceSeries?.items)},
   navSeries:{status:db.navSeries?.status,items:latestPerTicker(db.navSeries?.items)},
   holdings:{status:'load_per_selected_etf',items:[]},distributionHistory:{},distributions:[],
   datasetCounts:{etfs:db.etfs?.length||0,stocks:db.stocks?.items?.length||0,holdings:db.holdings?.items?.length||0,distributions:db.distributions?.length||0,priceSeries:db.priceSeries?.items?.length||0,navSeries:db.navSeries?.items?.length||0},
   yieldSummaries:Object.fromEntries((db.etfs||[]).map(e=>[e.ticker,{...trailingYield(db,e.ticker,asOf),asOf,requestedAsOf:today()}])),
   splits:db.splits||[],holdingsCoverage:db.holdingsCoverage||{},
   stocks:{status:db.stocks?.status,items:(db.stocks?.items||[]).map(s=>({ticker:s.ticker,name:s.name,shortName:s.shortName,industry:s.industry,sector:s.sector,latestPrice:s.latestPrice?{close:s.latestPrice.close,date:s.latestPrice.date}:null}))},
   marketCoverage:db.marketCoverage?{asOf:db.marketCoverage.asOf,population:db.marketCoverage.population,status:db.marketCoverage.status,notVerified:db.marketCoverage.notVerified}:null};
}
module.exports={marketCatalog};
