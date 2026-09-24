import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream,existsSync,readFileSync,writeFileSync,mkdirSync,statSync } from 'node:fs';
import { extname,resolve,sep } from 'node:path';
import { openDatabase } from './database.mjs';
import { readKey, encrypt, decrypt } from './security.mjs';
import { createApi } from './api.mjs';
import { createWorker } from './worker.mjs';

const production=process.env.NODE_ENV==='production';
if(!production) {
  const dir=resolve('.journal-local');mkdirSync(dir,{recursive:true,mode:0o700});
  const path=resolve(dir,'server.json');
  if(!existsSync(path))writeFileSync(path,JSON.stringify({encryptionKey:randomBytes(32).toString('hex'),setupToken:randomBytes(24).toString('base64url')},null,2),{mode:0o600});
  const local=JSON.parse(readFileSync(path,'utf8'));
  process.env.JOURNAL_ENCRYPTION_KEY??=local.encryptionKey;process.env.JOURNAL_SETUP_TOKEN??=local.setupToken;
  // Owner reads this locally; never uploaded or served via HTTP.
  writeFileSync(resolve(dir,'SETUP.txt'),`Код первоначальной настройки журнала (вводится один раз):\n${local.setupToken}\n\nОткройте http://localhost:5173/ и задайте свой пароль.\n`,{mode:0o600});
}
const origin=process.env.APP_ORIGIN||(production?'':'http://localhost:5173');
if(!origin||new URL(origin).origin!==origin||(production&&!origin.startsWith('https://')))throw new Error('Set APP_ORIGIN to the exact HTTPS application origin without a trailing slash.');
const key=readKey(process.env.JOURNAL_ENCRYPTION_KEY);
if(production&&!process.env.JOURNAL_DB_PATH)throw new Error('Set JOURNAL_DB_PATH to /data/journal.sqlite and mount a persistent volume at /data.');
const db=openDatabase(process.env.JOURNAL_DB_PATH||resolve('.journal-local/journal.sqlite'));
const keyCheck=db.prepare("SELECT value FROM settings WHERE key='encryption-check'").get();
if(keyCheck) decrypt(keyCheck.value,key,'key-check');
else db.prepare("INSERT INTO settings VALUES('encryption-check',?)").run(encrypt('valid',key,'key-check'));
if(!db.prepare("SELECT value FROM settings WHERE key='owner'").get() && (process.env.JOURNAL_SETUP_TOKEN||'').length<24)throw new Error('Set a random JOURNAL_SETUP_TOKEN of at least 24 characters.');
const handle=createApi(db,key,{origin,secure:production,setupToken:process.env.JOURNAL_SETUP_TOKEN});
let web;
if(production) {
  const {default:next}=await import('next');const app=next({dev:false});await app.prepare();web=app.getRequestHandler();
}
const worker=createWorker(db,key);
const staticRoot=resolve('.next/static');
const staticTypes={'.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2'};
function serveStatic(req,res) {
  if(!production||!['GET','HEAD'].includes(req.method||''))return false;
  let pathname;
  try {pathname=decodeURIComponent(new URL(req.url||'/','http://localhost').pathname);} catch {return false;}
  if(!pathname.startsWith('/_next/static/'))return false;
  const file=resolve(staticRoot,pathname.slice('/_next/static/'.length));
  if(file!==staticRoot&&!file.startsWith(staticRoot+sep)){res.writeHead(400);res.end();return true;}
  try {if(!statSync(file).isFile())throw new Error('not a file');} catch {res.writeHead(404);res.end();return true;}
  res.writeHead(200,{'Content-Type':staticTypes[extname(file).toLowerCase()]||'application/octet-stream','Cache-Control':'no-cache, no-store, must-revalidate','X-Content-Type-Options':'nosniff'});
  if(req.method==='HEAD')res.end();else createReadStream(file).pipe(res);
  return true;
}
const server=createServer(async(req,res)=>{
  if(req.url?.startsWith('/api/journal/'))return handle(req,res);
  if(serveStatic(req,res))return;
  if(web)return web(req,res);
  res.writeHead(404);res.end();
});
server.requestTimeout=30000;server.headersTimeout=15000;
server.listen(Number(process.env.PORT||5174),production?'0.0.0.0':'127.0.0.1',()=>{console.log('Journal server ready. Credentials and financial data are never logged.');worker.start();});
async function stop(){server.close();await worker.stop();db.close();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);

