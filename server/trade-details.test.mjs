import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateTrades,buildTrades,normalizeExecution,tickerOf } from './trade-details.mjs';

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
