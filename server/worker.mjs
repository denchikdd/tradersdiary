import { decrypt } from './security.mjs';
import { createAdapter, DAY } from './exchanges.mjs';
import { deferExchange, enqueue, exchangeRetryAt, savePage } from './database.mjs';

export const SYNC_INTERVAL = 5*60*1000;
const SNAPSHOT_INTERVAL = 5*60*1000;
const LIVE_LOOKBACK = 2*DAY;
const REPLAY_OVERLAP = 15*60*1000;
const MAX_ACCOUNTS = 4;

function liveStreams(streams) {
  // Apply the exchange ledger first when available. Symbol discovery can then
  // add execution streams to the same pass without moving its checkpoint.
  return streams.filter(v=>!v.id.startsWith('spot-scan:')).sort((a,b)=>priority(a.id)-priority(b.id));
}
const priority=id=>/income|ledger|bills|^futures:(pnl|fee|fund)$/.test(id)?0:1;

function freshPass(connection,state,end) {
  const previous=Number(state.liveSyncedAt||connection.synced||0);
  return {end,stream:0,effectiveStart:Math.max(connection.start,end-LIVE_LOOKBACK,previous?previous-REPLAY_OVERLAP:0)};
}

export function createWorker(db,key,adapterFactory=createAdapter) {
  let stopped=false,timer;
  const running=new Map();
  // One worker process per SQLite volume. Interrupted pages are safe to replay.
  db.prepare("UPDATE jobs SET status='queued' WHERE status='running'").run();
  const errorMessage=e=>e.name==='ExchangeError'?e.message:'Не удалось обработать данные биржи. Сохранённые страницы не потеряны.';
  async function run(job,c) {
    let state;
    try {
      db.prepare("UPDATE jobs SET status='running',updated=? WHERE id=?").run(Date.now(),job.id);
      db.prepare("UPDATE connections SET status='syncing' WHERE id=?").run(c.id);
      const options=JSON.parse(c.options);
      if(c.exchange==='Binance'){
        const symbols=new Set(options.futuresSymbols||[]);for(const row of db.prepare("SELECT DISTINCT symbol FROM events WHERE connection_id=? AND market='futures' AND symbol<>''").all(c.id))symbols.add(row.symbol);
        const found=[...symbols].filter(v=>/^[A-Z0-9]{4,30}$/.test(v)).sort();if(JSON.stringify(found)!==JSON.stringify(options.futuresSymbols||[])){options.futuresSymbols=found;db.prepare('UPDATE connections SET options=? WHERE id=?').run(JSON.stringify(options),c.id);}
      }
      const adapter=adapterFactory(c.exchange,decrypt(c.secret,key,c.id),options);
      state=JSON.parse(job.checkpoint);
      const now=Date.now();
      if(adapter.prepare&&now-(state.preparedAt||0)>=SYNC_INTERVAL) {
        try {
          if(await adapter.prepare()) db.prepare('UPDATE connections SET options=? WHERE id=?').run(JSON.stringify(options),c.id);
          delete state.prepareError;
        } catch(e) {
          if(e.retryAt||!adapter.streams(now).length)throw e;
          state.prepareError=errorMessage(e);
        }
        state.preparedAt=now;
      }
      if(c.exchange==='MEXC'&&!options.mexcSpotHistoryV2At&&!state.mexcSpotHistoryV2) {
        // Legacy pages could be capped at 100 without a usable continuation.
        // Replay the available window using the same event IDs.
        state={preparedAt:state.preparedAt,prepareError:state.prepareError,mexcSpotHistoryV2:true};
      }
      if(c.exchange==='Binance'&&!state.binanceRecentSymbolsV1&&state.end) {
        state.binanceRecentSymbolsV1=true;
        state.live=freshPass(c,state,now);
      }
      const repairRequired=['Aster','Gate.io','Bitget','Hyperliquid'].includes(c.exchange)&&!options.pnlAuditV2At;
      if(!state.end) {
        state.end=now;state.stream=0;state.pnlAuditV2=repairRequired;state.binanceFuturesBackfill=c.exchange==='Binance'&&!options.futuresTradesBackfillAt;state.effectiveStart=state.mexcSpotHistoryV2?Math.max(c.start,now-29*DAY):repairRequired?c.start:state.binanceFuturesBackfill?Math.max(c.start,state.end-89*DAY):c.synced?Math.max(c.start,c.synced-REPLAY_OVERLAP):c.start;
        state.discoverSpot=c.exchange==='Binance'&&options.spotAuto===true&&(!options.spotDiscoveryAt||Date.now()-options.spotDiscoveryAt>7*DAY);
        // A long first import must not hide today's trades until years of old
        // pages have finished. Short imports already are their own live pass.
        if(state.effectiveStart<state.end-LIVE_LOOKBACK||state.discoverSpot)state.live=freshPass(c,state,state.end);
        if(c.exchange==='Binance')state.binanceRecentSymbolsV1=true;
      } else if(c.exchange==='Binance'&&options.spotAuto===true&&state.discoverSpot===undefined&&!options.spotDiscoveryAt) {
        state.discoverSpot=true;resetPass(state);
      }
      if(repairRequired&&state.pnlAuditV2===undefined) {
        state.pnlAuditV2=true;resetPass(state);state.effectiveStart=c.start;
        if(!state.live)state.live=freshPass(c,state,Date.now());
      }
      if(!state.live&&now-Number(state.liveAttemptAt||state.liveSyncedAt||c.synced||state.end)>=SYNC_INTERVAL)state.live=freshPass(c,state,now);
      const isLive=!!state.live,pass=isLive?state.live:state;
      const available=adapter.streams(pass.end,isLive?{...state,discoverSpot:false}:state);
      let streams=isLive?liveStreams(available):available;
      pass.finishedStreams??=streams.slice(0,pass.stream).map(v=>v.id);
      const finished=new Set(pass.finishedStreams);
      const recentBinance=c.exchange==='Binance'&&(isLive||(!state.binanceFuturesBackfill&&!state.discoverSpot&&pass.effectiveStart>=pass.end-LIVE_LOOKBACK));
      if(recentBinance&&finished.has('income')&&Array.isArray(pass.binanceIncomeSymbols)&&!pass.streamErrors?.income) {
        const traded=new Set(pass.binanceIncomeSymbols);
        streams=streams.filter(v=>!v.id.startsWith('futures:')||traded.has(v.id.slice(8)));
      }
      const stream=streams.find(v=>v.id===pass.activeStream&&!finished.has(v.id))||streams.find(v=>!finished.has(v.id));
      if(!stream) {
        if(!available.length&&adapter.snapshot) {
          try {
            const snapshot=await adapter.snapshot();
            db.prepare('INSERT INTO snapshots VALUES(?,?,?) ON CONFLICT(connection_id) DO UPDATE SET time=excluded.time,data=excluded.data').run(c.id,now,JSON.stringify(snapshot));
          } catch { /* Balance-only connections keep their last snapshot. */ }
        }
        const errors=Object.values(pass.streamErrors||{});
        if(state.prepareError)errors.push(state.prepareError);
        const error=errors[0]||(c.exchange==='MEXC'&&!available.length?'MEXC не предоставила доступных пар для импорта.':null);
        if(isLive) {
          state.liveAttemptAt=now;
          state.liveError=error;
          if(!error)state.liveSyncedAt=pass.end;
          delete state.live;
          db.prepare('UPDATE connections SET synced=coalesce(?,synced),error=? WHERE id=?').run(error?null:pass.end,error,c.id);
          savePage(db,c.id,'__live__',[],job.id,state);
          db.prepare("UPDATE jobs SET status='queued',attempts=0,updated=? WHERE id=?").run(Date.now(),job.id);
          return;
        }
        if(!error) {
          if(state.discoverSpot)options.spotDiscoveryAt=now;
          if(state.binanceFuturesBackfill)options.futuresTradesBackfillAt=now;
          if(state.pnlAuditV2)options.pnlAuditV2At=now;
          if(state.mexcSpotHistoryV2)options.mexcSpotHistoryV2At=now;
          db.prepare('UPDATE connections SET options=? WHERE id=?').run(JSON.stringify(options),c.id);
        }
        const synced=error||state.liveError?c.synced:Math.max(c.synced||0,state.liveSyncedAt||0,state.end);
        const status=error||state.liveError?'partial':!available.length?'unsupported':'ready';
        db.prepare('UPDATE connections SET status=?,synced=?,error=? WHERE id=?').run(status,synced,error||state.liveError||null,c.id);
        db.prepare("UPDATE jobs SET status='done',updated=?,error=? WHERE id=?").run(now,error,job.id);
        return;
      }
      if(pass.activeStream&&pass.activeStream!==stream.id){delete pass.start;delete pass.cursor;}
      pass.activeStream=stream.id;
      const mexcSpot=c.exchange==='MEXC'&&stream.id.startsWith('spot:')?stream.id.slice(5):null;
      const spotSkip=mexcSpot&&options.mexcUnavailablePairs?.[mexcSpot];
      const skippedFrom=spotSkip?(spotSkip.from??spotSkip-DAY):null;
      const replayFrom=skippedFrom===null?pass.effectiveStart:Math.max(c.start,skippedFrom);
      const start=pass.start??Math.max(Math.min(pass.effectiveStart,replayFrom),stream.start);
      const end=Math.min(start+stream.window-1,pass.end);
      if(start>pass.end) {finishStream(pass,stream.id);savePage(db,c.id,stream.id,[],job.id,state);}
      else {
        let page;
        try {
          page=await adapter.page(stream.id,start,end,pass.cursor);
          if(page.next && page.next===pass.cursor)throw new Error('Repeated exchange cursor');
        } catch(e) {
          if(e.retryAt||e.retryable&&job.attempts<1)throw e;
          (pass.streamErrors??={})[stream.id]=errorMessage(e);
          finishStream(pass,stream.id);
          savePage(db,c.id,stream.id,[],job.id,state);
          db.prepare("UPDATE jobs SET status='queued',attempts=0,next_run=0 WHERE id=?").run(job.id);
          db.prepare('UPDATE connections SET error=? WHERE id=?').run(errorMessage(e),c.id);
          return;
        }
        if(page.unavailableSpotSymbol) {
          const unavailable=options.mexcUnavailablePairs??={};
          unavailable[page.unavailableSpotSymbol]={retryAt:now+DAY,from:Math.min(start,skippedFrom??start)};
          db.prepare('UPDATE connections SET options=? WHERE id=?').run(JSON.stringify(options),c.id);
        }
        if(!db.prepare('SELECT id FROM connections WHERE id=? AND disabled=0').get(c.id)) {
          db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(job.id);
          return;
        }
        if(page.discoveredSymbol&&!options.spotSymbols.includes(page.discoveredSymbol)) {
          options.spotSymbols.push(page.discoveredSymbol);options.spotSymbols.sort();
          db.prepare('UPDATE connections SET options=? WHERE id=?').run(JSON.stringify(options),c.id);
        }
        const discovered=page.discoveredFuturesSymbols||(c.exchange==='Aster'&&stream.id==='income'?
          page.events.map(v=>v.symbol).filter(v=>/^[A-Z0-9]{4,30}$/.test(v)):[]);
        if(recentBinance&&stream.id==='income'&&Array.isArray(page.discoveredFuturesSymbols)) {
          pass.binanceIncomeSymbols=[...new Set([...(pass.binanceIncomeSymbols||[]),...discovered])];
        }
        if(discovered.length) {
          const key=c.exchange==='Aster'?'asterSymbols':'futuresSymbols';
          const symbols=new Set(options[key]||[]);for(const symbol of discovered)symbols.add(symbol);
          options[key]=[...symbols].sort();db.prepare('UPDATE connections SET options=? WHERE id=?').run(JSON.stringify(options),c.id);
        }
        if(page.next) {pass.start=start;pass.cursor=page.next;}
        else if(end>=pass.end||page.unavailableSpotSymbol) {
          finishStream(pass,stream.id);
          if(spotSkip&&!page.unavailableSpotSymbol) {
            delete options.mexcUnavailablePairs[mexcSpot];
            db.prepare('UPDATE connections SET options=? WHERE id=?').run(JSON.stringify(options),c.id);
          }
        }
        else {pass.start=end+1;delete pass.cursor;}
        savePage(db,c.id,stream.id,page.events,job.id,state);
      }
      if(adapter.snapshot&&now-(state.snapshotAt||0)>=SNAPSHOT_INTERVAL) {
        state.snapshotAt=now;
        try {
          const snapshot=await adapter.snapshot();
          db.prepare('INSERT INTO snapshots VALUES(?,?,?) ON CONFLICT(connection_id) DO UPDATE SET time=excluded.time,data=excluded.data').run(c.id,now,JSON.stringify(snapshot));
        } catch(e) {
          if(e.retryAt)throw e;
          // A balance failure never rolls back trade history.
        }
        db.prepare('UPDATE jobs SET checkpoint=? WHERE id=?').run(JSON.stringify(state),job.id);
      }
      db.prepare("UPDATE jobs SET status='queued',attempts=0,next_run=0,updated=? WHERE id=?").run(Date.now(),job.id);
    } catch(e) {
      if(e.retryAt) {
        const retryAt=deferExchange(db,c.exchange,e.retryAt);
        const now=Date.now(),message=errorMessage(e);
        db.prepare("UPDATE jobs SET status='queued',checkpoint=?,next_run=?,error=?,updated=? WHERE id=?")
          .run(JSON.stringify(state||JSON.parse(job.checkpoint)),retryAt,message,now,job.id);
        db.prepare("UPDATE connections SET status='retrying',error=? WHERE id=?").run(message,c.id);
      } else {
        const retry=!!e.retryable && job.attempts<5;
        const message=errorMessage(e);
        db.prepare('UPDATE jobs SET status=?,attempts=attempts+1,next_run=?,error=?,updated=? WHERE id=?').run(retry?'queued':'failed',Date.now()+Math.min(300000,5000*2**job.attempts),message,Date.now(),job.id);
        db.prepare('UPDATE connections SET status=?,error=? WHERE id=?').run(retry?'retrying':'error',message,job.connection_id);
      }
    }
  }
  async function tick() {
    if(stopped)return;
    const now=Date.now();
    for(const c of db.prepare(`SELECT c.id FROM connections c WHERE c.disabled=0
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.connection_id=c.id AND j.status IN ('queued','running'))
      AND coalesce((SELECT max(updated) FROM jobs j WHERE j.connection_id=c.id),0)<=?`).all(now-SYNC_INTERVAL))enqueue(db,c.id);
    const jobs=db.prepare(`SELECT j.*,c.exchange FROM jobs j JOIN connections c ON c.id=j.connection_id
      WHERE j.status='queued' AND j.next_run<=? AND c.disabled=0
      ORDER BY CASE WHEN json_type(j.checkpoint,'$.live')='object' OR
        coalesce(json_extract(j.checkpoint,'$.liveAttemptAt'),c.synced,0)<=? THEN 0 ELSE 1 END,j.updated,j.id`).all(now,now-SYNC_INTERVAL);
    const started=[];
    for(const job of jobs) {
      if(running.size>=MAX_ACCOUNTS)break;
      if(running.has(job.exchange)||exchangeRetryAt(db,job.exchange)>now)continue;
      const connection=db.prepare('SELECT * FROM connections WHERE id=?').get(job.connection_id);
      const task=run(job,connection).finally(()=>running.delete(job.exchange));
      running.set(job.exchange,task);
      started.push(task);
    }
    await Promise.all(started);
  }
  return {tick,start(){timer=setInterval(()=>void tick(),500);timer.unref();void tick();},async stop(){stopped=true;clearInterval(timer);await Promise.all(running.values());}};
}

function finishStream(pass,id) {
  pass.finishedStreams.push(id);
  pass.stream++;
  delete pass.activeStream;
  delete pass.start;
  delete pass.cursor;
}

function resetPass(pass) {
  pass.stream=0;
  pass.finishedStreams=[];
  delete pass.activeStream;
  delete pass.start;
  delete pass.cursor;
}


