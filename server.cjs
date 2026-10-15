'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {IndependentRoom,GlobalRoom,changeRoomSettings,changePlayerRole,setMonitor,hostMap,teleportPlayer,GameError,protocol}=require('./engine.cjs');
function createServer({maxRooms=32,maxPresence=5000,now=()=>Date.now()}={}){
  const rooms=new Map(),sessions=new Map(),ipLimits=new Map(),presence=new Map();
  const html=fs.readFileSync(path.join(__dirname,'Backrooms-Enhanced.html'));
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'};
  const json=(res,status,data)=>{res.writeHead(status,{...headers,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  // Anonymous, short-lived page presence includes menus and solo play as well as rooms.
  // One browser counts once; each tab has its own lease so closing a duplicate is safe.
  function prunePresence(t=now()){
    for(const [id,tabs]of presence){for(const [tab,lastSeen]of tabs)if(t-lastSeen>=35000)tabs.delete(tab);if(!tabs.size)presence.delete(id);}
  }
  function updatePresence(data){
    if(typeof data.browserId!=='string'||!/^[a-f0-9]{32}$/.test(data.browserId)||typeof data.tabId!=='string'||!/^[a-f0-9]{32}$/.test(data.tabId)||typeof data.online!=='boolean')throw new GameError('Invalid presence update.');
    const t=now();prunePresence(t);let tabs=presence.get(data.browserId);
    if(data.online){
      if(!tabs){if(presence.size>=maxPresence)throw new GameError('Online count is temporarily unavailable.',503);tabs=new Map();presence.set(data.browserId,tabs);}
      if(!tabs.has(data.tabId)&&tabs.size>=32)throw new GameError('Too many game tabs in this browser.',429);
      tabs.set(data.tabId,t);
    }else if(tabs){tabs.delete(data.tabId);if(!tabs.size)presence.delete(data.browserId);}
    return {onlinePlayers:presence.size};
  }
  const snapshotMessage=(room,playerId)=>'data: '+JSON.stringify(room.snapshot(playerId),room.global?(_key,value)=>typeof value==='number'?Math.round(value*1000)/1000:value:undefined)+'\n\n';
  function sendSnapshot(session,message){const sink=session.gzip||session.stream;sink.write(message);if(session.gzip)session.gzip.flush(zlib.constants.Z_SYNC_FLUSH);}
  function roomCode(){const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let code;do{code=Array.from(crypto.randomBytes(6),v=>alphabet[v%alphabet.length]).join('');}while(rooms.has(code));return code;}
  function authorization(req){const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{48})$/)?.[1],session=sessions.get(token);if(!session)throw new GameError('Your connection expired. Join the room again.',401);session.lastSeen=now();const p=session.room.players.get(session.playerId);if(!p)throw new GameError('You are no longer in this room.',401);return {session,p};}
  function leave(token){const s=sessions.get(token);if(!s)return;if(s.stream)s.stream.end();sessions.delete(token);s.room.removePlayer(s.playerId);if(!s.room.players.size)rooms.delete(s.room.code);}
  function join(room,name,avatar){const p=room.addPlayer(name,avatar),token=crypto.randomBytes(24).toString('hex');sessions.set(token,{token,room,playerId:p.id,lastSeen:now(),window:now(),requests:0,actions:0,stream:null});return {token,playerId:p.id,snapshot:room.snapshot(p.id)};}
  function rate(req){const key=req.socket.remoteAddress||'unknown',t=now();let limit=ipLimits.get(key);if(!limit||t-limit.start>60000){limit={start:t,count:0};ipLimits.set(key,limit);}if(++limit.count>30)throw new GameError('Too many room requests. Wait a minute and try again.',429);if(ipLimits.size>2048)for(const [k,v]of ipLimits)if(t-v.start>60000)ipLimits.delete(k);}
  async function body(req){
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw new GameError('Send JSON.',415);
    let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>4096)throw new GameError('Request is too large.',413);chunks.push(c);}try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||Array.isArray(value)||typeof value!=='object')throw Error();return value;}catch{throw new GameError('Invalid JSON.');}
  }
  const server=http.createServer({maxHeaderSize:8192},async(req,res)=>{
    try{
      const url=new URL(req.url,'http://localhost'),route=url.pathname;
      if(req.method==='GET'&&['/','/Backrooms-Enhanced.html'].includes(route)){res.writeHead(200,{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"});res.end(html);return;}
      if(req.method==='GET'&&route==='/favicon.ico'){res.writeHead(204,headers);res.end();return;}
      if(req.method==='GET'&&route==='/api/health'){const global=rooms.get('GLOBAL');json(res,200,{ok:true,version:protocol.version,maxPlayers:protocol.maxPlayers,globalMaxPlayers:protocol.globalMaxPlayers,globalPlayers:global?.players.size||0,globalLevel:global?.level||1});return;}
      // An exact same-origin connection: no CORS keys or editable server URL.
      if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{throw new GameError('Invalid origin.',403);}const allowed=process.env.PUBLIC_ORIGIN?new URL(process.env.PUBLIC_ORIGIN).origin:null;if(allowed?origin.origin!==allowed:origin.host!==req.headers.host)throw new GameError('Open the game from this server to connect.',403);}
      if(req.method==='POST'&&route==='/api/presence'){json(res,200,updatePresence(await body(req)));return;}
      if(req.method==='POST'&&['/api/rooms','/api/join','/api/quick','/api/global'].includes(route)){
        rate(req);const data=await body(req);if(data.version!==protocol.version)throw new GameError('Refresh the game to update multiplayer.',409);
        if(route!=='/api/global'&&(!Number.isInteger(data.level)||data.level<1||data.level>5))throw new GameError('Choose a level from 1 to 5.');let room;
        if(route==='/api/global'){room=rooms.get('GLOBAL');if(!room){room=new GlobalRoom();rooms.set('GLOBAL',room);}}
        else if(route==='/api/join'){const code=String(data.code||'').trim().toUpperCase();if(!/^[A-HJ-NP-Z2-9]{6}$/.test(code))throw new GameError('Enter the six-character room code.');room=rooms.get(code);if(!room)throw new GameError('Room not found. Check the code or ask your friend to create a room.',404);}
        else{
          if(route==='/api/quick')room=[...rooms.values()].find(r=>!r.global&&r.publicRoom&&r.level===data.level&&r.phase==='lobby'&&r.players.size<r.maxPlayers);
          if(!room){if(rooms.size-(rooms.has('GLOBAL')?1:0)>=maxRooms)throw new GameError('The server is full. Try again shortly.',503);room=new IndependentRoom(roomCode(),{level:data.level,publicRoom:route==='/api/quick'||data.publicRoom===true});rooms.set(room.code,room);}
        }
        json(res,201,join(room,data.name,data.avatar));return;
      }
      if(req.method==='GET'&&route==='/api/events'){
        const {session}=authorization(req);if(session.stream)session.stream.end();session.gzip?.destroy();session.gzip=null;session.stream=res;
        const compressed=session.room.global&&(req.headers['accept-encoding']||'').split(',').some(value=>/^gzip(?:\s*;|$)/i.test(value.trim())&&!/;\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(value));
        res.writeHead(200,{...headers,'Content-Type':'text/event-stream; charset=utf-8','Connection':'keep-alive','X-Accel-Buffering':'no',...(compressed?{'Content-Encoding':'gzip','Vary':'Accept-Encoding'}:{})});res.flushHeaders();
        const gzip=compressed?zlib.createGzip({level:zlib.constants.Z_BEST_SPEED}):null;session.gzip=gzip;if(gzip){gzip.on('error',()=>res.destroy());gzip.pipe(res);}
        sendSnapshot(session,snapshotMessage(session.room,session.playerId));
        res.on('close',()=>{gzip?.destroy();if(session.stream===res){session.stream=null;session.gzip=null;}});return;
      }
      if(req.method==='POST'&&['/api/input','/api/action','/api/chat','/api/start','/api/retry','/api/leave','/api/room-settings','/api/player-role','/api/monitor','/api/host-map','/api/teleport'].includes(route)){
        const {session:s}=authorization(req),t=now();if(t-s.window>=1000){s.window=t;s.requests=0;s.actions=0;}if(++s.requests>55)throw new GameError('Slow down your requests.',429);
        const data=await body(req),p=s.room.players.get(s.playerId);if(!sessions.has(s.token)||!p)throw new GameError('You are no longer in this room.',401);
        if(route==='/api/input'){s.room.input(p,data);json(res,200,{ok:true});return;}
        if(++s.actions>8)throw new GameError('Give your last action a moment.',429);
        if(route==='/api/action'){json(res,200,{ok:s.room.action(p,data.action,data.epoch,data.life)});return;}
        if(route==='/api/chat')s.room.chat(p,data.kind,data.index,t,data.to);
        if(route==='/api/room-settings'){const old=s.room,next=changeRoomSettings(old,p.id,data);if(next!==old){rooms.set(next.code,next);for(const member of sessions.values())if(member.room===old)member.room=next;}json(res,200,{ok:true,snapshot:next.snapshot(p.id)});return;}
        if(route==='/api/player-role'){changePlayerRole(s.room,p.id,data);json(res,200,{ok:true,snapshot:s.room.snapshot(p.id)});return;}
        if(route==='/api/monitor'){setMonitor(s.room,p.id,data);json(res,200,{ok:true,snapshot:s.room.snapshot(p.id)});return;}
        if(route==='/api/host-map'){json(res,200,hostMap(s.room,p.id,data.key));return;}
        if(route==='/api/teleport'){teleportPlayer(s.room,p.id,data);json(res,200,{ok:true});return;}
        if(route==='/api/start')s.room.start(p.id);
        if(route==='/api/retry')s.room.retry(p.id);
        if(route==='/api/leave')leave(s.token);
        json(res,200,{ok:true});return;
      }
      json(res,404,{error:'Not found.'});
    }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'The server could not handle this request.'});else res.end();if(!e.status)console.error('Multiplayer request failed:',e.message);}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  let previous=performance.now(),accumulator=0,frames=0;
  const timer=setInterval(()=>{
    const t=performance.now();accumulator+=Math.min(.25,(t-previous)/1000);previous=t;
    while(accumulator>=1/30){for(const room of rooms.values())room.tick(1/30);accumulator-=1/30;}
    if(++frames%2===0){for(const room of rooms.values()){
      if(room.global&&frames%4!==0)continue; // 7.5 updates/sec; the client interpolates movement.
      for(const s of sessions.values())if(s.room===room&&s.stream&&!s.stream.destroyed){const queued=s.stream.writableLength+(s.gzip?.writableLength||0);if(queued>262144){s.stream.end();s.gzip?.destroy();s.stream=null;s.gzip=null;}else if(queued<65536)sendSnapshot(s,snapshotMessage(room,s.playerId));}
    }}
    if(frames%30===0){const t=now();prunePresence(t);for(const [token,s]of sessions)if(t-s.lastSeen>20000)leave(token);}
  },1000/30);timer.unref();
  server.shutdown=async()=>{clearInterval(timer);for(const s of sessions.values())s.stream?.end();sessions.clear();rooms.clear();presence.clear();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
  return {server,rooms,sessions};
}
if(require.main===module){
  const {server}=createServer(),port=Number(process.env.PORT)||8787,host=process.env.HOST||'0.0.0.0';
  server.listen(port,host,()=>{console.log('The Rooms multiplayer is running.');console.log('On this computer: http://localhost:'+port);console.log('Keep this window open while playing. Press Ctrl+C to stop.');});
  server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'Port '+port+' is already in use. The multiplayer server may already be running.':e.message);process.exitCode=1;});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.shutdown().then(()=>process.exit(0)));
}
module.exports={createServer};
