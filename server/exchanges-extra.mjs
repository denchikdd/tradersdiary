import { createHash,createHmac } from 'node:crypto';
import { decimal,units } from './security.mjs';
const DAY=86400000,hmac=(algo,key,text,enc='hex')=>createHmac(algo,key).update(text).digest(enc);
class ExchangeError extends Error{constructor(message,retryable=false){super(message);this.name='ExchangeError';this.retryable=retryable;}}
const safeAmount=v=>{try{return decimal(units(v||'0'));}catch{return '0';}};
const event=(v,x={})=>({id:String(x.id??v.id??v.tradeId??v.billId??v.orderId),time:Number(x.time??v.time??v.cTime??v.createdAt??v.ts),kind:x.kind||'fill',market:x.market||'futures',symbol:x.symbol??v.symbol??v.contract??v.instId??'',currency:x.currency??v.currency??v.marginCoin??v.feeCoin??v.feeCurrency??v.commissionAsset??'USDT',gross:safeAmount(x.gross),fee:safeAmount(x.fee),funding:safeAmount(x.funding),raw:v});
const stableTotal=rows=>decimal((rows||[]).reduce((n,v)=>{if(!['USDT','USDC','USD','FDUSD'].includes(v.asset||v.coin||v.currency))return n;const amount=v.equity??v.balance??(v.free!==undefined?decimal(units(v.free||'0')+units(v.locked||'0')):v.available||'0');return n+units(amount);},0n));

async function parse(response){if(response.status===429||response.status===418||response.status>=500)throw new ExchangeError(`Биржа временно ограничила запросы (HTTP ${response.status}).`,true);if(!response.ok)throw new ExchangeError(`Биржа отклонила запрос (HTTP ${response.status}). Проверьте ключ, passphrase, регион и IP.`);try{return JSON.parse(await response.text());}catch{throw new ExchangeError('Некорректный ответ биржи.',true);}}
async function send(fetchImpl,url,headers={}){let r;try{r=await fetchImpl(url,{method:'GET',headers,redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new ExchangeError('Биржа недоступна или истекло время ожидания.',true);}return parse(r);}

export function createExtraAdapter(exchange,credentials,options={},fetchImpl=fetch){
  async function mexcContract(path,params={}){const sorted=Object.entries(params).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)),query=new URLSearchParams(sorted.map(([k,v])=>[k,String(v)])).toString(),ts=String(Date.now()),headers={'ApiKey':credentials.apiKey,'Request-Time':ts,'Signature':hmac('sha256',credentials.secret,credentials.apiKey+ts+query),'Content-Type':'application/json'},body=await send(fetchImpl,`https://contract.mexc.com${path}${query?'?'+query:''}`,headers);if(body.success===false||Number(body.code)!==0)throw new ExchangeError(body.message||`Ошибка MEXC Futures ${body.code}.`);return body.data;}
  async function request(path,params={},host){
    const query=new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)])).toString(),now=Date.now();let url,headers={};
    if(exchange==='Aster'||exchange==='MEXC'){
      const signed=query+(query?'&':'')+`timestamp=${now}&recvWindow=10000`,base=host||(exchange==='Aster'?'https://fapi.asterdex.com':'https://api.mexc.com');
      url=`${base}${path}?${signed}&signature=${hmac('sha256',credentials.secret,signed)}`;headers={'X-MBX-APIKEY':credentials.apiKey};
    }else if(exchange==='Gate.io'){
      const prefix='/api/v4',ts=String(Math.floor(now/1000)),bodyHash=createHash('sha512').update('').digest('hex'),sign=`GET\n${prefix+path}\n${query}\n${bodyHash}\n${ts}`;
      url=`https://api.gateio.ws${prefix}${path}${query?'?'+query:''}`;headers={KEY:credentials.apiKey,Timestamp:ts,SIGN:hmac('sha512',credentials.secret,sign)};
    }else if(exchange==='Bitget'){
      const target=path+(query?'?'+query:''),ts=String(now);url='https://api.bitget.com'+target;headers={'ACCESS-KEY':credentials.apiKey,'ACCESS-TIMESTAMP':ts,'ACCESS-PASSPHRASE':credentials.passphrase,'ACCESS-SIGN':hmac('sha256',credentials.secret,ts+'GET'+target,'base64')};
    }else if(exchange==='KuCoin'){
      const target=path+(query?'?'+query:''),ts=String(now),base=host||'https://api.kucoin.com';url=base+target;headers={'KC-API-KEY':credentials.apiKey,'KC-API-TIMESTAMP':ts,'KC-API-SIGN':hmac('sha256',credentials.secret,ts+'GET'+target,'base64'),'KC-API-PASSPHRASE':hmac('sha256',credentials.secret,credentials.passphrase,'base64'),'KC-API-KEY-VERSION':'2'};
    }else if(exchange==='Lighter'){
      url=`https://mainnet.zklighter.elliot.ai${path}${query?'?'+query:''}`;
    }else throw new ExchangeError('Биржа пока не поддерживается.');
    const body=await send(fetchImpl,url,headers);
    if(exchange==='Bitget'&&body.code!=='00000')throw new ExchangeError(body.msg||'Ошибка Bitget API.');
    if(exchange==='KuCoin'&&body.code!=='200000')throw new ExchangeError(body.msg||'Ошибка KuCoin API.');
    if(body?.code!==undefined&&Number(body.code)<0)throw new ExchangeError(body.msg||`Ошибка биржи ${body.code}.`);
    return exchange==='Bitget'||exchange==='KuCoin'?body.data:body;
  }
  async function verify(){
    if(exchange==='Aster')return void await request('/fapi/v2/balance');
    if(exchange==='MEXC'){await request('/api/v3/account');if(options.futures!==false)await mexcContract('/api/v1/private/account/assets');return;}
    if(exchange==='Gate.io')return void await request('/spot/accounts');
    if(exchange==='Bitget')return void await request('/api/v2/spot/account/assets');
    if(exchange==='KuCoin'){const info=await request('/api/v1/user/api-key');if(String(info.permission||'').split(',').some(v=>['Withdrawal','Transfer','InnerTransfer','FlexTransfers'].includes(v)))throw new ExchangeError('Отключите у ключа KuCoin вывод и переводы. Оставьте General для чтения.');return;}
    const accounts=await request('/api/v1/account',{by:'l1_address',value:credentials.address,active_only:false});if(!(accounts.accounts||accounts.data||[]).length)throw new ExchangeError('Аккаунт Lighter по этому адресу не найден.');
  }
  async function snapshot(){
    if(exchange==='Aster'){const a=await request('/fapi/v4/account');return {equityUsd:a.totalMarginBalance||a.totalWalletBalance||'0',wallet:a,scope:'perpetuals'};}
    if(exchange==='MEXC'){const a=await request('/api/v3/account'),f=options.futures!==false?await mexcContract('/api/v1/private/account/assets'):[];return {equityUsd:decimal(units(stableTotal(a.balances))+units(stableTotal(f))),spot:a,futures:f,scope:'spot-stablecoins+futures',warning:'В spot-капитале учитываются USD-стейблкоины; остальные spot-активы пока не оценены.'};}
    if(exchange==='Gate.io'){const [spot,futures]=await Promise.all([request('/spot/accounts'),request('/futures/usdt/accounts')]);return {equityUsd:decimal(units(stableTotal(spot))+units(futures.total||futures.total_equity||'0')),spot,futures,scope:'spot-stablecoins+usdt-futures'};}
    if(exchange==='Bitget'){const [spot,usdt,usdc]=await Promise.all([request('/api/v2/spot/account/assets'),request('/api/v2/mix/account/accounts',{productType:'USDT-FUTURES'}),request('/api/v2/mix/account/accounts',{productType:'USDC-FUTURES'})]);const fs=[...(usdt||[]),...(usdc||[])].reduce((n,v)=>n+units(v.accountEquity||v.usdtEquity||'0'),0n);return {equityUsd:decimal(units(stableTotal(spot))+fs),spot,futures:[...usdt,...usdc],scope:'spot-stablecoins+futures'};}
    if(exchange==='KuCoin'){const [spot,futures]=await Promise.all([request('/api/v1/accounts'),request('/api/v1/account-overview',{currency:'USDT'},'https://api-futures.kucoin.com')]);return {equityUsd:decimal(units(stableTotal(spot))+units(futures.accountEquity||'0')),spot,futures,scope:'spot-stablecoins+usdt-futures'};}
    const a=await request('/api/v1/account',{by:'l1_address',value:credentials.address,active_only:false}),account=(a.accounts||a.data||[])[0]||{};return {equityUsd:account.collateral||account.total_asset_value||account.available_balance||'0',wallet:account,scope:'lighter-account'};
  }
  function streams(now){
    if(exchange==='Aster')return [{id:'income',start:now-89*DAY,window:7*DAY}];
    if(exchange==='MEXC')return [...(options.spotSymbols||[]).map(symbol=>({id:'spot:'+symbol,start:now-30*DAY,window:7*DAY})),...(options.futures===false?[]:(options.spotSymbols||[]).map(symbol=>({id:'futures:'+symbol.replace(/(USDT|USDC)$/,'_$1'),start:now-89*DAY,window:89*DAY})))];
    if(exchange==='Gate.io')return [{id:'spot',start:now-365*DAY,window:7*DAY},{id:'futures',start:now-365*DAY,window:7*DAY}];
    if(exchange==='Bitget')return ['USDT-FUTURES','USDC-FUTURES'].map(id=>({id:'bills:'+id,start:now-89*DAY,window:7*DAY}));
    if(exchange==='KuCoin')return [{id:'futures-ledger',start:now-365*DAY,window:DAY}];
    return [];
  }
  async function page(stream,start,end,cursor){let rows=[],next=null;
    if(exchange==='Aster'){rows=await request('/fapi/v1/income',{startTime:start,endTime:end,limit:1000,page:cursor||1});next=rows.length===1000?String(Number(cursor||1)+1):null;return {events:rows.map(v=>{const e=event(v,{id:`${v.incomeType}:${v.tranId}`,time:v.time,symbol:v.symbol,currency:v.asset,kind:'transfer'});if(v.incomeType==='REALIZED_PNL'){e.kind='pnl';e.gross=v.income;}if(v.incomeType==='COMMISSION'){e.kind='pnl';e.fee=decimal(-units(v.income));}if(v.incomeType==='FUNDING_FEE'){e.kind='pnl';e.funding=v.income;}return e;}),next};}
    if(exchange==='MEXC'){const futures=stream.startsWith('futures:'),symbol=stream.slice(futures?8:5);if(futures){const r=await mexcContract('/api/v1/private/order/list/order_deals',{symbol,start_time:start,end_time:end,page_num:cursor||1,page_size:100});rows=r?.resultList||r||[];next=rows.length===100?String(Number(cursor||1)+1):null;return {events:rows.map(v=>event(v,{market:'futures',kind:'pnl',time:v.timestamp,symbol:v.symbol,gross:v.profit,fee:v.fee,currency:v.feeCurrency||'USDT'})),next};}rows=await request('/api/v3/myTrades',{symbol,startTime:start,endTime:end,limit:1000,fromId:cursor||undefined});next=rows.length===1000?String(rows.at(-1).id):null;return {events:rows.map(v=>event(v,{market:'spot',symbol,fee:v.commission,currency:v.commissionAsset,time:v.time})),next};}
    if(exchange==='Gate.io'){rows=stream==='spot'?await request('/spot/my_trades',{from:Math.floor(start/1000),to:Math.floor(end/1000),limit:1000,page:cursor||1}):await request('/futures/usdt/account_book',{from:Math.floor(start/1000),to:Math.floor(end/1000),limit:1000,page:cursor||1,type:'pnl,fee,fund'});next=rows.length===1000?String(Number(cursor||1)+1):null;return {events:rows.map(v=>stream==='spot'?event(v,{market:'spot',time:Number(v.create_time_ms||v.create_time*1000),symbol:v.currency_pair,fee:v.fee,currency:v.fee_currency}):event(v,{kind:'pnl',time:Number(v.time)*1000,symbol:v.contract,gross:v.type==='pnl'?v.change:'0',fee:v.type==='fee'?decimal(-units(v.change)):'0',funding:v.type==='fund'?v.change:'0',currency:'USDT'})),next};}
    if(exchange==='Bitget'){const productType=stream.slice(6),r=await request('/api/v2/mix/account/bill',{productType,startTime:start,endTime:end,limit:100,idLessThan:cursor||undefined});rows=r?.bills||r||[];next=rows.length===100?String(rows.at(-1).id||rows.at(-1).billId):null;return {events:rows.map(v=>event(v,{id:v.billId||v.id,time:v.cTime||v.ctime,kind:'pnl',symbol:v.symbol,gross:v.businessType==='close_position'?v.amount:'0',fee:String(v.businessType||'').includes('fee')?decimal(-units(v.amount)):'0',funding:String(v.businessType||'').includes('funding')?v.amount:'0',currency:v.marginCoin||'USDT'})),next};}
    if(exchange==='KuCoin'){const r=await request('/api/v1/transaction-history',{startAt:start,endAt:end,maxCount:50,offset:cursor||undefined,forward:true},'https://api-futures.kucoin.com');rows=r.dataList||[];next=r.hasMore&&rows.length?String(rows.at(-1).offset):null;return {events:rows.map(v=>event(v,{id:v.offset,time:v.time,kind:['RealisedPNL','FundingFee','TradingFee'].includes(v.type)?'pnl':'transfer',symbol:v.remark,gross:v.type==='RealisedPNL'?v.amount:'0',fee:v.type==='TradingFee'?decimal(-units(v.amount)):'0',funding:v.type==='FundingFee'?v.amount:'0',currency:v.currency})),next};}
    return {events:[],next:null};
  }
  return {verify,snapshot,streams,page};
}

