const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const assert=require('node:assert/strict'),{test}=require('node:test');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function implementation(name){
  const start=source.search(new RegExp('(?:async )?function '+name+'\\('));
  assert.ok(start>=0,name);
  const next=source.slice(start+1).search(/\n(?:async )?function /);
  return source.slice(start,next<0?undefined:start+1+next);
}
function fixture(){
  const nodes=new Map(),moves=[],messages=[];
  const node=key=>{if(!nodes.has(key))nodes.set(key,{id:key,hidden:false,textContent:'',classList:{toggle(){}},setAttribute(){},removeAttribute(){},focus(){}});return nodes.get(key);};
  const context={URL,URLSearchParams,AbortSignal,console,clearTimeout,setTimeout,Promise,
    authState:{authenticated:true,user:{id:'local-admin',onboardingCompleted:true}},
    memberAccess:{role:'admin',fullReport:true,status:'free'},accessRequest:null,accessUnavailable:false,
    premiumData:{report:true},premiumSignature:'old',premiumEpoch:0,premiumError:'',premiumFailedSignature:'',premiumTimer:null,premiumBusy:false,portfolioRuntime:null,
    navigationSequence:0,state:{paidUnlocked:true,profile:{},holdings:[],monthlyCashflows:{},simulationYears:20},
    activeView:'adminView',activeMemberNav:'',activeWorkspaceSection:'',viewSessionKey:'view',memberNavSessionKey:'nav',workspaceSectionSessionKey:'section',
    premiumViews:['paidReportView','simulationView','calendarView'],availableViews:['landingView','dashboardView','freeReportView','adminView','paidReportView','upgradeView','inputView','simulationView','calendarView'],memberNavItems:[],
    location:{href:'https://example.test/?view=adminView'},history:{},sessionStorage:{setItem(){}},
    document:{querySelectorAll(){return[];},querySelector(s){return s==='.view.is-active'?{id:context.activeView}:node(s);}},
    q:node,showToast:m=>messages.push(m),refreshMemberAuthUi(){},refreshReports(){},applyEntitlements(){context.state.paidUnlocked=context.memberAccess.fullReport;},
    memberNavForLocation(){return '';},syncWorkspaceTabs(){},syncMemberBottomNav(){},
    window:{scrollTo(){},matchMedia(){return {matches:true};}},escapeHtml:s=>s,
    apiRequest:async()=>({access:{role:'admin',fullReport:true,status:'free'}})
  };
  for(const method of ['pushState','replaceState'])context.history[method]=(_,__,url)=>{moves.push(method);context.location.href=String(url);};
  vm.createContext(context);
  for(const name of ['clearPremium','refreshMemberAccess','schedulePremium','syncViewUrl','goTo','reportUpgradeCtaHtml','premiumPlaceholderHtml'])vm.runInContext(implementation(name),context);
  return {c:context,nodes,moves,messages};
}
test('admin can go home then full report; URL follows the actual view',async()=>{
  const {c,moves}=fixture();await c.goTo('landingView');assert.equal(c.activeView,'dashboardView');
  await c.goTo('paidReportView');assert.equal(c.activeView,'paidReportView');assert.match(c.location.href,/view=paidReportView/);
  await c.goTo('adminView');assert.equal(c.activeView,'adminView');assert.equal(moves.length,3);
  await c.goTo('adminView');assert.equal(moves.length,3,'same-view clicks must not add history');
  await c.goTo('paidReportView','','',{historyMode:'replace'});assert.equal(moves.at(-1),'replaceState');
});
test('latest navigation wins while access is slow; concurrent checks share a request',async()=>{
  const {c}=fixture();let resolve,calls=0;c.apiRequest=()=>{calls++;return new Promise(r=>{resolve=r;});};
  const paid=c.goTo('paidReportView'),admin=c.goTo('adminView');await c.goTo('dashboardView');
  resolve({access:{role:'admin',fullReport:true}});await Promise.all([paid,admin]);assert.equal(calls,1);assert.equal(c.activeView,'dashboardView');
});
test('503 keeps identity, clears private data and offers retry without an upgrade redirect',async()=>{
  const {c}=fixture();c.apiRequest=async()=>{throw Object.assign(Error('unavailable'),{status:503});};
  await c.goTo('paidReportView');assert.equal(c.memberAccess.role,'admin');assert.equal(c.memberAccess.fullReport,true);
  assert.equal(c.premiumData,null);assert.equal(c.activeView,'adminView');assert.equal(c.q('#memberAccessNotice').hidden,false);
  assert.match(c.premiumPlaceholderHtml(),/重新載入完整報告/);assert.doesNotMatch(c.premiumPlaceholderHtml(),/查看開通方式/);
  c.apiRequest=async()=>({access:{role:'admin',fullReport:true}});await c.goTo('paidReportView');assert.equal(c.activeView,'paidReportView');
});
test('confirmed free members cannot enter admin or full report',async()=>{
  const {c}=fixture();c.apiRequest=async()=>({access:{role:'member',fullReport:false,status:'free'}});
  await c.goTo('adminView');assert.equal(c.activeView,'dashboardView');await c.goTo('paidReportView');assert.equal(c.activeView,'upgradeView');assert.equal(c.premiumData,null);
});
test('expired login clears role and routes to sign in',async()=>{
  const {c}=fixture();c.apiRequest=async()=>{throw Object.assign(Error('expired'),{status:401});};
  await c.goTo('adminView');assert.equal(c.activeView,'landingView');assert.equal(c.authState.authenticated,false);assert.equal(c.memberAccess.fullReport,false);
});
test('paid CTA opens full report; loading never asks an entitled member to buy again',()=>{
  const {c}=fixture();assert.match(c.reportUpgradeCtaHtml(),/data-goto="paidReportView"/);assert.match(c.premiumPlaceholderHtml(),/正在載入完整報告/);
  assert.doesNotMatch(c.premiumPlaceholderHtml(),/查看開通方式/);c.state.paidUnlocked=false;assert.match(c.reportUpgradeCtaHtml(),/data-goto="upgradeView"/);
});
test('failed premium request does not revoke access or retry forever',async()=>{
  const {c}=fixture();let callback,calls=0;c.setTimeout=fn=>{callback=fn;return 1;};c.clearTimeout=()=>{};
  c.apiRequest=async()=>{calls++;throw Object.assign(Error('timeout'),{status:503});};
  c.schedulePremium();await callback();assert.equal(calls,1);assert.equal(c.memberAccess.fullReport,true);assert.match(c.premiumError,/重試/);
  callback=null;c.schedulePremium();assert.equal(callback,null,'wait for explicit retry for unchanged input');
});
