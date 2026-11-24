import { createHash, createHmac } from 'node:crypto';
import { decimal, multiply, units } from './security.mjs';
import { createExtraAdapter } from './exchanges-extra.mjs';

export const DAY = 86400000;
export const catalog = [
  { id:'Bybit', enabled:true, passphrase:false, notice:'Единый аккаунт UTA: исполнения spot/linear и журнал PnL за последние 2 года. Старый Classic Account не поддерживается.' },
  { id:'Binance', enabled:true, passphrase:false, notice:'USDⓈ-M: журнал доходов за доступные API 3 месяца. Spot-пары определяются и загружаются автоматически; первичный поиск может занять несколько минут.' },
  { id:'OKX', enabled:true, passphrase:true, notice:'Исполнения и финансовый журнал за последние 3 месяца. Для старой истории потребуется архив биржи.' },
  { id:'Hyperliquid', enabled:true, address:true, notice:'Perpetuals и Spot подключаются только по публичному адресу. Для Spot используется закрытый PnL из исполнений Hyperliquid; приватный ключ не нужен.' },
  { id:'Kraken', enabled:true, passphrase:false, notice:'Kraken Spot. Включите только Query Funds, Query Open Orders & Trades и Query Closed Orders & Trades. Торговля, переводы и вывод должны быть отключены.' },
  { id:'Gate.io',enabled:true,notice:'Spot и USDT perpetuals. История биржи загружается доступными окнами API.' },
  { id:'Bitget',enabled:true,passphrase:true,notice:'Classic и UTA определяются автоматически. Для UTA включите только чтение UTA management и UTA trading; тип ключа должен быть Read-only, без Withdraw.' },
  { id:'Aster',enabled:true,notice:'Aster V3: адрес и приватный ключ отдельного API Wallet с разрешением Read. Не используйте приватный ключ основного кошелька.' },
  { id:'KuCoin',enabled:true,passphrase:true,notice:'Spot-баланс и USDT Futures ledger. Оставьте только General/read permission.' },
  { id:'MEXC',enabled:true,notice:'Spot подключается по API Key и Secret. Торговые пары и доступ к USDT/USDC фьючерсам определяются автоматически; отсутствие Futures-доступа не мешает Spot. Spot API ограничивает историю одним месяцем.' },
  { id:'Lighter',enabled:true,address:true,notice:'Публичный адрес L1: капитал аккаунта. Для полной приватной истории позже понадобится signer API.' },
];
const hmac = (secret, text, encoding='hex') => createHmac('sha256',secret).update(text).digest(encoding);
export class ExchangeError extends Error { constructor(message, retryable=false) { super(message); this.name='ExchangeError';this.retryable=retryable; } }
const delay = ms => new Promise(resolve=>setTimeout(resolve, ms));
// No arbitrary URLs, redirects or trading endpoints are accepted by these adapters.
export function createAdapter(exchange, credentials, options={}, fetchImpl=fetch) {
  if(['Gate.io','Bitget','Aster','KuCoin','MEXC','Lighter'].includes(exchange))return createExtraAdapter(exchange,credentials,options,fetchImpl);
  async function publicJson(url) {
    let response;try{response=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20000)});}catch{return null;}
    if(!response.ok)return null;try{return JSON.parse(await response.text());}catch{return null;}
  }
  let krakenNonce=BigInt(Date.now())*1000n;
  async function request(path, params={}) {
    await delay(fetchImpl === fetch ? (exchange==='Kraken'?1100:exchange==='Binance'?220:180) : 0);
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
      const publicInfo=['spotMeta','spotMetaAndAssetCtxs','allMids'].includes(path);
      init={...init,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:path,...(publicInfo?{}:{user:credentials.address}),...params})};
    } else if(exchange==='Kraken') {
      const nonce=String(++krakenNonce),postData=new URLSearchParams({nonce,...Object.fromEntries(Object.entries(params).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]))}).toString();
      const message=Buffer.concat([Buffer.from(path),createHash('sha256').update(nonce+postData).digest()]);
      url='https://api.kraken.com'+path;
      init={...init,method:'POST',headers:{'API-Key':credentials.apiKey,'API-Sign':createHmac('sha512',Buffer.from(credentials.secret,'base64')).update(message).digest('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:postData};
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
    if(exchange==='Kraken') {
      const errors=Array.isArray(body.error)?body.error.filter(Boolean):[];
      if(errors.length){const detail=errors.join(', ').replace(/[\r\n]+/g,' ').slice(0,180);throw new ExchangeError(`Ошибка Kraken: ${detail}` ,/rate limit|service|temporarily|unavailable/i.test(detail));}
      return body.result;
    }
    const code=exchange==='Bybit'?body.retCode:exchange==='OKX'?body.code:exchange==='Binance'?body.code:0;
    if(code!==undefined && Number(code)!==0) {
      const detail=String(body.retMsg||body.msg||'').replace(/[\r\n]+/g,' ').slice(0,180);
      throw new ExchangeError(`Ошибка биржи ${Number(code)}${detail?`: ${detail}`:''}. Проверьте ключ, права, IP и тип аккаунта.`,[10006,10000,50011,-1003,-1021].includes(Number(code)));
    }
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
    } else if(exchange==='Kraken') {
      const info=await request('/0/private/GetApiKeyInfo'),permissions=new Set(info?.permissions||[]),required=['query-funds','query-open-trades','query-closed-trades'],write=['add-funds','withdraw-funds','earn-funds','modify-trades','close-trades','add-withdraw-address','update-withdraw-address'];
      if(required.some(permission=>!permissions.has(permission)))throw new ExchangeError('Для Kraken нужны только права Query Funds, Query Open Orders & Trades и Query Closed Orders & Trades.');
      if(write.some(permission=>permissions.has(permission)))throw new ExchangeError('У ключа Kraken найдены права на изменение счёта. Оставьте только три права чтения.');
      await request('/0/private/Balance');
    } else await request('clearinghouseState');
  }
  async function prepare() {
    if(exchange==='Hyperliquid') {
      const meta=await request('spotMeta'),tokens=new Map((meta?.tokens||[]).map(v=>[Number(v.index),String(v.name||v.fullName||v.index).toUpperCase()])),names={};
      for(const pair of meta?.universe||[]){const base=tokens.get(Number(pair.tokens?.[0]))||'',quote=tokens.get(Number(pair.tokens?.[1]))||'USDC';if(pair.name&&base)names[String(pair.name)]=`${base==='XBT'?'BTC':base}${quote}`;}
      if(JSON.stringify(names)!==JSON.stringify(options.hyperliquidSpotNames||{})){options.hyperliquidSpotNames=names;return true;}return false;
    }
    if(exchange==='Kraken') {
      if(options.krakenPairsVersion===1)return false;
      const info=await publicJson('https://api.kraken.com/0/public/AssetPairs'),pairs={};
      for(const [key,value] of Object.entries(info?.result||{})){const parts=String(value.wsname||value.altname||key).toUpperCase().split('/'),base=(parts[0]||'').replace(/^X(?=[A-Z]{3}$)/,'').replace('XBT','BTC').replace('XDG','DOGE'),quote=(parts[1]||'USD').replace(/^Z(?=[A-Z]{3}$)/,'');pairs[key]={symbol:`${base}${quote}`,quote};if(value.altname)pairs[value.altname]={symbol:`${base}${quote}`,quote};}
      if(!Object.keys(pairs).length)throw new ExchangeError('Kraken не отдал каталог торговых пар. Повторим автоматически.',true);
      options.krakenPairs=pairs;options.krakenPairsVersion=1;return true;
    }
    if(exchange!=='Binance')return false;
    let changed=false;
    if(options.spotAuto!==true){options.spotAuto=true;changed=true;}
    if(!Array.isArray(options.spotSymbols)){options.spotSymbols=[];changed=true;}
    if(!Array.isArray(options.spotCandidates)||!options.spotCandidates.length) {
      const info=await publicJson('https://api.binance.com/api/v3/exchangeInfo');
      if(!Array.isArray(info?.symbols))throw new ExchangeError('Binance не отдал каталог spot-пар. Повторим автоматически.',true);
      options.spotCandidates=[...new Set(info.symbols
        .filter(v=>v?.symbol&&v.status==='TRADING'&&v.isSpotTradingAllowed!==false)
        .map(v=>String(v.symbol).toUpperCase()))].sort();
      changed=true;
    }
    return changed;
  }
  async function snapshot() {
    if(exchange==='Bybit') return {wallet:await request('/v5/account/wallet-balance',{accountType:'UNIFIED'})};
    if(exchange==='OKX') return {wallet:await request('/api/v5/account/balance'),positions:await request('/api/v5/account/positions')};
    if(exchange==='Hyperliquid') {
      const [wallet,spot,portfolio]=await Promise.all([request('clearinghouseState'),request('spotClearinghouseState'),request('portfolio')]);
      return {wallet,spot,portfolio};
    }
    if(exchange==='Kraken') {const [balance,trade]=await Promise.all([request('/0/private/Balance'),request('/0/private/TradeBalance',{asset:'ZUSD'})]);return {equityUsd:trade?.eb||'0',availableUsd:trade?.mf||null,balance,trade,scope:'spot-equivalent-usd'};}
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
  function streams(now,state={}) {
    // Keep a one-day cushion: Bybit rejects the exact rolling two-year boundary
    // when its server clock advances between creating the stream and the request.
    if(exchange==='Bybit') return ['fills:spot','fills:linear','ledger:linear'].map(id=>({id,start:now-729*DAY,window:7*DAY}));
    if(exchange==='Binance') return [
      ...(options.futures!==false?[{id:'income',start:now-89*DAY,window:7*DAY}]:[]),
      ...(options.futuresSymbols||[]).map(symbol=>({id:'futures:'+symbol,start:now-89*DAY,window:7*DAY})),
      ...(state.discoverSpot?(options.spotCandidates||[]).map(symbol=>({id:'spot-scan:'+symbol,start:now,window:1})):[]),
      ...(options.spotSymbols||[]).map(symbol=>({id:'spot:'+symbol,start:Date.UTC(2017,6,1),window:DAY})),
    ];
    if(exchange==='OKX') return ['fills:SPOT','fills:SWAP','bills:SWAP'].map(id=>({id,start:now-89*DAY,window:7*DAY}));
    if(exchange==='Kraken') return [{id:'spot',start:Date.UTC(2017,0,1),window:30*DAY}];
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
        return {events:rows.map(binanceIncome),next,discoveredFuturesSymbols:[...new Set(rows.map(v=>String(v.symbol||'')).filter(v=>/^[A-Z0-9]{4,30}$/.test(v)))]};
      }
      if(stream.startsWith('futures:')){
        const symbol=stream.slice(8);rows=await request('/fapi/v1/userTrades',{symbol,...(cursor?{fromId:cursor}:{startTime:start,endTime:end}),limit:1000});
        const filtered=rows.filter(v=>v.time<=end&&v.time>=start);next=rows.length===1000&&rows.at(-1).time<=end?String(BigInt(rows.at(-1).id)+1n):null;
        return {events:filtered.map(v=>({id:String(v.id),time:v.time,kind:'fill',market:'futures',symbol,currency:v.commissionAsset||'USDT',gross:'0',fee:v.commission||'0',funding:'0',raw:v})),next};
      }
      const scan=stream.startsWith('spot-scan:'),symbol=stream.slice(scan?10:5);
      if(scan) {
        rows=await request('/api/v3/myTrades',{symbol,limit:1});
        return {events:rows.map(v=>({id:String(v.id),time:v.time,kind:'fill',market:'spot',symbol,currency:v.commissionAsset,gross:'0',fee:'0',funding:'0',raw:v})),next:null,discoveredSymbol:rows.length?symbol:null};
      }
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
    if(exchange==='Kraken') {
      const offset=Number(cursor||0),result=await request('/0/private/TradesHistory',{type:'all',trades:false,consolidate_taker:false,start:Math.floor(start/1000),end:Math.floor(end/1000),ofs:offset,limit:50}),entries=Object.entries(result?.trades||{}),count=Number(result?.count||entries.length);
      next=offset+entries.length<count?String(offset+entries.length):null;
      return {events:entries.map(([id,v])=>{const pair=options.krakenPairs?.[v.pair]||{symbol:String(v.pair||'').replace(/[^A-Z0-9]/gi,''),quote:/USDT$/i.test(v.pair||'')?'USDT':/USDC$/i.test(v.pair||'')?'USDC':'USD'};return {id,time:Math.round(Number(v.time)*1000),kind:'fill',market:'spot',symbol:pair.symbol,currency:pair.quote,gross:'0',fee:'0',funding:'0',raw:{...v,id,quote:pair.quote}};}),next};
    }
    rows=await request(stream==='fills'?'userFillsByTime':'userFunding',{startTime:cursor?Number(cursor):start,endTime:end,...(stream==='fills'?{aggregateByTime:false}:{})});
    // Hyperliquid has time pagination only: replay boundary; refuse silent truncation.
    const limit=stream==='fills'?2000:500;
    if(rows.length>=limit) {
      const last=Math.max(...rows.map(v=>Number(v.time)));
      if(last<=Number(cursor||start)) throw new ExchangeError('Слишком много записей с одной меткой времени. Нужен архив биржи.');
      next=String(last);
    }
    const events=[];for(const value of rows){const fill=hyperliquidEvent(value,stream,options.hyperliquidSpotNames);events.push(fill);if(stream==='fills'&&fill.market==='spot')events.push({...fill,id:`pnl:${fill.id}`,kind:'pnl',gross:value.closedPnl||'0',fee:value.fee||'0',raw:{sourceTid:value.tid,closedPnl:value.closedPnl||'0',fee:value.fee||'0',feeToken:value.feeToken||'USDC',spotPnl:true}});}
    return {events,next:next||null};
  }
  return {verify,prepare,snapshot,streams,page,options};
}

export function normalizedCapital(exchange,data) {
  if(data?.equityUsd!==undefined)return {equityUsd:data.equityUsd,availableUsd:data.availableUsd||null,unrealizedPnlUsd:data.unrealizedPnlUsd||null,scope:data.scope||'account',warning:data.warning||null};
  let equity='0',available=null,unrealized=null,scope='account',warning=null;
  if(exchange==='Bybit') {const v=data.wallet?.list?.[0]||{};equity=v.totalEquity||'0';available=v.totalAvailableBalance||null;unrealized=v.totalPerpUPL||null;}
  else if(exchange==='OKX') {const v=data.wallet?.[0]||{};equity=v.totalEq||'0';available=v.availEq||null;unrealized=v.upl||null;}
  else if(exchange==='Hyperliquid') {
    const periods=Array.isArray(data.portfolio)?Object.fromEntries(data.portfolio):{};
    const history=periods.day?.accountValueHistory||periods.allTime?.accountValueHistory||[];
    const portfolioValue=history.length?history[history.length-1]?.[1]:null;
    const v=data.wallet?.marginSummary||{};
    equity=portfolioValue||v.accountValue||'0';available=v.totalRawUsd||null;
    unrealized=v.totalNtlPos&&v.accountValue?decimal(units(v.accountValue)-units(v.totalRawUsd||v.accountValue)):null;
    scope=portfolioValue?'portfolio':'perpetuals';
  }
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
export function hyperliquidEvent(v,type,spotNames={}) {
  const funding=type==='funding', spot=!funding&&String(v.coin).startsWith('@');
  return {id:funding?`${v.hash}:${v.delta.coin}`:String(v.tid),time:Number(v.time),kind:spot?'fill':'pnl',market:spot?'spot':'futures',symbol:funding?v.delta.coin:(spotNames[v.coin]||v.coin),currency:funding?'USDC':v.feeToken||'USDC',gross:funding||spot?'0':v.closedPnl||'0',fee:funding||spot?'0':v.fee||'0',funding:funding?v.delta.usdc||'0':'0',raw:v};
}

