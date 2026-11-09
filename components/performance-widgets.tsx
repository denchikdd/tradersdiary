"use client";

import { useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, Treemap, XAxis, YAxis } from 'recharts';
import { Eye, EyeOff, TrendingUp } from 'lucide-react';
import { money, percentOfCapital, type Trade } from '@/lib/journal';

type Unit='usd'|'percent';
type Period='week'|'month'|'year';
const DAY=86400000;
const colors=['#55c7e8','#a98be8','#ef8dc1','#65d6ad','#f2ba69','#d7dc73','#8598f5','#e18c74','#66c9c2','#a6c77c','#ed7f8d','#b8c3d8'];
const net=(row:Trade)=>row.gross-row.fee+row.funding;
const utcDate=(time:number)=>new Date(time).toISOString().slice(0,10);
const dayLabel=(date:string)=>date.slice(5).split('-').reverse().join('.');
const marketLabel=(market:Trade['market'])=>market==='spot'?'Spot':'Futures';

function range(period:Period){
  const now=new Date(),today=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate());let start=today;
  if(period==='week')start=today-((now.getUTCDay()+6)%7)*DAY;
  if(period==='month')start=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1);
  if(period==='year')start=Date.UTC(now.getUTCFullYear(),0,1);
  return {start:utcDate(start),end:utcDate(today),days:Array.from({length:Math.floor((today-start)/DAY)+1},(_,i)=>utcDate(start+i*DAY))};
}

function amount(value:number,unit:Unit,capitalUsd:number){return unit==='usd'?money(value):`${value>0?'+':value<0?'−':''}${Math.abs(percentOfCapital(value,capitalUsd)).toFixed(2)}%`;}
function chartValue(value:number,unit:Unit,capitalUsd:number){return unit==='usd'?value/100:percentOfCapital(value,capitalUsd);}
function axisValue(value:number,unit:Unit){return unit==='usd'?`${value.toLocaleString('ru-RU',{maximumFractionDigits:0})} $`:`${value.toLocaleString('ru-RU',{maximumFractionDigits:1})}%`;}

function ChartTooltip({active,payload,label,unit,hidden}:{active?:boolean;payload?:Array<{name:string;value:number;color:string}>;label?:string;unit:Unit;hidden:boolean}){
  if(!active||!payload?.length||hidden)return null;
  return <div className="performance-tooltip"><strong>{label}</strong>{payload.filter(v=>v.value!==undefined).map(item=><span key={item.name}><i style={{background:item.color}}/>{item.name}<b>{axisValue(item.value,unit)}</b></span>)}</div>;
}

function PrivacyCover({hidden}:{hidden:boolean}){return hidden?<div className="privacy-cover"><EyeOff size={22}/><strong>Прибыль скрыта</strong><span>Нажмите на глаз, чтобы показать значения и график</span></div>:null;}

function CoinCell(props:any){
  const {x,y,width,height,name,pnl,unit,capitalUsd,hidden,index,depth}=props;if(depth===0||!Number.isFinite(pnl)||width<2||height<2)return null;
  const positive=pnl>=0,fill=positive?`rgba(56, ${Math.max(105,155-(index%4)*12)}, 112, .${Math.max(38,74-(index%4)*8)})`:`rgba(151, 69, 76, .${Math.max(42,76-(index%4)*8)})`,showName=width>55&&height>32,showValue=width>88&&height>55;
  return <g><rect x={x} y={y} width={width} height={height} fill={fill} stroke="#516071" strokeWidth={1}/>{showName&&<text x={x+width/2} y={y+height/2-(showValue?7:0)} textAnchor="middle" dominantBaseline="central" fill="#eef3f7" fontSize={Math.min(17,Math.max(11,width/9))} fontWeight={700}>{name}</text>}{showValue&&<text x={x+width/2} y={y+height/2+14} textAnchor="middle" dominantBaseline="central" fill="#dce5ec" fontSize={12}>{hidden?'••••':amount(pnl,unit,capitalUsd)}</text>}</g>;
}

export function PerformanceWidgets({rows,unit,capitalUsd,hidden,onToggleHidden}:{rows:Trade[];unit:Unit;capitalUsd:number;hidden:boolean;onToggleHidden:()=>void}){
  const [period,setPeriod]=useState<Period>('week'),dates=useMemo(()=>range(period),[period]);
  const filtered=useMemo(()=>rows.filter(row=>row.date>=dates.start&&row.date<=dates.end),[rows,dates]);
  const model=useMemo(()=>{
    const accounts=new Map<string,{key:string;label:string;color:string;value:number}>(),byDay=new Map<string,Trade[]>(),byCoin=new Map<string,{name:string;pnl:number;count:number}>();
    for(const row of filtered){
      const key=`${row.connectionId||row.exchange+'|'+row.account}|${row.market}`,old=accounts.get(key),value=net(row);
      if(old)old.value+=value;else accounts.set(key,{key,label:`${row.exchange}: ${marketLabel(row.market)}${row.account?` · ${row.account}`:''}`,color:colors[accounts.size%colors.length],value});
      byDay.set(row.date,[...(byDay.get(row.date)||[]),row]);const coin=byCoin.get(row.ticker);if(coin){coin.pnl+=value;coin.count++;}else byCoin.set(row.ticker,{name:row.ticker,pnl:value,count:1});
    }
    const accountList=[...accounts.values()].sort((a,b)=>Math.abs(b.value)-Math.abs(a.value)),running=Object.fromEntries(accountList.map(v=>[v.key,0])) as Record<string,number>,chart=dates.days.map(date=>{const point:Record<string,string|number>={date,label:dayLabel(date)};for(const row of byDay.get(date)||[]){const key=`${row.connectionId||row.exchange+'|'+row.account}|${row.market}`;running[key]=(running[key]||0)+net(row);}for(const account of accountList)point[account.key]=chartValue(running[account.key],unit,capitalUsd);return point;});
    let total=0;const totalChart=dates.days.map(date=>{const value=(byDay.get(date)||[]).reduce((sum,row)=>sum+net(row),0);total+=value;return {date,label:dayLabel(date),daily:value,value:chartValue(total,unit,capitalUsd)};});
    const coins=[...byCoin.values()].sort((a,b)=>Math.abs(b.pnl)-Math.abs(a.pnl)).map(v=>({...v,size:Math.max(1,Math.abs(v.pnl))}));
    return {accounts:accountList,chart,totalChart,coins,total,positive:coins.filter(v=>v.pnl>0).reduce((s,v)=>s+v.pnl,0),negative:coins.filter(v=>v.pnl<0).reduce((s,v)=>s+v.pnl,0)};
  },[filtered,dates,unit,capitalUsd]);
  const title=period==='week'?`${dayLabel(dates.start)}–${dayLabel(dates.end)}`:period==='month'?new Date(dates.start+'T00:00:00Z').toLocaleDateString('ru-RU',{month:'long',year:'numeric',timeZone:'UTC'}):dates.start.slice(0,4);
  const value=(cents:number)=>hidden?'••••':amount(cents,unit,capitalUsd),yFormatter=(v:number)=>axisValue(v,unit);
  return <section className="performance-widgets" aria-label="Графики прибыли">
    <div className="performance-toolbar"><div><span className="eyebrow">АНАЛИТИКА РЕЗУЛЬТАТА</span><h2>Кумулятивная прибыль</h2><p>{title} · по времени закрытия сделок, UTC</p></div><div className="performance-actions"><div className="period-switch">{([['week','Неделя'],['month','Месяц'],['year','Год']] as const).map(([id,label])=><button key={id} className={period===id?'active':''} onClick={()=>setPeriod(id)}>{label}</button>)}</div><button className="icon-button privacy-toggle" onClick={onToggleHidden} aria-label={hidden?'Показать прибыль':'Скрыть прибыль'}>{hidden?<Eye size={18}/>:<EyeOff size={18}/>}</button></div></div>
    <div className="performance-summary"><div><span>Общий результат</span><strong className={model.total>=0?'positive':'negative'}>{value(model.total)}</strong></div><div><span>Записи PnL</span><strong>{filtered.length}</strong></div><div><span>API-ключи / рынки</span><strong>{model.accounts.length}</strong></div><div><span>Единицы</span><strong>{unit==='usd'?'USD':'% от капитала'}</strong></div></div>
    <article className="performance-card"><div className="performance-card-head"><div><h3>По каждому API-ключу</h3><span>Накопление с нуля за выбранный период</span></div></div><div className={`performance-chart ${hidden?'is-hidden':''}`}><ResponsiveContainer width="100%" height={300}><LineChart data={model.chart} margin={{top:12,right:16,bottom:0,left:4}}><CartesianGrid stroke="#2a3440" strokeDasharray="4 5" vertical={false}/><XAxis dataKey="label" minTickGap={26} tick={{fill:'#7f8b98',fontSize:11}} axisLine={{stroke:'#34404d'}} tickLine={false}/><YAxis width={58} tickFormatter={yFormatter} tick={{fill:'#7f8b98',fontSize:10}} axisLine={false} tickLine={false}/><Tooltip content={<ChartTooltip unit={unit} hidden={hidden}/>}/>{model.accounts.map(account=><Line key={account.key} type="stepAfter" dataKey={account.key} name={account.label} stroke={account.color} strokeWidth={2.2} dot={false} activeDot={{r:4}} isAnimationActive={false}/>)}</LineChart></ResponsiveContainer><PrivacyCover hidden={hidden}/>{!model.accounts.length&&!hidden&&<div className="chart-empty">Нет закрытых сделок за этот период</div>}</div>
      {!!model.accounts.length&&<div className="performance-legend">{model.accounts.map(account=><div key={account.key}><i style={{background:account.color}}/><span title={account.label}>{account.label}</span><strong className={account.value>=0?'positive':'negative'}>{value(account.value)}</strong></div>)}</div>}
    </article>
    <article className="performance-card total-performance"><div className="performance-card-head"><div><h3>Общая кумулятивная прибыль</h3><span>Сумма подтверждённого реализованного PnL</span></div><strong className={model.total>=0?'positive':'negative'}>{value(model.total)}</strong></div><div className={`performance-chart ${hidden?'is-hidden':''}`}><ResponsiveContainer width="100%" height={260}><AreaChart data={model.totalChart} margin={{top:12,right:16,bottom:0,left:4}}><defs><linearGradient id="performanceArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#68d79c" stopOpacity={.36}/><stop offset="100%" stopColor="#68d79c" stopOpacity={.02}/></linearGradient></defs><CartesianGrid stroke="#2a3440" strokeDasharray="4 5" vertical={false}/><XAxis dataKey="label" minTickGap={26} tick={{fill:'#7f8b98',fontSize:11}} axisLine={{stroke:'#34404d'}} tickLine={false}/><YAxis width={58} tickFormatter={yFormatter} tick={{fill:'#7f8b98',fontSize:10}} axisLine={false} tickLine={false}/><Tooltip content={<ChartTooltip unit={unit} hidden={hidden}/>}/><Area type="stepAfter" dataKey="value" name="Общий результат" stroke="#67d89c" strokeWidth={2.5} fill="url(#performanceArea)" dot={false} isAnimationActive={false}/></AreaChart></ResponsiveContainer><PrivacyCover hidden={hidden}/></div><div className="daily-results">{model.totalChart.filter(point=>point.daily!==0).map(point=><div key={point.date}><span>{point.label}</span><strong className={point.daily>=0?'positive':'negative'}>{value(point.daily)}</strong></div>)}</div></article>
    <article className="performance-card coin-performance"><div className="performance-card-head"><div><h3>Прибыль по монете</h3><span>Площадь блока = абсолютный результат монеты</span></div><div><span>{model.coins.length} монет</span><strong className={model.total>=0?'positive':'negative'}>{value(model.total)}</strong></div></div><div className={`coin-map ${hidden?'is-hidden':''}`}>{model.coins.length?<ResponsiveContainer width="100%" height={420}><Treemap data={model.coins} dataKey="size" nameKey="name" isAnimationActive={false} content={<CoinCell unit={unit} capitalUsd={capitalUsd} hidden={hidden}/>}/></ResponsiveContainer>:<div className="chart-empty"><TrendingUp size={24}/>Нет данных по монетам</div>}<PrivacyCover hidden={hidden}/></div><div className="coin-totals"><span className="positive">Прибыльные монеты: {value(model.positive)}</span><span className="negative">Убыточные монеты: {value(model.negative)}</span></div><div className="coin-list">{model.coins.map(coin=><div key={coin.name} className={coin.pnl>=0?'gain':'loss'}><i/><b>{coin.name}</b><span>{coin.count} зап.</span><strong className={coin.pnl>=0?'positive':'negative'}>{value(coin.pnl)}</strong></div>)}</div></article>
  </section>;
}
