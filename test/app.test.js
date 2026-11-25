// Testes da app num browser simulado (jsdom). Correr com: npm test
const {test,after}=require('node:test');
const wins=[];after(async()=>{await new Promise(r=>setTimeout(r,300));wins.forEach(w=>{try{w.close()}catch{}})});
const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path');
const {JSDOM}=require('jsdom');
const {indexedDB}=require('fake-indexeddb');

const ROOT=path.join(__dirname,'..');
const HTML=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
const wait=ms=>new Promise(r=>setTimeout(r,ms));

// Abre a app. `deezer` responde às pesquisas JSONP do Deezer; `fetch` trata dos outros pedidos.
function boot({store={},deezer=()=>[],fetch}={}){
  const w=new JSDOM(HTML,{runScripts:'dangerously',url:'https://sense01.github.io/Musica/',pretendToBeVisual:true,beforeParse(w){
    w.indexedDB=indexedDB;
    for(const [k,v] of Object.entries(store))w.localStorage.setItem(k,JSON.stringify(v));
    w.HTMLMediaElement.prototype.play=()=>Promise.resolve();
    w.HTMLMediaElement.prototype.pause=()=>{};
    w.matchMedia=()=>({matches:false});
    w.setTimeout=(st=>(f,ms,...a)=>st(f,ms>=12000?ms:Math.min(ms||0,20),...a))(w.setTimeout);  // acelera as esperas
    const ap=w.HTMLHeadElement.prototype.appendChild;
    w.HTMLHeadElement.prototype.appendChild=function(el){
      if(el.tagName==='SCRIPT'&&el.src){const u=new URL(el.src),cb=u.searchParams.get('callback');
        if(u.host==='api.deezer.com')setTimeout(()=>w[cb]&&w[cb]({data:deezer(u.searchParams.get('q'))}),1);
        else setTimeout(()=>el.onerror&&el.onerror(),1);
        return el}
      return ap.call(this,el)};
    w.fetch=fetch||(()=>Promise.reject(new TypeError('Load failed')));
  }}).window;
  wins.push(w);return w}
const dz=(artist,title,img)=>({title,artist:{name:artist},album:{title:'Álbum',cover_big:img,cover_medium:img}});

test('o service worker não está vazio e usa a versão da app',()=>{
  const sw=fs.readFileSync(path.join(ROOT,'sw.js'),'utf8');
  assert.match(sw,/addEventListener\('fetch'/);
  const v=HTML.match(/Versão (\d+)/)[1];
  assert.match(sw,new RegExp(`drums-v${v}'`));
});

test('nomes de ficheiro: o número inicial não é o artista',()=>{
  const w=boot();
  const p=n=>{const x=w.parseName('id000000000000001',n,'');return [x.artist,x.title]};
  assert.deepEqual(p('173 - &ME & Black Coffee - The Rapture'),['&ME & Black Coffee','The Rapture']);
  assert.deepEqual(p('01. Adele - Lovesong'),['Adele','Lovesong']);
  assert.deepEqual(p('Raye & Rudimental - Regardless (Official Audio)'),['Raye & Rudimental','Regardless (Official Audio)']);
  assert.deepEqual(p('Só o título'),['Google Drive','Só o título']);

});

test('capas: aceita o artista e o título certos, rejeita o resto',()=>{
  const w=boot();
  const x=n=>w.parseName('id000000000000001',n,'');
  const r=(a,t)=>[{a,t,l:'Álbum',img:'https://cdn/x.jpg'}];
  const ok=(n,a,t)=>!!w.pickArt(r(a,t),x(n),false);
  assert.ok(ok('Felipe & Rodrigo - Pós (Ao Vivo) #NoSentimento','Felipe e Rodrigo','Pós (Ao Vivo)'));
  assert.ok(ok('Kew - Deve ser la (Gilcastro)','Kew','Deve Ser IA'));  // pequena diferença no título
  assert.ok(ok('173 - &ME & Black Coffee - The Rapture','&ME, Black Coffee & Keinemusik','The Rapture'));
  assert.ok(!ok('Adele - Lovesong','The Cure','Lovesong'));  // artista errado
  assert.ok(!ok('Adele - Lovesong','Adele','Hello'));         // título errado

});

test('segurança: um endereço de capa com aspas nunca chega ao HTML',()=>{
  const w=boot();
  const bad="https://cdn/a.jpg' onerror='alert(1)";
  const safeUrl=w.eval('safeUrl');
  assert.equal(safeUrl(bad),'');
  assert.equal(safeUrl('https://cdn-images.dzcdn.net/images/cover/x/500x500-000000-80-0-0.jpg').length>0,true);
  assert.equal(w.pickArt([{a:'Adele',t:'Lovesong',img:bad}],w.parseName('i',"Adele - Lovesong",''),false),null);

});

test('pesquisa ignora acentos',()=>{
  const w=boot({store:{drive3:[{id:'id000000000000001',fn:'João Gustavo e Murilo - Pós',d:''}]}});
  w.eval("go('search')");
  const q=w.document.querySelector('#q');q.value='joao pos';q.dispatchEvent(new w.Event('input'));
  assert.equal(w.document.querySelectorAll('#res .row').length,1);

});

test('um ficheiro com erro: tenta outra vez, depois passa à seguinte e regista a causa',async()=>{
  const w=boot({store:{drive3:[1,2,3].map(i=>({id:'id00000000000000'+i,fn:'A - S'+i,d:''}))}});
  w.eval("go('lib')");w.document.querySelectorAll('.row')[0].click();
  const au=w.document.querySelector('#au');
  au.dispatchEvent(new w.Event('error'));await wait(150);
  assert.equal(w.eval('cur.title'),'S1');  // 1.º erro: tenta a mesma música outra vez
  au.dispatchEvent(new w.Event('error'));await wait(150);
  assert.equal(w.eval('cur.title'),'S2');  // 2.º erro: passa à seguinte
  assert.match(w.localStorage.getItem('plog'),/S1/);  // a falha fica registada

});

test('capas automáticas: se o iTunes falha (como no iPhone), o Deezer resolve',async()=>{
  const files=['173 - Justin Bieber - Yummy (Lyric Video).mp3','Felipe & Rodrigo - Pós (Ao Vivo).mp3'].map((name,i)=>({id:'fileid00000000000'+i,name,mimeType:'audio/mpeg',createdTime:'2024-0'+(i+1)}));
  const w=boot({
    store:{cfg:{key:'KEY',folder:'FOLDER'}},
    deezer:q=>/Yummy/.test(q)?[dz('Justin Bieber','Yummy','https://dz/yummy.jpg')]:/Pós/.test(q)?[dz('Felipe e Rodrigo','Pós (Ao Vivo)','https://dz/pos.jpg')]:[],
    fetch:(u,o)=>/drive\/v3\/files\?/.test(u)?Promise.resolve({ok:true,json:async()=>({files})}):Promise.reject(new TypeError('Load failed')),
  });
  await wait(1500);
  const covers=JSON.parse(w.localStorage.getItem('covers')||'{}');
  assert.equal(covers['id:fileid000000000000'],'https://dz/yummy.jpg');
  assert.equal(covers['id:fileid000000000001'],'https://dz/pos.jpg');

});

test('a fila toca seguida: 6 músicas, cada uma acaba e a seguinte começa',async()=>{
  const w=boot({store:{drive3:[1,2,3,4,5,6].map(i=>({id:'id00000000000000'+i,fn:'A - S'+i,d:''}))}});
  w.eval("go('lib')");w.document.querySelectorAll('.row')[0].click();
  const au=w.document.querySelector('#au'),seen=[w.eval('cur.title')];
  for(let k=0;k<5;k++){au.dispatchEvent(new w.Event('ended'));await wait(20);seen.push(w.eval('cur.title'))}
  assert.deepEqual(seen,['S1','S2','S3','S4','S5','S6']);
  assert.equal(w.eval('wantPlay'),true);
});
