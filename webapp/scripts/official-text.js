
function decode(s){return String(s??'').replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&(nbsp|amp|lt|gt|quot|apos);/g,(_,n)=>({nbsp:' ',amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[n]));}
function text(s){return decode(String(s??'').replace(/<!--[\s\S]*?-->/g,' ').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();}
function tables(s){s=s.replace(/<!--[\s\S]*?-->/g,'');return [...s.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(m=>[...m[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(r=>[...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c=>text(c[1]))).filter(r=>r.length));}
function number(v){if(v===null||v===undefined||text(v)===''||/^[-—]+$/.test(text(v)))return null;const n=Number(text(v).replace(/[,％%]/g,''));return Number.isFinite(n)?n:null;}
function date(v){
 let s=text(v);
 const asp=s.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/);if(asp){const stamp=new Date(Number(asp[1]));return Number.isFinite(stamp.getTime())?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(stamp):null;}
 if(/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(s)){
  const base=new Date(s.slice(0,10)+'T00:00:00Z'),stamp=new Date(s);
  if(!Number.isFinite(base.getTime())||base.toISOString().slice(0,10)!==s.slice(0,10)||!Number.isFinite(stamp.getTime()))return null;
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(stamp);
 }
 let m=s.match(/^(\d{2,4})[\/年.-](\d{1,2})[\/月.-](\d{1,2})/);if(!m)m=s.match(/^(\d{3}|\d{4})(\d{2})(\d{2})$/);if(!m)return null;
 const y=+m[1]+(m[1].length<=3?1911:0),iso=String(y).padStart(4,'0')+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0'),d=new Date(iso+'T00:00:00Z');
 return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===iso?iso:null;
}
function name(v){return text(v).normalize('NFKC').replace(/臺/g,'台').replace(/\s+/g,'').toLowerCase();}
function listTables(s){s=s.replace(/<!--[\s\S]*?-->/g,'');return [...s.matchAll(/<ul\b[^>]*class="[^"]*list-style-table[^"]*"[^>]*>([\s\S]*?)<\/ul>/gi)].map(m=>[...m[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(r=>[...r[1].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map(c=>text(c[1]))).filter(r=>r.length));}
function csv(s){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<s.length;i++){let c=s[i];if(c==='"'){if(quoted&&s[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(!quoted&&c===','){row.push(cell);cell='';}else if(!quoted&&(c==='\r'||c==='\n')){if(c==='\r'&&s[i+1]==='\n')i++;row.push(cell);if(row.some(Boolean))rows.push(row);row=[];cell='';}else cell+=c;}if(cell||row.length){row.push(cell);rows.push(row);}if(rows[0]?.[0])rows[0][0]=rows[0][0].replace(/^\uFEFF/,'');return rows;}
module.exports={decode,text,tables,listTables,csv,number,date,name};
