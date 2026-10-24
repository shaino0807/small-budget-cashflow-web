// Run locally against an explicitly selected database after verifying the member id.
const {createStore}=require('../customer-store');
if(!process.env.CUSTOMER_DATA_DIR)throw Error('必須明確設定 CUSTOMER_DATA_DIR');
const userId=process.argv[2];
if(!/^[0-9a-f-]{36}$/i.test(userId||''))throw Error('請提供已核對的會員 UUID');
if(process.argv[3]!=='--confirm-first-admin')throw Error('需要 --confirm-first-admin');
const store=createStore();
try{store.bootstrapAdmin(userId);console.log('首次管理員設定完成');}finally{store.close();}
