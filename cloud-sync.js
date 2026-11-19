/* MEAL PARTNER optional cloud sync — browser remains the primary local store. */
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInAnonymously, setPersistence, browserLocalPersistence } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import { getDatabase, ref, get, set, onValue, runTransaction } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-database.js';

const bridge=window.MEAL_PARTNER_CLOUD_BRIDGE;
const STORE_NAMES=['meals','favorites','weights','settings','userFoods','aiNotes','aiImports'];
const ROOT='mealPartnerRooms';
const KEYS='mealPartnerRoomKeys';
const PROOFS='mealPartnerRoomProofs';
const CONFIGURED=Boolean(firebaseConfig?.apiKey&&firebaseConfig?.authDomain&&firebaseConfig?.databaseURL&&firebaseConfig?.projectId&&firebaseConfig?.appId);
const html=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cloudKey=id=>encodeURIComponent(id).replace(/\./g,'%2E').replace(/!/g,'%21').replace(/'/g,'%27').replace(/\(/g,'%28').replace(/\)/g,'%29');
const uidPath=room=>ROOT+'/'+room+'/v1';
const currentRecordPath=(room,store,id)=>uidPath(room)+'/'+store+'/'+cloudKey(id);
const ROOM_ALPHABET='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROOM_STORAGE='mp-cloud-room-credentials-v1';
const OWNER_KEY='mp-cloud-room-owner-v1';
const generateRoomCode=()=>{const bytes=crypto.getRandomValues(new Uint8Array(12));return Array.from(bytes,n=>ROOM_ALPHABET[n%ROOM_ALPHABET.length]).join('');};
const generateSecret=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('').toUpperCase();
const normalizeCode=value=>String(value||'').toUpperCase().replace(/[^2-9A-HJ-NP-Z]/g,'');
const normalizeSecret=value=>String(value||'').replace(/[^0-9a-f]/gi,'').toUpperCase();
async function verifier(code,key){
  const bytes=new TextEncoder().encode('MEALPARTNER-V1:'+code+':'+key);
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
}
const formatKey=s=>s.match(/.{1,8}/g)?.join('-')||s;
const getStoredRoom=()=>{try{return JSON.parse(localStorage.getItem(ROOM_STORAGE)||'null')}catch{return null}};
const persistRoom=(code,secret)=>localStorage.setItem(ROOM_STORAGE,JSON.stringify({code,secret}));

const idKey=(store,id)=>store+'|'+id;
const packetToken=packet=>[packet.writer||'',packet.changedAt||0,packet.nonce||''].join('|');
const clientId=crypto.randomUUID?.()||String(Date.now())+'-'+Math.random();
let app=null,auth=null,database=null,user=null,unsubscribe=null;
let room=null,showSecret=false,justCreated=false,adoptRemoteSettings=false;
let enabled=false,busy=false,phase=CONFIGURED?'匿名認証を準備中':'Firebase設定待ち',lastError='',lastSync='',collisions=0;
const conflictIds=new Set();
const known=new Map(),pending=new Set();
let needsFlush=false;
let worker=Promise.resolve(),flushPromise=null;
const ownerKey=OWNER_KEY;
const enabledKey=code=>'mp-cloud-enabled-room-v1:'+code;

function paint(){
  const container=document.getElementById('meal-cloud-panel');
  if(!container)return;
  if(!CONFIGURED){
    container.innerHTML='<p class="small muted">🔧 Firebase接続設定が未入力です。既存の食事・体重・写真は端末内に残っています。</p>'+
      '<p class="caption">Authenticationの匿名ログインを有効にし、専用のRealtime Databaseルールを設定してから使えます。</p>';
    return;
  }
  let main='';
  if(!user){
    main='<p class="small muted">Firebaseに匿名接続しています。メールアドレスは必要ありません。</p>';
  }else if(!room){
    main='<div class="notice">初回の同期前に「設定 → バックアップ → 保存」でJSONを保存してね。既存データは削除されません。</div>'+
      '<label class="small" style="display:flex;align-items:center;gap:8px;margin:12px 0"><input id="mp-cloud-backup-ok" type="checkbox" style="width:auto"><span>バックアップJSONをファイルに保存済み</span></label>'+
      '<button class="primary wide" data-action="mp-cloud-create">✨ 自分専用の部屋を作る</button>'+
      '<div class="section-title"><h3>別のSafari・ホーム画面版で接続</h3></div>'+
      '<div class="field"><label class="label" for="mp-cloud-code">共有コード（12文字）</label><input id="mp-cloud-code" maxlength="17" spellcheck="false" autocapitalize="characters" autocomplete="off" placeholder="例：ABCDEFGH2345"></div>'+
      '<div class="field"><label class="label" for="mp-cloud-key">復旧キー（64桁）</label><input id="mp-cloud-key" type="password" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="保存してある復旧キーを貼り付け"></div>'+
      '<button class="secondary wide" data-action="mp-cloud-join">🔑 既存の部屋に接続する</button>';
  }else{
    main='<p class="small muted">🔐 共有コード： <strong>'+html(room.code)+'</strong></p>'+
      '<div class="btn-row"><button class="secondary" data-action="mp-cloud-copy-code">共有コードをコピー</button><button class="secondary" data-action="mp-cloud-copy-credentials">コード＋復旧キーをコピー</button></div>'+
      (justCreated?'<div class="notice">🎉 部屋ができたよ！下の復旧キーは安全な場所に保存してね。失うと新しい端末から復元できないよ。</div>':'')+
      '<button class="ghost small" data-action="mp-cloud-toggle-key">'+(showSecret?'復旧キーを隠す':'復旧キーを表示')+'</button>'+
      (showSecret?'<p class="caption" style="overflow-wrap:anywhere">'+html(formatKey(room.secret))+'</p>':'')+
      (enabled?'<div class="notice">☁️ 同期有効：Safari・ホーム画面版で同じコードと復旧キーを入力すると同じ記録を使えます。</div>':
      '<div class="notice">まだ同期は開始していません。端末のバックアップJSONを保存してから開始してください。</div>'+
      '<label class="small" style="display:flex;align-items:center;gap:8px;margin:12px 0"><input id="mp-cloud-backup-ok" type="checkbox" style="width:auto"><span>バックアップJSONをファイルに保存済み</span></label>'+
      '<button class="primary wide" data-action="mp-cloud-start">☁️ 既存データを守って同期を開始</button>')+
      (enabled?'<button class="secondary wide" data-action="mp-cloud-resync">🔄 同期を再確認</button>':'');
  }
  const status='<div class="caption" style="margin-top:12px">状態：'+html(phase)+(lastSync?' · 最終確認 '+html(lastSync):'')+
      (collisions?' · ID競合 '+collisions+'件（上書きせず保留）':'')+'</div>';
  container.innerHTML='<p class="small muted">☁️ メールアドレス不要。共有コードと復旧キーの両方を持つ端末だけが記録を読み書きできます。</p>'+
     main+status+(lastError?'<p class="notice" style="margin-top:10px">⚠️ '+html(lastError)+'</p>':'')+
     '<p class="caption">復旧キーはチャットやGitHubに貼らないでね。端末内の記録は残ります。同期完了まではバックアップJSONを保持してください。</p>';
  for(const btn of container.querySelectorAll('button'))btn.disabled=busy;
}
function announce(message,error=''){
  phase=message;lastError=error;paint();
}
async function prepare(){
  if(!CONFIGURED||!bridge)return;
  try{
    app=initializeApp(firebaseConfig,'meal-partner-cloud');
    auth=getAuth(app);database=getDatabase(app);
    await setPersistence(auth,browserLocalPersistence);
    onAuthStateChanged(auth,async account=>{
      user=account;
      if(!account){enabled=false;if(unsubscribe)unsubscribe();unsubscribe=null;announce('匿名認証中');try{await signInAnonymously(auth)}catch(err){announce('匿名認証に失敗',String(err.message||err))}return;}
      announce('メール不要の認証が完了しました');
      const saved=getStoredRoom();
      if(saved&&/^[2-9A-HJ-NP-Z]{12}$/.test(saved.code)&&/^[A-F0-9]{64}$/.test(saved.secret)){
        try{
          const owner=localStorage.getItem(ownerKey);
          if(owner&&owner!==saved.code)throw new Error('この端末には別の部屋の記録があります。同期を停止しました。');
          await joinRoom(saved.code,saved.secret,false);
          if(localStorage.getItem(enabledKey(saved.code))==='yes')await startSync(false);
        }catch(err){room=null;announce('再接続できませんでした',String(err.message||err))}
      }
    },err=>announce('認証に失敗しました',String(err.message||err)));
  }catch(err){announce('Firebase初期化エラー',String(err.message||err));}
}
async function joinRoom(code,secret,save){
  if(!user||!database)throw new Error('匿名認証がまだ完了していません');
  if(!/^[2-9A-HJ-NP-Z]{12}$/.test(code)||!/^[A-F0-9]{64}$/.test(secret))throw new Error('共有コードまたは復旧キーの形式が違います');
  const owner=localStorage.getItem(ownerKey);
  if(owner&&owner!==code)throw new Error('この端末の記録は別の共有コードに紐づいています。記録の混在を防ぐため接続を停止しました');
  const hash=await verifier(code,secret);
  // The private verifier is never readable. Firebase rules compare the proof server-side.
  try{await set(ref(database,PROOFS+'/'+code+'/'+user.uid),hash)}
  catch(err){throw new Error('共有コード・復旧キーが一致しないか、Firebaseの匿名認証・データベースルールが未設定です：'+String(err.message||err))}
  room={code,secret};if(save)persistRoom(code,secret);
  announce('部屋への接続が完了しました');
}
async function createRoom(){
  if(!user||!database)throw new Error('匿名認証を確認してください');
  const owner=localStorage.getItem(ownerKey);
  if(owner)throw new Error('既存の部屋との混在を防ぐため、新しい部屋を作れません。既存の部屋を使ってください');
  const secret=generateSecret();
  for(let attempt=0;attempt<4;attempt++){
    const code=generateRoomCode();
    try{
      await set(ref(database,KEYS+'/'+code),{verifier:await verifier(code,secret),creator:user.uid});
      await joinRoom(code,secret,true);
      justCreated=true;showSecret=true;announce('新しい部屋を作成しました');
      return;
    }catch(err){
      if(attempt===3)throw new Error('部屋の作成に失敗しました。Firebaseのルールを確認してください：'+String(err.message||err));
    }
  }
}
async function serialize(name,record){
  const doc={...record};
  if(name==='meals'&&doc.photo instanceof Blob){
    doc.photo=await bridge.photoToDataUrl(doc.photo);
    if(doc.photo.length>7*1024*1024)throw new Error('写真が大きすぎます。該当写真を圧縮してから同期してください。');
  }
  if(name==='meals'&&doc.photo!=null&&typeof doc.photo!=='string')throw new Error('写真を同期用に変換できませんでした');
  // Firebase RTDB removes null object properties. Normalize now, so equality checks are stable.
  return JSON.parse(JSON.stringify(doc), (key,value)=>value===null?undefined:value);
}
function deserialize(name,record){
  if(!record||typeof record!=='object'||typeof record.id!=='string')throw new Error('クラウドデータの形式が不正です');
  const data={...record};
  if(name==='meals'&&typeof data.photo==='string'&&data.photo.startsWith('data:image/')){
    data.photo=bridge.photoFromDataUrl(data.photo);
  }
  return data;
}
const nextPacket=(record,deleted)=>({
  schema:1,id:record.id,changedAt:Date.now(),writer:clientId,nonce:crypto.randomUUID?.()||String(Math.random()),deleted:Boolean(deleted),
  ...(!deleted?{data:record}:{})
});
async function localMap(name){return new Map((await bridge.read(name)).map(x=>[x.id,x]));}
async function readOutbox(){return bridge.read('cloudOutbox');}
function isSame(a,b){return JSON.stringify(a)===JSON.stringify(b);}
async function submitOutbox(entry){
  if(!user||!database||!room||!enabled)throw new Error('同期が無効です');
  const key=idKey(entry.store,entry.recordId);
  const record=(await localMap(entry.store)).get(entry.recordId);
  const act=entry.action==='delete'||!record?'delete':'put';
  const data=act==='put'?await serialize(entry.store,record):{id:entry.recordId};
  const packet=nextPacket(data,act==='delete');
  pending.add(key);
  try{
    const expected=known.get(key);
    const outcome=await runTransaction(
      ref(database,currentRecordPath(room.code,entry.store,entry.recordId)),
      current=>{
        // Compare-and-swap: do not discard a newer change made by another device.
        if(current&&packetToken(current)!==expected)return;
        if(!current&&expected!=null)return;
        return packet;
      },
      {applyLocally:false}
    );
    if(!outcome.committed){
      if(!conflictIds.has(key)){conflictIds.add(key);collisions++;}
      throw new Error('別端末で変更された記録があるため上書きを停止しました。バックアップを保持してください。');
    }
    known.set(key,packetToken(packet));
    const again=(await readOutbox()).find(x=>x.id===entry.id);
    if(again&&again.changedAt===entry.changedAt)await bridge.removeOutbox(entry.id);
  }finally{pending.delete(key);}
}
async function flush(){
  if(flushPromise){needsFlush=true;return flushPromise;}
  flushPromise=(async()=>{
    if(!enabled||!user||!navigator.onLine)return;
    const entries=(await readOutbox()).sort((a,b)=>a.changedAt-b.changedAt);
    for(const entry of entries){
      if(!STORE_NAMES.includes(entry.store)||conflictIds.has(entry.id))continue;
      await submitOutbox(entry);
    }
  })().catch(err=>{announce('同期に失敗した変更があります',err.message||String(err));throw err}).finally(()=>{
    flushPromise=null;
    if(needsFlush){needsFlush=false;Promise.resolve().then(()=>flush().catch(()=>{}));}
  });
  return flushPromise;
}
async function appendOnlyUpload(pristine){
  // Never overwrite records that already exist in the cloud.
  const remoteSnap=await get(ref(database,uidPath(room.code)));
  const remote=remoteSnap.exists()?remoteSnap.val():{};
  const outbox=(await readOutbox()).map(x=>x.id);
  for(const store of STORE_NAMES){
    const collection=remote?.[store]||{};
    const records=await bridge.read(store);
    for(const record of records){
      if(pristine&&store==='settings'&&collection[cloudKey(record.id)])continue;
      const rid=cloudKey(record.id);
      const existing=collection[rid];
      if(existing){
        known.set(idKey(store,record.id),packetToken(existing));
        if(!existing.deleted&&!isSame(existing.data,await serialize(store,record))){
          const key=idKey(store,record.id);
          // An already-linked device may be replaying a legitimate offline edit.
          // An unlinked new device must never overwrite the existing cloud record.
          const trustedOffline=localStorage.getItem(ownerKey)===room.code &&
            localStorage.getItem(enabledKey(room.code))==='yes' && outbox.includes(key);
          if(!trustedOffline){conflictIds.add(key);collisions++;}
        }
        continue;
      }
      const document=await serialize(store,record);
      const result=await runTransaction(
        ref(database,currentRecordPath(room.code,store,record.id)),
        current=>current===null?nextPacket(document,false):undefined,
        {applyLocally:false}
      );
      if(result.snapshot?.exists())known.set(idKey(store,record.id),packetToken(result.snapshot.val()));
      if(!result.committed&&result.snapshot?.exists()){
        if(!conflictIds.has(idKey(store,record.id))){conflictIds.add(idKey(store,record.id));collisions++;}
      }
    }
  }
  return remote;
}
async function applyCloudSnapshot(snapshot){
  const data=snapshot.val()||{}, outboxIds=new Set((await readOutbox()).map(x=>x.id));
  let count=0;
  for(const store of STORE_NAMES){
    const locally=await localMap(store);
    for(const packet of Object.values(data[store]||{})){
      if(!packet||typeof packet.id!=='string'||!packet.schema)continue;
      const key=idKey(store,packet.id),stamp=packetToken(packet),previous=known.get(key);
      if(outboxIds.has(key)||pending.has(key))continue;
      if(previous===stamp&&!(store==='settings'&&adoptRemoteSettings))continue;
      if(packet.deleted){
        // Keep pre-migration local records if they conflict with a remote tombstone;
        // apply deletion only after this client has observed the original remote revision.
        if(previous!=null&&stamp!==previous&&locally.has(packet.id)){
          await bridge.deleteFromCloud(store,packet.id);locally.delete(packet.id);count++;
        }
        known.set(key,stamp);continue;
      }
      if(!packet.data||packet.data.id!==packet.id)continue;
      const current=locally.get(packet.id);
      if(store==='settings'&&adoptRemoteSettings){
        await bridge.putFromCloud(store,deserialize(store,packet.data));
        locally.set(packet.id,packet.data);adoptRemoteSettings=false;count++;
      }else if(!current){
        await bridge.putFromCloud(store,deserialize(store,packet.data));
        locally.set(packet.id,packet.data);count++;
      }else if(previous!=null&&stamp!==previous&&packet.writer!==clientId){
        await bridge.putFromCloud(store,deserialize(store,packet.data));
        locally.set(packet.id,packet.data);count++;
      }else if(previous==null){
        const localSerialized=await serialize(store,current);
        if(!isSame(localSerialized,packet.data))collisions++;
      }
      known.set(key,stamp);
    }
  }
  if(count)await bridge.rebuild();
  lastSync=new Date().toLocaleString('ja-JP');
  if(!lastError)announce('同期中');
}
function subscribe(){
  if(unsubscribe)unsubscribe();
  const base=ref(database,uidPath(room.code));
  unsubscribe=onValue(base,snap=>{
    worker=worker.then(()=>applyCloudSnapshot(snap)).catch(err=>announce('クラウドからの受信に失敗',err.message||String(err)));
  },err=>announce('クラウドの読込権限エラー','Realtime Databaseのルールを確認：'+(err.message||String(err))));
}
async function startSync(requireBackup){
  if(!user||!database||!room)throw new Error('部屋への接続が必要です');
  await bridge.ready;
  if(requireBackup&&!document.getElementById('mp-cloud-backup-ok')?.checked)
    throw new Error('まず「設定 → バックアップ → 保存」でJSONを保存し、確認欄にチェックしてください');
  const owner=localStorage.getItem(ownerKey);
  if(owner&&owner!==room.code)throw new Error('この端末には異なる部屋の記録があります');
  if(!navigator.onLine)throw new Error('インターネット接続を確認してください');
  busy=true;announce('既存データを照合中');
  try{
    // In a new home-screen installation, only the default settings exist locally.
    const activity=await Promise.all(STORE_NAMES.filter(x=>x!=='settings').map(n=>bridge.read(n)));
    const pristine=activity.every(records=>records.length===0)&&!owner;
    const remote=await appendOnlyUpload(pristine);
    if(pristine&&remote?.settings?.[cloudKey('prefs')]){
      for(const entry of await readOutbox())if(entry.store==='settings')await bridge.removeOutbox(entry.id);
      adoptRemoteSettings=true;
    }
    enabled=true;
    localStorage.setItem(ownerKey,room.code);
    await flush();
    subscribe();
    localStorage.setItem(enabledKey(room.code),'yes');
    lastSync=new Date().toLocaleString('ja-JP');
    announce('クラウド同期が有効です');
  }catch(err){
    enabled=false;announce('同期を開始できませんでした',String(err.message||err));
    throw err;
  }finally{busy=false;paint();}
}
document.addEventListener('click',async event=>{
  const btn=event.target.closest('[data-action^="mp-cloud-"]');
  if(!btn)return;
  event.preventDefault();event.stopImmediatePropagation();
  if(busy)return;
  const action=btn.dataset.action;
  try{
    if(action==='mp-cloud-toggle-key'){showSecret=!showSecret;paint();return;}
    if(action==='mp-cloud-copy-code'){
      if(room){await navigator.clipboard.writeText(room.code);announce('共有コードをコピーしました');}return;
    }
    if(action==='mp-cloud-copy-credentials'){
      if(room){
        await navigator.clipboard.writeText('MEAL PARTNER\n共有コード: '+room.code+'\n復旧キー: '+formatKey(room.secret));
        justCreated=false;announce('コードと復旧キーをコピーしました。安全な場所に保存してね');
      }return;
    }
    if(action==='mp-cloud-create'||action==='mp-cloud-join'){
      if(!document.getElementById('mp-cloud-backup-ok')?.checked)throw new Error('まず端末のバックアップJSONを保存し、確認欄にチェックしてください');
      let code='',secret='';
      if(action==='mp-cloud-join'){
        code=normalizeCode(document.getElementById('mp-cloud-code')?.value);
        secret=normalizeSecret(document.getElementById('mp-cloud-key')?.value);
      }
      busy=true;paint();
      try{
        if(action==='mp-cloud-create')await createRoom();
        else await joinRoom(code,secret,true);
      }finally{busy=false;paint();}
      return;
    }
    if(action==='mp-cloud-start'){await startSync(true);return;}
    if(action==='mp-cloud-resync'){
      if(!enabled)throw new Error('同期が有効ではありません');
      busy=true;announce('同期を再確認中');
      try{await flush();lastSync=new Date().toLocaleString('ja-JP');announce('再確認が完了しました')}
      finally{busy=false;paint()}
    }
  }catch(err){announce('操作が完了しませんでした',String(err.message||err));}
},true);
window.addEventListener('mealpartner:render',paint);
window.addEventListener('mealpartner:localwrite',()=>{
  if(!enabled||!user)return;
  flush().catch(()=>{});
});
window.addEventListener('online',()=>{if(enabled)flush().catch(()=>{})});
paint();
prepare();
