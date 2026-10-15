'use strict';
const crypto=require('node:crypto'),worlds=require('./world-data.json'),protocol=require('./mp-shared.js');
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),mix=(a,b,t)=>a+(b-a)*t,dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const copy=v=>JSON.parse(JSON.stringify(v));
class GameError extends Error{constructor(message,status=400){super(message);this.status=status;}}
class Room{
  constructor(code,{level=1,publicRoom=false}={}){
    this.code=code;this.publicRoom=publicRoom;this.players=new Map();this.hostId=null;this.phase='lobby';this.epoch=0;this.events=[];this.eventId=0;this.messages=[];this.closedAt=0;this.configure(level);
  }
  configure(level,run=false){
    this.level=level;this.epoch++;this.elapsed=0;this.transition=0;this.run=run;this.runTime=0;this.front=-24;
    this.base=worlds[level];this.map=copy(run?worlds.run.map:this.base.map);this.obstacles=run?[]:this.base.obstacles;this.edges=level===4?new Set(this.base.edges):null;
    this.floors=run?worlds.run.path:this.base.floors;this.spawnPoint=run?worlds.run.spawn:this.base.spawn;
    this.monster={...this.base.monster,angle:0,walk:0,mode:'patrol',target:null,path:[],memory:0,repath:0};
    this.objectives={hammer:false,hits:[0,0,0,0,0],opened:[],opener:false,unlocked:false,doorOpen:0,anchors:run?[true,true,true]:[false,false,false],gates:(this.base.gates||[]).map(()=>false),warning:0,shifts:0};
    this.hiddenOpener=level===4?crypto.randomInt(this.base.units.length):-1;this.revealedOpener=-1;this.openTimes={};this.hammerCooldown=0;this.shiftIn=24;this.footIn=13;this.finalCheckpoint=run;
    const placed=[];for(const p of this.players.values()){this.spawnPlayer(p,this.spawnPoint,placed);placed.push(p);}
  }
  spawnPlayer(p,origin=this.spawnPoint,peers=[...this.players.values()]){
    // Keep cameras out of teammates' heads, including at checkpoints and late joins.
    const occupied=peers.filter(q=>q.id!==p.id&&q.alive&&!q.escaped),offsets=[[0,0]];
    for(const radius of [1.2,2.4,3.6])for(const [x,z] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]])offsets.push([x*radius,z*radius]);
    const position=offsets.map(([x,z])=>({x:origin.x+x,z:origin.z+z})).find(q=>!this.blocked(q.x,q.z,.29)&&occupied.every(other=>dist(q,other)>=1)&&this.line(origin,q,true,.26));
    if(!position)throw new GameError('There is no clear space beside your team. Try joining again in a moment.',409);
    Object.assign(p,{...origin,...position,y:0,vy:0,ground:true,eye:1.65,pitch:0,stamina:100,exhausted:false,noise:0,crouch:false,running:false,moving:false,flash:true,alive:true,escaped:false,crawl:null,cooldown:0,grace:7,step:0,seq:0,input:{f:0,s:0,yaw:origin.yaw,pitch:0,crouch:false,run:false,flash:true},inputAge:0});
  }
  addPlayer(name,avatar){
    if(this.players.size>=protocol.maxPlayers)throw new GameError('This room is full.',409);
    if(['won','lost'].includes(this.phase))throw new GameError('This room has finished. Create a new room.',409);
    const id=crypto.randomBytes(8).toString('hex');
    const p={id,name:protocol.cleanName(name),avatar:protocol.normalizeAvatar(avatar),color:this.players.size,lastChat:-Infinity,lastSeen:Date.now(),rate:0};let origin=this.spawnPoint;
    if(this.phase==='playing'){const buddy=[...this.players.values()].find(q=>q.alive&&!q.escaped&&!q.crawl);if(buddy)origin={x:buddy.x,z:buddy.z,yaw:buddy.yaw};else throw new GameError('Wait for the next checkpoint before joining.',409);}
    this.spawnPlayer(p,origin);
    this.players.set(id,p);if(!this.hostId)this.hostId=id;this.emit('joined',{playerId:id,name:p.name});return p;
  }
  removePlayer(id){const p=this.players.get(id);if(!p)return;this.players.delete(id);this.emit('left',{playerId:id,name:p.name});if(this.hostId===id){this.hostId=this.players.keys().next().value||null;this.emit('host',{playerId:this.hostId});}this.checkResolved();}
  start(id){if(id!==this.hostId)throw new GameError('Only the room host can start.',403);if(this.phase!=='lobby')throw new GameError('The room has already started.',409);this.phase='playing';this.emit('start');}
  retry(id){if(id!==this.hostId)throw new GameError('Only the host can restart the checkpoint.',403);if(!['lost','won'].includes(this.phase))throw new GameError('This run is still in progress.',409);const won=this.phase==='won';this.configure(won?1:this.level,!won&&this.finalCheckpoint);this.phase='playing';this.emit('retry');}
  emit(kind,data={}){this.events.push({...data,id:++this.eventId,kind});if(this.events.length>64)this.events.shift();}
  chat(p,kind,index,now=Date.now()){
    const list=kind==='message'?protocol.messages:kind==='emoji'?protocol.faces:null;
    if(!list||!Number.isInteger(index)||index<0||index>=list.length)throw new GameError('Choose one of the available messages or faces.');
    if(now-p.lastChat<900)throw new GameError('Give your last message a moment.',429);p.lastChat=now;
    const event={id:++this.eventId,kind:'chat',playerId:p.id,name:p.name,type:kind,text:list[index]};this.events.push(event);if(this.events.length>64)this.events.shift();this.messages.push(event);if(this.messages.length>8)this.messages.shift();return event;
  }
  input(p,data){
    if(data.epoch!==this.epoch)return false;
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
  action(p,action,epoch){
    if(epoch!==this.epoch||this.phase!=='playing'||!p.alive||p.escaped||p.crawl)return false;
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
      const gate=this.base.gate;if(o.anchors.every(Boolean)&&this.reach(p,gate.x,gate.z,2.3)){this.configure(5,true);this.phase='playing';this.emit('escape');return true;}
    }return false;
  }
  stepPlayer(p,dt){
    p.inputAge+=dt;p.grace=Math.max(0,p.grace-dt);p.cooldown=Math.max(0,p.cooldown-dt);p.noise=Math.max(0,p.noise-dt*.75);
    if(!p.alive||p.escaped)return;
    if(p.crawl){const e=this.base.exits[p.crawl.exit-1];p.crawl.time+=dt;const lower=clamp(p.crawl.time/.55,0,1),travel=clamp((p.crawl.time-.55)/2.6,0,1),smooth=travel*travel*(3-2*travel);p.x=mix(p.crawl.x,e.x-e.dc*3.2,smooth);p.z=mix(p.crawl.z,e.z-e.dr*3.2,smooth);p.eye=mix(1.65,.79,lower);p.yaw=Math.atan2(e.dc,e.dr);if(p.crawl.time>=3.2){p.crawl=null;p.escaped=true;this.emit('escaped',{playerId:p.id});}return;}
    const input=p.input;let f=p.inputAge>.4?0:input.f,s=p.inputAge>.4?0:input.s,len=Math.hypot(f,s);if(len>1){f/=len;s/=len;}
    p.yaw=input.yaw;p.pitch=input.pitch;p.crouch=input.crouch;p.flash=input.flash;
    const wantsRun=input.run&&!p.crouch&&len>.1&&p.inputAge<=.4;if(p.stamina<=1)p.exhausted=true;if(!wantsRun||p.stamina>25)p.exhausted=false;p.running=wantsRun&&!p.exhausted&&p.stamina>1;
    const speed=(p.crouch?1.9:p.running?6.2:3.8)*(this.level===3?.62:1),ox=p.x,oz=p.z;
    this.move(p,(-Math.sin(p.yaw)*f+Math.cos(p.yaw)*s)*speed*dt,(-Math.cos(p.yaw)*f-Math.sin(p.yaw)*s)*speed*dt);
    const moved=Math.hypot(p.x-ox,p.z-oz);p.moving=moved>dt*.2;p.step+=moved;
    p.stamina=clamp(p.stamina+(p.running&&p.moving?-21:13)*dt,0,100);p.eye=mix(p.eye,p.crouch?1.02:1.65,1-Math.exp(-12*dt));
    if(!p.ground){p.vy-=13.5*dt;p.y+=p.vy*dt;if(p.y<=0){p.y=0;p.vy=0;p.ground=true;p.noise=1;}}
    if(p.moving&&p.ground)p.noise=Math.max(p.noise,p.crouch?.07:p.running?1:.42);
  }
  stepMonster(dt){
    const m=this.monster,candidates=[...this.players.values()].filter(p=>p.alive&&!p.escaped&&!p.crawl&&p.grace===0);
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
    if(target){const d=dist(m,target);if(d>.01){const speed=(m.mode==='chase'?(this.level===1?3.1:3.4):m.mode==='investigate'?2.65:1.85)*(this.level===3?.62:1),step=Math.min(d,speed*dt),dx=(target.x-m.x)/d,dz=(target.z-m.z)/d,ox=m.x,oz=m.z;this.move(m,dx*step,dz*step,.29);m.walk+=Math.hypot(m.x-ox,m.z-oz)*4.6;const a=Math.atan2(dx,dz);m.angle+=Math.atan2(Math.sin(a-m.angle),Math.cos(a-m.angle))*Math.min(1,dt*7);}}
  }
  shift(){
    let changed=false;this.base.gates.forEach((g,i)=>{if(this.objectives.anchors[g.zone])return;const point={x:(g.c+.5)*4,z:(g.r+.5)*4};if(dist(point,this.monster)<7)return;
      for(const p of this.players.values()){if(!p.alive||p.escaped)continue;const d=dist(p,point),dot=(-Math.sin(p.yaw)*(point.x-p.x)-Math.cos(p.yaw)*(point.z-p.z))/Math.max(.01,d);if(d<9||dot>-.2&&this.line(p,point,false))return;}
      this.objectives.gates[i]=!this.objectives.gates[i];this.map[g.r][g.c]=this.objectives.gates[i]?1:0;changed=true;
    });if(changed){this.objectives.shifts++;this.monster.path=[];this.monster.repath=0;this.emit('shift');}
  }
  runProgress(p){let best=Infinity,result=0;const path=worlds.run.path;for(let i=0;i<path.length-1;i++){const a=path[i],b=path[i+1],dx=b.x-a.x,dz=b.z-a.z,t=clamp(((p.x-a.x)*dx+(p.z-a.z)*dz)/16,0,1),d=(p.x-a.x-dx*t)**2+(p.z-a.z-dz*t)**2;if(d<best){best=d;result=(i+t)*4;}}return result;}
  checkResolved(){
    if(this.phase!=='playing'||!this.players.size)return;
    const players=[...this.players.values()];if(players.some(p=>p.alive&&!p.escaped))return;
    if(players.some(p=>p.escaped)){if(this.level===5){this.phase='won';this.emit('won');}else this.nextLevel();}
    else{this.phase='lost';this.emit('lost');}
  }
  nextLevel(){if(this.phase!=='playing')return;this.phase='transition';this.transition=2.8;this.emit('transition',{nextLevel:this.level+1});}
  tick(dt){
    if(this.phase==='transition'){this.transition-=dt;if(this.transition<=0){this.configure(this.level+1);this.phase='playing';this.emit('level');}return;}
    if(this.phase!=='playing')return;
    this.elapsed+=dt;this.hammerCooldown=Math.max(0,this.hammerCooldown-dt);for(const p of this.players.values())this.stepPlayer(p,dt);
    const o=this.objectives;
    if(this.run){this.runTime+=dt;this.front=-24+this.runTime*3.25;for(const p of this.players.values()){if(!p.alive||p.escaped)continue;p.progress=this.runProgress(p);if(this.front>=0&&p.progress<=this.front+.5){p.alive=false;this.emit('caught',{playerId:p.id});}else if(p.progress>worlds.run.length-1.4&&dist(p,worlds.run.path.at(-1))<1.5){p.escaped=true;this.emit('escaped',{playerId:p.id});}}}
    else this.stepMonster(dt);
    if(this.level===4){
      if(o.opened.includes(this.hiddenOpener)&&this.elapsed-this.openTimes[this.hiddenOpener]>.4)this.revealedOpener=this.hiddenOpener;
      if(o.unlocked){o.doorOpen=mix(o.doorOpen,1,1-Math.exp(-3*dt));if(o.doorOpen>.85){this.map[24][21]=0;for(const p of this.players.values())if(p.alive&&!p.escaped&&p.z>98.55&&p.x>84.3&&p.x<87.7){p.escaped=true;this.emit('escaped',{playerId:p.id});}}}
    }
    if(this.level===5){this.footIn-=dt;if(this.footIn<=0){this.footIn=this.run?3.6:15;this.emit('giant');}
      if(!this.run&&!o.anchors.every(Boolean)){if(o.warning>0){o.warning=Math.max(0,o.warning-dt);if(o.warning===0){this.shift();this.shiftIn=25;}}else{this.shiftIn-=dt;if(this.shiftIn<=0){o.warning=4;this.emit('warning');}}}else o.warning=0;
    }
    this.checkResolved();if(this.phase==='playing'&&this.level<3&&this.elapsed>=(this.level===1?120:300))this.nextLevel();
  }
  snapshot(){
    const players=[...this.players.values()].map(p=>{const out={};for(const k of ['id','name','avatar','color','x','z','y','vy','ground','eye','yaw','pitch','stamina','crouch','running','moving','flash','alive','escaped','seq','grace','step'])out[k]=p[k];out.crawling=!!p.crawl;return out;});
    const m=this.monster;return {version:protocol.version,code:this.code,hostId:this.hostId,publicRoom:this.publicRoom,phase:this.phase,level:this.level,epoch:this.epoch,elapsed:this.elapsed,transition:this.transition,run:this.run,runTime:this.runTime,front:this.front,players,monster:{x:m.x,z:m.z,angle:m.angle,walk:m.walk,mode:m.mode},objectives:{...this.objectives,revealedOpener:this.revealedOpener},events:this.events.slice(-24),messages:this.messages};
  }
}
const cleanName=protocol.cleanName;
module.exports={Room,GameError,cleanName,worlds,protocol};
