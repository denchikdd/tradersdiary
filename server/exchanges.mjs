import { createHmac } from 'node:crypto';
import { decimal, units } from './security.mjs';

export const DAY = 86400000;
export const catalog = [
  { id:'Bybit', enabled:true, passphrase:false, notice:'Единый аккаунт UTA: исполнения spot/linear и журнал PnL за последние 2 года. Старый Classic Account не поддерживается.' },
  { id:'Binance', enabled:true, passphrase:false, notice:'USDⓈ-M: журнал доходов за доступные API 3 месяца; spot — история указанных пар. Пары spot нужно перечислить, включая закрытые позиции.' },
  { id:'OKX', enabled:true, passphrase:true, notice:'Исполнения и финансовый журнал за последние 3 месяца. Для старой истории потребуется архив биржи.' },
  { id:'Hyperliquid', enabled:true, address:true, notice:'Только публичный адрес кошелька. Perpetuals: до 10 000 последних исполнений; приватный ключ не нужен.' },
  ...['Gate.io','Bitget','Aster'].map(id=>({id,enabled:false,notice:'Адаптер ещё не доступен для реальных ключей.'})),
];
const hmac = (secret, text, encoding='hex') => createHmac('sha256',secret).update(text).digest(encoding);
export class ExchangeError extends Error { constructor(message, retryable=false) { super(message); this.retryable=retryable; } }
const delay = ms => new Promise(resolve=>setTimeout(resolve, ms));
const multiply = (a,b) => decimal(units(a)*units(b)/(10n**12n));
// No arbitrary URLs, redirects or trading endpoints are accepted by these adapters.
export function createAdapter(exchange, credentials, options={}, fetchImpl=fetch) {
  async function publicJson(url) {
    let response;try{response=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000)});}catch{return null;}
    if(!response.ok)return null;try{return JSON.parse(await response.text());}catch{return null;}
  }
  async function request(path, params={}) {
    await delay(fetchImpl === fetch ? 180 : 0);
    let url, init = {method:'GET',redirect:'error',signal:AbortSignal.timeout(20000),headers:{}};
    const query = new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)])).toString();
    const now=String(Date.now());
    if(exchange==='Bybit') {
      url=`https://api.bybit.com${path}${query?'?'+query:''}`;
      init.headers={'X-BAPI-API-KEY':credentials.apiKey,'X-BAPI-TIMESTAMP':now,'X-BAPI-RECV-WINDOW':'10000','X-BAPI-SIGN':hmac(credentials.secret,now+credentials.apiKey+'10000'+query)};
    } else if(exchange==='Binance') {
      const signed=query+(query?'&':'')+`timestamp=${now}&recvWindow=10000`;
      url=`https://${path.startsWith('/fapi/')?'fapi':'api'}.binance.com${path}?${signed}&signature=${hmac(credentials.secret,signed)}`;
      init.headers={'X-MBX-APIKEY':credentials.apiKey};
    } else if(exchange==='OKX') {
      const timestamp=new Date().toISOString(), target=path+(query?'?'+query:'');
      url='https://www.okx.com'+target;
      init.headers={'OK-ACCESS-KEY':credentials.apiKey,'OK-ACCESS-PASSPHRASE':credentials.passphrase,'OK-ACCESS-TIMESTAMP':timestamp,'OK-ACCESS-SIGN':hmac(credentials.secret,timestamp+'GET'+target,'base64')};
    } else if(exchange==='Hyperliquid') {
      url='https://api.hyperliquid.xyz/info';
      init={...init,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:path,user:credentials.address,...params})};
    } else throw new ExchangeError('Биржа пока не поддерживается.');
    let response;
    try { response=await fetchImpl(url,init); } catch { throw new ExchangeError('Биржа недоступна или истекло время ожидания.',true); }
    if(response.status===429 || response.status===418 || response.status>=500) throw new ExchangeError(`Биржа временно ограничила запросы (HTTP ${response.status}).`,true);
    if(!response.ok) throw new ExchangeError(`Биржа отклонила запрос (HTTP ${response.status}). Проверьте регион, IP и права ключа.`);
    let body;
    try {
      body=JSON.parse(await response.text(),(_key,value,context)=>
        typeof value==='number' && Number.isInteger(value) && !Number.isSafeInteger(value) ? context.source : value);
    } catch { throw new ExchangeError('Некорректный ответ биржи.',true); }
    const code=exchange==='Bybit'?body.retCode:exchange==='OKX'?body.code:exchange==='Binance'?body.code:0;
    if(code!==undefined && Number(code)!==0) throw new ExchangeError(`Ошибка биржи ${Number(code)}. Проверьте ключ, права, IP и тип аккаунта.`,[10006,10000,50011,-1003,-1021].includes(Number(code)));
    return exchange==='Bybit'?body.result:exchange==='OKX'?body.data:body;
  }
  async function verify() {
    if(exchange==='Bybit') {
      const v=await request('/v5/user/query-api');
      if(Number(v.readOnly)!==1) throw new ExchangeError('Нужен ключ только для чтения (Read-Only).');
      await request('/v5/account/wallet-balance',{accountType:'UNIFIED'});
    } else if(exchange==='Binance') {
      const v=await request('/sapi/v1/account/apiRestrictions');
      if(v.enableReading!==true || Object.entries(v).some(([k,x])=>k.startsWith('enable')&&k!=='enableReading'&&x===true)) throw new ExchangeError('Оставьте у ключа только Enable Reading. Торговля, переводы и вывод должны быть отключены.');
    } else if(exchange==='OKX') {
      const [v]=await request('/api/v5/account/config');
      if(!v || v.perm!=='read_only') throw new ExchangeError('Нужен ключ OKX только с разрешением Read.');
    } else await request('clearinghouseState');
  }
  async function snapshot() {
    if(exchange==='Bybit') return {wallet:await request('/v5/account/wallet-balance',{accountType:'UNIFIED'})};
    if(exchange==='OKX') return {wallet:await request('/api/v5/account/balance'),positions:await request('/api/v5/account/positions')};
    if(exchange==='Hyperliquid') return {wallet:await request('clearinghouseState')};
    const result={};
    result.spot=await request('/api/v3/account');
    if(options.futures!==false) result.futures=await request('/fapi/v3/account');
    const tickers=await publicJson('https://api.binance.com/api/v3/ticker/price');
    if(Array.isArray(tickers)) {
      const prices=new Map(tickers.map(v=>[v.symbol,v.price]));let total=0n,unvalued=[];
      for(const b of result.spot?.balances||[]) {
        const amount=units(b.free||'0')+units(b.locked||'0');if(!amount)continue;
        const price=['USDT','USDC','FDUSD'].includes(b.asset)?'1':prices.get(b.asset+'USDT');
        if(price)total+=units(multiply(decimal(amount),price));else unvalued.push(b.asset);
      }
      result.spotEquityUsd=decimal(total);result.unvaluedSpotAssets=unvalued;
    }
    return result;
  }
  function streams(now) {
    if(exchange==='Bybit') return ['fills:spot','fills:linear','ledger:linear'].map(id=>({id,start:now-730*DAY,window:7*DAY}));
    if(exchange==='Binance') return [
      ...(options.futures!==false?[{id:'income',start:now-89*DAY,window:7*DAY}]:[]),
      ...(options.spotSymbols||[]).map(symbol=>({id:'spot:'+symbol,start:Date.UTC(2017,6,1),window:DAY})),
    ];
    if(exchange==='OKX') return ['fills:SPOT','fills:SWAP','bills:SWAP'].map(id=>({id,start:now-89*DAY,window:7*DAY}));
    return [{id:'fills',start:0,window:30*DAY},{id:'funding',start:0,window:30*DAY}];
  }
  async function page(stream,start,end,cursor) {
    let rows,next,market='futures';
    if(exchange==='Bybit') {
      const [type,category]=stream.split(':');market=category==='spot'?'spot':'futures';
      const r=await request(type==='fills'?'/v5/execution/list':'/v5/account/transaction-log',{category,startTime:start,endTime:end,limit:100,cursor:cursor||undefined});
      rows=r.list; next=r.nextPageCursor||null;
      return {events:rows.map(v=>bybitEvent(v,type,market)),next};
    }
    if(exchange==='Binance') {
      if(stream==='income') {
        rows=await request('/fapi/v1/income',{startTime:start,endTime:end,limit:1000,page:cursor||1});
        next=rows.length===1000?String(Number(cursor||1)+1):null;
        return {events:rows.map(binanceIncome),next};
      }
      const symbol=stream.slice(5);
      rows=await request('/api/v3/myTrades',{symbol,...(cursor?{fromId:cursor}:{startTime:start,endTime:end}),limit:1000});
      const filtered=rows.filter(v=>v.time<=end&&v.time>=start);
      next=rows.length===1000 && rows[rows.length-1].time<=end?String(BigInt(rows[rows.length-1].id)+1n):null;
      return {events:filtered.map(v=>({id:String(v.id),time:v.time,kind:'fill',market:'spot',symbol,currency:v.commissionAsset,gross:'0',fee:'0',funding:'0',raw:v})),next};
    }
    if(exchange==='OKX') {
      const [type,instType]=stream.split(':');market=instType==='SPOT'?'spot':'futures';
      rows=await request(type==='fills'?'/api/v5/trade/fills-history':'/api/v5/account/bills-archive',{instType,begin:start,end:end+1,limit:100,after:cursor||undefined});
      next=rows.length===100?String(rows[rows.length-1].billId):null;
      return {events:rows.map(v=>okxEvent(v,type,market)),next};
    }
    rows=await request(stream==='fills'?'userFillsByTime':'userFunding',{startTime:cursor?Number(cursor):start,endTime:end,...(stream==='fills'?{aggregateByTime:false}:{})});
    // Hyperliquid has time pagination only: replay boundary; refuse silent truncation.
    const limit=stream==='fills'?2000:500;
    if(rows.length>=limit) {
      const last=Math.max(...rows.map(v=>Number(v.time)));
      if(last<=Number(cursor||start)) throw new ExchangeError('Слишком много записей с одной меткой времени. Нужен архив биржи.');
      next=String(last);
    }
    return {events:rows.map(v=>hyperliquidEvent(v,stream)),next:next||null};
  }
  return {verify,snapshot,streams,page};
}

export function normalizedCapital(exchange,data) {
  let equity='0',available=null,unrealized=null,scope='account',warning=null;
  if(exchange==='Bybit') {const v=data.wallet?.list?.[0]||{};equity=v.totalEquity||'0';available=v.totalAvailableBalance||null;unrealized=v.totalPerpUPL||null;}
  else if(exchange==='OKX') {const v=data.wallet?.[0]||{};equity=v.totalEq||'0';available=v.availEq||null;unrealized=v.upl||null;}
  else if(exchange==='Hyperliquid') {const v=data.wallet?.marginSummary||{};equity=v.accountValue||'0';available=v.totalRawUsd||null;unrealized=v.totalNtlPos&&v.accountValue?decimal(units(v.accountValue)-units(v.totalRawUsd||v.accountValue)):null;scope='perpetuals';}
  else if(exchange==='Binance') {const futures=data.futures?.totalMarginBalance||data.futures?.totalWalletBalance||'0',spot=data.spotEquityUsd||'0';equity=decimal(units(futures)+units(spot));available=data.futures?.availableBalance||null;unrealized=data.futures?.totalUnrealizedProfit||null;scope='spot+usd-m-futures';if(data.unvaluedSpotAssets?.length)warning=`Не оценены spot-активы: ${data.unvaluedSpotAssets.join(', ')}`;}
  try{units(equity);}catch{return null;}return {equityUsd:equity,availableUsd:available,unrealizedPnlUsd:unrealized,scope,warning};
}

export function bybitEvent(v,type,market) {
  const e={id:String(type==='fills'?v.execId:v.id),time:Number(type==='fills'?v.execTime:v.transactionTime),kind:type==='fills'?'fill':'transfer',market,symbol:v.symbol||'',currency:v.currency||v.feeCurrency||'',gross:'0',fee:'0',funding:'0',raw:v};
  if(type==='ledger' && ['TRADE','SETTLEMENT','LIQUIDATION','ADL'].includes(v.type)) {
    e.kind='pnl';e.gross=v.cashFlow||'0';e.fee=v.fee||'0';e.funding=v.funding||'0';
  }
  return e;
}
export function binanceIncome(v) {
  const e={id:`${v.incomeType}:${v.tranId}`,time:Number(v.time),kind:'transfer',market:'futures',symbol:v.symbol||'',currency:v.asset,gross:'0',fee:'0',funding:'0',raw:v};
  if(v.incomeType==='REALIZED_PNL') { e.kind='pnl';e.gross=v.income; }
  if(v.incomeType==='COMMISSION') {e.kind='pnl';e.fee=decimal(-units(v.income));}
  if(v.incomeType==='FUNDING_FEE') {e.kind='pnl';e.funding=v.income;}
  return e;
}
export function okxEvent(v,type,market) {
  const e={id:String(v.billId),time:Number(v.ts),kind:type==='fills'?'fill':'transfer',market,symbol:v.instId||'',currency:v.ccy||v.feeCcy||'',gross:'0',fee:'0',funding:'0',raw:v};
  // OKX fees are negative for expenses; funding is in pnl for subtypes 173/174.
  if(type==='bills' && ['2','5','8'].includes(String(v.type))) {
    e.kind='pnl';e.fee=decimal(-units(v.fee||'0'));
    if(['173','174'].includes(String(v.subType))) e.funding=v.pnl||'0'; else e.gross=v.pnl||'0';
  }
  return e;
}
export function hyperliquidEvent(v,type) {
  const funding=type==='funding', spot=!funding&&String(v.coin).startsWith('@');
  return {id:funding?`${v.hash}:${v.delta.coin}`:String(v.tid),time:Number(v.time),kind:spot?'fill':'pnl',market:spot?'spot':'futures',symbol:funding?v.delta.coin:v.coin,currency:funding?'USDC':v.feeToken||'USDC',gross:funding?'0':v.closedPnl||'0',fee:funding?'0':v.fee||'0',funding:funding?v.delta.usdc||'0':'0',raw:v};
}

