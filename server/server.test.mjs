import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,createHmac,randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { openDatabase,enqueue,savePage } from './database.mjs';
import { encrypt,decrypt,units,decimal,passwordHash,passwordMatches } from './security.mjs';
import { createApi } from './api.mjs';
import { createWorker, SYNC_INTERVAL } from './worker.mjs';
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
  assert.equal(decimal(units('-0.80284444444416')),'-0.802844444444');
  assert.equal(decimal(units('9.9999999999999')),'10.000000000000');
  assert.throws(()=>units('NaN'));assert.throws(()=>units('1e10'));
});
test('password hashing and verification',()=>{const hash=passwordHash('long-private-password');assert(passwordMatches('long-private-password',hash));assert(!passwordMatches('wrong-password',hash));});
test('normalizes exchange equity without floating point arithmetic',()=>{
  assert.equal(normalizedCapital('Bybit',{wallet:{list:[{totalEquity:'123.45'}]}}).equityUsd,'123.45');
  assert.equal(normalizedCapital('OKX',{wallet:[{totalEq:'55.25'}]}).equityUsd,'55.25');
  assert.equal(normalizedCapital('Hyperliquid',{wallet:{marginSummary:{accountValue:'0'}},portfolio:[['day',{accountValueHistory:[[1,'210.374011']]}]]}).equityUsd,'210.374011');
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
test('Bybit history starts inside the rolling two-year boundary',()=>{
  const now=Date.now(),streams=createAdapter('Bybit',{apiKey:'abc',secret:'def'}).streams(now);
  assert(streams.every(stream=>stream.start===now-729*86400000));
});
test('Binance discovers spot pairs automatically before loading their history',async()=>{
  const options={futures:false,spotAuto:true},calls=[];
  const adapter=createAdapter('Binance',{apiKey:'key123',secret:'secret123'},options,async url=>{
    calls.push(url);
    if(url.includes('/exchangeInfo'))return new Response(JSON.stringify({symbols:[
      {symbol:'ETHUSDT',status:'TRADING',isSpotTradingAllowed:true},
      {symbol:'OLDUSDT',status:'BREAK',isSpotTradingAllowed:true},
      {symbol:'BTCUSDT',status:'TRADING',isSpotTradingAllowed:true},
    ]}));
    if(url.includes('/myTrades'))return new Response(JSON.stringify(url.includes('BTCUSDT')?[{id:7,time:1000,commissionAsset:'USDT'}]:[]));
    throw new Error(`Unexpected URL ${url}`);
  });
  assert.equal(await adapter.prepare(),true);
  assert.deepEqual(options.spotCandidates,['BTCUSDT','ETHUSDT']);
  assert.deepEqual(adapter.streams(2000,{discoverSpot:true}).map(v=>v.id),['spot-scan:BTCUSDT','spot-scan:ETHUSDT']);
  const page=await adapter.page('spot-scan:BTCUSDT',2000,2000);
  assert.equal(page.discoveredSymbol,'BTCUSDT');assert.equal(page.events[0].symbol,'BTCUSDT');
  assert(calls.some(v=>v.includes('limit=1')));
});
test('all requested exchange adapters are enabled and sign read requests',async()=>{
  const expected=['Gate.io','Bitget','Aster','KuCoin','MEXC','Lighter'];assert(expected.every(id=>catalog.find(v=>v.id===id)?.enabled));
  const cases=[
    ['Gate.io',{apiKey:'key123',secret:'secret123'},{},[],h=>h.KEY&&h.SIGN],
    ['Bitget',{apiKey:'key123',secret:'secret123',passphrase:'pass'},{},{code:'00000',data:[]},h=>h['ACCESS-SIGN']&&h['ACCESS-PASSPHRASE']],
    ['Aster',{apiKey:'0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',secret:'0x0000000000000000000000000000000000000000000000000000000000000001'},{},{totalMarginBalance:'500'},h=>h.Accept==='application/json'],
    ['KuCoin',{apiKey:'key123',secret:'secret123',passphrase:'pass'},{},{code:'200000',data:{permission:'General'}},h=>h['KC-API-SIGN']&&h['KC-API-PASSPHRASE']],
    ['MEXC',{apiKey:'key123',secret:'secret123'},{futures:false},{balances:[]},h=>h['X-MBX-APIKEY']],
    ['Lighter',{address:'0x1111111111111111111111111111111111111111'},{},{accounts:[{}]},h=>Object.keys(h).length===0],
  ];
  for(const [name,credentials,options,response,headersOk] of cases){let called;const adapter=createAdapter(name,credentials,options,async(url,init)=>{called={url,init};return new Response(JSON.stringify(response));});await adapter.verify();assert(headersOk(called.init.headers),`${name} auth headers`);assert(called.init.redirect==='error');if(name==='Aster'){assert(called.url.includes('signer=0x7E5F'));assert(called.url.includes('nonce='));assert(called.url.includes('signature=0x'));assert(!called.url.includes(credentials.secret));}}
});
test('KuCoin uses current v3 authentication and falls back to legacy v2 keys',async()=>{
  const credentials={apiKey:'key123',secret:'secret123',passphrase:'pass'},calls=[];
  const adapter=createAdapter('KuCoin',credentials,{},async(url,init)=>{
    calls.push({url,init});
    if(init.headers['KC-API-KEY-VERSION']==='3')return new Response(JSON.stringify({code:'400004',msg:'KC-API-PASSPHRASE error'}),{status:401});
    return new Response(JSON.stringify({code:'200000',data:{permission:'General',apiVersion:2}}));
  });
  await adapter.verify();
  assert.deepEqual(calls.map(v=>v.init.headers['KC-API-KEY-VERSION']),['3','2']);
  const headers=calls[0].init.headers,ts=headers['KC-API-TIMESTAMP'];
  assert.equal(headers['KC-API-SIGN'],createHmac('sha256',credentials.secret).update(ts+'GET/api/v1/user/api-key').digest('base64'));
  assert.equal(headers['KC-API-PASSPHRASE'],createHmac('sha256',credentials.secret).update(credentials.passphrase).digest('base64'));
  assert.equal(headers['Content-Type'],'application/json');
});
test('KuCoin authentication errors include the exchange code and explanation',async()=>{
  const adapter=createAdapter('KuCoin',{apiKey:'key123',secret:'secret123',passphrase:'wrong'}, {},async()=>new Response(JSON.stringify({code:'400006',msg:'The requested ip address is not on the api whitelist'}),{status:401}));
  await assert.rejects(adapter.verify(),/IP сервера не добавлен.*код 400006/);
});
test('Gate futures ledger signs and requests each supported type separately',async()=>{
  const credentials={apiKey:'gate-key',secret:'gate-secret'},calls=[];
  const adapter=createAdapter('Gate.io',credentials,{},async(url,init)=>{calls.push({url,init});return new Response('[]');});
  assert.deepEqual(adapter.streams(Date.now()).map(v=>v.id),['spot','futures:pnl','futures:fee','futures:fund']);
  await adapter.page('futures:fee',Date.UTC(2026,0,1),Date.UTC(2026,0,2)-1);
  const {url,init}=calls[0],parsed=new URL(url),rawQuery=decodeURIComponent(parsed.search.slice(1)),bodyHash=createHash('sha512').update('').digest('hex');
  assert.equal(parsed.searchParams.get('type'),'fee');
  assert.equal(parsed.searchParams.has('page'),false);
  assert.equal(init.headers.SIGN,createHmac('sha512',credentials.secret).update(`GET\n${parsed.pathname}\n${rawQuery}\n${bodyHash}\n${init.headers.Timestamp}`).digest('hex'));
});
test('Bitget automatically switches UTA accounts to v3 assets and fills',async()=>{
  const options={},calls=[];
  const adapter=createAdapter('Bitget',{apiKey:'bitget-key',secret:'bitget-secret',passphrase:'pass'},options,async(url,init)=>{
    calls.push({url,init});
    if(url.includes('/api/v2/'))return new Response(JSON.stringify({code:'40085',msg:'Unified Account mode'}),{status:400});
    if(url.includes('/api/v3/account/info'))return new Response(JSON.stringify({code:'00000',data:{permType:'read-only',permissions:['uta_mgt','uta_trade']}}));
    if(url.includes('/api/v3/account/assets'))return new Response(JSON.stringify({code:'00000',data:{accountEquity:'125.50',assets:[]}}));
    if(url.includes('/api/v3/trade/fills'))return new Response(JSON.stringify({code:'00000',data:{list:[{execId:'e1',category:'USDT-FUTURES',symbol:'BTCUSDT',createdTime:'1750141421721',execPnl:'4.5',feeDetail:[{feeCoin:'USDT',fee:'0.25'}]}],cursor:''}}));
    throw new Error(`Unexpected URL ${url}`);
  });
  await adapter.verify();
  assert.equal(options.accountMode,'uta');
  assert(adapter.streams(Date.now()).some(v=>v.id==='uta-fills:USDT-FUTURES'));
  const page=await adapter.page('uta-fills:USDT-FUTURES',Date.now()-86400000,Date.now());
  assert.deepEqual(page.events.map(v=>v.kind),['fill','pnl']);
  assert.equal(page.events[1].gross,'4.500000000000');
  assert.equal(page.events[1].fee,'0.250000000000');
  assert(calls.every(v=>v.init.headers['Content-Type']==='application/json'));
});
test('Bitget accepts alternate read-only spelling returned for a UTA key',async()=>{
  const options={};
  const adapter=createAdapter('Bitget',{apiKey:'bitget-key',secret:'bitget-secret',passphrase:'pass'},options,async url=>{
    if(url.includes('/api/v2/'))return new Response(JSON.stringify({code:'40085',msg:'Unified Account mode'}),{status:400});
    if(url.includes('/api/v3/account/info'))return new Response(JSON.stringify({code:'00000',data:{permType:'read_only',permissions:['UTA_MGT','UTA_TRADE']}}));
    if(url.includes('/api/v3/account/assets'))return new Response(JSON.stringify({code:'00000',data:{accountEquity:'125.50',assets:[]}}));
    throw new Error(`Unexpected URL ${url}`);
  });
  await adapter.verify();
  assert.equal(options.accountMode,'uta');
});
test('Bitget rejects a UTA key that explicitly has write access',async()=>{
  const adapter=createAdapter('Bitget',{apiKey:'bitget-key',secret:'bitget-secret',passphrase:'pass'},{},async url=>{
    if(url.includes('/api/v2/'))return new Response(JSON.stringify({code:'40085',msg:'Unified Account mode'}),{status:400});
    if(url.includes('/api/v3/account/info'))return new Response(JSON.stringify({code:'00000',data:{permType:'read-and-write',permissions:['uta_mgt','uta_trade']}}));
    throw new Error(`Unexpected URL ${url}`);
  });
  await assert.rejects(adapter.verify(),/имеет право записи/);
});
test('worker persists pages, resumes after restart and marks snapshot completion',async()=>{
  const db=openDatabase(':memory:'),key=randomBytes(32),id=addConnection(db,key);enqueue(db,id);let calls=0;
  const factory=()=>({streams:()=>[{id:'ledger',start:0,window:100000}],page:async()=>{calls++;return {events:[{id:'e1',time:Date.now(),kind:'pnl',market:'futures',symbol:'BTCUSDT',currency:'USDT',gross:'10',raw:{}}],next:null};},snapshot:async()=>({wallet:[]})});
  const worker=createWorker(db,key,factory);await worker.tick();await worker.stop();
  const restarted=createWorker(db,key,factory);await restarted.tick();await restarted.tick();assert.equal(calls,1);assert.equal(db.prepare('SELECT status FROM connections').get().status,'ready');await restarted.stop();db.close();
});
test('worker refreshes after five minutes and rotates long imports between exchanges',async()=>{
  assert.equal(SYNC_INTERVAL,5*60*1000);
  const db=openDatabase(':memory:'),key=randomBytes(32),first=addConnection(db,key),second='22222222-2222-4222-8222-222222222222';
  db.prepare('INSERT INTO connections(id,exchange,label,secret,fingerprint,start,options,created) VALUES(?,?,?,?,?,?,?,?)').run(second,'OKX','Second',encrypt({apiKey:'key-2',secret:'secret-2',passphrase:'pass'},key,second),'fingerprint-2',Date.now()-10000,'{}',Date.now());
  enqueue(db,first);enqueue(db,second);
  db.prepare('UPDATE jobs SET updated=CASE connection_id WHEN ? THEN 1 ELSE 2 END').run(first);
  const pages=[];
  const factory=exchange=>({streams:()=>[{id:'ledger',start:0,window:1}],page:async()=>{pages.push(exchange);return {events:[],next:null};},snapshot:async()=>({wallet:[]})});
  const worker=createWorker(db,key,factory);await worker.tick();await worker.tick();
  assert.deepEqual(pages,['Bybit','OKX']);
  assert.equal(db.prepare('SELECT count(*) AS n FROM snapshots').get().n,2);
  await worker.stop();db.close();
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
    const allTime=await call('/journal?scope=all');assert.equal(allTime.status,200);assert.equal((await allTime.json()).rows.length,1);
    const emptyNote=await (await call('/notes/2026-09-16')).json();assert.equal(emptyNote.note,'');assert.deepEqual(emptyNote.images,[]);
    assert.equal((await call('/notes/2026-09-16',{note:'Хороший день https://example.com/review'})).status,200);
    const uploaded=await call('/notes/2026-09-16/images',{name:'chart.png',mime:'image/png',data:Buffer.from('image-bytes').toString('base64')});assert.equal(uploaded.status,201);const image=await uploaded.json();
    const savedNote=await (await call('/notes/2026-09-16')).json();assert.match(savedNote.note,/example\.com/);assert.equal(savedNote.images.length,1);assert.equal(savedNote.images[0].name,'chart.png');
    const servedImage=await call(`/notes/2026-09-16/images/${image.id}`);assert.equal(servedImage.status,200);assert.equal(servedImage.headers.get('content-type'),'image/png');assert.equal(await servedImage.text(),'image-bytes');
    for(let i=0;i<10;i++)assert.equal((await call('/notes/2026-09-17/images',{name:`screen-${i}.png`,mime:'image/png',data:Buffer.from(`image-${i}`).toString('base64')})).status,201);
    const tooMany=await call('/notes/2026-09-17/images',{name:'screen-11.png',mime:'image/png',data:Buffer.from('overflow').toString('base64')});assert.equal(tooMany.status,400);assert.match((await tooMany.json()).error,/10 скриншотов/);
    assert.equal((await call(`/notes/2026-09-16/images/${image.id}/delete`,{})).status,200);assert.equal((await (await call('/notes/2026-09-16')).json()).images.length,0);
    await call('/logout',{});assert.equal((await call('/connections')).status,401);
    for(let i=0;i<12;i++)await call('/login',{password:'wrong-password-long'});
    assert.equal((await call('/login',{password:'test-owner-password'})).status,429);
  } finally {await new Promise(r=>server.close(r));db.close();}
});


