import { decrypt } from './security.mjs';
import { createAdapter, DAY } from './exchanges.mjs';
import { enqueue, savePage } from './database.mjs';

export function createWorker(db,key,adapterFactory=createAdapter) {
  let busy=false,stopped=false,timer;
  // One worker process per SQLite volume. Interrupted pages are safe to replay.
  db.prepare("UPDATE jobs SET status='queued' WHERE status='running'").run();
  async function tick() {
    if(busy||stopped)return;
    busy=true;
    let job;
    try {
      for(const c of db.prepare("SELECT id FROM connections WHERE disabled=0 AND synced IS NOT NULL AND synced<? AND status='ready'").all(Date.now()-15*60000)) enqueue(db,c.id);
      job=db.prepare("SELECT * FROM jobs WHERE status='queued' AND next_run<=? ORDER BY id LIMIT 1").get(Date.now());
      if(!job)return;
      const c=db.prepare('SELECT * FROM connections WHERE id=? AND disabled=0').get(job.connection_id);
      if(!c) {db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(job.id);return;}
      db.prepare("UPDATE jobs SET status='running',updated=? WHERE id=?").run(Date.now(),job.id);
      db.prepare("UPDATE connections SET status='syncing',error=NULL WHERE id=?").run(c.id);
      const options=JSON.parse(c.options),adapter=adapterFactory(c.exchange,decrypt(c.secret,key,c.id),options);
      if(adapter.prepare && await adapter.prepare()) db.prepare('UPDATE connections SET options=? WHERE id=?').run(JSON.stringify(options),c.id);
      const state=JSON.parse(job.checkpoint);
      if(!state.end) {
        state.end=Date.now();state.stream=0;state.effectiveStart=c.synced?Math.max(c.start,c.synced-2*DAY):c.start;
        state.discoverSpot=c.exchange==='Binance'&&options.spotAuto===true&&(!options.spotDiscoveryAt||Date.now()-options.spotDiscoveryAt>7*DAY);
      } else if(c.exchange==='Binance'&&options.spotAuto===true&&state.discoverSpot===undefined&&!options.spotDiscoveryAt) {
        state.discoverSpot=true;state.stream=0;delete state.start;delete state.cursor;
      }
      const streams=adapter.streams(state.end,state);
      if(state.stream>=streams.length) {
        const snapshot=await adapter.snapshot();
        if(state.discoverSpot){options.spotDiscoveryAt=Date.now();db.prepare('UPDATE connections SET options=? WHERE id=?').run(JSON.stringify(options),c.id);}
        db.prepare('INSERT INTO snapshots VALUES(?,?,?) ON CONFLICT(connection_id) DO UPDATE SET time=excluded.time,data=excluded.data').run(c.id,Date.now(),JSON.stringify(snapshot));
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
        if(page.next && page.next===state.cursor) throw new Error('Биржа повторила курсор. Синхронизация остановлена без потери данных.');
        if(page.next) {state.start=start;state.cursor=page.next;}
        else if(end>=state.end) {state.stream++;delete state.start;delete state.cursor;}
        else {state.start=end+1;delete state.cursor;}
        savePage(db,c.id,stream.id,page.events,job.id,state);
      }
      db.prepare("UPDATE jobs SET status='queued',attempts=0 WHERE id=?").run(job.id);
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

