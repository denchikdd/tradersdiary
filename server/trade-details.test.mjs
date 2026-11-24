import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateTrades,buildTrades,marketCandles,normalizeExecution,tickerOf } from './trade-details.mjs';

const row=(id,time,side,price,qty,extra={})=>normalizeExecution({external_id:id,time,exchange:'Aster',label:'Main',symbol:'AKEUSDT',market:'futures',gross:'0',fee:'0',raw:{id,side,price:String(price),qty:String(qty),...extra}});

test('trade details reconstruct long and short round trips',()=>{
  const trades=buildTrades([row('1',1000,'BUY',100,2),row('2',2000,'SELL',110,2,{realizedPnl:'20'}),row('3',3000,'SELL',120,1),row('4',4000,'BUY',100,1,{realizedPnl:'20'})]);
  assert.equal(trades.length,2);assert.equal(trades[0].direction,'short');assert.equal(trades[0].entryPrice,120);assert.equal(trades[0].exitPrice,100);
  assert.equal(trades[1].direction,'long');assert.equal(trades[1].entryPrice,100);assert.equal(trades[1].exitPrice,110);assert.equal(trades[1].pnl,20);
});

test('trade details aggregate public executions into one-second OHLC',()=>{
  const candles=aggregateTrades([{T:1001,p:'10',q:'2'},{T:1500,p:'12',q:'1'},{T:2200,p:'11',q:'3'}],1000);
  assert.deepEqual(candles,[{time:1000,open:10,high:12,low:10,close:12,volume:3},{time:2000,open:11,high:11,low:11,close:11,volume:3}]);
  assert.equal(tickerOf('AKE-USDT-SWAP'),'AKE');
});

function storedZip(text){
  const name=Buffer.from('trades.csv'),data=Buffer.from(text),local=Buffer.alloc(30),central=Buffer.alloc(46),eocd=Buffer.alloc(22);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0,8);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,6);central.writeUInt16LE(0,10);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(0,42);eocd.writeUInt32LE(0x06054b50);eocd.writeUInt16LE(1,8);eocd.writeUInt16LE(1,10);eocd.writeUInt32LE(central.length+name.length,12);eocd.writeUInt32LE(local.length+name.length+data.length,16);return Buffer.concat([local,name,data,central,name,eocd]);
}

test('old Binance futures seconds fall back to the official daily archive',async()=>{
  const from=Date.parse('2026-09-30T09:21:00Z'),zip=storedZip(`agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker\n1,10,2,1,1,${from+100},false\n2,12,3,2,2,${from+900},true\n`);
  const candles=await marketCandles({exchange:'Binance',symbol:'AGTUSDT',market:'futures',from,to:from+1000,intervalMs:1000,fetchImpl:async url=>String(url).includes('data.binance.vision')?new Response(zip):new Response(JSON.stringify({code:-4166}),{status:400})});
  assert.deepEqual(candles,[{time:from,open:10,high:12,low:10,close:12,volume:5}]);
});

test('minute and higher charts use historical klines',async()=>{
  const candles=await marketCandles({exchange:'Binance',symbol:'AGTUSDT',market:'futures',from:1000,to:999999,intervalMs:3600000,fetchImpl:async()=>new Response(JSON.stringify([[1000,'10','12','9','11','25']]))});
  assert.deepEqual(candles,[{time:1000,open:10,high:12,low:9,close:11,volume:25}]);
});

test('minute candles use the original Hyperliquid spot ID and sort exchange responses',async()=>{
  const from=Date.UTC(2026,10,24,12),to=from+60000;
  const candles=await marketCandles({exchange:'Hyperliquid',symbol:'HYPEUSDC',coin:'@107',market:'spot',from,to,intervalMs:60000,
    fetchImpl:async(url,request)=>{
      assert.equal(String(url),'https://api.hyperliquid.xyz/info');
      assert.deepEqual(JSON.parse(request.body),{type:'candleSnapshot',req:{coin:'@107',interval:'1m',startTime:from,endTime:to}});
      return Response.json([{t:to,o:'12',h:'13',l:'11',c:'12',v:'4'},{t:from,o:'10',h:'12',l:'9',c:'11',v:'9'}]);
    }});
  assert.deepEqual(candles.map(v=>[v.time,v.close]),[[from,11],[to,12]]);
});

test('Gate spot and KuCoin spot decode their different candle column orders',async()=>{
  const from=Date.UTC(2026,10,24,12),to=from+60000;
  for(const [exchange,symbol,expectedSymbol,body] of [
    ['Gate.io','EVAA_USDT','EVAA_USDT',[[from/1000,'100','11','12','9','10','5']]],
    ['KuCoin','EVAA-USDT','EVAA-USDT',{data:[[from/1000,'10','11','12','9','5']]}],
  ]){
    const candles=await marketCandles({exchange,symbol,market:'spot',from,to,intervalMs:60000,fetchImpl:async url=>{
      assert.equal(url.searchParams.get(exchange==='Gate.io'?'currency_pair':'symbol'),expectedSymbol);
      return Response.json(body);
    }});
    assert.deepEqual(candles,[{time:from,open:10,high:12,low:9,close:11,volume:5}]);
  }
});
