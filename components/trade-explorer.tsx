"use client";
import { useEffect,useMemo,useRef,useState } from 'react';
import type { CandlestickData,SeriesMarker,UTCTimestamp } from 'lightweight-charts';
import { ArrowLeft,ChartCandlestick,Clock3,Maximize2,Minimize2,X } from 'lucide-react';
import { journalApi } from './journal-server';
import { TradeNote } from './trade-note';
import { DialogClose } from './ui/dialog';

type Execution={id:string;time:number;side:'BUY'|'SELL';price:number;quantity:number;pnl:number;fee:number};
type Trade={id:string;exchange:string;account:string;symbol:string;chartSymbol?:string;market:'spot'|'futures';direction:'long'|'short'|'unknown';entryTime:number;exitTime:number|null;entryPrice:number;exitPrice:number;pnl:number;fee:number;complete:boolean;entries?:Execution[];exits?:Execution[];executions:Execution[]};
type Candle={time:number;open:number;high:number;low:number;close:number;volume:number};
const intervals=[['1s',1000],['5s',5000],['15s',15000],['1m',60000],['5m',300000],['15m',900000],['1h',3600000],['4h',14400000],['1D',86400000]] as const;
const money=(value:number)=>`${value>=0?'+':'−'}$${Math.abs(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:Math.abs(value)<0.01?8:2})}`;
const time=(value:number)=>new Date(value).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'UTC'});
const movement=(trade:Trade)=>trade.entryPrice>0&&trade.exitPrice>0?(trade.direction==='short'?-1:1)*(trade.exitPrice-trade.entryPrice)/trade.entryPrice*100:null;
const percent=(value:number)=>`${value>=0?'+':'−'}${Math.abs(value).toFixed(2)}%`;

function TradeChart({trade}:{trade:Trade}){
  const [interval,setIntervalValue]=useState(60000),[candles,setCandles]=useState<Candle[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[expanded,setExpanded]=useState(false),[hover,setHover]=useState<{time:number;open:number;high:number;low:number;close:number}|null>(null),[ruler,setRuler]=useState<{x1:number;y1:number;x2:number;y2:number;p1:number;p2:number;t1:number;t2:number}|null>(null),host=useRef<HTMLDivElement|null>(null),resetChart=useRef<(()=>void)|null>(null);
  const hasSeconds=['Binance','Aster'].includes(trade.exchange)||(trade.exchange==='MEXC'&&trade.market==='spot');
  const bounds=useMemo(()=>{
    const exit=trade.exitTime||trade.entryTime;
    const padding=interval<60000?5*60000:interval===60000?45*60000:interval*24;
    const maxSpan=interval<60000?3600000:interval===86400000?120*86400000:interval>=3600000?12*86400000:Math.min(2*86400000,interval*200);
    const to=Math.floor(exit/interval)*interval+padding;
    return {from:Math.max(trade.entryTime-padding,to-maxSpan),to};
  },[trade,interval]);
  useEffect(()=>{
    let active=true;
    setLoading(true);setCandles([]);setError('');setHover(null);setRuler(null);
    const params=new URLSearchParams({exchange:trade.exchange,symbol:trade.symbol,market:trade.market,from:String(bounds.from),to:String(bounds.to),interval:String(interval)});
    if(trade.chartSymbol)params.set('coin',trade.chartSymbol);
    journalApi<{candles:Candle[]}>(`/market-chart?${params}`).then(v=>{if(active)setCandles(v.candles);})
      .catch(e=>{if(active)setError((e as Error).message);}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false};
  },[trade,bounds,interval]);
  useEffect(()=>{if(!host.current||!candles.length)return;let active=true,dispose=()=>{};void import('lightweight-charts').then(({CandlestickSeries,ColorType,CrosshairMode,HistogramSeries,LineStyle,createChart,createSeriesMarkers})=>{if(!active||!host.current)return;const data=candles.map(v=>({time:Math.floor(v.time/1000) as UTCTimestamp,open:v.open,high:v.high,low:v.low,close:v.close} as CandlestickData<UTCTimestamp>)),prices=candles.flatMap(v=>[v.high,v.low]),smallest=Math.min(...prices.filter(v=>v>0)),precision=Math.max(2,Math.min(8,Math.ceil(-Math.log10(smallest||1))+4)),chart=createChart(host.current,{autoSize:true,layout:{background:{type:ColorType.Solid,color:'#0b1321'},textColor:'#8492a6',fontFamily:'Arial, Helvetica, sans-serif',fontSize:11,attributionLogo:false},grid:{vertLines:{color:'#233149',style:LineStyle.Dotted},horzLines:{color:'#233149',style:LineStyle.Dotted}},crosshair:{mode:CrosshairMode.Normal,vertLine:{color:'#8290a5',width:1,style:LineStyle.Dashed,labelBackgroundColor:'#2d3b52'},horzLine:{color:'#8290a5',width:1,style:LineStyle.Dashed,labelBackgroundColor:'#2d3b52'}},rightPriceScale:{visible:true,borderColor:'#2b3950',scaleMargins:{top:.06,bottom:.16}},leftPriceScale:{visible:false},timeScale:{borderColor:'#2b3950',timeVisible:true,secondsVisible:interval<60000,rightOffset:10,barSpacing:interval<60000?4.6:7,minBarSpacing:.7,fixLeftEdge:false,fixRightEdge:false},handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},handleScale:{mouseWheel:true,pinch:true,axisPressedMouseMove:{time:true,price:true},axisDoubleClickReset:{time:true,price:true}},localization:{timeFormatter:(value:unknown)=>new Date(Number(value)*1000).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:interval<60000?'2-digit':undefined,timeZone:'UTC'})}}),series=chart.addSeries(CandlestickSeries,{upColor:'#00d7b0',downColor:'#ff4265',borderVisible:false,wickUpColor:'#13e0ba',wickDownColor:'#ff5270',priceLineVisible:false,lastValueVisible:true,priceFormat:{type:'price',precision,minMove:10**-precision}});series.setData(data);const volume=chart.addSeries(HistogramSeries,{priceScaleId:'',priceFormat:{type:'volume'},priceLineVisible:false,lastValueVisible:false});volume.setData(candles.map(v=>({time:Math.floor(v.time/1000) as UTCTimestamp,value:v.volume,color:v.close>=v.open?'#00d7b02b':'#ff42652b'})));volume.priceScale().applyOptions({scaleMargins:{top:.82,bottom:0}});
    const times=new Set(data.map(v=>Number(v.time)));
    const markers:SeriesMarker<UTCTimestamp>[]=[];
    for(const [stamp,price,label,buy] of [
      [trade.entryTime,trade.entryPrice,'Вход',trade.direction==='long'],
      [trade.exitTime,trade.exitPrice,'Выход',trade.direction==='short'],
    ] as const){
      if(!stamp||price<=0)continue;
      const bucket=Math.floor(stamp/interval)*interval/1000;
      if(times.has(bucket))markers.push({time:bucket as UTCTimestamp,position:buy?'belowBar':'aboveBar',color:buy?'#20d98a':'#ff5b70',shape:buy?'arrowUp':'arrowDown',text:label});
    }
    if(markers.length)createSeriesMarkers(series,markers,{autoScale:true});
    if(trade.entryPrice>0)series.createPriceLine({price:trade.entryPrice,color:trade.direction==='short'?'#ff5b70':'#20d98a',lineWidth:1,lineStyle:LineStyle.Dashed,axisLabelVisible:true,title:'Вход'});if(trade.exitPrice>0)series.createPriceLine({price:trade.exitPrice,color:trade.direction==='short'?'#20d98a':'#ff5b70',lineWidth:1,lineStyle:LineStyle.Dashed,axisLabelVisible:true,title:'Выход'});
    let measuring=false,start:{x:number;y:number;p:number;t:number}|null=null;const point=(event:MouseEvent)=>{if(!host.current)return null;const rect=host.current.getBoundingClientRect(),x=Math.max(0,Math.min(rect.width,event.clientX-rect.left)),y=Math.max(0,Math.min(rect.height,event.clientY-rect.top)),price=series.coordinateToPrice(y),stamp=chart.timeScale().coordinateToTime(x);return price===null||stamp===null?null:{x,y,p:Number(price),t:Number(stamp)*1000}};const down=(event:MouseEvent)=>{if(event.button!==1)return;const p=point(event);if(!p)return;event.preventDefault();event.stopPropagation();measuring=true;start=p;setRuler({x1:p.x,y1:p.y,x2:p.x,y2:p.y,p1:p.p,p2:p.p,t1:p.t,t2:p.t})};const move=(event:MouseEvent)=>{if(!measuring||!start)return;const p=point(event);if(!p)return;event.preventDefault();setRuler({x1:start.x,y1:start.y,x2:p.x,y2:p.y,p1:start.p,p2:p.p,t1:start.t,t2:p.t})};const up=(event:MouseEvent)=>{if(event.button===1||measuring){event.preventDefault();measuring=false;start=null;setRuler(null)}};const aux=(event:MouseEvent)=>{if(event.button===1)event.preventDefault()};host.current.addEventListener('mousedown',down,true);host.current.addEventListener('auxclick',aux,true);window.addEventListener('mousemove',move,true);window.addEventListener('mouseup',up,true);
    chart.subscribeCrosshairMove(param=>{if(!param.time){setHover(null);return}const value=param.seriesData.get(series) as CandlestickData<UTCTimestamp>|undefined;if(value)setHover({time:Number(param.time)*1000,open:value.open,high:value.high,low:value.low,close:value.close});});chart.timeScale().fitContent();resetChart.current=()=>{setRuler(null);chart.priceScale('right').applyOptions({autoScale:true});chart.timeScale().fitContent();};dispose=()=>{if(host.current){host.current.removeEventListener('mousedown',down,true);host.current.removeEventListener('auxclick',aux,true)}window.removeEventListener('mousemove',move,true);window.removeEventListener('mouseup',up,true);resetChart.current=null;chart.remove();};});return()=>{active=false;dispose()}},[candles,interval,trade]);
  useEffect(()=>{if(!expanded)return;const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setExpanded(false)};document.addEventListener('keydown',close);const previous=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.removeEventListener('keydown',close);document.body.style.overflow=previous}},[expanded]);
  const fmtPrice=(value:number)=>value?value.toLocaleString('ru-RU',{maximumFractionDigits:8}):'—',duration=trade.exitTime?Math.max(0,(trade.exitTime-trade.entryTime)/1000):0,quantity=(trade.entries||[]).reduce((n,v)=>n+v.quantity,0),intervalLabel=intervals.find(([,value])=>value===interval)?.[0]||'1s',priceMove=movement(trade),rulerDelta=ruler?ruler.p2-ruler.p1:0,rulerPercent=ruler&&ruler.p1?(rulerDelta/ruler.p1)*100:0,rulerSeconds=ruler?Math.abs(ruler.t2-ruler.t1)/1000:0;
  return <section className={`trade-chart-card ${expanded?'chart-expanded':''}`}><div className="trade-chart-overview"><div><span>Результат</span><strong className={trade.pnl-trade.fee>=0?'positive':'negative'}>{money(trade.pnl-trade.fee)}{priceMove!==null&&<em className={priceMove>=0?'positive':'negative'}> · {percent(priceMove)}</em>}</strong><small>PnL {money(trade.pnl)} · комиссия {money(-trade.fee)}</small></div><div><span>Позиция</span><strong>{trade.direction==='long'?'LONG':trade.direction==='short'?'SHORT':'—'}</strong><small>{fmtPrice(trade.entryPrice)} → {fmtPrice(trade.exitPrice)}{quantity?` · ${quantity}`:''}</small></div><div><span>Время · UTC</span><strong>{time(trade.entryTime)} → {trade.exitTime?time(trade.exitTime):'—'}</strong><small>{duration?`${duration<60?duration.toFixed(2)+'с':(duration/60).toFixed(1)+'м'} в позиции`:trade.exchange}</small></div></div>
    <div className="trade-chart-toolbar"><div className="chart-tools-left"><button className="chart-auto" onClick={()=>resetChart.current?.()}><Clock3 size={13}/>Авто · {intervalLabel}</button><span className="chart-ruler-hint">Зажмите колесо — линейка</span></div><div className="trade-chart-actions"><div className="chart-intervals">{intervals.map(([label,value])=><button key={value} className={interval===value?'active':''} aria-pressed={interval===value} disabled={value<60000&&!hasSeconds} onClick={()=>{if(interval!==value){setCandles([]);setLoading(true);setIntervalValue(value)}}}>{label}</button>)}</div><button className="chart-expand" onClick={()=>setExpanded(v=>!v)} aria-label={expanded?'Свернуть график':'Развернуть график'}>{expanded?<Minimize2 size={16}/>:<Maximize2 size={16}/>}</button></div></div>
    <div className="trade-chart-wrap">{loading&&<div className="chart-message">Загружаю историю рынка…</div>}{!loading&&!candles.length&&<div className="chart-message"><ChartCandlestick size={28}/><strong>Данные графика пока недоступны</strong><span>{error||'Биржа не вернула свечи за выбранный период. Исполнения сделки показаны ниже.'}</span></div>}
      {!!candles.length&&<><div ref={host} className="lightweight-chart" role="img" aria-label={`Интерактивный свечной график ${trade.symbol}`}/>{hover&&!ruler&&<div className="chart-crosshair-data"><span>{new Date(hover.time).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'UTC'})}</span><b>O {fmtPrice(hover.open)}</b><b>H {fmtPrice(hover.high)}</b><b>L {fmtPrice(hover.low)}</b><b>C {fmtPrice(hover.close)}</b></div>}{ruler&&<svg className="chart-ruler" aria-hidden="true"><line x1={ruler.x1} y1={ruler.y1} x2={ruler.x2} y2={ruler.y2}/><circle cx={ruler.x1} cy={ruler.y1} r="4"/><circle cx={ruler.x2} cy={ruler.y2} r="4"/><g transform={`translate(${(ruler.x1+ruler.x2)/2},${(ruler.y1+ruler.y2)/2})`}><rect x="-72" y="-24" width="144" height="48" rx="7"/><text y="-4" textAnchor="middle" className={rulerPercent>=0?'up':'down'}>{rulerPercent>=0?'+':''}{rulerPercent.toFixed(2)}%</text><text y="14" textAnchor="middle">{rulerDelta>=0?'+':'−'}{Math.abs(rulerDelta).toLocaleString('ru-RU',{maximumFractionDigits:8})} · {rulerSeconds<60?`${rulerSeconds.toFixed(0)}с`:`${(rulerSeconds/60).toFixed(1)}м`}</text></g></svg>}</>}
    </div>
    {!!trade.executions.length&&<div className="trade-order-list"><table>
      <caption>Исполнения</caption>
      <thead><tr>{['Время · UTC','Сторона','Цена','Количество','Комиссия'].map(label=><th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{trade.executions.map((fill,i)=><tr key={`${fill.id}-${i}`}><td>{time(fill.time)}</td>
        <td className={fill.side==='BUY'?'positive':'negative'}>{fill.side}</td><td>{fmtPrice(fill.price)}</td>
        <td>{fmtPrice(fill.quantity)}</td><td>{fmtPrice(fill.fee)}</td></tr>)}</tbody>
    </table></div>}
    <div className="trade-chart-foot">{!trade.executions.length&&<p>Для этой записи доступны время и PnL биржи.</p>}<a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a></div>
  </section>;
}

export function TradeExplorer({date,ticker,exchange,market='all',connectionId,onBack}:{date:string;ticker:string;exchange:string;market?:string;connectionId?:string;onBack:()=>void}){
  const [trades,setTrades]=useState<Trade[]>([]),[selected,setSelected]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState(''),[limited,setLimited]=useState(false);
  useEffect(()=>{
    let active=true;
    async function load(){
      try {
        const params=new URLSearchParams({date,ticker,exchange,market});
        if(connectionId)params.set('connectionId',connectionId);
        const data=await journalApi<{trades:Trade[];limited:boolean}>(`/trade-details?${params}`);
        if(!active)return;
        setTrades(current=>{
          const prior=new Map(current.map(trade=>[trade.id,trade]));
          return data.trades.map(trade=>{
            const old=prior.get(trade.id);
            return old&&JSON.stringify(old)===JSON.stringify(trade)?old:trade;
          });
        });
        setLimited(data.limited);setError('');
      } catch(e){if(active)setError((e as Error).message);}
      finally{if(active)setLoading(false);}
    }
    void load();const timer=setInterval(load,15000);
    return()=>{active=false;clearInterval(timer);};
  },[date,ticker,exchange,market,connectionId]);
  const trade=trades.find(v=>v.id===selected)||trades[0];
  return <div className="trade-explorer"><div className="trade-explorer-head"><button onClick={onBack}><ArrowLeft size={17}/>К разбивке</button><div><span>{date.split('-').reverse().join('.')} · UTC</span><h2>{ticker||'Сделки за день'} <small>{exchange==='all'?'Все биржи':exchange}</small></h2></div><DialogClose className="icon-button trade-explorer-close" aria-label="Закрыть"><X size={20}/></DialogClose></div>
    {loading?<div className="empty-state">Загружаю сделки…</div>:error?<div className="empty-state negative">{error}</div>:!trades.length?<div className="empty-state"><h3>Закрытые сделки пока не найдены</h3><p>Статус загрузки по каждому счёту показан в разделе синхронизации.</p></div>:<><div className="trade-upper"><div className="trade-picker">{trades.map(v=>{const priceMove=movement(v);return <button key={v.id} className={v.id===trade?.id?'active':''} onClick={()=>setSelected(v.id)}><span>{v.symbol}<small>{v.exchange} · {time(v.exitTime||v.entryTime)} UTC</small></span><strong className={v.pnl-v.fee>=0?'positive':'negative'}>{money(v.pnl-v.fee)}{priceMove!==null&&<small className={priceMove>=0?'positive':'negative'}>{percent(priceMove)}</small>}</strong><em>{v.direction==='long'?'LONG':v.direction==='short'?'SHORT':'PNL'}</em></button>})}</div>{trade&&<TradeNote key={trade.id} tradeKey={trade.id}/>}</div>{limited&&<p className="trade-data-note">По некоторым записям биржа передала только PnL и время закрытия.</p>}{trade&&<TradeChart key={trade.id} trade={trade}/>}</>}
  </div>;
}
