import { decimal, units } from './security.mjs';

const USD_QUOTES=new Set(['USD','USDT','USDC']);

function safeUnits(value){try{return units(String(value??'0'));}catch{return 0n;}}

/**
 * Kraken Spot does not expose realised PnL. Reconstruct it with FIFO only when
 * every sold unit has a known purchase lot in the imported history. Unknown
 * opening inventory is deliberately excluded instead of inventing cost basis.
 */
export function krakenSpotPnl(events,{from=0}={}){
  const inventories=new Map(),realized=[];let incomplete=0,otherQuotes=0;
  const sorted=[...events].sort((a,b)=>Number(a.time)-Number(b.time)||String(a.external_id).localeCompare(String(b.external_id)));
  for(const event of sorted){
    let raw={};try{raw=typeof event.raw==='string'?JSON.parse(event.raw):event.raw||{};}catch{continue;}
    const side=String(raw.type||raw.side||'').toLowerCase(),quantity=safeUnits(raw.vol||raw.quantity),cost=safeUnits(raw.cost),fee=safeUnits(raw.fee);
    if(!quantity||!['buy','sell'].includes(side))continue;
    const quote=String(event.currency||raw.quote||'').toUpperCase();
    if(!USD_QUOTES.has(quote)){otherQuotes++;continue;}
    const key=`${event.connection_id}:${event.symbol}`,lots=inventories.get(key)||[];
    if(side==='buy'){
      lots.push({quantity,cost,fee});inventories.set(key,lots);continue;
    }
    let remaining=quantity,matched=0n,matchedCost=0n,matchedBuyFee=0n;
    while(remaining>0n&&lots.length){
      const lot=lots[0],take=remaining<lot.quantity?remaining:lot.quantity;
      const takeCost=lot.quantity===take?lot.cost:lot.cost*take/lot.quantity;
      const takeFee=lot.quantity===take?lot.fee:lot.fee*take/lot.quantity;
      matched+=take;matchedCost+=takeCost;matchedBuyFee+=takeFee;remaining-=take;
      lot.quantity-=take;lot.cost-=takeCost;lot.fee-=takeFee;if(lot.quantity===0n)lots.shift();
    }
    inventories.set(key,lots);
    if(remaining>0n){incomplete++;continue;}
    const matchedProceeds=cost*matched/quantity,matchedSellFee=fee*matched/quantity;
    realized.push({...event,kind:'pnl',gross:decimal(matchedProceeds-matchedCost),fee:decimal(matchedBuyFee+matchedSellFee),funding:'0',synthetic:true});
  }
  return {events:realized.filter(event=>Number(event.time)>=from),incomplete,otherQuotes};
}
