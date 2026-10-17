const u=require('./official-text');
const corrections=require('./official-payout-corrections.json');
function amendExchangePayments(rows,ref,client,asOf){
 const applied=[],receipts=client.records();
 const result=rows.map(row=>{
  for(const rule of corrections){
   if(!rule.tickers.includes(ref.ticker)||!new RegExp(rule.issuerPattern).test(ref.identity.issuer)||asOf<rule.announcementDate||row.exDate!==rule.exDate||row.payDate!==rule.originalPayDate)continue;
   const receipt=receipts.find(r=>r.id===rule.id),raw=client.read(rule.id);
   if(receipt?.status!==200||receipt.url!==rule.sourceUrl||!receipt.path||!receipt.sha256||typeof raw!=='string')continue;
   // Restrict proof to the announcement content, excluding navigation/scripts.
   const table=u.tables(raw).find(t=>t.some(r=>r[0]==='說明'));
   const explanation=table?.find(r=>r[0]==='說明')?.[1];
   const announcement=table?.find(r=>r.includes('發言日期'));
   const dateIndex=announcement?.indexOf('發言日期');
   if(!explanation||dateIndex<0||u.date(announcement?.[dateIndex+1])!==rule.announcementDate)continue;
   const compact=explanation.replace(/\s+/g,'');
   if(!rule.requiredText.every(s=>compact.includes(s))||!rule.tickers.every(t=>new RegExp('證券代號[：:]'+t+'(?:[)）]|\\b)').test(explanation.replace(/\s+/g,''))))continue;
   const proof={sourceId:rule.id,sourceUrl:rule.sourceUrl,sourceSha256:receipt.sha256,announcementDate:rule.announcementDate,
    exDate:row.exDate,originalPayDate:row.payDate,correctedPayDate:rule.correctedPayDate,amount:row.amount,basis:'issuer amendment filed on TWSE; original aggregate record retained'};
   applied.push(proof);
   return {...row,payDate:rule.correctedPayDate,originalPayDate:row.payDate,officialCorrection:proof};
  }
  return row;
 });
 return {rows:result,applied};
}
module.exports={amendExchangePayments,corrections};
