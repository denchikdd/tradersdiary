import { randomBytes, randomUUID } from 'node:crypto';
import { encrypt,digest,passwordHash,passwordMatches,cents,units,decimal } from './security.mjs';
import { enqueue } from './database.mjs';
import { catalog,createAdapter,normalizedCapital } from './exchanges.mjs';

class ApiError extends Error { constructor(status,message){super(message);this.status=status;} }
export function createApi(db,key,{origin,secure,setupToken,adapterFactory=createAdapter}) {
  const cookieName=secure?'__Host-journal':'journal';
  const cookie=(token,age)=>`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure?'; Secure':''}`;
  const sessionFor=req=>{
    const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.split('=')[1];
    return token?db.prepare('SELECT hash FROM sessions WHERE hash=? AND expires>?').get(digest(token),Date.now()):null;
  };
  const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  async function body(req) {
    if(!String(req.headers['content-type']).startsWith('application/json'))throw new ApiError(415,'Нужен JSON.');
    let value='',bytes=0;
    for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)throw new ApiError(413,'Слишком большой запрос.');value+=chunk;}
    try{return JSON.parse(value);}catch{throw new ApiError(400,'Некорректный JSON.');}
  }
  function text(v,min=1,max=512) {if(typeof v!=='string'||v.length<min||v.length>max)throw new ApiError(400,'Проверьте заполнение полей.');return v;}
  function rateLimit() {
    // Global persisted limiter, independent of attacker-controlled forwarded IP headers.
    const old=db.prepare("SELECT * FROM login_attempts WHERE bucket='owner'").get();
    if(old?.expires>Date.now()&&old.attempts>=10)throw new ApiError(429,'Слишком много попыток. Попробуйте через 15 минут.');
    db.prepare("INSERT INTO login_attempts VALUES('owner',1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN expires>? THEN attempts+1 ELSE 1 END,expires=CASE WHEN expires>? THEN expires ELSE excluded.expires END").run(Date.now()+900000,Date.now(),Date.now());
  }
  return async function handle(req,res) {
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    const url=new URL(req.url,'http://localhost'),path=url.pathname.replace('/api/journal',''),method=req.method;
    try {
      if(method==='GET'&&path==='/health'){db.prepare('SELECT 1').get();return send(res,200,{ok:true});}
      if(!['GET','HEAD'].includes(method) && (req.headers.origin!==origin||req.headers['x-journal-request']!=='1'))throw new ApiError(403,'Запрос с другого сайта запрещён.');
      const owner=db.prepare("SELECT value FROM settings WHERE key='owner'").get();
      if(method==='GET'&&path==='/session')return send(res,200,{authenticated:!!sessionFor(req),needsSetup:!owner});
      if(method==='POST'&&(path==='/setup'||path==='/login')) {
        rateLimit();const input=await body(req);const password=text(input.password,12,256);
        if(path==='/setup') {
          if(owner)throw new ApiError(409,'Пароль уже установлен.');
          if(!setupToken||digest(text(input.token))!==digest(setupToken))throw new ApiError(403,'Неверный код настройки сервера.');
          db.prepare("INSERT INTO settings VALUES('owner',?)").run(passwordHash(password));
        } else if(!owner||!passwordMatches(password,owner.value))throw new ApiError(401,'Неверный пароль.');
        db.prepare("DELETE FROM login_attempts WHERE bucket='owner'").run();
        db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
        const token=randomBytes(32).toString('base64url');
        db.prepare('INSERT INTO sessions VALUES(?,?)').run(digest(token),Date.now()+7*86400000);
        res.setHeader('Set-Cookie',cookie(token,7*86400));return send(res,200,{ok:true});
      }
      const session=sessionFor(req);if(!session)throw new ApiError(401,'Введите пароль журнала.');
      if(method==='POST'&&path==='/logout'){db.prepare('DELETE FROM sessions WHERE hash=?').run(session.hash);res.setHeader('Set-Cookie',cookie('',0));return send(res,200,{ok:true});}
      if(method==='GET'&&path==='/connections') {
        const connections=db.prepare(`SELECT c.id,c.exchange,c.label,c.start,c.status,c.error,c.synced,c.disabled,
          (SELECT count(*) FROM events e WHERE e.connection_id=c.id) AS records,
          (SELECT min(time) FROM events e WHERE e.connection_id=c.id) AS earliest,
          (SELECT checkpoint FROM jobs j WHERE j.connection_id=c.id ORDER BY id DESC LIMIT 1) AS checkpoint
          FROM connections c ORDER BY c.created`).all();
        return send(res,200,{catalog,connections});
      }
      if(method==='POST'&&path==='/connections') {
        const input=await body(req),exchange=text(input.exchange);
        const provider=catalog.find(v=>v.id===exchange&&v.enabled);if(!provider)throw new ApiError(400,'Эта биржа пока недоступна.');
        if(db.prepare('SELECT count(*) AS n FROM connections').get().n>=20)throw new ApiError(400,'Максимум 20 подключений.');
        const start=Date.parse(text(input.start));if(!Number.isFinite(start)||start<Date.UTC(2017,0,1)||start>Date.now())throw new ApiError(400,'Проверьте начальную дату истории.');
        const label=text(input.label,1,80),credentials=provider.address?{address:text(input.address,42,42)}:{apiKey:text(input.apiKey,6,256),secret:text(input.secret,6,512),...(provider.passphrase?{passphrase:text(input.passphrase,1,256)}:{})};
        if(provider.address&&!/^0x[a-fA-F0-9]{40}$/.test(credentials.address))throw new ApiError(400,'Нужен публичный адрес 0x…');
        const symbols=(input.spotSymbols||'').toUpperCase().split(/[\s,]+/).filter(Boolean);
        if(symbols.length>100||symbols.some(s=>! /^[A-Z0-9]{4,30}$/.test(s)))throw new ApiError(400,'Пары spot: BTCUSDT, ETHUSDC, без слеша.');
        const options={spotSymbols:symbols,futures:input.futures!==false};
        if(exchange==='Binance'&&!options.futures&&!symbols.length)throw new ApiError(400,'Выберите фьючерсы или укажите пары spot.');
        if(exchange==='MEXC'&&!symbols.length)throw new ApiError(400,'Укажите торговавшиеся spot-пары MEXC для загрузки истории.');
        const fingerprint=digest(exchange+':'+(credentials.apiKey||credentials.address.toLowerCase()));
        if(db.prepare('SELECT id FROM connections WHERE fingerprint=?').get(fingerprint))throw new ApiError(409,'Этот ключ или адрес уже подключён.');
        await adapterFactory(exchange,credentials,options).verify();
        const id=randomUUID();
        db.prepare('INSERT INTO connections(id,exchange,label,secret,fingerprint,start,options,created) VALUES(?,?,?,?,?,?,?,?)').run(id,exchange,label,encrypt(credentials,key,id),fingerprint,start,JSON.stringify(options),Date.now());
        enqueue(db,id);return send(res,201,{id});
      }
      const action=path.match(/^\/connections\/([a-f0-9-]{36})\/(sync|pause|resume|delete)$/);
      if(method==='POST'&&action) {
        const [,id,verb]=action,c=db.prepare('SELECT * FROM connections WHERE id=?').get(id);if(!c)throw new ApiError(404,'Подключение не найдено.');
        if(verb==='delete') {db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM events WHERE connection_id=?').run(id);db.prepare('DELETE FROM snapshots WHERE connection_id=?').run(id);db.prepare('DELETE FROM jobs WHERE connection_id=?').run(id);db.prepare('DELETE FROM connections WHERE id=?').run(id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
        else if(verb==='pause') {db.prepare('UPDATE connections SET disabled=1 WHERE id=?').run(id);db.prepare("UPDATE jobs SET status='cancelled' WHERE connection_id=? AND status='queued'").run(id);}
        else {
          db.prepare("UPDATE connections SET disabled=0,status='queued',error=NULL WHERE id=?").run(id);
          const failed=db.prepare("SELECT id FROM jobs WHERE connection_id=? AND status='failed' ORDER BY id DESC LIMIT 1").get(id);
          const active=db.prepare("SELECT id FROM jobs WHERE connection_id=? AND status IN ('queued','running')").get(id);
          if(failed&&!active)db.prepare("UPDATE jobs SET status='queued',attempts=0,next_run=0,error=NULL WHERE id=?").run(failed.id);else enqueue(db,id);
        }
        return send(res,200,{ok:true});
      }
      if(method==='GET'&&path==='/journal') {
        const from=Date.parse(url.searchParams.get('from')),to=Date.parse(url.searchParams.get('to'));
        if(!Number.isFinite(from)||!Number.isFinite(to)||to<from||to-from>370*86400000)throw new ApiError(400,'Период не должен превышать год.');
        const events=db.prepare(`SELECT e.*,c.exchange,c.label FROM events e JOIN connections c ON c.id=e.connection_id WHERE time>=? AND time<? AND kind='pnl' ORDER BY time`).all(from,to+86400000);
        const groups=new Map();let unvalued=0;
        for(const e of events) {
          if(!['USDT','USDC'].includes(e.currency)){unvalued++;continue;}
          const day=new Date(e.time).toISOString().slice(0,10),id=[e.connection_id,day,e.symbol,e.currency].join(':');
          const row=groups.get(id)||{id,date:day,exchange:e.exchange,account:e.label,ticker:e.symbol.replace(/[-/]?(USDT|USDC)(-SWAP)?$/,'')||'Без тикера',market:e.market,settle:e.currency,gross:0n,fee:0n,funding:0n};
          row.gross+=units(e.gross);row.fee+=units(e.fee);row.funding+=units(e.funding);groups.set(id,row);
        }
        const rows=[...groups.values()].map(r=>({...r,gross:cents(decimal(r.gross)),fee:cents(decimal(r.fee)),funding:cents(decimal(r.funding))}));
        return send(res,200,{rows,unvalued,notice:'Реализованный PnL фьючерсов. USDT/USDC приняты за 1 USD. Spot сохранён как исполнения, но прибыль не рассчитана без проверенной себестоимости. Процент PnL считается от текущего общего капитала всех подключённых счетов.'});
      }
      if(method==='GET'&&path==='/fills') {
        const from=Date.parse(url.searchParams.get('from')),to=Date.parse(url.searchParams.get('to'));
        if(!Number.isFinite(from)||!Number.isFinite(to)||to<from||to-from>370*86400000)throw new ApiError(400,'Некорректный период.');
        const offset=Math.max(0,Math.min(10000000,Number(url.searchParams.get('offset'))||0));
        const rows=db.prepare(`SELECT e.external_id,e.time,e.market,e.symbol,e.currency,e.raw,c.exchange,c.label FROM events e JOIN connections c ON c.id=e.connection_id WHERE e.kind='fill' AND e.time>=? AND e.time<? ORDER BY e.time DESC,e.external_id LIMIT 201 OFFSET ?`).all(from,to+86400000,offset);
        return send(res,200,{hasMore:rows.length>200,rows:rows.slice(0,200).map(e=>{const v=JSON.parse(e.raw),rawFee=v.execFee||v.commission||v.fee||'0',fee=e.exchange==='OKX'?decimal(-units(rawFee)):rawFee;return {id:e.external_id,time:e.time,exchange:e.exchange,account:e.label,symbol:e.symbol,market:e.market,side:v.side||(v.isBuyer?'Buy':'Sell'),quantity:v.execQty||v.qty||v.fillSz||v.sz||'',price:v.execPrice||v.price||v.fillPx||v.px||'',fee,currency:e.currency};})});
      }
      if(method==='GET'&&path==='/balances') {
        const accounts=db.prepare('SELECT c.exchange,c.label,s.time,s.data FROM snapshots s JOIN connections c ON c.id=s.connection_id ORDER BY c.created').all().map(s=>({...s,...normalizedCapital(s.exchange,JSON.parse(s.data))})).filter(v=>v.equityUsd!==undefined);
        const total=accounts.reduce((n,v)=>n+units(v.equityUsd),0n);
        return send(res,200,{totalEquityUsd:decimal(total),updatedAt:accounts.length?Math.min(...accounts.map(v=>v.time)):null,accounts:accounts.map(({data,...v})=>v)});
      }
      throw new ApiError(404,'Не найдено.');
    } catch(e) {
      // Never return or log exchange request URLs, credentials, raw errors or stack traces.
      send(res,e.status||(e.name==='ExchangeError'?422:500),{error:e.status||e.name==='ExchangeError'?e.message:'Внутренняя ошибка сервера.'});
    }
  };
}


