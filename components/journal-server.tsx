"use client";
import { useEffect, useState } from 'react';
import type { Trade } from '@/lib/journal';

type Connection={id:string;exchange:string;label:string;start:number;status:string;error:string|null;synced:number|null;records:number;earliest:number|null;disabled:number};
type Provider={id:string;enabled:boolean;address?:boolean;passphrase?:boolean;notice:string};
export async function journalApi<T = {ok:boolean}>(path:string,body?:unknown):Promise<T> {
  const res=await fetch('/api/journal'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json','X-Journal-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!res.headers.get('content-type')?.includes('application/json'))throw new Error('Сервер журнала пока недоступен.');
  const data=await res.json() as T & {error?:string};if(!res.ok)throw new Error(data.error||'Ошибка сервера.');return data;
}
export function useServerJournal(from:string,to:string,enabled:boolean) {
  const [rows,setRows]=useState<Trade[]>([]),[notice,setNotice]=useState(''),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  useEffect(()=>{if(!enabled){setRows([]);return;}let active=true;setRows([]);
    async function load(){try{const now=Date.now(),a=new Date(now-7*86400000).toISOString().slice(0,10),b=new Date(now+7*86400000).toISOString().slice(0,10);const [data,recent]=await Promise.all([journalApi<{rows:Trade[];notice:string;unvalued:number}>(`/journal?from=${from}&to=${to}`),journalApi<{rows:Trade[]}>(`/journal?from=${a}&to=${b}`)]);data.rows=[...new Map([...data.rows,...recent.rows].map(r=>[r.id,r])).values()];if(active){setRows(data.rows);setNotice(data.notice+(data.unvalued?` ${data.unvalued} записей в других валютах не включены в USD-итог.`:''));setError('');}}catch(e){if(active)setError((e as Error).message);}}
    void load();const timer=setInterval(load,10000);return()=>{active=false;clearInterval(timer);};
  },[from,to,enabled,revision]);
  return {rows,notice,error,refresh:()=>setRevision(v=>v+1)};
}
export function OwnerAccess({onOpen}:{onOpen:()=>void}) {
  const [state,setState]=useState<'loading'|'setup'|'login'|'error'>('loading'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{journalApi<{authenticated:boolean;needsSetup:boolean}>('/session').then(v=>{if(v.authenticated)onOpen();else setState(v.needsSetup?'setup':'login');}).catch(()=>{setState('error');setError('Сервер недоступен. Запустите npm run dev:api или проверьте хостинг.');});},[onOpen]);
  return <div className="owner-access"><div className="panel"><h1>Торговый журнал</h1><p>{state==='setup'?'Задайте пароль личного журнала. Регистрация не нужна.':state==='loading'?'Подключение к серверу…':'Введите пароль для доступа к биржевым данным.'}</p>{state!=='loading'&&state!=='error'&&<form className="connection-form" onSubmit={async e=>{e.preventDefault();const form=e.currentTarget;setBusy(true);setError('');const data=new FormData(form);try{await journalApi(state==='setup'?'/setup':'/login',{password:data.get('password'),token:data.get('token')});form.reset();onOpen();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>{state==='setup'&&<label>Код первоначальной настройки<input name="token" type="password" autoComplete="off" required/><small>Локально: файл .journal-local/SETUP.txt. На Railway: переменная JOURNAL_SETUP_TOKEN.</small></label>}<label>Пароль журнала<input name="password" type="password" minLength={12} maxLength={256} autoComplete={state==='setup'?'new-password':'current-password'} required/></label><button className="connect-button" disabled={busy}>{busy?'Проверка…':state==='setup'?'Создать личный журнал':'Открыть журнал'}</button></form>}{error&&<p role="alert" className="server-error">{error}</p>}</div></div>;
}
export function Connections({onChange}:{onChange:()=>void}) {
  const [items,setItems]=useState<Connection[]>([]),[providers,setProviders]=useState<Provider[]>([]),[exchange,setExchange]=useState('Bybit'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const selected=providers.find(v=>v.id===exchange);
  async function load(){const data=await journalApi<{connections:Connection[];catalog:Provider[]}>('/connections');setItems(data.connections);setProviders(data.catalog);}
  useEffect(()=>{void load().catch(e=>setError(e.message));const timer=setInterval(()=>void load().catch(()=>{}),4000);return()=>clearInterval(timer);},[]);
  const labels:Record<string,string>={queued:'В очереди',syncing:'Загружаем историю',retrying:'Ожидаем биржу',ready:'Доступная история загружена',error:'Нужна проверка'};
  async function action(c:Connection,verb:string){setError('');try{await journalApi(`/connections/${c.id}/${verb}`,{});await load();onChange();}catch(e){setError((e as Error).message);}}
  return <div className="server-connections"><div className="saved-connections">{items.map(c=><section className="saved-connection" key={c.id}><strong>{c.exchange} · {c.label}</strong><span>{c.disabled?'Приостановлено':labels[c.status]||c.status}</span><small>{c.records.toLocaleString('ru-RU')} записей{c.earliest?` · с ${new Date(c.earliest).toLocaleDateString('ru-RU')}`:''}</small>{c.synced&&<small>Обновлено: {new Date(c.synced).toLocaleString('ru-RU')}</small>}{c.error&&<p role="alert">{c.error}</p>}<div className="connection-actions"><button className="secondary-button" onClick={()=>void action(c,'sync')}>Синхронизировать</button><button className="secondary-button" onClick={()=>void action(c,c.disabled?'resume':'pause')}>{c.disabled?'Продолжить':'Пауза'}</button></div></section>)}</div>
    <form className="connection-form" onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');const form=e.currentTarget;const data=new FormData(form);try{await journalApi('/connections',{exchange,label:data.get('label'),apiKey:data.get('apiKey'),secret:data.get('secret'),passphrase:data.get('passphrase'),address:data.get('address'),start:data.get('start'),spotSymbols:data.get('spotSymbols'),futures:data.get('futures')==='on'});form.reset();await load();onChange();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>
    <h3>Добавить подключение</h3><label>Биржа<select value={exchange} onChange={e=>setExchange(e.target.value)}>{providers.map(v=><option key={v.id} value={v.id} disabled={!v.enabled}>{v.id}{!v.enabled?' — скоро':''}</option>)}</select></label>
    <p className="info-note">{selected?.notice}</p><label>Название счёта<input name="label" placeholder="Основной счёт" maxLength={80} required/></label>
    {selected?.address?<label>Публичный адрес кошелька<input name="address" placeholder="0x…" pattern="0x[a-fA-F0-9]{40}" autoComplete="off" required/><small>Не вводите seed-фразу или приватный ключ.</small></label>:<><label>API Key<input name="apiKey" type="password" autoComplete="off" maxLength={256} required/></label><label>API Secret<input name="secret" type="password" autoComplete="off" maxLength={512} required/></label>{selected?.passphrase&&<label>API Passphrase<input name="passphrase" type="password" autoComplete="off" maxLength={256} required/></label>}</>}
    <label>Начало истории<input name="start" type="date" min="2017-01-01" max={new Date().toISOString().slice(0,10)} defaultValue="2024-01-01" required/></label>
    {exchange==='Binance'&&<><label className="check-label"><input name="futures" type="checkbox" defaultChecked/>USDⓈ-M фьючерсы</label><label>Все торговавшиеся пары spot<input name="spotSymbols" placeholder="BTCUSDT, ETHUSDT, SOLUSDC"/><small>Без списка пар Binance не позволяет найти всю историю spot.</small></label></>}
    <label className="check-label"><input type="checkbox" required/>Ключ только для чтения, без торговли, переводов и вывода.</label>
    <button className="connect-button" disabled={busy||!selected?.enabled}>{busy?'Проверяем доступ…':'Подключить и загрузить историю'}</button>
    {error&&<p role="alert" className="server-error">{error}</p>}
    <small>Секрет отправляется только вашему серверу, хранится зашифрованным и не возвращается в браузер. Синхронизация продолжается после закрытия страницы.</small>
    </form></div>;
}
export function RealHistory({from,to,exchange,market}:{from:string;to:string;exchange:string;market:string}) {
  const [rows,setRows]=useState<Array<{id:string;time:number;exchange:string;symbol:string;market:string;side:string;quantity:string;price:string;fee:string;currency:string}>>([]),[offset,setOffset]=useState(0),[more,setMore]=useState(false),[error,setError]=useState('');
  useEffect(()=>setOffset(0),[from,to]);
  useEffect(()=>{let active=true;async function load(){try{const data=await journalApi<{rows:typeof rows;hasMore:boolean}>(`/fills?from=${from}&to=${to}&offset=${offset}`);if(active){setRows(data.rows);setMore(data.hasMore);setError('');}}catch(e){if(active)setError((e as Error).message);}}void load();const timer=setInterval(load,10000);return()=>{active=false;clearInterval(timer);};},[from,to,offset]);
  const filtered=rows.filter(v=>(exchange==='all'||exchange===v.exchange)&&(market==='all'||market===v.market));
  return <div><p className="info-note">Исполнения биржи. Цена и комиссия — в исходных валютах; прибыль spot здесь не рассчитывается. Фильтры применяются к текущей странице.</p>{error&&<p role="alert">{error}</p>}<table className="real-history"><thead><tr>{['Дата · UTC','Биржа','Тикер','Сторона','Количество','Цена','Комиссия'].map(v=><th key={v}>{v}</th>)}</tr></thead><tbody>{filtered.map((v,i)=><tr key={v.exchange+v.id+i}><td>{new Date(v.time).toISOString().replace('T',' ').slice(0,19)}</td><td>{v.exchange}</td><td>{v.symbol}</td><td>{v.side}</td><td>{v.quantity}</td><td>{v.price}</td><td>{v.fee} {v.currency}</td></tr>)}</tbody></table>{!filtered.length&&<p className="empty-state">Нет исполнений на этой странице</p>}<div className="connection-actions"><button className="secondary-button" disabled={!offset} onClick={()=>setOffset(v=>Math.max(0,v-200))}>Назад</button><button className="secondary-button" disabled={!more} onClick={()=>setOffset(v=>v+200)}>Далее</button></div></div>;
}
