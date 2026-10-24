// Real Chromium layout and keyboard checks; public pages only, no customer writes.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const isolated=process.argv[2]==='--serve';
const target=isolated?'http://127.0.0.1:5188/':process.argv[2]||'http://127.0.0.1:5188/';
const output=path.resolve(process.argv[3]||'accessibility-evidence');
const chrome=process.env.CHROME_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 fs.mkdirSync(output,{recursive:true});
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'market-a11y-')),port=9500+Math.floor(Math.random()*300);
 const browser=spawn(chrome,['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'--disable-gpu','--no-sandbox','about:blank'],{windowsHide:true,stdio:'ignore'});
 let ws,server,session;
 if(isolated){
  const crypto=require("crypto"),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),"market-a11y-data-"));
  Object.assign(process.env,{SMOKE_TEST:"1",PORT:"5188",CUSTOMER_DATA_DIR:dataDir,CUSTOMER_DATA_KEY:crypto.randomBytes(32).toString("base64"),ACCESS_CODE_PEPPER:crypto.randomBytes(32).toString("hex"),ADMIN_API_KEY:crypto.randomBytes(32).toString("hex"),LINE_LOGIN_CHANNEL_ID:"isolated-a11y",LINE_LOGIN_CHANNEL_SECRET:crypto.randomBytes(24).toString("hex"),API_PUBLIC_BASE_URL:target,SITE_PUBLIC_BASE_URL:target,LINE_REPLY_DISABLED:"1",LINE_RICH_MENU_AUTO_DEPLOY:"0"});
  const store=require("../customer-store").createStore(),user=store.findOrCreateUserByLineId("Ua11y-member");session=store.createUserSession(user.id).token;store.close();
  server=spawn(process.execPath,[path.join(__dirname,"../server.js")],{env:process.env,windowsHide:true,stdio:"ignore"});
  for(let i=0;i<100;i++){try{if((await fetch(target+"api/health")).ok)break;}catch{}await sleep(100);}
 }
 const results={target,checkedAt:new Date().toISOString(),viewports:[],runtimeErrors:[],limitations:['Chromium emulation, not physical iOS/Android','No human screen-reader or LINE login acceptance']};
 try{
  let tabs;for(let i=0;i<80;i++){try{tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();break;}catch{await sleep(250);}}
  ws=new WebSocket(tabs.find(x=>x.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let id=0;const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')results.runtimeErrors.push(m.params.exceptionDetails.text);};
  const send=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const key=async(key,code=key,vk=9)=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:vk});await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk});};
  await send('Page.enable');await send('Runtime.enable');await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  for(const width of [320,390,1440]){
   await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<640});
   if(session)await send('Network.setCookie',{name:'__Host-cashflow_session',value:session,url:target,secure:true,httpOnly:true,sameSite:'Lax',path:'/'});
   await send('Page.navigate',{url:target});
   for(let i=0;i<120;i++){if(await evaluate('document.body?.dataset.appReady === "true"'))break;await sleep(250);}
   assert.equal(await evaluate('document.body.dataset.appReady'),'true');
   const item={width};
   item.landingOverflow=await evaluate('document.documentElement.scrollWidth-innerWidth');assert.ok(item.landingOverflow<=1);
   await evaluate('document.querySelector("#landingView [data-goto=databaseView]").click()');
   item.headingFocus=await evaluate('document.activeElement.id');assert.equal(item.headingFocus,'databaseTitle');
   await key('Tab');item.firstTab=await evaluate('document.activeElement.id');assert.equal(item.firstTab,'reloadDataBtn');
   item.focusOutline=await evaluate('getComputedStyle(document.activeElement).outlineStyle');assert.notEqual(item.focusOutline,'none');
   await key('Tab');assert.equal(await evaluate('document.activeElement.id'),'priceChartSearch');
   // Enter before the demand-loaded catalog has necessarily resolved; the intent must survive.
   item.catalogPendingAtEarlyInput=await evaluate('!etfDatabase');
   await send('Input.insertText',{text:'0050'});await key('Enter','Enter',13);
   for(let i=0;i<120;i++){if(await evaluate('priceChartTickers.includes("0050")'))break;await sleep(100);}
   assert(await evaluate('priceChartTickers.includes("0050")'),'early input retained until catalog resolves');
   await evaluate('document.querySelector("[data-remove-chart=\\"0050\\"]").click()');
   await send('Input.insertText',{text:'不存在的 ETF'});await key('Enter','Enter',13);
   item.invalidInput=await evaluate('document.querySelector("#priceChartSearch").getAttribute("aria-invalid")');assert.equal(item.invalidInput,'true');
   for(const text of ['0050','元大高股息']){
    await evaluate('document.querySelector("#priceChartSearch").value=""');await send('Input.insertText',{text});await key('Enter','Enter',13);
   }
   for(let i=0;i<100;i++){if(await evaluate('document.querySelectorAll("#priceChartData tbody tr").length>0'))break;await sleep(250);}
   item.chartRows=await evaluate('document.querySelectorAll("#priceChartData tbody tr").length');assert.ok(item.chartRows>0);
   item.selection=await evaluate('Array.from(document.querySelectorAll("[data-remove-chart]")).map(e=>e.dataset.removeChart)');assert.deepEqual(item.selection,['0050','0056']);
   item.overflow=await evaluate('document.documentElement.scrollWidth-innerWidth');assert.ok(item.overflow<=1);
   item.smallTargets=await evaluate('Array.from(document.querySelectorAll("#priceChartControls button,#priceChartControls input,#priceChartControls select,#priceChartSelection button")).filter(e=>e.getBoundingClientRect().height<44).map(e=>e.id)');assert.deepEqual(item.smallTargets,[]);
   item.scrollableTables=await evaluate('Array.from(document.querySelectorAll("#databaseView .table-panel")).every(e=>e.tabIndex===0 && !!e.getAttribute("aria-label"))');assert.equal(item.scrollableTables,true);
   item.reducedMotion=await evaluate('getComputedStyle(document.querySelector("#addPriceChartEtf")).transitionDuration');assert.equal(item.reducedMotion,'0s');
   item.contrast=await evaluate(`(()=>{
    const rgb=s=>s.match(/[\\d.]+/g).map(Number), lum=c=>c.slice(0,3).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
    return ['#databaseTitle','#databaseSummary','#priceChartStatus','#addPriceChartEtf','#priceChartControls label','#dataQuality .metric small'].map(selector=>{
     const e=document.querySelector(selector),s=getComputedStyle(e);let n=e,bg;
     while(n){const c=rgb(getComputedStyle(n).backgroundColor);if(c.length<4||c[3]===1){bg=c;break;}n=n.parentElement;}
     bg ||= [255,255,255];const a=lum(rgb(s.color)),b=lum(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
     return {selector,ratio,threshold:parseFloat(s.fontSize)>=24||(parseFloat(s.fontSize)>=18.66&&Number(s.fontWeight)>=700)?3:4.5};
    });})()`);
   assert.ok(item.contrast.every(x=>x.ratio>=x.threshold),JSON.stringify(item.contrast));
   await evaluate('document.querySelector("#priceChartControls").scrollIntoView({block:"start"})');
   fs.writeFileSync(path.join(output,`market-${width}.png`),Buffer.from((await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));
   await evaluate(`document.querySelector('[data-remove-chart="0056"]').click()`);
   item.removeFocus=await evaluate('document.activeElement.id');assert.equal(item.removeFocus,'priceChartSearch');
   if(width===1440){await evaluate('document.body.style.zoom="2"');item.zoomOverflow=await evaluate('document.documentElement.scrollWidth-innerWidth');item.zoomOffenders=await evaluate('Array.from(document.querySelectorAll("body *")).filter(e=>e.getClientRects().length && e.getBoundingClientRect().right>innerWidth+1 && !e.closest(".table-panel")).slice(0,12).map(e=>({tag:e.tagName,id:e.id,cls:e.className,right:e.getBoundingClientRect().right}))');results.zoomCheck=item;assert.ok(item.zoomOverflow<=1,JSON.stringify(item.zoomOffenders));await evaluate('document.body.style.zoom=""');}
   results.viewports.push(item);
  }
  const ax=await send('Accessibility.getFullAXTree');fs.writeFileSync(path.join(output,'accessibility-tree.json'),JSON.stringify(ax,null,2));
  assert.equal(results.runtimeErrors.length,0);results.passed=true;
 }catch(error){results.passed=false;results.error=error.stack;throw error;}
 finally{fs.writeFileSync(path.join(output,'accessibility.json'),JSON.stringify(results,null,2));ws?.close();browser.kill();server?.kill();}
 console.log(JSON.stringify(results,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
