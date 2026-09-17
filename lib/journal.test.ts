import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum, group, makeDemo, percentOfCapital, type Trade } from './journal.ts';
const base:Trade={id:'1',date:'2026-09-16',exchange:'Binance',account:'a',ticker:'BTC',market:'futures',settle:'USDT',gross:10000,fee:100,funding:-50};
test('fees and signed funding are included once',()=>assert.equal(sum([base]),9850));
test('multiple accounts on one exchange aggregate without mixing exchanges',()=>{const result=group([base,{...base,id:'2',account:'b',gross:-3500},{...base,id:'3',exchange:'Bybit'}],'exchange');assert.deepEqual(result,[['Binance',6200,2],['Bybit',9850,1]])});
test('ticker and exchange breakdown reconcile with the same total',()=>{const rows=makeDemo(2026,8,new Date(2026,8,16));for(const key of ['exchange','ticker'] as const)assert.equal(group(rows,key).reduce((n,r)=>n+r[1],0),sum(rows));assert.equal(rows.some(r=>r.date>'2026-09-16'),false);assert.equal(new Set(rows.map(r=>r.id)).size,rows.length)});
test('empty period is zero',()=>{assert.equal(sum([]),0);assert.deepEqual(group([],'ticker'),[])});
test('PnL percentage uses total portfolio capital',()=>{assert.equal(percentOfCapital(967,967),1);assert.equal(percentOfCapital(-1936,968),-2);assert.equal(percentOfCapital(100,0),0)});

