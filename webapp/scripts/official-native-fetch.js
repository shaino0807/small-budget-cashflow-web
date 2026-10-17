// Optional system curl transport for public sources whose TLS chain needs the
// platform certificate store or whose response headers exceed fetch's limit.
// No insecure TLS option, shell interpolation, cookies or authorization headers.
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const exec=promisify(execFile);
async function nativeFetch(url,{method='GET',body,headers={},signal}={}){
 const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password)throw Error('Public HTTPS URL required');
 if(method!=='GET'||body||Object.keys(headers).some(k=>/authorization|cookie|token/i.test(k)))throw Error('Native transport accepts anonymous GET only');
 const {stdout}=await exec(process.platform==='win32'?'curl.exe':'curl',[
  '--silent','--show-error','--max-time','20','--max-filesize','12000000','--proto','=https',
  '--write-out','%{http_code}',u.toString()
 ],{encoding:'buffer',maxBuffer:12000003,timeout:25000,windowsHide:true,signal});
 const status=Number(stdout.subarray(-3).toString('ascii'));if(!Number.isInteger(status)||status<200||status>599)throw Error('Invalid native HTTP response');
 return new Response(stdout.subarray(0,-3),{status});
}
module.exports={nativeFetch};
