const u=require('./official-text');
function attribute(tag,key){return tag.match(new RegExp('\\b'+key+'\\s*=\\s*["\']([^"\']*)["\']','i'))?.[1];}
function parseSinopacHistory(html,{shortName,asOf}){
 if(typeof html!=='string')return null;
 const select=[...html.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/gi)].map(m=>m[0]).find(s=>attribute(s.slice(0,s.indexOf('>')+1),'name')==='fundId');
 const selected=select&&[...select.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].find(m=>/\bselected\b/i.test(m[1]));
 const table=u.tables(html).find(t=>t[0].length>=6&&/發放/.test(t[0].join(' ')));
 if(!selected||!table||u.name(selected[2])!==u.name(shortName))return null;
 const head=table[0],pay=head.findIndex(x=>/發放/.test(x)),ex=head.findIndex(x=>/除息/.test(x)),amt=head.findIndex(x=>/每單位/.test(x));
 if(Math.min(pay,ex,amt)<0||!table.slice(1).length||!table.slice(1).every(r=>u.name(r[0])===u.name(shortName)))return null;
 const inputs=[...html.matchAll(/<input\b[^>]*>/gi)].map(m=>m[0]);
 const range=inputs.find(t=>attribute(t,'name')==='hdnTimeRange');
 const allRadio=inputs.find(t=>attribute(t,'name')==='range'&&attribute(t,'value')==='5'&&/\bchecked\b/i.test(t));
 // The URL's range=5 is ignored by GET. Trust the returned form state only.
 const complete=attribute(range||'','value')==='5'&&!!allRadio;
 return {identityVerified:true,completeWindow:complete,windowFrom:complete?'1900-01-01':null,windowTo:asOf,
  rows:table.slice(1).map(r=>({payDate:u.date(r[pay]),exDate:u.date(r[ex]),amount:u.number(r[amt])})),
  coverageBasis:complete?'official response echoes hdnTimeRange=5 and selected 成立以來; same-fund rows':'official recent-only response; full history not verified'};
}
module.exports={parseSinopacHistory};
