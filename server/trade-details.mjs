import { inflateRawSync } from 'node:zlib';

const QUOTES=['USDT','USDC','USD'];
const archiveCache=new Map();

export function tickerOf(symbol=''){
  const clean=String(symbol).toUpperCase().replace(/[-_/]?SWAP$/,'').replace(/[^A-Z0-9]/g,'');
  return clean.replace(new RegExp(`(${QUOTES.join('|')})$`),'')||clean||'UNKNOWN';
}

const number=(...values)=>{for(const value of values){const n=Number(value);if(Number.isFinite(n))return n;}return 0;};
const word=value=>String(value||'').toUpperCase();

export function normalizeExecution(row){
  let raw={};try{raw=typeof row.raw==='string'?JSON.parse(row.raw):row.raw||{};}catch{}
  let side=word(raw.side||raw.S||raw.tradeSide);
  if(['1','2'].includes(side))side='BUY';if(['3','4'].includes(side))side='SELL';
  if(!side&&raw.isBuyer!==undefined)side=raw.isBuyer?'BUY':'SELL';
  if(side==='B')side='BUY';if(['A','S'].includes(side))side='SELL';
  const dir=word(raw.dir||raw.direction),positionSide=word(raw.positionSide||raw.posSide||raw.holdSide);
  if(!side&&dir.includes('LONG'))side=dir.includes('CLOSE')?'SELL':'BUY';
  if(!side&&dir.includes('SHORT'))side=dir.includes('CLOSE')?'BUY':'SELL';
  const price=number(raw.execPrice,raw.price,raw.fillPx,raw.px,raw.dealPrice,raw.deal_price,raw.avgPrice);
  const quantity=Math.abs(number(raw.execQty,raw.qty,raw.fillSz,raw.sz,raw.vol,raw.quantity,raw.dealVol,raw.size));
  if(!price||!quantity||!['BUY','SELL'].includes(side))return null;
  return {id:String(row.external_id||raw.execId||raw.tradeId||raw.id),time:Number(row.time),exchange:row.exchange,account:row.label,symbol:row.symbol,market:row.market,side,positionSide,price,quantity,pnl:number(raw.realizedPnl,raw.execPnl,raw.closedPnl,raw.profit,row.gross),fee:Math.abs(number(raw.execFee,raw.commission,raw.fee,row.fee)),raw};
}

export function buildTrades(executions){
  const groups=new Map();
  for(const e of executions){const key=[e.exchange,e.account,e.symbol,e.positionSide||'ONEWAY'].join('|');const list=groups.get(key)||[];list.push(e);groups.set(key,list);}
  const result=[];
  for(const list of groups.values()){
    list.sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));let position=0,current=null,index=0;
    for(const e of list){
      const signed=e.side==='BUY'?e.quantity:-e.quantity;
      if(!current||Math.abs(position)<1e-12){position=signed;current={id:`${e.exchange}:${e.symbol}:${e.time}:${index++}`,exchange:e.exchange,account:e.account,symbol:e.symbol,market:e.market,direction:signed>0?'long':'short',entryTime:e.time,exitTime:null,entries:[e],exits:[],pnl:e.pnl,fee:e.fee,complete:false};continue;}
      if(Math.sign(position)===Math.sign(signed)){position+=signed;current.entries.push(e);current.pnl+=e.pnl;current.fee+=e.fee;continue;}
      current.exits.push(e);current.pnl+=e.pnl;current.fee+=e.fee;const before=position;position+=signed;
      if(Math.abs(position)<1e-12||Math.sign(position)!==Math.sign(before)){
        current.exitTime=e.time;current.complete=true;result.push(current);
        if(Math.abs(position)>=1e-12){current={id:`${e.exchange}:${e.symbol}:${e.time}:${index++}`,exchange:e.exchange,account:e.account,symbol:e.symbol,market:e.market,direction:position>0?'long':'short',entryTime:e.time,exitTime:null,entries:[e],exits:[],pnl:0,fee:0,complete:false};}else current=null;
      }
    }
    if(current)result.push(current);
  }
  const average=items=>{const qty=items.reduce((n,v)=>n+v.quantity,0);return qty?items.reduce((n,v)=>n+v.price*v.quantity,0)/qty:0;};
  return result.map(t=>{const clean=items=>items.map(e=>({id:e.id,time:e.time,exchange:e.exchange,account:e.account,symbol:e.symbol,market:e.market,side:e.side,positionSide:e.positionSide,price:e.price,quantity:e.quantity,pnl:e.pnl,fee:e.fee}));return {...t,entries:clean(t.entries),exits:clean(t.exits),entryPrice:average(t.entries),exitPrice:average(t.exits),executions:clean([...t.entries,...t.exits].sort((a,b)=>a.time-b.time))};}).sort((a,b)=>(b.exitTime||b.entryTime)-(a.exitTime||a.entryTime));
}

export function aggregateTrades(rows,intervalMs){
  const buckets=new Map();
  for(const row of rows){const time=number(row.T,row.time,row.ts),price=number(row.p,row.price),qty=Math.abs(number(row.q,row.qty,row.size));if(!time||!price)continue;const bucket=Math.floor(time/intervalMs)*intervalMs,old=buckets.get(bucket);if(old){old.high=Math.max(old.high,price);old.low=Math.min(old.low,price);old.close=price;old.volume+=qty;}else buckets.set(bucket,{time:bucket,open:price,high:price,low:price,close:price,volume:qty});}
  return [...buckets.values()].sort((a,b)=>a.time-b.time);
}

function unzipFirst(buffer){
  let eocd=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(buffer.readUInt32LE(i)===0x06054b50){eocd=i;break;}
  if(eocd<0)throw new Error('Повреждённый архив Binance.');const central=buffer.readUInt32LE(eocd+16);if(buffer.readUInt32LE(central)!==0x02014b50)throw new Error('Повреждённый архив Binance.');
  const method=buffer.readUInt16LE(central+10),compressed=buffer.readUInt32LE(central+20),uncompressed=buffer.readUInt32LE(central+24),local=buffer.readUInt32LE(central+42);if(uncompressed>250*1024*1024)throw new Error('Архив Binance слишком большой.');
  const start=local+30+buffer.readUInt16LE(local+26)+buffer.readUInt16LE(local+28),data=buffer.subarray(start,start+compressed);return method===8?inflateRawSync(data):method===0?data:Buffer.alloc(0);
}

async function binanceArchiveRows(symbol,from,to,fetchImpl){
  const rows=[];let day=Date.UTC(new Date(from).getUTCFullYear(),new Date(from).getUTCMonth(),new Date(from).getUTCDate());
  for(;day<=to;day+=86400000){const date=new Date(day).toISOString().slice(0,10),key=`${symbol}:${date}`;let zip=archiveCache.get(key);
    if(!zip){const url=`https://data.binance.vision/data/futures/um/daily/aggTrades/${symbol}/${symbol}-aggTrades-${date}.zip`,response=await fetchImpl(url,{headers:{Accept:'application/zip'},redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)continue;const length=Number(response.headers.get('content-length')||0);if(length>30*1024*1024)continue;zip=Buffer.from(await response.arrayBuffer());archiveCache.set(key,zip);while(archiveCache.size>4)archiveCache.delete(archiveCache.keys().next().value);}
    const csv=unzipFirst(zip).toString('utf8');let offset=0;
    while(offset<csv.length){const next=csv.indexOf('\n',offset),line=csv.slice(offset,next<0?csv.length:next);offset=next<0?csv.length:next+1;if(!/^\d/.test(line))continue;const fields=line.split(','),rawTime=Number(fields[5]),time=rawTime>1e14?Math.floor(rawTime/1000):rawTime;if(time>=from&&time<=to)rows.push({T:time,p:fields[1],q:fields[2]});}
  }
  return rows;
}

export async function marketCandles({exchange,symbol,market,from,to,intervalMs,fetchImpl=fetch}){
  const safeSymbol=String(symbol).toUpperCase().replace(/[^A-Z0-9]/g,'');if(!safeSymbol)throw new Error('Некорректный тикер.');
  if(intervalMs>=60000){
    const intervals={60000:'1m',300000:'5m',3600000:'1h',86400000:'1d'},interval=intervals[intervalMs],endpoints={Aster:market==='spot'?'https://sapi.asterdex.com/api/v3/klines':'https://fapi.asterdex.com/fapi/v3/klines',Binance:market==='spot'?'https://api.binance.com/api/v3/klines':'https://fapi.binance.com/fapi/v1/klines',MEXC:'https://api.mexc.com/api/v3/klines'},endpoint=endpoints[exchange];if(!endpoint||!interval)return [];
    const url=new URL(endpoint);url.searchParams.set('symbol',safeSymbol);url.searchParams.set('interval',interval);url.searchParams.set('startTime',String(from));url.searchParams.set('endTime',String(to));url.searchParams.set('limit','1000');const response=await fetchImpl(url,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)return [];
    const body=await response.json(),rows=Array.isArray(body)?body:body?.data||[];return rows.map(v=>({time:Number(v[0]),open:Number(v[1]),high:Number(v[2]),low:Number(v[3]),close:Number(v[4]),volume:Number(v[5])})).filter(v=>Number.isFinite(v.time)&&Number.isFinite(v.close));
  }
  const hosts={Aster:market==='spot'?'https://sapi.asterdex.com/api/v3/aggTrades':'https://fapi.asterdex.com/fapi/v3/aggTrades',Binance:market==='spot'?'https://api.binance.com/api/v3/aggTrades':'https://fapi.binance.com/fapi/v1/aggTrades',MEXC:'https://api.mexc.com/api/v3/aggTrades'};
  const endpoint=hosts[exchange];if(!endpoint)return [];
  const rows=[];let cursor=from;const maxPages=intervalMs===1000?64:16;
  for(let page=0;page<maxPages&&cursor<=to;page++){
    const url=new URL(endpoint);url.searchParams.set('symbol',safeSymbol);url.searchParams.set('startTime',String(cursor));url.searchParams.set('endTime',String(to));url.searchParams.set('limit','1000');
    const response=await fetchImpl(url,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok){if(exchange==='Binance'&&market!=='spot')return aggregateTrades(await binanceArchiveRows(safeSymbol,from,to,fetchImpl),intervalMs);return [];}
    const body=await response.json(),batch=Array.isArray(body)?body:body?.data||[];rows.push(...batch);if(batch.length<1000)break;
    const lastTime=number(batch.at(-1)?.T,batch.at(-1)?.time,batch.at(-1)?.ts);if(!lastTime||lastTime<cursor)break;cursor=lastTime+1;
  }
  return aggregateTrades(rows,intervalMs);
}
