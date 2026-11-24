"use client";

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Eye, EyeOff } from 'lucide-react';
import { dateKey, money, percentOfCapital, type Trade } from '@/lib/journal';
import type { PortfolioCapital } from './journal-server';

type Period = 'day' | 'week' | 'month' | 'year' | 'all';
type Market = Trade['market'];
type Account = PortfolioCapital['accounts'][number];
type Totals = { net: number; fees: number; funding: number; count: number };
type Scope = { start:string; end:string; title:string; exchange?:string; market?:Market; connectionId?:string; account?:string };
type AccountRow = { id:string; label:string; exchange:string; balance:number|null; markets:Map<Market,Totals>; totals:Totals };

const periods = [['day','День'],['week','Неделя'],['month','Месяц'],['year','Год'],['all','Всё время']] as const;
const marketLabels = { spot:'Spot', futures:'Futures' };
const colors = ['#80cdb9','#a69ae7','#e2ae75','#6ba5d7','#d68bb4','#a4c77d','#7dbbc9','#d6aece','#a8a0c5','#e2cc84'];
const dateLabel=new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short'});
const monthLabel=new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric'});
const formatCount=new Intl.NumberFormat('ru-RU');
const usd=new Intl.NumberFormat('ru-RU',{style:'currency',currency:'USD'});
const emptyTotals=():Totals=>({net:0,fees:0,funding:0,count:0});
const tone=(value:number)=>value>0?'positive':value<0?'negative':'neutral';
const accountKey=(exchange:string, account:string, id?:string)=>id||`${exchange}:${account}`;

function include(totals:Totals,row:Trade) {
  totals.net+=row.gross-row.fee+row.funding;
  totals.fees-=row.fee;
  totals.funding+=row.funding;
  totals.count++;
}

function getRange(period:Period, today:Date, month:Date, firstTrade?:string):Scope {
  const end=dateKey(today);
  if(period==='day')return {start:end,end,title:`${dateLabel.format(today)} · UTC`};
  if(period==='week'){
    const start=new Date(today.getFullYear(),today.getMonth(),today.getDate()-(today.getDay()+6)%7);
    return {start:dateKey(start),end,title:`${dateLabel.format(start)} — ${dateLabel.format(today)} · UTC`};
  }
  if(period==='month'){
    const last=new Date(month.getFullYear(),month.getMonth()+1,0);
    return {start:dateKey(month),end:dateKey(last),title:`${monthLabel.format(month)} · UTC`};
  }
  if(period==='year')return {start:`${today.getFullYear()}-01-01`,end,title:`${today.getFullYear()} · UTC`};
  return {start:firstTrade||end,end,title:'Вся история · UTC'};
}

function summarize(rows:Trade[],balances:Account[]) {
  const accounts=new Map<string,AccountRow>();
  for(const b of balances) {
    const id=accountKey(b.exchange,b.label,b.connectionId);
    accounts.set(id,{id,label:b.label,exchange:b.exchange,balance:Number(b.equityUsd),markets:new Map(),totals:emptyTotals()});
  }
  const exchanges=new Map<string,{key:string;exchange:string;market:Market;net:number}>();
  const daily=new Map<string,number>(),total=emptyTotals();
  for(const row of rows){
    const id=accountKey(row.exchange,row.account,row.connectionId);
    const account=accounts.get(id)||{id,exchange:row.exchange,label:row.account,balance:null,markets:new Map<Market,Totals>(),totals:emptyTotals()};
    const market=account.markets.get(row.market)||emptyTotals();
    include(market,row);include(account.totals,row);include(total,row);
    account.markets.set(row.market,market);accounts.set(id,account);
    const key=`${row.exchange}:${row.market}`,entry=exchanges.get(key)||{key,exchange:row.exchange,market:row.market,net:0};
    const net=row.gross-row.fee+row.funding;
    entry.net+=net;exchanges.set(key,entry);
    daily.set(row.date,(daily.get(row.date)||0)+net);
  }
  const dates=[...daily].sort(([a],[b])=>a.localeCompare(b));
  let equity=0,peak=0,drawdown=0,gains=0,losses=0,wins=0,losingDays=0;
  for(const [,net] of dates){
    equity+=net;peak=Math.max(peak,equity);drawdown=Math.min(drawdown,equity-peak);
    if(net>0){gains+=net;wins++;}
    if(net<0){losses-=net;losingDays++;}
  }
  return {accounts:[...accounts.values()].sort((a,b)=>a.exchange.localeCompare(b.exchange)||a.label.localeCompare(b.label)),
    exchanges:[...exchanges.values()].filter(v=>v.net!==0).sort((a,b)=>Math.abs(b.net)-Math.abs(a.net)),
    dates,total,drawdown,gains,losses,wins,losingDays};
}

export function ExchangeStatistics({rows,accounts,today,month,unit,capitalUsd,hidden,onToggleHidden,onOpen,icon,error}: {
  rows:Trade[];accounts:Account[];today:Date;month:Date;unit:'usd'|'percent';capitalUsd:number;hidden:boolean;
  onToggleHidden:()=>void;onOpen:(scope:Scope)=>void;icon:(name:string)=>ReactNode;error?:string;
}){
  const [period,setPeriod]=useState<Period>('month');
  const [calendarShift,setCalendarShift]=useState(0);
  const [selectedSlice,setSelectedSlice]=useState<string|null>(null);
  const first=useMemo(()=>rows.reduce((date,row)=>!date||row.date<date?row.date:date,''),[rows]);
  const range=getRange(period,today,month,first);
  const {accounts:table,exchanges,dates,total,drawdown,gains,losses,wins,losingDays}=useMemo(()=>(
    summarize(rows.filter(row=>row.date>=range.start&&row.date<=range.end),accounts)
  ),[accounts,rows,range.start,range.end]);
  const calendarMonth=new Date(month.getFullYear(),month.getMonth()+calendarShift,1);
  const calendarPrefix=dateKey(calendarMonth).slice(0,7);
  const calendarTotals=useMemo(()=>{
    const netByDay=new Map<string,number>();
    for(const row of rows)if(row.date.startsWith(calendarPrefix))netByDay.set(row.date,(netByDay.get(row.date)||0)+row.gross-row.fee+row.funding);
    return netByDay;
  },[calendarPrefix,rows]);
  const calendarDays=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth()+1,0).getDate();
  const capital=table.reduce((sum,a)=>sum+(a.balance||0),0);
  const capitalKnown=table.some(a=>a.balance!==null);
  const ringTotal=exchanges.reduce((value,v)=>value+Math.abs(v.net),0);
  const active=exchanges.find(v=>v.key===selectedSlice);
  let angle=0;
  const stops=exchanges.map((entry,index)=>{
    const start=angle;
    angle+=Math.abs(entry.net)/ringTotal*100;
    return `${colors[index%colors.length]} ${start}% ${angle}%`;
  });
  const formatPnl=(value:number)=>unit==='usd'?money(value):capitalUsd>0?`${value>0?'+':value<0?'−':''}${Math.abs(percentOfCapital(value,capitalUsd)).toFixed(2)}%`:'—';
  const amount=(value:number)=>hidden?<span className="stats-masked">•••</span>:<span className={tone(value)}>{formatPnl(value)}</span>;
  const marketScope=(exchange:string,market:Market)=>({...range,exchange,market,title:`${exchange} · ${marketLabels[market]} · ${range.title}`});

  return <section className="exchange-statistics panel" aria-labelledby="exchange-stats-title">
    <header className="stats-header">
      <div><h2 id="exchange-stats-title">Статистика торговли</h2><span>{range.title}</span></div>
      <div className="stats-controls">
        <div className="period-switch" aria-label="Период статистики">{periods.map(([id,label])=><button key={id} className={id===period?'active':''} aria-pressed={id===period} onClick={()=>{setPeriod(id);setSelectedSlice(null);}}>{label}</button>)}</div>
        <button className="icon-button" aria-label={hidden?'Показать суммы':'Скрыть суммы'} onClick={onToggleHidden}>{hidden?<EyeOff size={17}/>:<Eye size={17}/>}</button>
      </div>
    </header>
    <div className="stats-kpis">
      <div><span>Чистый PnL</span><strong>{amount(total.net)}</strong></div>
      <div><span>Комиссии</span><strong>{amount(total.fees)}</strong></div>
      <div><span>Фандинг</span><strong>{amount(total.funding)}</strong></div>
      <div><span>Записи PnL</span><strong>{formatCount.format(total.count)}</strong></div>
      <div><span>Плюсовые дни</span><strong>{wins} <small>из {dates.length}</small></strong></div>
    </div>
    {error&&<p className="server-error" role="status">{error}</p>}
    <div className="stats-grid-layout">
      <section className="stats-section stats-account-panel">
        <div className="stats-section-head"><h3>Счета и рынки</h3><span>{formatCount.format(table.length)} подключений</span></div>
        {table.length>0?<div className="stats-table-scroll" tabIndex={0} aria-label="Таблица результатов по счетам">
          <table className="stats-account-table">
            <thead><tr><th scope="col">Биржа / рынок</th><th scope="col">Капитал</th><th scope="col">Чистый PnL</th><th scope="col">Комиссии</th><th scope="col">Фандинг</th></tr></thead>
            <tbody>{table.map(account=><Fragment key={account.id}>
              <tr className="stats-account-row"><th scope="row"><span>{icon(account.exchange)}<span>{account.exchange}<small>{account.label}</small></span></span></th>
                <td>{account.balance===null?'—':hidden?'•••':usd.format(account.balance)}</td>
                <td>{account.totals.count?amount(account.totals.net):'—'}</td><td>{account.totals.count?amount(account.totals.fees):'—'}</td><td>{account.totals.count?amount(account.totals.funding):'—'}</td>
              </tr>
              {(['spot','futures'] as const).map(market=>{
                const values=account.markets.get(market);
                if(!values)return null;
                return <tr className="stats-market-row" key={market}>
                  <th scope="row"><button onClick={()=>onOpen({...marketScope(account.exchange,market),connectionId:account.id,account:account.label})}>{marketLabels[market]} <small>{formatCount.format(values.count)} зап.</small></button></th>
                  <td>—</td><td>{amount(values.net)}</td><td>{amount(values.fees)}</td><td>{amount(values.funding)}</td>
                </tr>;
              })}
            </Fragment>)}</tbody>
            <tfoot><tr><th scope="row">Итого</th><td>{!capitalKnown?'—':hidden?'•••':usd.format(capital)}</td><td>{amount(total.net)}</td><td>{amount(total.fees)}</td><td>{amount(total.funding)}</td></tr></tfoot>
          </table>
        </div>:<p className="stats-empty">За этот период пока нет записей.</p>}
        <p className="stats-footnote">Капитал указан один раз на счёт. PnL рынков включает комиссии и фандинг.</p>
      </section>
      <div className="stats-side">
        <section className="stats-section">
          <div className="stats-section-head"><h3>Вклад бирж</h3><span>Доля в |PnL|</span></div>
          <div className="stats-ring" style={stops.length&&!hidden?{background:`conic-gradient(${stops.join(',')})`}:undefined}>
            <div><strong>{amount(active?.net??total.net)}</strong><small>{active?`${active.exchange} ${marketLabels[active.market]}`:'Чистый PnL'}</small></div>
          </div>
          {exchanges.length>0?<ul className="stats-ring-legend">{exchanges.map((entry,index)=><li key={entry.key}>
            <button onFocus={()=>setSelectedSlice(entry.key)} onBlur={()=>setSelectedSlice(null)} onMouseEnter={()=>setSelectedSlice(entry.key)} onMouseLeave={()=>setSelectedSlice(null)} onClick={()=>onOpen(marketScope(entry.exchange,entry.market))}>
              <i style={{backgroundColor:colors[index%colors.length]}}/><span>{entry.exchange} {marketLabels[entry.market]}</span><b>{amount(entry.net)}</b>
            </button>
          </li>)}</ul>:<p className="stats-empty">Нет ненулевого PnL за период.</p>}
        </section>
        <section className="stats-section">
          <div className="stats-section-head"><h3>Риск</h3><span>По итогам дней</span></div>
          <div className="stats-risk">
            <div><span>Профит-фактор</span><strong>{hidden?'•••':losses?(gains/losses).toFixed(2):gains?'∞':'—'}</strong></div>
            <div><span>Макс. просадка</span><strong>{dates.length?amount(drawdown):'—'}</strong></div>
            <div><span>Минусовых дней</span><strong>{losingDays}</strong></div>
            <div><span>Дней с PnL</span><strong>{dates.length}</strong></div>
          </div>
        </section>
        <section className="stats-section stats-mini-panel">
          <div className="stats-section-head"><h3>{monthLabel.format(calendarMonth)}</h3><div className="stats-month-nav">
            <button className="icon-button" onClick={()=>setCalendarShift(v=>v-1)} aria-label="Предыдущий месяц мини-календаря"><ChevronLeft size={16}/></button>
            <button className="icon-button" onClick={()=>setCalendarShift(v=>v+1)} disabled={calendarPrefix>=dateKey(today).slice(0,7)} aria-label="Следующий месяц мини-календаря"><ChevronRight size={16}/></button>
          </div></div>
          <div className="stats-mini-grid">
            {['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map(day=><span className="stats-weekday" key={day}>{day}</span>)}
            {Array.from({length:(calendarMonth.getDay()+6)%7},(_,index)=><span key={`blank-${index}`}/>)}
            {Array.from({length:calendarDays},(_,index)=>{
              const day=index+1,date=new Date(calendarMonth.getFullYear(),calendarMonth.getMonth(),day),key=dateKey(date),value=calendarTotals.get(key);
              return <button key={day} className={!hidden&&value!==undefined?`stats-mini-day ${tone(value)}`:'stats-mini-day'} disabled={key>dateKey(today)}
                aria-label={`${dateLabel.format(date)}${!hidden&&value!==undefined?`, ${formatPnl(value)}`:''}`}
                onClick={()=>onOpen({start:key,end:key,title:dateLabel.format(date)})}><span>{day}</span><small>{hidden||value===undefined?'':formatPnl(value)}</small></button>;
            })}
          </div>
        </section>
      </div>
    </div>
  </section>;
}
