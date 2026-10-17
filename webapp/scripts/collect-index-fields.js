const u=require('./official-text');
const providerLabels=new Set(['指數編製公司','指數編製機構','指數編製機關','標的指數編製公司']);
function labelledPairs(html){
 if(typeof html!=='string')return [];
 const pairs=u.tables(html).flat().filter(row=>row.length===2);
 for(const li of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)){
  const values=[...li[1].matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m=>u.text(m[1]));if(values.length===2)pairs.push(values);
 }
 return pairs;
}
async function collectIndexFields(c,db){
 for(const e of db.etfs.filter(e=>/富邦/.test(e.issuer))){
  const profile=c.read('fubon-profile-'+e.ticker);if(typeof profile!=='string')continue;
  const link=[...profile.matchAll(/href=["']([^"']+IndexIntro\.aspx\?stkId=[^"']+)["']/gi)].map(m=>u.decode(m[1])).find(s=>{try{return new URL(s,'https://websys.fsit.com.tw').searchParams.get('stkId')===e.ticker}catch{return false}});
  if(!link)continue;
  await c.get('fubon-index-'+e.ticker,new URL(link,'https://websys.fsit.com.tw').toString());await c.sleep(300);
 }
}
function normalizeIndexFields(ref,c){
 for(const r of ref.items){
  const details=r.profile.issuerDetails||{};
  const direct=Object.entries(details).find(([label,value])=>providerLabels.has(label)&&typeof value==='string'&&u.text(value));
  if(direct){r.profile.indexProvider=u.text(direct[1]);r.profile.indexProviderField=direct[0];}
  const ids=[...r.sourceRefs.map(s=>s.id),'fubon-index-'+r.ticker];
  for(const id of ids){const html=c.read(id);
   if(id.startsWith('fubon-index-')){
    const identities=typeof html==='string'?[...new Set([...html.matchAll(/>\s*(0\d{3,5}[A-Z]?)\s*\//g)].map(m=>m[1]))]:[];
    if(identities.length!==1||identities[0]!==r.ticker)continue;
   }
   const entry=labelledPairs(html).find(([label,value])=>providerLabels.has(u.text(label))&&u.text(value));
   if(!entry)continue;r.profile.indexProvider=u.text(entry[1]);r.profile.indexProviderField=u.text(entry[0]);
   r.profile.indexProviderSourceId=id;
   if(!r.sourceRefs.some(s=>s.id===id))r.sourceRefs.push({id,dataDate:null,dateBasis:'explicit index-provider label; observation time is not an effective version date'});
   break;
  }
 }
 return ref;
}
module.exports={collectIndexFields,normalizeIndexFields,labelledPairs};
