// A shared allowlist: peers can send only these messages and face emoji.
(function(root){
  const messages=["Hi.","You are good at this game.","How are you.","I'm feeling good.","I'm not feeling good.","Follow me.","LOL","I'm laughing right now.","Bruh.","What the heck.","Let's go.","Yes.","No.","Wait for me.","I'm so goated, I know.","You are goated.","Frick.","BRB.","Is the monster here?","IDK.","Help!","You're on your own, buddy.","Go away.","AAAAAA","Why did you do that?"];
  // Unicode Smileys & Emotion face groups, including cats and the three monkeys.
  const faces='😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 🫠 🫫 😉 😊 😇 🥰 😍 🤩 😘 😗 ☺️ 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🫢 🫣 🤫 🤔 🫡 🤐 🤨 😐 😑 😶 🫥 😶‍🌫️ 😏 😒 🙄 😬 😮‍💨 🤥 🫨 🙂‍↔️ 🙂‍↕️ 😌 😔 😪 🤤 😴 🫩 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 😵‍💫 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 🫤 😟 🙁 ☹️ 😮 😯 😲 😳 🫪 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👺 👻 👽 👾 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾 🙈 🙉 🙊'.split(' ');
  // Cosmetic data is bounded here on both client and server. It never changes physics.
  const avatarChoices=Object.freeze({
    hair:['short','swept','bob','long','curly','afro','bun','ponytail','mohawk','bald'],
    face:['oval','round','square'],eyes:['round','almond'],brows:['soft','straight','angled'],
    mouth:['neutral','smile','serious'],facialHair:['none','stubble','beard','mustache'],
    top:['jacket','shirt','hoodie','vest'],pants:['trousers','shorts'],
    eyewear:['none','round','square','sunglasses'],hat:['none','beanie','cap'],
    accessory:['none','mask','earrings'],backpack:['none','pack']
  });
  Object.values(avatarChoices).forEach(Object.freeze);
  const avatarDefaults=Object.freeze({skin:'#bc8865',hairColor:'#30251f',eyeColor:'#749c88',topColor:'#a9ac7b',pantsColor:'#34483e',shoeColor:'#252c28',accentColor:'#e3d18f',hair:'swept',face:'oval',eyes:'almond',brows:'soft',mouth:'neutral',facialHair:'none',top:'jacket',pants:'trousers',eyewear:'none',hat:'none',accessory:'none',backpack:'pack',height:100,build:100,shoulders:100,headSize:100,eyeSize:100});
  const avatarRanges=Object.freeze({height:[90,110],build:[80,125],shoulders:[80,120],headSize:[85,115],eyeSize:[85,120]});
  Object.values(avatarRanges).forEach(Object.freeze);
  function normalizeAvatar(value){
    const input=value&&typeof value==='object'&&!Array.isArray(value)?value:{},out={};
    for(const [key,fallback] of Object.entries(avatarDefaults)){
      const v=input[key];
      if(avatarChoices[key])out[key]=avatarChoices[key].includes(v)?v:fallback;
      else if(avatarRanges[key]){const [min,max]=avatarRanges[key];out[key]=typeof v==='number'&&Number.isFinite(v)?Math.round(Math.max(min,Math.min(max,v))):fallback;}
      else out[key]=typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v)?v.toLowerCase():fallback;
    }return out;
  }
  function cleanName(name){const s=(typeof name==='string'?name:'Explorer').normalize('NFKC').replace(/[^\p{L}\p{N} _-]/gu,'').trim().slice(0,18);return s||'Explorer';}
  const protocol=Object.freeze({version:1,messages:Object.freeze(messages),faces:Object.freeze(faces),maxPlayers:4,globalMaxPlayers:16,avatarChoices,avatarDefaults,avatarRanges,normalizeAvatar,cleanName});
  if(typeof module!=='undefined'&&module.exports)module.exports=protocol;else root.BackroomsNetProtocol=protocol;
})(globalThis);
