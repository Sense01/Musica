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
        if(u.host==='api.deezer.com')setTimeout(()=>w[cb]&&w[cb]({data:deezer(u.searchParams.get('q'),u.pathname)}),1);
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
  assert.match(sw,/cache:'no-cache'/);  // vai sempre ver se há versão nova
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

const LIB=['Raye & Rudimental - Regardless (Official Audio)','Raye - Escapism','Felipe & Rodrigo - Pós (Ao Vivo) #NoSentimento',
  'Grupo Menos É Mais, Simone Mendes - P do Pecado (Ao Vivo)','Simone Mendes - Erro Gostoso','Agir - Manto de Água (feat. Ana Moura)',
  'Ana Moura - Desfado','João Gustavo e Murilo, @matogrossoemathias - Postinho De Gasolina'].map((fn,i)=>({id:'id0000000000000'+String(i).padStart(2,'0'),fn,d:''}));

test('páginas de artista: juntam colaborações e participações, sem partir duplas',()=>{
  const w=boot({store:{drive3:LIB}});
  const n=k=>{const e=w.eval('artIdx').get(k);return e?e.songs.length:0};
  assert.equal(n('raye'),2);                 // «Raye & Rudimental» separa-se porque há músicas só da Raye
  assert.equal(n('rudimental'),1);
  assert.equal(n('simone mendes'),2);        // a solo + em colaboração com vírgula
  assert.equal(n('ana moura'),2);            // a solo + «(feat. Ana Moura)» no título
  assert.equal(n('felipe rodrigo'),1);       // dupla: fica junta
  assert.equal(n('felipe'),0);
  assert.equal(n('joao gustavo e murilo'),1);
  assert.ok(![...w.eval('artIdx').keys()].some(k=>k.includes('matogrosso')));  // «@…» não é artista
  w.eval("go('artist','Ana Moura')");
  assert.equal(w.document.querySelectorAll('#c .row').length,2);
});

test('pesquisa: mostra artistas e filtra os resultados por cantor',()=>{
  const w=boot({store:{drive3:LIB}});
  w.eval("go('search')");
  const q=w.document.querySelector('#q');q.value='moura';q.dispatchEvent(new w.Event('input'));
  const res=w.document.querySelector('#res');
  assert.match(res.textContent,/Ana Moura/);
  assert.equal(res.querySelectorAll('[data-v="artist"]').length,1);
  q.value='r';q.dispatchEvent(new w.Event('input'));
  const all=res.querySelectorAll('.row[data-i]').length;
  res.querySelector('[data-sa="raye"]').click();
  const only=[...res.querySelectorAll('.row[data-i] .meta span')].map(e=>e.textContent);
  assert.ok(only.length===2&&only.length<all);
  assert.ok(only.every(t=>/Raye/.test(t)));
});

test('leitor: tocar no nome do artista abre a página dele',()=>{
  const w=boot({store:{drive3:LIB}});
  w.eval("go('artist','Simone Mendes')");
  const row=[...w.document.querySelectorAll('#c .row')].find(r=>/P do Pecado/.test(r.textContent));row.click();
  w.document.querySelector('#sheet').classList.add('open');
  const links=[...w.document.querySelectorAll('#sA [data-art]')].map(e=>e.dataset.art);
  assert.deepEqual(links,['Grupo Menos É Mais','Simone Mendes']);
  assert.equal(w.document.querySelector('#sA').textContent,'Grupo Menos É Mais, Simone Mendes');  // o texto não muda
  w.document.querySelector('#sA [data-art="Grupo Menos É Mais"]').click();
  assert.equal(w.eval('view'),'artist');
  assert.equal(w.document.querySelector('#h').textContent,'Grupo Menos É Mais');
  assert.ok(!w.document.querySelector('#sheet').classList.contains('open'));  // o leitor fecha
  // participação no título aparece como «com …»
  w.eval("play(songs.findIndex(s=>/Manto/.test(s.title)),songs)");
  assert.match(w.document.querySelector('#sA').textContent,/Agir · com Ana Moura/);
});

test('fotos dos artistas: vêm do Deezer; sem foto, usa a capa de uma música',async()=>{
  const w=boot({store:{drive3:LIB,covers:{'id:id000000000000006':'https://dz/desfado.jpg'}},
    deezer:(q,p)=>!/artist/.test(p)?[]:q==='Simone Mendes'?[{name:'Simone Mendes',picture_big:'https://dz/simone.jpg'}]
      :q==='Ana Moura'?[{name:'Ana Moura',picture_big:'https://cdn/images/artist//500x500.jpg'}]  // o Deezer não tem foto
      :q==='Raye'?[{name:'RAYE',picture_big:'https://dz/raye.jpg'}]:q==='Rudimental'?[{name:'Rudimental',picture_big:"https://dz/r.jpg' onerror='x"}]:[]});  // a Raye tem foto; o endereço da Rudimental é inseguro
  w.eval("go('artists')");
  await wait(600);
  const ap=JSON.parse(w.localStorage.getItem('apics')||'{}');
  assert.equal(ap['simone mendes'],'https://dz/simone.jpg');
  assert.equal(ap['ana moura'],'');
  assert.equal(ap['raye'],'https://dz/raye.jpg');
  assert.equal(ap['rudimental'],'');
  const bgOf=k=>w.document.querySelector('[data-ak="'+k+'"]').getAttribute('style');
  assert.ok(w.document.querySelector('[data-ak="simone mendes"]').classList.contains('hasart'));
  w.eval("render()");
  assert.match(bgOf('simone mendes'),/dz\/simone\.jpg/);
  assert.match(bgOf('ana moura'),/dz\/desfado\.jpg/);  // capa de uma música dela
  assert.ok(!/onerror/.test(w.document.querySelector('#c').innerHTML));
});

test('definições: o botão copia o prompt de downloads exatamente',async()=>{
  const w=boot();let copied=null;
  Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async t=>{copied=t}},configurable:true});
  w.eval("go('set')");
  w.document.querySelector('#cp').click();await wait(50);
  const expected=fs.readFileSync(path.join(__dirname,'prompt-yt-dlp.txt'),'utf8').replace(/\n$/,'');
  assert.equal(copied,expected);
  assert.match(w.document.querySelector('#toast').textContent,/copiado/);
});
