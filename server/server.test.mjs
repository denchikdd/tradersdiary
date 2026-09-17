import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { openDatabase,enqueue,savePage } from './database.mjs';
import { encrypt,decrypt,units,decimal,passwordHash,passwordMatches } from './security.mjs';
import { createApi } from './api.mjs';
import { createWorker } from './worker.mjs';
import { catalog,createAdapter,bybitEvent,binanceIncome,okxEvent,normalizedCapital } from './exchanges.mjs';

test('AES-GCM authenticates credentials, account identity and ciphertext',()=>{
  const key=randomBytes(32),secret={apiKey:'private-api-key',secret:'sensitive-secret'};
  const box=encrypt(secret,key,'account-a');assert(!box.includes(secret.secret));assert.deepEqual(decrypt(box,key,'account-a'),secret);
  assert.throws(()=>decrypt(box,key,'account-b'));assert.throws(()=>decrypt(box,randomBytes(32),'account-a'));
  const parts=box.split('.');const bytes=Buffer.from(parts[2],'base64url');bytes[0]^=1;parts[2]=bytes.toString('base64url');assert.throws(()=>decrypt(parts.join('.'),key,'account-a'));
});
test('exact decimals, negative funding and rebates',()=>{
  assert.equal(decimal(units('0.1')+units('0.2')),'0.300000000000');
  const e=bybitEvent({id:'1',transactionTime:'10',type:'SETTLEMENT',cashFlow:'5',funding:'-1.5',fee:'-0.2',currency:'USDC'},'ledger','futures');
  assert.equal(decimal(units(e.gross)-units(e.fee)+units(e.funding)),'3.700000000000');
  assert.equal(bybitEvent({type:'TRANSFER_IN',cashFlow:'10000'},'ledger','futures').kind,'transfer');
  assert.equal(binanceIncome({incomeType:'COMMISSION',income:'-0.02',tranId:'1',time:10}).fee,'0.020000000000');
  const ok=okxEvent({billId:'1',type:'8',subType:'173',pnl:'2',fee:'0',ts:'10'},'bills','futures');assert.equal(ok.funding,'2');assert.equal(ok.gross,'0');
  assert.throws(()=>units('NaN'));assert.throws(()=>units('1e10'));
});
test('password hashing and verification',()=>{const hash=passwordHash('long-private-password');assert(passwordMatches('long-private-password',hash));assert(!passwordMatches('wrong-password',hash));});
test('normalizes exchange equity without floating point arithmetic',()=>{
  assert.equal(normalizedCapital('Bybit',{wallet:{list:[{totalEquity:'123.45'}]}}).equityUsd,'123.45');
  assert.equal(normalizedCapital('OKX',{wallet:[{totalEq:'55.25'}]}).equityUsd,'55.25');
  assert.equal(normalizedCapital('Hyperliquid',{wallet:{marginSummary:{accountValue:'9.5'}}}).equityUsd,'9.5');
  assert.equal(normalizedCapital('Binance',{spotEquityUsd:'10.1',futures:{totalMarginBalance:'20.2'}}).equityUsd,'30.300000000000');
});

function addConnection(db,key) {
  const id='11111111-1111-4111-8111-111111111111';
  db.prepare('INSERT INTO connections(id,exchange,label,secret,fingerprint,start,options,created) VALUES(?,?,?,?,?,?,?,?)').run(id,'Bybit','Main',encrypt({apiKey:'key',secret:'secret'},key,id),'fingerprint',Date.now()-10000,'{}',Date.now());return id;
}
test('atomic import deduplicates replay, separates accounts and rolls back malformed pages',()=>{
  const db=openDatabase(':memory:'),key=randomBytes(32),id=addConnection(db,key);enqueue(db,id);enqueue(db,id);assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n,1);
  const e={id:'x',time:100,kind:'pnl',market:'futures',symbol:'BTCUSDT',currency:'USDT',gross:'2',raw:{}};
  savePage(db,id,'ledger',[e],1,{cursor:'a'});savePage(db,id,'ledger',[e],1,{cursor:'b'});
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n,1);
  assert.throws(()=>savePage(db,id,'ledger',[{...e,id:'second'},{...e,time:NaN}],1,{cursor:'wrong'}));
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n,1);assert.equal(db.prepare('SELECT checkpoint FROM jobs').get().checkpoint,'{"cursor":"b"}');db.close();
});
test('read-only verification rejects write permission and does not follow redirects',async()=>{
  let called;
  const adapter=createAdapter('Bybit',{apiKey:'abc',secret:'def'},{},async(url,init)=>{called={url,init};return new Response(JSON.stringify({retCode:0,result:{readOnly:0}}));});
  await assert.rejects(adapter.verify(),/только для чтения/);assert.equal(called.init.method,'GET');assert.equal(called.init.redirect,'error');assert(called.init.headers['X-BAPI-SIGN']);assert(!called.url.includes('def'));
});
test('all requested exchange adapters are enabled and sign read requests',async()=>{
  const expected=['Gate.io','Bitget','Aster','KuCoin','MEXC','Lighter'];assert(expected.every(id=>catalog.find(v=>v.id===id)?.enabled));
  const cases=[
    ['Gate.io',{apiKey:'key123',secret:'secret123'},{},[],h=>h.KEY&&h.SIGN],
    ['Bitget',{apiKey:'key123',secret:'secret123',passphrase:'pass'},{},{code:'00000',data:[]},h=>h['ACCESS-SIGN']&&h['ACCESS-PASSPHRASE']],
    ['Aster',{apiKey:'key123',secret:'secret123'},{},{totalMarginBalance:'500'},h=>h['X-MBX-APIKEY']],
    ['KuCoin',{apiKey:'key123',secret:'secret123',passphrase:'pass'},{},{code:'200000',data:{permission:'General'}},h=>h['KC-API-SIGN']&&h['KC-API-PASSPHRASE']],
    ['MEXC',{apiKey:'key123',secret:'secret123'},{futures:false},{balances:[]},h=>h['X-MBX-APIKEY']],
    ['Lighter',{address:'0x1111111111111111111111111111111111111111'},{},{accounts:[{}]},h=>Object.keys(h).length===0],
  ];
  for(const [name,credentials,options,response,headersOk] of cases){let called;const adapter=createAdapter(name,credentials,options,async(url,init)=>{called={url,init};return new Response(JSON.stringify(response));});await adapter.verify();assert(headersOk(called.init.headers),`${name} auth headers`);assert(called.init.redirect==='error');}
});
test('worker persists pages, resumes after restart and marks snapshot completion',async()=>{
  const db=openDatabase(':memory:'),key=randomBytes(32),id=addConnection(db,key);enqueue(db,id);let calls=0;
  const factory=()=>({streams:()=>[{id:'ledger',start:0,window:100000}],page:async()=>{calls++;return {events:[{id:'e1',time:Date.now(),kind:'pnl',market:'futures',symbol:'BTCUSDT',currency:'USDT',gross:'10',raw:{}}],next:null};},snapshot:async()=>({wallet:[]})});
  const worker=createWorker(db,key,factory);await worker.tick();await worker.stop();
  const restarted=createWorker(db,key,factory);await restarted.tick();await restarted.tick();assert.equal(calls,1);assert.equal(db.prepare('SELECT status FROM connections').get().status,'ready');await restarted.stop();db.close();
});
test('HTTP auth, CSRF, encrypted storage, no returned credentials, logout, dedup and USD totals',async()=>{
  const db=openDatabase(':memory:'),key=randomBytes(32),setupToken='setup-token-long-enough-for-tests';
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  server.on('request',createApi(db,key,{origin,secure:false,setupToken,adapterFactory:()=>({verify:async()=>{}})}));
  let cookie='';
  async function call(path,body,extra={}) {return fetch(origin+'/api/journal'+path,{...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{}),headers:{'Content-Type':'application/json','X-Journal-Request':'1',Origin:origin,Cookie:cookie,...extra}});}
  try {
    assert.equal((await call('/connections')).status,401);
    assert.equal((await call('/setup',{token:setupToken,password:'test-owner-password'},{Origin:'https://evil.example'})).status,403);
    assert.equal((await call('/setup',{token:'wrong',password:'test-owner-password'})).status,403);
    const setup=await call('/setup',{token:setupToken,password:'test-owner-password'});assert.equal(setup.status,200);cookie=setup.headers.get('set-cookie').split(';')[0];assert(setup.headers.get('set-cookie').includes('HttpOnly'));
    assert.equal((await call('/setup',{token:setupToken,password:'test-owner-password'})).status,409);
    const credentials={exchange:'Bybit',label:'My account',apiKey:'private-key-123',secret:'private-secret-456',start:'2024-01-01'};
    const connected=await call('/connections',credentials);assert.equal(connected.status,201);const {id}=await connected.json();
    assert.equal((await call('/connections',credentials)).status,409);
    const visible=await (await call('/connections')).text();assert(!visible.includes(credentials.apiKey));assert(!visible.includes(credentials.secret));assert(!visible.includes('fingerprint'));
    assert(!db.prepare('SELECT secret FROM connections').get().secret.includes(credentials.secret));
    const e={id:'a',time:Date.parse('2026-09-16T12:00:00Z'),kind:'pnl',market:'futures',symbol:'BTCUSDT',currency:'USDT',gross:'100.25',fee:'0.25',funding:'-1',raw:{}};
    savePage(db,id,'ledger',[e,{...e,id:'deposit',kind:'transfer',gross:'10000'}],1,{});
    const result=await (await call('/journal?from=2026-09-01&to=2026-09-30')).json();assert.equal(result.rows.length,1);assert.equal(result.rows[0].gross-result.rows[0].fee+result.rows[0].funding,9900);
    await call('/logout',{});assert.equal((await call('/connections')).status,401);
    for(let i=0;i<12;i++)await call('/login',{password:'wrong-password-long'});
    assert.equal((await call('/login',{password:'test-owner-password'})).status,429);
  } finally {await new Promise(r=>server.close(r));db.close();}
});

