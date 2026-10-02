import { decrypt } from './security.mjs';
import { createAdapter, DAY } from './exchanges.mjs';
import { enqueue, savePage } from './database.mjs';

export const SYNC_INTERVAL = 5*60*1000;
const SNAPSHOT_INTERVAL = 5*60*1000;

export function createWorker(db,key,adapterFactory=createAdapter) {
  let busy=false,stopped=false,timer;
  // One worker process per SQLite volume. Interrupted pages are safe to replay.
  db.prepare("UPDATE jobs SET status='queued' WHERE status='running'").run();
  async function tick() {
    if(busy||stopped)return;
    busy=true;
    let job;
    try {
      for(const c of db.prepare("SELECT id FROM connections WHERE disabled=0 AND synced IS NOT NULL AND synced<? AND status='ready'").all(Date.now()-SYNC_INTERVAL)) enqueue(db,c.id);
      // Rotate long imports page by page so one account cannot hold up every other exchange.
      job=db.prepare("SELECT * FROM jobs WHERE status='queued' AND next_run<=? ORDER BY updated,id LIMIT 1").get(Date.now());
      if(!job)return;
      const c=db.prepare('SELECT * FROM connections WHERE id=? AND disabled=0').get(job.connection_id);
      if(!c) {db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(job.id);return;}
      db.prepare("UPDATE jobs SET status='running',updated=? WHERE id=?").run(Date.now(),job.id);
      db.prepare("UPDATE connections SET status='syncing',error=NULL WHERE id=?").run(c.id);
      const options=JSON.parse(c.options);
      if(c.exchange==='Binance'){
        const symbols=new Set(options.futuresSymbols||[]);for(const row of db.prepare("SELECT DISTINCT symbol FROM events WHERE connection_id=? AND market='futures' AND symbol<>''").all(c.id))symbols.add(row.symbol);
        const found=[...symbols].filter(v=>/^[A-Z0-9]{4,30}$/.test(v)).sort();if(JSON.stringify(found)!==JSON.stringify(options.futuresSymbols||[])){options.futuresSymbols=found;db.prepare('UPDATE connections SET options=? WHERE id=?').run(JSON.stringify(options),c.id);}
      }
      const adapter=adapterFactory(c.exchange,decrypt(c.secret,key,c.id),options);
      if(adapter.prepare && await adapter.prepare()) db.prepare('UPDATE connections SET options=? WHERE id=?').run(JSON.stringify(options),c.id);
      const state=JSON.parse(job.checkpoint);
      if(!state.end) {
        state.end=Date.now();state.stream=0;state.binanceFuturesBackfill=c.exchange==='Binance'&&!options.futuresTradesBackfillAt;state.effectiveStart=state.binanceFuturesBackfill?Math.max(c.start,state.end-89*DAY):c.synced?Math.max(c.start,c.synced-2*DAY):c.start;
        state.discoverSpot=c.exchange==='Binance'&&options.spotAuto===true&&(!options.spotDiscoveryAt||Date.now()-options.spotDiscoveryAt>7*DAY);
      } else if(c.exchange==='Binance'&&options.spotAuto===true&&state.discoverSpot===undefined&&!options.spotDiscoveryAt) {
        state.discoverSpot=true;state.stream=0;delete state.start;delete state.cursor;
      }
      const now=Date.now();
      if(!state.snapshotAt||now-state.snapshotAt>=SNAPSHOT_INTERVAL) {
        const snapshot=await adapter.snapshot();
        state.snapshotAt=now;
        db.prepare('INSERT INTO snapshots VALUES(?,?,?) ON CONFLICT(connection_id) DO UPDATE SET time=excluded.time,data=excluded.data').run(c.id,now,JSON.stringify(snapshot));
        db.prepare('UPDATE jobs SET checkpoint=?,updated=? WHERE id=?').run(JSON.stringify(state),now,job.id);
      }
      const streams=adapter.streams(state.end,state);
      if(state.stream>=streams.length) {
        if(state.discoverSpot){options.spotDiscoveryAt=Date.now();db.prepare('UPDATE connections SET options=? WHERE id=?').run(JSON.stringify(options),c.id);}
        if(state.binanceFuturesBackfill){options.futuresTradesBackfillAt=Date.now();db.prepare('UPDATE connections SET options=? WHERE id=?').run(JSON.stringify(options),c.id);}
        db.prepare("UPDATE connections SET status='ready',synced=?,error=NULL WHERE id=?").run(state.end,c.id);
        db.prepare("UPDATE jobs SET status='done',updated=? WHERE id=?").run(Date.now(),job.id);
        return;
      }
      const stream=streams[state.stream];
      const start=state.start??Math.max(state.effectiveStart,stream.start);
      const end=Math.min(start+stream.window-1,state.end);
      if(start>state.end) {state.stream++;delete state.start;delete state.cursor;savePage(db,c.id,stream.id,[],job.id,state);}
      else {
        const page=await adapter.page(stream.id,start,end,state.cursor);
        if(page.discoveredSymbol&&!options.spotSymbols.includes(page.discoveredSymbol)) {
          options.spotSymbols.push(page.discoveredSymbol);options.spotSymbols.sort();
          db.prepare('UPDATE connections SET options=? WHERE id=?').run(JSON.stringify(options),c.id);
        }
        if(Array.isArray(page.discoveredFuturesSymbols)) {
          const symbols=new Set(options.futuresSymbols||[]);for(const symbol of page.discoveredFuturesSymbols)symbols.add(symbol);
          options.futuresSymbols=[...symbols].sort();db.prepare('UPDATE connections SET options=? WHERE id=?').run(JSON.stringify(options),c.id);
        }
        if(page.next && page.next===state.cursor) throw new Error('Биржа повторила курсор. Синхронизация остановлена без потери данных.');
        if(page.next) {state.start=start;state.cursor=page.next;}
        else if(end>=state.end) {state.stream++;delete state.start;delete state.cursor;}
        else {state.start=end+1;delete state.cursor;}
        savePage(db,c.id,stream.id,page.events,job.id,state);
      }
      db.prepare("UPDATE jobs SET status='queued',attempts=0,updated=? WHERE id=?").run(Date.now(),job.id);
    } catch(e) {
      if(job) {
        const retry=!!e.retryable && job.attempts<5;
        const message=e.name==='ExchangeError'?e.message:'Не удалось обработать данные биржи. Сохранённые страницы не потеряны.';
        db.prepare('UPDATE jobs SET status=?,attempts=attempts+1,next_run=?,error=?,updated=? WHERE id=?').run(retry?'queued':'failed',Date.now()+Math.min(300000,5000*2**job.attempts),message,Date.now(),job.id);
        db.prepare('UPDATE connections SET status=?,error=? WHERE id=?').run(retry?'retrying':'error',message,job.connection_id);
      }
    } finally {busy=false;}
  }
  return {tick,start(){timer=setInterval(()=>void tick(),500);timer.unref();void tick();},async stop(){stopped=true;clearInterval(timer);while(busy)await new Promise(r=>setTimeout(r,50));}};
}


