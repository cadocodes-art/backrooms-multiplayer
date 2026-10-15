'use strict';
const crypto=require('node:crypto'),worlds=require('./world-data.json'),protocol=require('./mp-shared.js');
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),mix=(a,b,t)=>a+(b-a)*t,dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const copy=v=>JSON.parse(JSON.stringify(v));
class GameError extends Error{constructor(message,status=400){super(message);this.status=status;}}
class Room{
  constructor(code,{level=1,publicRoom=false,global=false,personal=false}={}){
    this.code=code;this.global=global;this.personal=personal;this.maxPlayers=global?protocol.globalMaxPlayers:protocol.maxPlayers;this.roomSpeed=1;this.deathLink=false;this.monsterEnabled=true;this.monsterSpeed=1;this.infiniteStamina=false;this.hostIds=new Set();this.roleVersion=0;this.publicRoom=publicRoom||global;this.players=new Map();this.hostId=null;this.phase=global?'playing':'lobby';this.epoch=0;this.events=[];this.eventId=0;this.messages=[];this.closedAt=0;this.configure(level);
  }
  configure(level,run=false,revive=true){
    this.level=level;this.epoch++;this.elapsed=0;this.transition=0;this.run=run;this.runTime=0;this.front=-24;this.restartIn=0;this.exitIn=null;
    this.base=worlds[level];this.map=copy(run?worlds.run.map:this.base.map);this.obstacles=run?[]:this.base.obstacles;this.edges=level===4?new Set(this.base.edges):null;
    this.floors=run?worlds.run.path:this.base.floors;this.spawnPoint=run?worlds.run.spawn:this.base.spawn;
    this.monster={...this.base.monster,angle:0,walk:0,mode:'patrol',target:null,path:[],memory:0,repath:0};
    this.objectives={hammer:false,hits:[0,0,0,0,0],opened:[],opener:false,unlocked:false,doorOpen:0,anchors:run?[true,true,true]:[false,false,false],gates:(this.base.gates||[]).map(()=>false),warning:0,shifts:0};
    this.hiddenOpener=level===4?crypto.randomInt(this.base.units.length):-1;this.revealedOpener=-1;this.openTimes={};this.hammerCooldown=0;this.shiftIn=24;this.footIn=13;this.finalCheckpoint=run;
    const placed=[];for(const p of this.players.values()){const dead=!p.alive;this.spawnPlayer(p,this.spawnPoint,placed);if(dead&&!revive)p.alive=false;placed.push(p);}
  }
  spawnPlayer(p,origin=this.spawnPoint,peers=[...this.players.values()]){
    // Keep cameras out of teammates' heads, including at checkpoints and late joins.
    const occupied=peers.filter(q=>q.id!==p.id&&q.alive&&!q.escaped),offsets=[[0,0]];
    for(const radius of [1.2,2.4,3.6])for(const [x,z] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]])offsets.push([x*radius,z*radius]);
    const clear=q=>!this.blocked(q.x,q.z,.29)&&occupied.every(other=>dist(q,other)>=1);
    let position=offsets.map(([x,z])=>({x:origin.x+x,z:origin.z+z})).find(q=>clear(q)&&this.line(origin,q,true,.26));
    if(!position&&this.global){
      // A full crowd may need the adjoining corridor, connected by a valid path.
      for(const floor of [...this.floors].sort((a,b)=>dist(a,origin)-dist(b,origin))){
        const path=this.route(origin,floor),same=Math.floor(origin.x/4)===Math.floor(floor.x/4)&&Math.floor(origin.z/4)===Math.floor(floor.z/4);
        if(!same&&!path.length)continue;
        for(const [x,z] of [[0,0],[-1.2,0],[1.2,0],[0,-1.2],[0,1.2],[-1.2,-1.2],[-1.2,1.2],[1.2,-1.2],[1.2,1.2]]){const q={x:floor.x+x,z:floor.z+z};if(clear(q)&&this.line(same?origin:floor,q,true,.26)){position=q;break;}}if(position)break;
      }
    }
    if(!position)throw new GameError('There is no clear space beside your team. Try joining again in a moment.',409);
    Object.assign(p,{...origin,...position,life:(p.life||0)+1,elapsed:0,runTime:0,deathLinkCause:null,y:0,vy:0,ground:true,eye:1.65,pitch:0,stamina:100,exhausted:false,noise:0,crouch:false,running:false,moving:false,flash:true,alive:true,escaped:false,waiting:false,crawl:null,cooldown:0,grace:7,step:0,seq:0,input:{f:0,s:0,yaw:origin.yaw,pitch:0,crouch:false,run:false,flash:true},inputAge:0});
  }
  addPlayer(name,avatar){
    if(this.players.size>=this.maxPlayers)throw new GameError(this.global?'The global room is full (16/16). Try again when someone leaves, or join a separate room.':'This room is full.',409);
    if(!this.global&&['won','lost'].includes(this.phase))throw new GameError('This room has finished. Create a new room.',409);
    const id=crypto.randomBytes(8).toString('hex');
    const p={id,name:protocol.cleanName(name),avatar:protocol.normalizeAvatar(avatar),color:this.players.size,lastChat:-Infinity,lastSeen:Date.now(),rate:0};let origin=this.spawnPoint;
    const waiting=this.global&&!this.personal&&(this.phase!=='playing'||this.run||this.exitIn!==null||this.players.size>0&&![...this.players.values()].some(q=>q.alive&&!q.escaped&&!q.crawl));
    if(!this.personal&&this.phase==='playing'&&!waiting&&this.players.size){const buddy=[...this.players.values()].find(q=>q.alive&&!q.escaped&&!q.crawl);if(buddy)origin={x:buddy.x,z:buddy.z,yaw:buddy.yaw};else throw new GameError('Wait for the next checkpoint before joining.',409);}
    this.spawnPlayer(p,origin);
    if(waiting){p.alive=false;p.waiting=true;}
    this.players.set(id,p);if(!this.global&&!this.hostId){this.hostId=id;this.hostIds.add(id);}this.emit('joined',{playerId:id,name:p.name});return p;
  }
  removePlayer(id){const p=this.players.get(id);if(!p)return;this.players.delete(id);this.emit('left',{playerId:id,name:p.name});removeHostRole(this,id);this.checkResolved();}
  start(id){if(this.global)throw new GameError('The global room starts automatically.',403);if(!isRoomHost(this,id))throw new GameError('Only the room host can start.',403);if(this.phase!=='lobby')throw new GameError('The room has already started.',409);this.phase='playing';this.emit('start');}
  retry(id){
    const p=this.players.get(id);if(!p)throw new GameError('You are no longer in this room.',401);
    if(!p.alive){this.spawnPlayer(p);if(this.phase==='lost'||this.phase==='won')this.phase='playing';this.emit('respawn',{playerId:id});return;}
    if(this.global)throw new GameError('You can restart after your run ends.',409);
    if(!isRoomHost(this,id))throw new GameError('Only the host can start a new campaign.',403);
    if(this.phase!=='won')throw new GameError('This run is still in progress.',409);this.restart();
  }
  restart(){const won=this.phase==='won';this.configure(won?1:this.level,!won&&this.finalCheckpoint);this.phase='playing';this.emit('retry');}
  emit(kind,data={}){this.events.push({...data,id:++this.eventId,kind});if(this.events.length>64)this.events.shift();}
  chat(p,kind,index,now=Date.now(),to=[]){
    const list=kind==='message'?protocol.messages:kind==='emoji'?protocol.faces:null;
    if(!list||!Number.isInteger(index)||index<0||index>=list.length)throw new GameError('Choose one of the available messages or faces.');
    if(!Array.isArray(to)||to.length>this.maxPlayers-1||to.some(id=>typeof id!=='string'||id===p.id))throw new GameError('Choose other players from this room.');
    const recipients=[...new Set(to)].map(id=>this.players.get(id));
    if(recipients.some(player=>!player))throw new GameError('A selected player has left. Choose the names again.');
    if(now-p.lastChat<(this.global?1800:900))throw new GameError('Give your last message a moment.',429);p.lastChat=now;
    const event={id:++this.eventId,kind:'chat',playerId:p.id,name:p.name,type:kind,text:list[index],to:recipients.map(player=>({id:player.id,name:player.name}))};this.events.push(event);if(this.events.length>64)this.events.shift();this.messages.push(event);if(this.messages.length>8)this.messages.shift();return event;
  }
  input(p,data){
    if(p.monitor)return monitorInput(this,p,data);
    if(data.epoch!==this.epoch||data.life!==undefined&&data.life!==p.life)return false;
    if(!Number.isSafeInteger(data.seq)||data.seq<=p.seq)return false;
    for(const k of ['f','s','yaw','pitch'])if(!Number.isFinite(data[k]))throw new GameError('Invalid movement.');
    if(Math.abs(data.f)>1||Math.abs(data.s)>1||Math.abs(data.yaw)>Math.PI*4||Math.abs(data.pitch)>1.3)throw new GameError('Invalid movement.');
    p.seq=data.seq;p.inputAge=0;p.input={f:data.f,s:data.s,yaw:data.yaw,pitch:data.pitch,crouch:data.crouch===true,run:data.run===true,flash:data.flash!==false};return true;
  }
  blocked(x,z,r=.26){
    const n=this.map.length;
    for(let row=Math.floor((z-r)/4);row<=Math.floor((z+r)/4);row++)for(let c=Math.floor((x-r)/4);c<=Math.floor((x+r)/4);c++){
      if(row<0||c<0||row>=n||c>=n)return true;
      if([1,8,9].includes(this.map[row][c])){const dx=x-clamp(x,c*4,(c+1)*4),dz=z-clamp(z,row*4,(row+1)*4);if(dx*dx+dz*dz<r*r)return true;}
    }
    for(const b of this.obstacles){const dx=x-clamp(x,b.minX,b.maxX),dz=z-clamp(z,b.minZ,b.maxZ);if(dx*dx+dz*dz<r*r)return true;}return false;
  }
  line(a,b,furniture=true,r=.06){const d=dist(a,b),steps=Math.ceil(d/.3);for(let i=1;i<=steps;i++){const x=mix(a.x,b.x,i/steps),z=mix(a.z,b.z,i/steps);if(furniture?this.blocked(x,z,r):[undefined,1,8,9].includes(this.map[Math.floor(z/4)]?.[Math.floor(x/4)]))return false;}return true;}
  move(p,dx,dz,r=.26){if(!this.blocked(p.x+dx,p.z,r))p.x+=dx;if(!this.blocked(p.x,p.z+dz,r))p.z+=dz;}
  route(a,b){
    const n=this.map.length,sr=Math.floor(a.z/4),sc=Math.floor(a.x/4),tr=Math.floor(b.z/4),tc=Math.floor(b.x/4);if(!this.map[sr]||!this.map[tr]||tc<0||tc>=n||sc<0||sc>=n)return[];
    const start=sr*n+sc,target=tr*n+tc,q=[start],parents=new Int32Array(n*n).fill(-1);parents[start]=start;
    for(let head=0;head<q.length;head++){const v=q[head];if(v===target)break;const r=Math.floor(v/n),c=v%n;for(const [dr,dc]of [[1,0],[-1,0],[0,1],[0,-1]]){const rr=r+dr,cc=c+dc,id=rr*n+cc;if(rr<0||cc<0||rr>=n||cc>=n||parents[id]!==-1||![0,2].includes(this.map[rr][cc]))continue;if(this.edges&&!this.edges.has(v+','+id))continue;parents[id]=v;q.push(id);}}
    if(parents[target]===-1)return[];const result=[];let k=target;while(k!==start){result.push({x:(k%n+.5)*4,z:(Math.floor(k/n)+.5)*4});k=parents[k];}result.reverse();
    if(result.length&&!this.line(a,result[0],true,.29))result.unshift({x:(sc+.5)*4,z:(sr+.5)*4});return result;
  }
  reach(p,x,z,range){const dx=x-p.x,dz=z-p.z,d=Math.hypot(dx,dz);return d<range&&(d<.35||(-Math.sin(p.yaw)*dx-Math.cos(p.yaw)*dz)/d>.45)&&this.line(p,{x,z},true,.04);}
  action(p,action,epoch,life){
    if(p.monitor||epoch!==this.epoch||life!==undefined&&life!==p.life||this.phase!=='playing'||!p.alive||p.escaped||p.crawl)return false;
    if(action==='jump'){if(p.ground&&!p.crouch){p.ground=false;p.vy=4.8;p.noise=1;}return true;}
    if(!['use','crawl'].includes(action))throw new GameError('Unknown action.');
    const o=this.objectives;
    if(this.level===3){
      const h=this.base.hammer;if(!o.hammer&&action==='use'&&this.reach(p,h.x,h.z,1.9)){o.hammer=true;this.emit('hammer',{playerId:p.id});return true;}
      const e=this.base.exits.find(e=>this.reach(p,e.x+e.dc*.12,e.z+e.dr*.12,2.25));if(!e)return false;
      if(o.hits[e.id-1]>=4){if(action!=='crawl')return false;p.crawl={exit:e.id,time:0,x:p.x,z:p.z};p.y=p.vy=0;p.ground=true;this.emit('crawl',{playerId:p.id,exit:e.id});return true;}
      if(!o.hammer||action==='crawl'||this.hammerCooldown>0)return false;
      this.hammerCooldown=.65;o.hits[e.id-1]++;p.noise=1;this.monster.target={x:p.x,z:p.z};this.monster.memory=12;this.monster.mode='investigate';this.monster.repath=0;this.emit('strike',{playerId:p.id,exit:e.id,hits:o.hits[e.id-1],x:e.x,z:e.z});return true;
    }
    if(this.level===4&&action==='use'&&p.cooldown<=0){
      if(this.reach(p,86,95.65,2.5)){if(!o.opener||o.unlocked)return false;o.unlocked=true;this.emit('unlock');return true;}
      const u=this.base.units.find(u=>this.reach(p,u.tx,u.tz,1.85));if(!u)return false;
      if(!o.opened.includes(u.id)){o.opened.push(u.id);this.openTimes[u.id]=this.elapsed;p.cooldown=.35;p.noise=.65;this.emit('drawer',{unit:u.id,x:u.x,z:u.z});return true;}
      if(this.elapsed-this.openTimes[u.id]<.4)return false;
      if(u.id===this.hiddenOpener&&!o.opener){o.opener=true;p.cooldown=.35;this.emit('opener',{playerId:p.id});return true;}return false;
    }
    if(this.level===5&&!this.run&&action==='use'){
      const a=this.base.anchors.find(a=>!o.anchors[a.id]&&this.reach(p,a.x,a.z,2.3));
      if(a){o.anchors[a.id]=true;p.stamina=100;this.base.gates.forEach((g,i)=>{if(g.zone===a.id){o.gates[i]=false;this.map[g.r][g.c]=0;}});this.monster.path=[];this.monster.repath=0;this.emit('anchor',{anchor:a.id,playerId:p.id,x:a.x,z:a.z});return true;}
      const gate=this.base.gate;if(o.anchors.every(Boolean)&&this.reach(p,gate.x,gate.z,2.3)){if(this.personal){p.escapeReady=true;return true;}this.configure(5,true,false);this.phase='playing';this.emit('escape');return true;}
    }return false;
  }
  stepPlayer(p,dt){
    p.inputAge+=dt;p.grace=Math.max(0,p.grace-dt);p.cooldown=Math.max(0,p.cooldown-dt);p.noise=Math.max(0,p.noise-dt*.75);
    if(p.monitor||!p.alive||p.escaped)return;p.elapsed+=dt;
    if(p.crawl){const e=this.base.exits[p.crawl.exit-1];p.crawl.time+=dt;const lower=clamp(p.crawl.time/.55,0,1),travel=clamp((p.crawl.time-.55)/2.6,0,1),smooth=travel*travel*(3-2*travel);p.x=mix(p.crawl.x,e.x-e.dc*3.2,smooth);p.z=mix(p.crawl.z,e.z-e.dr*3.2,smooth);p.eye=mix(1.65,.79,lower);p.yaw=Math.atan2(e.dc,e.dr);if(p.crawl.time>=3.2){p.crawl=null;p.escaped=true;this.emit('escaped',{playerId:p.id});}return;}
    const input=p.input;let f=p.inputAge>.4?0:input.f,s=p.inputAge>.4?0:input.s,len=Math.hypot(f,s);if(len>1){f/=len;s/=len;}
    p.yaw=input.yaw;p.pitch=input.pitch;p.crouch=input.crouch;p.flash=input.flash;
    if(this.infiniteStamina){p.stamina=100;p.exhausted=false;}
    const wantsRun=input.run&&!p.crouch&&len>.1&&p.inputAge<=.4;if(p.stamina<=1)p.exhausted=true;if(!wantsRun||p.stamina>25)p.exhausted=false;p.running=wantsRun&&!p.exhausted&&p.stamina>1;
    const speed=(p.crouch?1.9:p.running?6.2:3.8)*(this.level===3?.62:1),ox=p.x,oz=p.z;
    this.move(p,(-Math.sin(p.yaw)*f+Math.cos(p.yaw)*s)*speed*dt,(-Math.cos(p.yaw)*f-Math.sin(p.yaw)*s)*speed*dt);
    const moved=Math.hypot(p.x-ox,p.z-oz);p.moving=moved>dt*.2;p.step+=moved;
    p.stamina=this.infiniteStamina?100:clamp(p.stamina+(p.running&&p.moving?-21:13)*dt,0,100);p.eye=mix(p.eye,p.crouch?1.02:1.65,1-Math.exp(-12*dt));
    if(!p.ground){p.vy-=13.5*dt;p.y+=p.vy*dt;if(p.y<=0){p.y=0;p.vy=0;p.ground=true;p.noise=1;}}
    if(p.moving&&p.ground)p.noise=Math.max(p.noise,p.crouch?.07:p.running?1:.42);
  }
  stepMonster(dt){
    if(!this.monsterEnabled)return;
    const m=this.monster,candidates=[...this.players.values()].filter(p=>!p.monitor&&p.alive&&!p.escaped&&!p.crawl&&p.grace===0);
    m.memory=Math.max(0,m.memory-dt);m.repath-=dt;
    let victim=null,nearest=Infinity,visual=false;
    for(const p of candidates){const d=dist(m,p);if(d<.82&&this.line(m,p,true,.04)){p.alive=false;p.moving=false;this.emit('caught',{playerId:p.id});continue;}
      const line=d<25&&this.line(m,p,false),dot=d>.01?(Math.sin(m.angle)*(p.x-m.x)+Math.cos(m.angle)*(p.z-m.z))/d:1;
      const range=p.crouch?(p.flash?13:8):(p.flash?21:15),seen=line&&d<range&&(dot>-.1||d<3.5||m.mode==='chase'),heard=d<p.noise*(line?17:8)&&p.noise>.12;
      if((seen||heard)&&d<nearest){victim=p;nearest=d;visual=seen;}
    }
    if(victim){m.target={x:victim.x,z:victim.z};m.memory=visual?6:3;m.mode=visual?'chase':'investigate';}
    else if(m.memory<=0&&m.mode!=='patrol'){m.mode='patrol';m.target=null;m.path=[];}
    if(!m.target||dist(m,m.target)<.4){m.target=null;for(let i=0;i<12;i++){const f=this.floors[crypto.randomInt(this.floors.length)];if(dist(m,f)<8)continue;const path=this.route(m,f);if(path.length){m.target=f;m.path=path;break;}}}
    if(!m.target)return;
    if(m.repath<=0){m.path=this.route(m,m.target);m.repath=.65;}
    let target;if(victim&&visual&&this.line(m,victim,true,.29))target=victim;else{while(m.path.length&&dist(m,m.path[0])<.15)m.path.shift();target=m.path[0];if(!target&&this.line(m,m.target,true,.29))target=m.target;}
    if(target){const d=dist(m,target);if(d>.01){const speed=(m.mode==='chase'?(this.level===1?3.1:3.4):m.mode==='investigate'?2.65:1.85)*(this.level===3?.62:1)*this.monsterSpeed,step=Math.min(d,speed*dt),dx=(target.x-m.x)/d,dz=(target.z-m.z)/d,ox=m.x,oz=m.z;this.move(m,dx*step,dz*step,.29);m.walk+=Math.hypot(m.x-ox,m.z-oz)*4.6;const a=Math.atan2(dx,dz);m.angle+=Math.atan2(Math.sin(a-m.angle),Math.cos(a-m.angle))*Math.min(1,dt*7);}}
  }
  shift(){
    let changed=false;this.base.gates.forEach((g,i)=>{if(this.objectives.anchors[g.zone])return;const point={x:(g.c+.5)*4,z:(g.r+.5)*4};if(dist(point,this.monster)<7)return;
      for(const p of this.players.values()){if(!p.alive||p.escaped)continue;const d=dist(p,point),dot=(-Math.sin(p.yaw)*(point.x-p.x)-Math.cos(p.yaw)*(point.z-p.z))/Math.max(.01,d);if(d<9||dot>-.2&&this.line(p,point,false))return;}
      this.objectives.gates[i]=!this.objectives.gates[i];this.map[g.r][g.c]=this.objectives.gates[i]?1:0;changed=true;
    });if(changed){this.objectives.shifts++;this.monster.path=[];this.monster.repath=0;this.emit('shift');}
  }
  runProgress(p){let best=Infinity,result=0;const path=worlds.run.path;for(let i=0;i<path.length-1;i++){const a=path[i],b=path[i+1],dx=b.x-a.x,dz=b.z-a.z,t=clamp(((p.x-a.x)*dx+(p.z-a.z)*dz)/16,0,1),d=(p.x-a.x-dx*t)**2+(p.z-a.z-dz*t)**2;if(d<best){best=d;result=(i+t)*4;}}return result;}
  checkResolved(){
    if(this.personal||this.phase!=='playing'||!this.players.size)return;
    const players=[...this.players.values()].filter(p=>!p.monitor);if(!players.length)return;if(players.some(p=>p.alive&&!p.escaped))return;
    if(players.some(p=>p.escaped)||this.global&&this.exitIn!==null){if(this.level===5){this.phase='won';this.emit('won');}else this.nextLevel();}
    else{this.phase='lost';this.emit('lost');}
    if(this.global&&['won','lost'].includes(this.phase))this.restartIn=8;
  }
  nextLevel(){if(this.phase!=='playing')return;this.phase='transition';this.transition=2.8;this.emit('transition',{nextLevel:this.level+1});}
  tick(dt){const before=livingIds(this);this.step(dt*(this.roomSpeed||1));finishHostTick(this,before,dt);}
  step(dt){
    if(this.global&&!this.players.size)return;
    if(this.global&&['won','lost'].includes(this.phase)){this.restartIn=Math.max(0,this.restartIn-dt);if(this.restartIn===0)this.restart();return;}
    if(this.phase==='transition'){this.transition-=dt;if(this.transition<=0){this.configure(this.level+1,false,false);this.phase='playing';this.emit('level');}return;}
    if(this.phase!=='playing')return;
    this.elapsed+=dt;this.hammerCooldown=Math.max(0,this.hammerCooldown-dt);for(const p of this.players.values())this.stepPlayer(p,dt);
    const o=this.objectives;
    if(this.run){if(this.monsterEnabled)this.runTime+=dt*this.monsterSpeed;this.front=-24+this.runTime*3.25;for(const p of this.players.values()){if(p.monitor||!p.alive||p.escaped)continue;if(this.monsterEnabled)p.runTime+=dt*this.monsterSpeed;const front=-24+p.runTime*3.25;p.progress=this.runProgress(p);if(this.monsterEnabled&&p.grace===0&&front>=0&&p.progress<=front+.5){p.alive=false;this.emit('caught',{playerId:p.id});}else if(p.progress>worlds.run.length-1.4&&dist(p,worlds.run.path.at(-1))<1.5){p.escaped=true;this.emit('escaped',{playerId:p.id});}}}
    else this.stepMonster(dt);
    if(this.level===4){
      if(o.opened.includes(this.hiddenOpener)&&this.elapsed-this.openTimes[this.hiddenOpener]>.4)this.revealedOpener=this.hiddenOpener;
      if(o.unlocked){o.doorOpen=mix(o.doorOpen,1,1-Math.exp(-3*dt));if(o.doorOpen>.85){this.map[24][21]=0;for(const p of this.players.values())if(!p.monitor&&p.alive&&!p.escaped&&p.z>98.55&&p.x>84.3&&p.x<87.7){p.escaped=true;this.emit('escaped',{playerId:p.id});}}}
    }
    if(this.level===5){this.footIn-=dt;if(this.footIn<=0){this.footIn=this.run?3.6:15;if(this.monsterEnabled)this.emit('giant');}
      if(!this.run&&!o.anchors.every(Boolean)){if(o.warning>0){o.warning=Math.max(0,o.warning-dt);if(o.warning===0){this.shift();this.shiftIn=25;}}else{this.shiftIn-=dt;if(this.shiftIn<=0){o.warning=4;this.emit('warning');}}}else o.warning=0;
    }
    if(this.global&&!this.personal&&this.level>=3&&(this.exitIn!==null||[...this.players.values()].some(p=>p.escaped))){
      if(this.exitIn===null){this.exitIn=45;this.emit('exit-countdown');}else this.exitIn=Math.max(0,this.exitIn-dt);
      if(this.exitIn===0)for(const p of this.players.values())if(p.alive&&!p.escaped){p.alive=false;p.moving=false;this.emit('caught',{playerId:p.id,reason:'exit-closed'});}
    }
    this.checkResolved();if(!this.personal&&this.phase==='playing'&&this.level<3&&this.elapsed>=(this.level===1?120:300))this.nextLevel();
  }
  snapshot(viewerId,raw=false){
    const players=[...this.players.values()].map(p=>{const out={};for(const k of ['id','name','avatar','color','x','z','y','vy','ground','eye','yaw','pitch','stamina','crouch','running','moving','flash','alive','escaped','waiting','seq','grace','step','life','elapsed','deathLinkCause'])out[k]=p[k];out.crawling=!!p.crawl;out.monitor=!!p.monitor;return out;});
    const m=this.monster,viewer=this.players.get(viewerId),runTime=viewer?viewer.runTime:this.runTime;const snapshot={version:protocol.version,code:this.code,hostId:this.hostId,hostIds:[...this.hostIds],roleVersion:this.roleVersion,global:this.global,maxPlayers:this.maxPlayers,publicRoom:this.publicRoom,roomSettings:roomSettingsFor(this),settingsVersion:this.settingsVersion||0,phase:this.phase,level:this.level,epoch:this.epoch,elapsed:this.elapsed,transition:this.transition,restartIn:this.restartIn,exitIn:this.exitIn,run:this.run,runTime,front:this.run&&this.monsterEnabled?-24+runTime*3.25:-24,players,monster:{x:m.x,z:m.z,angle:m.angle,walk:m.walk,mode:m.mode},objectives:{...this.objectives,revealedOpener:this.revealedOpener},events:this.events.slice(-24),messages:this.messages};return raw||this.personal?snapshot:decorateSnapshot(this,viewerId,snapshot);
  }
}

// One membership/chat roster, with shared worlds and independent journeys.
class GlobalRoom{
  constructor(code='GLOBAL'){
    this.code=code;this.global=true;this.personal=true;this.maxPlayers=protocol.globalMaxPlayers;this.publicRoom=true;this.hostId=null;this.level=1;
    this.roomSpeed=1;this.deathLink=false;this.monsterEnabled=true;this.monsterSpeed=1;this.infiniteStamina=false;this.hostIds=new Set();this.roleVersion=0;this.players=new Map();this.worlds=new Map();this.events=[];this.messages=[];this.eventId=0;this.epoch=0;this.entryKey='1';
  }
  emit(kind,data={}){Room.prototype.emit.call(this,kind,data);}
  world(key){
    if(!this.worlds.has(key)){
      const room=new Room(this.code,{global:this.global,personal:true,level:key==='run'?5:Number(key)});if(key==='run')room.configure(5,true);room.phase='playing';room.maxPlayers=this.maxPlayers;copyGameplaySettings(this,room);
      room.emit=(kind,data={})=>this.emit(kind,{...data,worldKey:key});this.worlds.set(key,room);
    }return this.worlds.get(key);
  }
  addPlayer(name,avatar){
    if(this.players.size>=this.maxPlayers)throw new GameError(this.global?'The global room is full (16/16). Try again when someone leaves, or join a separate room.':'This room is full.',409);
    const p=this.world(this.entryKey).addPlayer(name,avatar);Object.assign(p,{worldKey:this.entryKey,epoch:++this.epoch,phase:'playing',transit:null});this.players.set(p.id,p);if(!this.global&&!this.hostId){this.hostId=p.id;this.hostIds.add(p.id);}return p;
  }
  detach(p){const old=this.worlds.get(p.worldKey);old.players.delete(p.id);if(!old.players.size)this.worlds.delete(p.worldKey);}
  enter(p,key,kind='level'){
    if(p.worldKey!==key)this.detach(p);const world=this.world(key);world.spawnPlayer(p);world.players.set(p.id,p);
    Object.assign(p,{worldKey:key,epoch:++this.epoch,phase:'playing',transit:null,escapeReady:false});this.emit(kind,{playerId:p.id,only:p.id,worldKey:key});
  }
  removePlayer(id){const p=this.players.get(id);if(!p)return;this.detach(p);this.players.delete(id);this.emit('left',{playerId:id,name:p.name});removeHostRole(this,id);}
  start(){throw new GameError('The global room starts automatically.',403);}
  retry(id){const p=this.players.get(id);if(!p)throw new GameError('You are no longer in this room.',401);if(p.alive&&p.phase!=='won')throw new GameError('You can restart after your run ends.',409);this.enter(p,p.phase==='won'?'1':p.worldKey,'retry');}
  chat(...args){return Room.prototype.chat.apply(this,args);}
  input(p,data){if(p.monitor)return monitorInput(this,p,data);if(data.epoch!==p.epoch)return false;const world=this.worlds.get(p.worldKey);return world.input(p,{...data,epoch:world.epoch});}
  action(p,action,epoch,life){
    if(p.monitor||epoch!==p.epoch||p.phase!=='playing')return false;const world=this.worlds.get(p.worldKey),result=world.action(p,action,world.epoch,life);
    if(p.escapeReady){p.escapeReady=false;this.transition(p,'run');}return result;
  }
  transition(p,key){p.escaped=true;p.moving=p.running=false;p.phase='transition';p.transit={key,time:2.8};this.emit('transition',{only:p.id,worldKey:p.worldKey,nextLevel:key==='run'?5:Number(key)});}
  tick(dt){const before=livingIds(this);this.step(dt*(this.roomSpeed||1));finishHostTick(this,before,dt);}
  step(dt){
    for(const world of this.worlds.values()){copyGameplaySettings(this,world);world.tick(dt);}
    for(const p of this.players.values()){
      if(p.monitor)continue;
      if(p.transit){p.transit.time-=dt;if(p.transit.time<=0)this.enter(p,p.transit.key,p.transit.key==='run'?'escape':'level');continue;}
      if(!p.alive||p.phase==='won')continue;
      const world=this.worlds.get(p.worldKey),duration=world.level===1?120:300;
      if(world.level<3&&p.elapsed>=duration){p.elapsed=duration;this.transition(p,String(world.level+1));}
      else if(p.escaped){if(world.run){p.phase='won';this.emit('won',{only:p.id,worldKey:p.worldKey});}else this.transition(p,String(world.level+1));}
    }
  }
  snapshot(viewerId=this.players.keys().next().value){
    const p=this.players.get(viewerId);if(!p)throw new GameError('You are no longer in this room.',401);
    const world=this.worlds.get(p.worldKey),snapshot=world.snapshot(p.id);
    const out={...snapshot,global:this.global,hostId:this.hostId,hostIds:[...this.hostIds],roleVersion:this.roleVersion,publicRoom:this.publicRoom,maxPlayers:this.maxPlayers,personal:true,roomSettings:roomSettingsFor(this),settingsVersion:this.settingsVersion||0,checkpoint:{...world.spawnPoint,label:world.run?'FINAL CHASE CHECKPOINT':'LEVEL '+world.level+' CHECKPOINT'},epoch:p.epoch,phase:!p.alive?'lost':p.phase,elapsed:p.elapsed,transition:p.transit?.time||0,restartIn:0,exitIn:null,playerCount:this.players.size,
      roster:[...this.players.values()].map(q=>({id:q.id,name:q.name,level:q.worldKey==='run'?5:Number(q.worldKey),run:q.worldKey==='run',alive:q.alive,monitor:!!q.monitor})),
      events:this.events.filter(e=>(!e.only||e.only===p.id)&&(!e.worldKey||e.worldKey===p.worldKey||e.kind==='chat')).slice(-24),messages:this.messages};return decorateSnapshot(this,viewerId,out);
  }
}

class IndependentRoom extends GlobalRoom{
  constructor(code,{level=1,publicRoom=false}={}){super(code);this.global=false;this.maxPlayers=protocol.maxPlayers;this.publicRoom=publicRoom;this.level=level;this.entryKey=String(level);this.phase='lobby';}
  start(id){if(!isRoomHost(this,id))throw new GameError('Only the room host can start.',403);if(this.phase!=='lobby')throw new GameError('The room has already started.',409);this.phase='playing';this.emit('start');}
  tick(dt){if(this.phase!=='lobby')super.tick(dt);}
  input(p,data){return this.phase==='lobby'?false:super.input(p,data);}
  action(p,...args){return this.phase==='lobby'?false:super.action(p,...args);}
  snapshot(id){const s=super.snapshot(id);if(this.phase==='lobby')s.phase='lobby';return s;}
}

function changeProgressMode(room,actorId,data){
  requireHost(room,actorId);
  if(typeof data.independentProgress!=='boolean')throw new GameError('Choose whether independent progress is on or off.');
  if(data.settingsVersion!==(room.settingsVersion||0))throw new GameError('The room settings changed. Review them and try again.',409);
  if(data.independentProgress===!!room.personal)return room;
  const host=room.personal?room.worlds.get(room.players.get(actorId).worldKey).snapshot(actorId,true):room.snapshot(actorId,true),next=data.independentProgress?new IndependentRoom(room.code,{level:host.level,publicRoom:room.publicRoom}):new Room(room.code,{level:host.level,publicRoom:room.publicRoom});
  const key=host.run?'run':String(host.level);next.epoch=Math.max(room.epoch,...[...room.players.values()].map(p=>p.epoch||0))+1;next.hostId=room.hostId;next.hostIds=new Set(room.hostIds);next.roleVersion=room.roleVersion;next.phase=room.phase==='lobby'?'lobby':'playing';next.settingsVersion=(room.settingsVersion||0)+1;
  if(next.personal)next.entryKey=key;else if(host.run){const epoch=next.epoch;next.configure(5,true);next.epoch=epoch;}
  const world=next.personal?next.world(key):next;
  for(const old of room.players.values()){
    const p={...old,monitor:null,input:{...old.input}};world.spawnPlayer(p);world.players.set(p.id,p);
    if(next.personal){Object.assign(p,{worldKey:key,epoch:++next.epoch,phase:'playing',transit:null,escapeReady:false});next.players.set(p.id,p);}
  }
  next.eventId=room.eventId;next.messages=room.messages.slice();next.events=room.events.filter(e=>e.kind==='chat');next.emit('room-settings',{independentProgress:next.personal===true});if(next.phase!=='lobby')next.emit('retry');return next;
}
function isRoomHost(room,id){return !room.global&&room.players.has(id)&&(room.hostIds.has(id)||room.hostId===id);}
function requireHost(room,id){if(!isRoomHost(room,id))throw new GameError('Only a room host can use this control.',403);}
function removeHostRole(room,id){
  if(room.global)return;const wasHost=room.hostIds.delete(id);if(!wasHost&&room.hostId!==id)return;
  if(!room.hostIds.size&&room.players.size)room.hostIds.add(room.players.keys().next().value);
  if(!room.hostIds.has(room.hostId))room.hostId=room.hostIds.values().next().value||null;
  room.roleVersion++;room.emit('host',{playerId:room.hostId});
}
function changePlayerRole(room,actorId,data){
  requireHost(room,actorId);
  if(data.roleVersion!==room.roleVersion)throw new GameError('The player roles changed. Review the list and try again.',409);
  if(!['host','player'].includes(data.role))throw new GameError('Choose Host or Player.');
  const target=room.players.get(data.playerId);if(!target)throw new GameError('That player has left this room.',409);
  const currentlyHost=isRoomHost(room,target.id);if(currentlyHost===(data.role==='host'))return;
  if(data.role==='host')room.hostIds.add(target.id);
  else{
    if(room.hostIds.size<=1)throw new GameError('Keep at least one host. Make another player a host first.',409);
    if(target.monitor)setMonitor(room,target.id,{enabled:false});
    room.hostIds.delete(target.id);if(room.hostId===target.id)room.hostId=room.hostIds.values().next().value;
  }
  room.roleVersion++;room.emit('host',{playerId:target.id,role:data.role,name:target.name});
}
function copyGameplaySettings(from,to){for(const key of ['monsterEnabled','monsterSpeed','infiniteStamina'])to[key]=from[key];}
function roomSettingsFor(room){return {independentProgress:!!room.personal,roomSpeed:room.roomSpeed||1,deathLink:!!room.deathLink,monsterEnabled:room.monsterEnabled!==false,monsterSpeed:room.monsterSpeed||1,infiniteStamina:!!room.infiniteStamina};}
function changeRoomSettings(room,id,data){
  requireHost(room,id);
  if(data.roomSpeed!==undefined&&![.25,.5,.75,1,1.5,2].includes(data.roomSpeed))throw new GameError('Choose an available room speed.');
  if(data.monsterSpeed!==undefined&&![.25,.5,.75,1,1.5,2,3].includes(data.monsterSpeed))throw new GameError('Choose an available monster speed.');
  for(const key of ['deathLink','monsterEnabled','infiniteStamina'])if(data[key]!==undefined&&typeof data[key]!=='boolean')throw new GameError('Choose whether '+key+' is on or off.');
  const selected={};for(const key of ['roomSpeed','deathLink','monsterEnabled','monsterSpeed','infiniteStamina'])selected[key]=data[key]??roomSettingsFor(room)[key];
  const enableMonster=!room.monsterEnabled&&selected.monsterEnabled;
  const changed=Object.keys(selected).some(key=>selected[key]!==roomSettingsFor(room)[key]),next=changeProgressMode(room,id,data);Object.assign(next,selected);
  for(const world of next.worlds?.values()||[])copyGameplaySettings(next,world);
  for(const p of next.players.values()){if(selected.infiniteStamina){p.stamina=100;p.exhausted=false;}if(enableMonster&&p.alive)p.grace=Math.max(p.grace,3);}
  if(next===room&&changed){next.settingsVersion=(next.settingsVersion||0)+1;next.emit('room-settings',roomSettingsFor(next));}
  return next;
}

function livingIds(room){return new Set([...room.players.values()].filter(p=>p.alive&&!p.monitor&&p.phase!=='won').map(p=>p.id));}
function finishHostTick(room,before,dt){
  if(room.global||room.personal&&!room.worlds)return;
  if(room.deathLink){const source=[...room.players.values()].find(p=>before.has(p.id)&&!p.alive);
    if(source){for(const p of room.players.values()){if(!p.alive||p.monitor||p.phase==='won')continue;p.alive=false;p.escaped=false;p.crawl=p.transit=null;p.moving=p.running=false;p.deathLinkCause=source.name;room.emit('caught',{playerId:p.id,reason:'death-link',source:source.name});}
      if(!room.personal){room.phase='lost';room.transition=0;}room.emit('death-link',{source:source.name});
    }
  }
  for(const host of room.players.values())if(host.monitor&&isRoomHost(room,host.id)){const m=host.monitor,i=m.input||{f:0,s:0,up:0},speed=(i.run?16:8)/Math.max(1,Math.hypot(i.f,i.s,i.up)),span=monitorWorld(room,m.key).map.length*4;
    if(Date.now()-m.lastInput<500){m.x=clamp(m.x+(-Math.sin(m.yaw)*i.f+Math.cos(m.yaw)*i.s)*speed*dt,-8,span+8);m.z=clamp(m.z+(-Math.cos(m.yaw)*i.f-Math.sin(m.yaw)*i.s)*speed*dt,-8,span+8);m.y=clamp(m.y+i.up*speed*dt,-4,30);}
  }
}
function roomKey(room,p){return room.personal?p.worldKey:room.run?'run':String(room.level);}
function monitorWorld(room,key){
  if(!['1','2','3','4','5','run'].includes(key))throw new GameError('Choose a level from 1 to 5 or the final chase.');
  if(room.personal&&room.worlds.has(key))return room.worlds.get(key);
  if(!room.personal&&key===roomKey(room))return room;
  room.monitorWorlds??=new Map();if(!room.monitorWorlds.has(key)){const w=new Room(room.code,{personal:true,level:key==='run'?5:Number(key)});if(key==='run')w.configure(5,true);w.phase='playing';room.monitorWorlds.set(key,w);}const w=room.monitorWorlds.get(key);copyGameplaySettings(room,w);return w;
}
function setMonitor(room,id,data){
  requireHost(room,id);const p=room.players.get(id);
  if(typeof data.enabled!=='boolean')throw new GameError('Choose whether Monitor Mode is on or off.');
  if(data.enabled){
    if(room.phase==='lobby'||!p.alive||p.phase==='transition'||p.phase==='won'||!room.personal&&room.phase!=='playing')throw new GameError('Start or restart your run before using Monitor Mode.',409);
    const key=data.level===undefined?(p.monitor?.key||roomKey(room,p)):String(data.level);const w=monitorWorld(room,key),old=p.monitor;
    if(old&&old.key===key)return;
    const at=key===roomKey(room,p)&&!old?p:w.spawnPoint;
    p.monitorSerial=(p.monitorSerial||0)+1;p.monitor={key,epoch:'monitor-'+id+'-'+p.monitorSerial,x:at.x,z:at.z,y:2,yaw:at.yaw||0,pitch:0,seq:0,input:{f:0,s:0,up:0},lastInput:0};p.noise=0;p.moving=p.running=false;
  }else if(p.monitor){p.monitor=null;if(room.personal)room.enter(p,p.worldKey,'respawn');else{room.spawnPlayer(p);if(room.phase==='lost')room.phase='playing';room.emit('respawn',{playerId:id});}}
}
function monitorInput(room,p,data){
  if(!isRoomHost(room,p.id)||data.epoch!==p.monitor.epoch||data.life!==p.life)return false;
  if(!Number.isSafeInteger(data.seq)||data.seq<=p.monitor.seq)return false;
  for(const k of ['f','s','up','yaw','pitch'])if(!Number.isFinite(data[k]))throw new GameError('Invalid flight input.');
  if(Math.abs(data.f)>1||Math.abs(data.s)>1||Math.abs(data.up)>1||Math.abs(data.pitch)>1.3||Math.abs(data.yaw)>Math.PI*4)throw new GameError('Invalid flight input.');
  const m=p.monitor;m.seq=data.seq;m.yaw=data.yaw;m.pitch=data.pitch;m.input={f:data.f,s:data.s,up:data.up,run:data.run===true};m.lastInput=Date.now();return true;
}
function decorateSnapshot(room,id,s){
  if(room.global)return s;const p=room.players.get(id);if(!p?.monitor)return s;
  const m=p.monitor,w=monitorWorld(room,m.key),view=w.snapshot(id,true),me={...s.players.find(q=>q.id===id),x:m.x,y:m.y,z:m.z,yaw:m.yaw,pitch:m.pitch,eye:1.65,alive:true,escaped:false,crawling:false,waiting:false,monitor:true,seq:m.seq,moving:false,ground:false,elapsed:p.elapsed};
  return {...s,...view,hostId:room.hostId,hostIds:[...room.hostIds],roleVersion:room.roleVersion,publicRoom:room.publicRoom,roomSettings:roomSettingsFor(room),settingsVersion:room.settingsVersion||0,personal:!!room.personal,global:false,phase:'playing',epoch:m.epoch,monitor:true,checkpoint:null,players:[...view.players.filter(q=>q.id!==id),me],playerCount:room.players.size,roster:[...room.players.values()].map(q=>({id:q.id,name:q.name,level:roomKey(room,q)==='run'?5:Number(roomKey(room,q)),run:roomKey(room,q)==='run',alive:q.alive,monitor:!!q.monitor})),events:s.events.filter(e=>['chat','joined','left','host','room-settings','death-link'].includes(e.kind)),messages:room.messages};
}
function hostMap(room,id,key){
  requireHost(room,id);key=String(key||roomKey(room,room.players.get(id)));const w=monitorWorld(room,key);
  return {key,epoch:w.epoch,map:w.map,obstacles:w.obstacles,spawn:w.spawnPoint,canDrop:!!room.personal||key===roomKey(room),players:[...room.players.values()].map(p=>({id:p.id,name:p.name,x:p.x,z:p.z,key:roomKey(room,p),life:p.life,alive:p.alive,monitor:!!p.monitor}))};
}
function teleportPlayer(room,id,data){
  requireHost(room,id);const p=room.players.get(data.playerId);if(!p)throw new GameError('That player has left the room.',409);
  if(room.phase==='lobby'||!room.personal&&room.phase!=='playing'||!p.alive||p.monitor||p.escaped||p.phase==='transition'||p.phase==='won')throw new GameError('Choose an active player who is not observing or leaving a level.',409);
  if(p.life!==data.life||roomKey(room,p)!==data.fromKey)throw new GameError('That player reached a new checkpoint. Refresh the map.',409);
  const key=String(data.key),w=monitorWorld(room,key);if(!room.personal&&key!==roomKey(room))throw new GameError('Enable independent progress to move players between levels.',409);
  if(data.mapEpoch!==w.epoch)throw new GameError('The map changed. Refresh it before moving a player.',409);
  const {x,z}=data;if(!Number.isFinite(x)||!Number.isFinite(z)||x<0||z<0||x>=w.map.length*4||z>=w.map.length*4||w.blocked(x,z,.3))throw new GameError('Drop the player on clear floor, away from walls and furniture.');
  if([...w.players.values()].some(q=>q.id!==p.id&&q.alive&&!q.monitor&&Math.hypot(q.x-x,q.z-z)<.8))throw new GameError('Choose a little more space beside that player.');
  if(room.personal&&p.worldKey!==key)room.enter(p,key,'respawn');
  Object.assign(p,{x,z,y:0,vy:0,ground:true,eye:1.65,crawl:null,noise:0,grace:3,moving:false,running:false,seq:0,life:p.life+1,input:{...p.input,f:0,s:0}});room.emit('relocated',{playerId:p.id,name:p.name});
}

const cleanName=protocol.cleanName;
module.exports={Room,GlobalRoom,IndependentRoom,changeRoomSettings,changePlayerRole,isRoomHost,setMonitor,hostMap,teleportPlayer,GameError,cleanName,worlds,protocol};
