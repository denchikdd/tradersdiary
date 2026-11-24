import { decimal, multiply, units } from './security.mjs';
import { normalizeExecution } from './trade-details.mjs';

const USD_QUOTES=new Set(['USD','USDT','USDC']);

function safeUnits(value){try{return units(String(value??'0'));}catch{return 0n;}}

/**
 * Kraken Spot does not expose realised PnL. Reconstruct it with FIFO only when
 * every sold unit has a known purchase lot in the imported history. Unknown
 * opening inventory is deliberately excluded instead of inventing cost basis.
 */
export function spotPnl(events,{from=0,details=false}={}){
  const inventories=new Map(),realized=[],seen=new Set();let incomplete=0,otherQuotes=0;
  const sorted=[...events].sort((a,b)=>Number(a.time)-Number(b.time)||String(a.external_id).localeCompare(String(b.external_id),'en',{numeric:true}));
  for(const event of sorted){
    if(['Hyperliquid','Bitget'].includes(event.exchange))continue;
    let raw={};try{raw=typeof event.raw==='string'?JSON.parse(event.raw):event.raw||{};}catch{continue;}
    const side=String(raw.side||raw.type||(typeof raw.isBuyer==='boolean'?(raw.isBuyer?'buy':'sell'):'')).toLowerCase();
    const symbol=event.symbol.toUpperCase().replace(/[^A-Z0-9]/g,'');
    const quote=String(raw.quote||symbol.match(/(USDT|USDC|USD)$/)?.[1]||'').toUpperCase();
    const base=symbol.slice(0,-quote.length);
    let quantity=safeUnits(raw.vol??raw.qty??raw.execQty??raw.fillSz??raw.quantity??raw.size??raw.amount);
    const price=raw.price??raw.execPrice??raw.fillPx;
    const rawCost=raw.cost??raw.quoteQty??raw.execValue??raw.funds;
    const cost=rawCost!=null?safeUnits(rawCost):safeUnits(multiply(decimal(quantity),decimal(safeUnits(price))));
    let fee=safeUnits(raw.fee??raw.commission??raw.execFee);
    if(event.exchange==='OKX')fee=-fee;
    const feeCurrency=String(raw.feeCurrency||raw.fee_currency||raw.feeCoin||raw.commissionAsset||raw.feeCcy||event.currency||'').toUpperCase();
    const key=`${event.connection_id}:${symbol}`,dedup=`${key}:${raw.id??raw.tradeId??raw.execId??event.external_id}`;
    if(quantity<=0n||!['buy','sell'].includes(side)||seen.has(dedup))continue;
    seen.add(dedup);
    if(!USD_QUOTES.has(quote)){if(event.time>=from&&side==='sell')otherQuotes++;continue;}
    const lots=inventories.get(key)||[];
    const baseFee=feeCurrency===base;
    const knownFee=fee===0n||feeCurrency===quote||baseFee&&side==='buy';
    const missingCost=cost<=0n||!knownFee;
    const execution=details?normalizeExecution(event):null;
    if(side==='buy'){
      if(baseFee){quantity-=fee;fee=0n;}
      if(quantity>0n)lots.push({quantity,cost,fee,missingCost,execution});
      inventories.set(key,lots);continue;
    }
    let remaining=quantity+(baseFee&&fee>0n?fee:0n),matchedCost=0n,matchedBuyFee=0n,unknown=missingCost;
    const entries=[];
    while(remaining>0n&&lots.length){
      const lot=lots[0],take=remaining<lot.quantity?remaining:lot.quantity;
      const takeCost=lot.quantity===take?lot.cost:lot.cost*take/lot.quantity;
      const takeFee=lot.quantity===take?lot.fee:lot.fee*take/lot.quantity;
      matchedCost+=takeCost;matchedBuyFee+=takeFee;remaining-=take;
      unknown ||= lot.missingCost;
      if(lot.execution)entries.push({...lot.execution,raw:undefined,quantity:Number(decimal(take)),fee:Number(decimal(takeFee))});
      lot.quantity-=take;lot.cost-=takeCost;lot.fee-=takeFee;if(lot.quantity===0n)lots.shift();
    }
    inventories.set(key,lots);
    if(event.time<from)continue;
    if(remaining>0n||unknown){incomplete++;continue;}
    const exits=execution?[{...execution,raw:undefined}]:[];
    const prices=entries.length&&execution?{entryTime:entries[0].time,entryPrice:Number(decimal(matchedCost))/Number(decimal(quantity)),
      exitPrice:execution.price,entries,exits,executions:[...entries,...exits]}:undefined;
    realized.push({...event,currency:quote,kind:'pnl',gross:decimal(cost-matchedCost),fee:decimal(matchedBuyFee+fee),funding:'0',synthetic:true,details:prices});
  }
  return {events:realized,incomplete,otherQuotes};
}

export const krakenSpotPnl=spotPnl;
