// Opt-in queue for known public, read-only issuer endpoints (including read-only POSTs).
// The caller's job signal is never replaced or extended.
const {setTimeout:delay}=require('node:timers/promises');
const transient=error=>error?.name==='TimeoutError'||/^(ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)$/.test(error?.cause?.code||error?.code||'');
function createPublicReadQueue({intervalMs=400,maxPending=64}={}){
  let tail=Promise.resolve(),pending=0,lastRead=0;
  return async function read(task,signal){
    signal.throwIfAborted();if(pending>=maxPending)throw Error('官方來源核對佇列已滿，請稍後重試');
    pending++;const previous=tail;let release,onAbort;
    const ticket=new Promise(resolve=>release=resolve);tail=previous.then(()=>ticket);
    try{
      await Promise.race([previous,new Promise((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});})]);
      for(let attempt=0;attempt<2;attempt++){
        signal.throwIfAborted();const pause=intervalMs-(Date.now()-lastRead);
        if(pause>0)await delay(pause,undefined,{signal});
        signal.throwIfAborted();lastRead=Date.now();
        try{return await task();}catch(error){if(attempt||signal.aborted||!transient(error))throw error;}
      }
    }finally{signal.removeEventListener('abort',onAbort);pending--;release();}
  };
}
module.exports={createPublicReadQueue};
