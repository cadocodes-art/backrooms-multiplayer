// A shared allowlist: peers can send only these messages and face emoji.
(function(root){
  const messages=["Hi.","You are good at this game.","How are you.","I'm feeling good.","I'm not feeling good.","Follow me.","LOL","I'm laughing right now.","Bruh.","What the heck.","Let's go.","Yes.","No.","Wait for me.","I'm so goated, I know.","You are goated.","Frick.","BRB.","Is the monster here?","IDK.","Help!","You're on your own, buddy.","Go away.","AAAAAA","Why did you do that?"];
  // Unicode Smileys & Emotion face groups, including cats and the three monkeys.
  const faces='😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 🫠 🫫 😉 😊 😇 🥰 😍 🤩 😘 😗 ☺️ 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🫢 🫣 🤫 🤔 🫡 🤐 🤨 😐 😑 😶 🫥 😶‍🌫️ 😏 😒 🙄 😬 😮‍💨 🤥 🫨 🙂‍↔️ 🙂‍↕️ 😌 😔 😪 🤤 😴 🫩 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 😵‍💫 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 🫤 😟 🙁 ☹️ 😮 😯 😲 😳 🫪 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👺 👻 👽 👾 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾 🙈 🙉 🙊'.split(' ');
  const protocol=Object.freeze({version:1,messages:Object.freeze(messages),faces:Object.freeze(faces),maxPlayers:4});
  if(typeof module!=='undefined'&&module.exports)module.exports=protocol;else root.BackroomsNetProtocol=protocol;
})(globalThis);
