const assert=require('node:assert/strict'),crypto=require('crypto'),fs=require('fs'),os=require('os'),path=require('path');
const {spawn}=require('child_process');
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'cashflow-member-access-'));
Object.assign(process.env,{CUSTOMER_DATA_DIR:dataDir,CUSTOMER_DATA_KEY:crypto.randomBytes(32).toString('base64'),ACCESS_CODE_PEPPER:crypto.randomBytes(32).toString('hex'),ADMIN_API_KEY:crypto.randomBytes(32).toString('hex'),SMOKE_TEST:'1',LINE_REPLY_DISABLED:'1',LINE_RICH_MENU_AUTO_DEPLOY:'0'});
const {createStore}=require('../customer-store');
const store=createStore(),admin=store.findOrCreateUserByLineId('U'+'1'.repeat(32)),alice=store.findOrCreateUserByLineId('U'+'2'.repeat(32)),bob=store.findOrCreateUserByLineId('U'+'3'.repeat(32));
const sessions=[admin,alice,bob].map(u=>store.createUserSession(u.id));
store.bootstrapAdmin(admin.id);
assert.throws(()=>store.bootstrapAdmin(bob.id));
assert.throws(()=>store.setMemberAccess(bob.id,alice.id,true,'attack'));
const profile={monthlyIncome:50000,fixedExpense:25000,insuranceExpense:2000,loanExpense:3000,monthlyInvestment:5000,cashSavings:120000,age:35,retirementMonthlyNeed:30000};
function submission(){return {checkType:'cashflow',consent:{accepted:true,acceptedAt:new Date().toISOString()},input:{profile,holdings:[],monthlyCashflows:{}},report:{score:70,status:'可改善',risks:[{body:'paid body'}],overlap:{score:99}}};}
const legacy=store.createReport(submission());
const paidLegacyUser=store.findOrCreateUserByLineId('U'+'4'.repeat(32));
const paidLegacyReport=store.createReport(submission(),{userId:paidLegacyUser.id});
store.createOrder({id:'LEGACY123',reportId:paidLegacyReport.id,userId:paidLegacyUser.id,productType:'full_report',amount:499,provider:'linepay'});
store.completeProviderPayment({orderId:'LEGACY123',provider:'linepay',providerTradeNo:'local-mock-paid',amount:499});
assert.equal(store.memberAccess(paidLegacyUser.id).fullReport,true);
store.deleteReportForUser(paidLegacyReport.id,paidLegacyUser.id);
assert.equal(store.memberAccess(paidLegacyUser.id).fullReport,true,'Deleting a report must not delete membership');
store.setMemberAccess(admin.id,paidLegacyUser.id,false,'人工撤銷舊權益');
const checkMigration=createStore();assert.equal(checkMigration.memberAccess(paidLegacyUser.id).fullReport,false);checkMigration.close();
for(const user of [admin,alice,bob]) {const r=store.createReport(submission(),{userId:user.id});store.completeUserOnboarding(user.id,r.id);}
const port=6800+Math.floor(Math.random()*500),base=`http://127.0.0.1:${port}`;
const child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...process.env,PORT:String(port),ALLOWED_ORIGINS:base,LINE_LOGIN_CHANNEL_ID:'local-test',LINE_LOGIN_CHANNEL_SECRET:crypto.randomBytes(24).toString('hex'),API_PUBLIC_BASE_URL:base},windowsHide:true,stdio:['ignore','pipe','pipe']});
let errors='';child.stderr.on('data',d=>{errors+=d;});
let checks=0;
async function request(route,index,method='GET',body){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(index==null?{}:{Cookie:'__Host-cashflow_session='+sessions[index].token})},...(body?{body:JSON.stringify(body)}:{})});const text=await r.text();let value;try{value=JSON.parse(text);}catch{value=text;}return {status:r.status,body:value};}
function status(r,n){assert.equal(r.status,n,JSON.stringify(r.body));checks++;}
async function main(){
 try{
  let ready=false;for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,errors);
  status(await request('/api/reports',null,'POST',submission()),401);
  status(await request('/api/reports/'+legacy.id+'?accessCode='+legacy.accessCode),401);
  status(await request('/api/reports/full',1,'POST',{profile,holdings:[]}),403);
  status(await request('/api/market/portfolio',1,'POST',{tickers:['00904']}),403);
  status(await request('/api/admin/members',1),403);
  const keyOnly=await fetch(base+'/api/admin/members',{headers:{Authorization:'Bearer '+process.env.ADMIN_API_KEY}});assert.equal(keyOnly.status,401);checks++;
  const created=await request('/api/reports',1,'POST',submission());status(created,201);const id=created.body.report.id;
  status(await request('/api/reports/'+id,2),404);
  let report=await request('/api/reports/'+id,1);status(report,200);assert.equal(report.body.report.payload.report.risks,undefined);checks++;
  status(await request('/api/admin/members/'+alice.id+'/access',0,'PATCH',{active:true,reason:''}),400);
  for(let i=0;i<2;i++)status(await request('/api/admin/members/'+alice.id+'/access',0,'PATCH',{active:true,reason:'人工核款'}),200);
  let audit=await request('/api/admin/members/'+alice.id+'/access',0);assert.equal(audit.body.audit.length,1);checks++;
  const full=await request('/api/reports/full',1,'POST',{profile,holdings:[],simulationYears:20,monthlyCashflows:{1:profile}});status(full,200);assert.equal(full.body.report.simulation.length,20);assert.equal(full.body.report.calendar.length,12);checks+=2;
  const newReport=await request('/api/reports',1,'POST',submission());status(newReport,201);assert.ok(newReport.body.report.entitlements.includes('full_report'));checks++;
  const secondSession=store.createUserSession(alice.id);const original=sessions[1];sessions[1]=secondSession;
  const access=await request('/api/users/me/access',1);assert.equal(access.body.access.fullReport,true);assert.equal(access.body.access.expiresAt,null);checks+=2;sessions[1]=original;
  status(await request('/api/reports/claim',1,'POST',{reportId:legacy.id,accessCode:legacy.accessCode}),200);
  status(await request('/api/reports/claim',2,'POST',{reportId:legacy.id,accessCode:legacy.accessCode}),403);
  const job=await request('/api/market/portfolio',1,'POST',{tickers:['00904']});status(job,202);
  store.setMemberAccess(admin.id,bob.id,true,'工作隔離測試');
  status(await request('/api/market/portfolio/'+job.body.job.id,2),404);
  store.setMemberAccess(admin.id,bob.id,false,'恢復免費');
  status(await request('/api/admin/members/'+alice.id+'/access',0,'PATCH',{active:false,reason:'撤銷'}),200);
  status(await request('/api/reports/full',1,'POST',{profile,holdings:[]}),403);
  status(await request('/api/market/portfolio',1,'POST',{tickers:['00904']}),403);
  status(await request('/api/users/me/bootstrap',1),200);
  status(await request('/api/ledger/monthly-summary',1),200);
  report=await request('/api/reports/'+id,1);assert.ok(!report.body.report.entitlements.includes('full_report'));assert.equal(report.body.report.payload.report.risks,undefined);checks+=2;
  status(await request('/api/reports',1,'POST',submission()),201);
  status(await request('/member-report.js'),404);
  status(await request('/api/reports/full',0,'POST',{profile,holdings:[]}),200);
  status(await request('/api/reports/full',0,'POST',{profile:{...profile,monthlyIncome:'invalid'},holdings:[]}),400);
  const reopened=createStore();assert.equal(reopened.memberAccess(alice.id).fullReport,false);reopened.close();checks++;
  if(process.argv.includes('--browser'))await require('./test-member-browser')({base,sessions,aliceId:alice.id,store,adminId:admin.id,legacy});
  console.log(JSON.stringify({ok:true,checks:checks+3,scope:'local isolated member roles, grants, revocation, ownership, planning, legacy paid migration and claim'}));
 }finally{child.kill();await new Promise(r=>child.once('exit',r));store.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
