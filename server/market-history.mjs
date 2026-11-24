const intervals = new Map([
  [1000, '1s'], [60000, '1m'], [300000, '5m'], [900000, '15m'],
  [3600000, '1h'], [14400000, '4h'], [86400000, '1d'],
]);

export const chartIntervals = new Set([...intervals.keys(), 5000, 15000]);

export function candle(time, open, high, low, close, volume) {
  return {time:Number(time), open:Number(open), high:Number(high), low:Number(low), close:Number(close), volume:Number(volume)||0};
}

export function normalizeCandles(rows, from, to) {
  const valid = rows.filter(v => v.time >= from && v.time <= to &&
    [v.open,v.high,v.low,v.close].every(n => Number.isFinite(n) && n > 0) &&
    v.low <= Math.min(v.open,v.close) && v.high >= Math.max(v.open,v.close));
  return [...new Map(valid.map(v => [v.time,v])).values()].sort((a,b) => a.time-b.time);
}

async function json(fetchImpl, endpoint, params={}, body, signal) {
  const url = new URL(endpoint);
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key,String(value));
  const deadline = AbortSignal.timeout(6500);
  const response = await fetchImpl(url,{redirect:'error',signal:signal?AbortSignal.any([signal,deadline]):deadline,
    headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},
    ...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  if (!response.ok) throw new Error(`Market data HTTP ${response.status}`);
  return response.json();
}

const standard = row => candle(...row.slice(0,6));
const sec = ms => Math.floor(ms/1000);
const quotePair = (symbol,separator) => symbol.replace(/(USDT|USDC|FDUSD|USD|EUR|BTC|ETH)$/,`${separator}$1`);

export async function venueCandles({exchange,symbol,coin,market,from,to,intervalMs,fetchImpl,signal}) {
  const interval = intervals.get(intervalMs);
  if (!interval) return [];
  const get = (url,params,body) => json(fetchImpl,url,params,body,signal);
  const compact = symbol.replace(/[^A-Z0-9]/g,'');
  const spot = market === 'spot';
  if (intervalMs < 60000 && !(exchange==='Binance'&&spot)) return [];

  if (exchange==='Binance'||exchange==='Aster'||exchange==='MEXC') {
    if (exchange==='MEXC'&&!spot) {
      const mexcIntervals = {'1m':'Min1','5m':'Min5','15m':'Min15','1h':'Min60','4h':'Hour4','1d':'Day1'};
      const data = (await get(`https://api.mexc.com/api/v1/contract/kline/${quotePair(compact,'_')}`,
        {interval:mexcIntervals[interval],start:sec(from),end:sec(to)}))?.data;
      return (data?.time||[]).map((t,i) => candle(t*1000,data.open[i],data.high[i],data.low[i],data.close[i],data.vol?.[i]));
    }
    const endpoint = {
      Binance:spot?'https://data-api.binance.vision/api/v3/klines':'https://fapi.binance.com/fapi/v1/klines',
      Aster:spot?'https://sapi.asterdex.com/api/v3/klines':'https://fapi.asterdex.com/fapi/v3/klines',
      MEXC:'https://api.mexc.com/api/v3/klines',
    }[exchange];
    const result = await get(endpoint,{symbol:compact,interval,startTime:from,endTime:to,limit:1000});
    return (Array.isArray(result)?result:result.data||[]).map(standard);
  }
  if (exchange==='Bybit') {
    const result = await get('https://api.bybit.com/v5/market/kline',{
      category:spot?'spot':'linear',symbol:compact,interval:interval==='1d'?'D':intervalMs/60000,start:from,end:to,limit:1000,
    });
    return (result?.result?.list||[]).map(standard);
  }
  if (exchange==='OKX') {
    const instId = symbol.includes('-')?symbol:quotePair(compact,'-')+(spot?'':'-SWAP');
    const bar = interval==='1d'?'1Dutc':interval.endsWith('h')?interval.toUpperCase():interval;
    const rows = [];
    let cursor = to+1;
    for (let page=0; page<10 && cursor>from; page++) {
      const result = await get('https://www.okx.com/api/v5/market/history-candles',{instId,bar,after:cursor,before:from-1,limit:300});
      const batch = result?.data||[];
      rows.push(...batch.map(standard));
      const oldest = Math.min(...batch.map(row => Number(row[0])));
      if (batch.length<300||oldest>=cursor) break;
      cursor=oldest;
    }
    return rows;
  }
  if (exchange==='Hyperliquid') {
    const marketCoin = coin || (spot&&symbol==='PURRUSDC'?'PURR/USDC':symbol);
    if (spot&&!/^@\d+$|^PURR\/USDC$/.test(marketCoin)) return [];
    const result = await get('https://api.hyperliquid.xyz/info',{},
      {type:'candleSnapshot',req:{coin:marketCoin,interval,startTime:from,endTime:to}});
    return (Array.isArray(result)?result:[]).map(v => candle(v.t,v.o,v.h,v.l,v.c,v.v));
  }
  if (exchange==='Gate.io') {
    const pair = quotePair(compact,'_');
    const endpoint = spot?'spot/candlesticks':`futures/${pair.endsWith('_USDC')?'usdc':'usdt'}/candlesticks`;
    const result = await get(`https://api.gateio.ws/api/v4/${endpoint}`,
      {[spot?'currency_pair':'contract']:pair,interval,from:sec(from),to:sec(to)});
    return (Array.isArray(result)?result:[]).map(v => spot?candle(v[0]*1000,v[5],v[3],v[4],v[2],v[6]||v[1]):candle(v.t*1000,v.o,v.h,v.l,v.c,v.v));
  }
  if (exchange==='Bitget') {
    const category=spot?'SPOT':compact.endsWith('USDC')?'USDC-FUTURES':'USDT-FUTURES';
    const params={category,symbol:compact,interval:intervalMs>=3600000?interval.toUpperCase():interval,startTime:from,endTime:to,limit:1000};
    const result=await get('https://api.bitget.com/api/v3/market/candles',params);
    if(result.data?.length)return result.data.map(standard);
    const history=await get('https://api.bitget.com/api/v3/market/history-candles',{...params,limit:100});
    return (history.data||[]).map(standard);
  }
  if (exchange==='KuCoin') {
    if (spot) {
      const type={'1m':'1min','5m':'5min','15m':'15min','1h':'1hour','4h':'4hour','1d':'1day'}[interval];
      const result = await get('https://api.kucoin.com/api/v1/market/candles',{symbol:quotePair(compact,'-'),type,startAt:sec(from),endAt:sec(to)});
      return (result?.data||[]).map(v => candle(v[0]*1000,v[1],v[3],v[4],v[2],v[5]));
    }
    const contract = compact.endsWith('USDT')?compact.replace(/^BTC/,'XBT')+'M':compact;
    const rows = [];
    for(let start=from;start<=to;start+=200*intervalMs) {
      const result = await get('https://api-futures.kucoin.com/api/v1/kline/query',
        {symbol:contract,granularity:intervalMs/60000,from:start,to:Math.min(to,start+199*intervalMs)});
      rows.push(...(result?.data||[]).map(standard));
    }
    return rows;
  }
  if (exchange==='Kraken'&&spot) {
    const pair = quotePair(compact,'').replace(/^BTC/,'XBT');
    const result = await get('https://api.kraken.com/0/public/OHLC',{pair,interval:intervalMs/60000,since:sec(from)-1});
    const series = Object.values(result?.result||{}).find(Array.isArray)||[];
    return series.map(v => candle(v[0]*1000,v[1],v[2],v[3],v[4],v[6]));
  }
  return [];
}
