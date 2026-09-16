import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync,readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
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
const server=createServer(async(req,res)=>{
  if(req.url?.startsWith('/api/journal/'))return handle(req,res);
  if(web)return web(req,res);
  res.writeHead(404);res.end();
});
server.requestTimeout=30000;server.headersTimeout=15000;
server.listen(Number(process.env.PORT||5174),production?'0.0.0.0':'127.0.0.1',()=>{console.log('Journal server ready. Credentials and financial data are never logged.');worker.start();});
async function stop(){server.close();await worker.stop();db.close();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
