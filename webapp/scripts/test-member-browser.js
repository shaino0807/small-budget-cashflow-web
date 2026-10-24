const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {spawn}=require('child_process');
module.exports=async function browserCheck({base,sessions,aliceId,store,adminId,legacy}) {
 const chrome=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);if(!chrome)throw Error('找不到瀏覽器');
 const debugPort=9500+Math.floor(Math.random()*300),dir=fs.mkdtempSync(path.join(os.tmpdir(),'cashflow-member-browser-'));
 const chromeProcess=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${dir}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let ws;const pending=new Map();let seq=0;const errors=[];let checks=0;
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 async function send(method,params={}) {const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},20000);pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject});ws.send(JSON.stringify({id,method,params}));});}
 async function value(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
 async function until(expression){for(let i=0;i<100;i++){if(await value(expression))return;await wait(150);}throw Error('瀏覽器等待逾時：'+expression);}
 const evidence=path.resolve(__dirname,'../../../../.agent-system/evidence/member-access-20261024');fs.mkdirSync(evidence,{recursive:true});
 async function shot(name){const r=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(r.data,'base64'));}
 async function open(index,width=1366,height=900){await send('Network.clearBrowserCookies');if(index!=null)await send('Network.setCookie',{name:'__Host-cashflow_session',value:sessions[index].token,url:base,secure:true,httpOnly:true,sameSite:'Lax',path:'/'});await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<640});await send('Page.navigate',{url:base+'/?member-test='+Date.now()});await until('document.body?.dataset.appReady === "true"');}
 try{
  let target;for(let i=0;i<100;i++){try{target=(await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(t=>t.type==='page');if(target)break;}catch{}await wait(150);}assert.ok(target,'Chrome did not start');
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);};
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await open(null,390,844);assert.equal(await value('document.querySelector("#memberAuthGate").hidden'),false);checks++;
  await value('document.querySelector("#exampleReportBtn").click()');await until('document.querySelector("#exampleReportDialog").open');await shot('guest-example-mobile');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  assert.equal(await value('document.querySelector("#exampleReportDialog").open'),false);checks++;
  await open(0);await until('authState.authenticated && memberAccess.role === "admin"');
  await value('document.querySelector(".admin-tab").click();document.querySelector("#loadAdminBtn").click()');await until('document.querySelectorAll("[data-member-id]").length > 0');
  await value('document.querySelector("#memberAccessReason").value="瀏覽器測試開通";document.querySelector(\'[data-member-id="'+aliceId+'"]\').click()');
  await until('document.querySelector(\'[data-member-id="'+aliceId+'"]\')?.dataset.active === "false"');assert.ok(store.memberAccess(aliceId).fullReport);checks++;await shot('admin-desktop');
  const contrast=await value(`(()=>{
    const rgb=s=>s.match(/[\\d.]+/g).map(Number),lum=c=>c.slice(0,3).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
    return ['#adminTitle','#memberSearch','#memberAccessReason','#memberAdminList button','#loadAdminBtn'].map(selector=>{
      const e=document.querySelector(selector),s=getComputedStyle(e);let n=e,bg;
      while(n){const c=rgb(getComputedStyle(n).backgroundColor);if(c.length<4||c[3]===1){bg=c;break;}n=n.parentElement;}
      bg ||= [255,255,255];const a=lum(rgb(s.color)),b=lum(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
      return {selector,ratio,threshold:parseFloat(s.fontSize)>=24?3:4.5};
    });})()`);
  assert.ok(contrast.every(c=>c.ratio>=c.threshold),JSON.stringify(contrast));checks++;
  await value('document.querySelector("#memberSearch").focus()');await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert.equal(await value('document.activeElement.id'),'memberAccessReason');assert.notEqual(await value('getComputedStyle(document.activeElement).outlineStyle'),'none');checks++;
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await shot('admin-mobile');
  await open(1,390,844);await until('memberAccess.fullReport && premiumData !== null');await value('document.querySelector(\'[data-view="paidReportView"]\').click()');await until('document.querySelector("#paidReport").textContent.includes("配息壓力測試")');checks++;
  const size=await value('({scroll:document.documentElement.scrollWidth,width:document.documentElement.clientWidth})');assert.ok(size.scroll<=size.width+1,JSON.stringify(size));checks++;await shot('paid-mobile');
  await value('Array.from(document.querySelectorAll("#paidReport h3")).find(e=>e.textContent==="配息壓力測試").scrollIntoView({block:"start"})');await shot('paid-stress-mobile');
  store.setMemberAccess(adminId,aliceId,false,'瀏覽器測試撤銷');await value('refreshMemberAccess()');await until('!memberAccess.fullReport && premiumData === null');assert.ok(!(await value('document.querySelector("#paidReport").textContent')).includes('下修 30%'));checks++;
  await value('goTo("dashboardView")');await shot('revoked-free-mobile');
  await value('document.querySelector("#legacyReportId").value='+JSON.stringify(legacy.id)+';document.querySelector("#legacyAccessCode").value='+JSON.stringify(legacy.accessCode)+';document.querySelector("#claimLegacyBtn").click()');
  await until('state.reportMeta?.reportId === '+JSON.stringify(legacy.id)+' && document.querySelector("#legacyAccessCode").value === ""');assert.equal(store.memberAccess(aliceId).fullReport,false);checks++;
  await send('Accessibility.enable');const ax=await send('Accessibility.getFullAXTree');assert.ok(ax.nodes.some(n=>n.role?.value==='button'));checks++;
  await value('document.querySelector("#exampleReportBtn").focus()');assert.equal(await value('document.activeElement.id'),'exampleReportBtn');checks++;
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(evidence,'browser-result.json'),JSON.stringify({ok:true,checks,errors,contrast,viewports:[[1366,900],[390,844]],limitations:'Headless local browser; scoped keyboard, contrast, focus and accessibility-tree checks; not physical phone, human screen reader or public deployment'},null,2));
  console.log(JSON.stringify({browser:true,checks,errors:errors.length}));
 } finally {if(ws)ws.close();chromeProcess.kill();}
};
