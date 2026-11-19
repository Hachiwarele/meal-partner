/* MEAL PARTNER optional cloud sync — browser remains the primary local store. */
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js';
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, setPersistence, browserLocalPersistence } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js';
import { getDatabase, ref, get, set, onValue, runTransaction } from 'https://www.gstatic.com/firebasejs/13.4.0/firebase-database.js';

const bridge=window.MEAL_PARTNER_CLOUD_BRIDGE;
const STORE_NAMES=['meals','favorites','weights','settings','userFoods','aiNotes','aiImports'];
const ROOT='mealPartnerUsers';
const CONFIGURED=Boolean(firebaseConfig?.apiKey&&firebaseConfig?.authDomain&&firebaseConfig?.databaseURL&&firebaseConfig?.projectId&&firebaseConfig?.appId);
const html=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cloudKey=id=>encodeURIComponent(id).replace(/\./g,'%2E').replace(/!/g,'%21').replace(/'/g,'%27').replace(/\(/g,'%28').replace(/\)/g,'%29');
const uidPath=uid=>ROOT+'/'+uid+'/v1';
const currentRecordPath=(uid,store,id)=>uidPath(uid)+'/'+store+'/'+cloudKey(id);
const idKey=(store,id)=>store+'|'+id;
const clientId=(()=>{try{
 const k='mp-client-id';
 let value=localStorage.getItem(k);
 if(!value){value=crypto.randomUUID?.()||String(Date.now())+'-'+Math.random();localStorage.setItem(k,value);}
 return value;
}catch(_){return String(Date.now())+'-'+Math.random();}})();
let app=null,auth=null,database=null,user=null,unsubscribe=null;
let enabled=false,busy=false,phase=CONFIGURED?'未ログイン':'Firebase設定待ち',lastError='',lastSync='',collisions=0;
const known=new Map(),pending=new Set();
let worker=Promise.resolve(),flushPromise=null;
const ownerKey='mp-cloud-owner-v1';
const enabledKey=uid=>'mp-cloud-enabled-v1:'+uid;

function paint(){
  const container=document.getElementById('meal-cloud-panel');
  if(!container)return;
  if(!CONFIGURED){
    container.innerHTML='<p class="small muted">🔧 Firebaseの設定がまだ入っていません。ローカルの食事・写真・体重はそのまま保存されます。設定が終わるまではクラウドに送信されません。</p>'+
      '<p class="caption">Firebase Authentication・Realtime Database・本人専用ルールの設定後に接続できます。</p>';
    return;
  }
  let main='';
  if(!user){
    main='<p class="small muted">Safariとホーム画面版で同じメールアドレス・パスワードを使うと、同じ記録にアクセスできます。パスワードをChatGPTに送る必要はありません。</p>'+
      '<div class="field"><label class="label" for="mp-cloud-email">ログイン用メールアドレス</label><input id="mp-cloud-email" type="email" autocomplete="email" placeholder="name@example.com"></div>'+
      '<div class="field"><label class="label" for="mp-cloud-password">パスワード（6文字以上）</label><input id="mp-cloud-password" type="password" autocomplete="current-password" placeholder="パスワード"></div>'+
      '<div class="btn-row"><button class="primary" data-action="mp-cloud-login">ログイン</button><button class="secondary" data-action="mp-cloud-register">新規登録</button></div>'+
      '<button class="ghost small" data-action="mp-cloud-reset">パスワードを再設定する</button>';
  }else{
    const displayEmail=html(user.email||'アカウント');
    main='<p class="small muted">👤 '+displayEmail+' <button class="ghost small" data-action="mp-cloud-logout">ログアウト</button></p>'+
      (enabled?'<div class="notice">☁️ 同期有効：このブラウザの変更をクラウドへ保存します。別端末からの変更も取り込みます。</div>':
      '<div class="notice">初回同期前：既存の食事・写真・体重はこの端末に残っています。必ず先に「設定 → バックアップ → 保存」を実行してください。</div>'+
      '<label class="small" style="display:flex;align-items:center;gap:8px;margin:12px 0"><input id="mp-cloud-backup-ok" type="checkbox" style="width:auto"><span>この端末のバックアップJSONを保存した</span></label>'+
      '<button class="primary wide" data-action="mp-cloud-start">☁️ 既存データを守って同期開始</button>')+
      (enabled?'<button class="secondary wide" data-action="mp-cloud-resync" style="margin-top:10px">🔄 同期を再確認</button>':'');
  }
  const status='<div class="caption" style="margin-top:12px">状態：'+html(phase)+(lastSync?' · 最終確認 '+html(lastSync):'')+
      (collisions?' · 同じIDの競合 '+collisions+'件（自動で上書きしません）':'')+'</div>';
  container.innerHTML='<p class="small muted">🔐 記録はログイン本人専用のFirebase領域に保存。端末内の記録も残る二重保存方式です。</p>'+
       main+status+(lastError?'<p class="notice" style="margin-top:10px">⚠️ '+html(lastError)+'</p>':'')+
       '<p class="caption">接続に問題があってもローカルの記録は残ります。Firebaseへの保存が完了するまではバックアップJSONを消さないでね。</p>';
  for(const btn of container.querySelectorAll('button'))btn.disabled=busy;
}
function announce(message,error=''){
  phase=message;lastError=error;paint();
}
async function prepare(){
  if(!CONFIGURED||!bridge)return;
  try{
    app=initializeApp(firebaseConfig,'meal-partner-cloud');
    auth=getAuth(app);
    database=getDatabase(app);
    await setPersistence(auth,browserLocalPersistence);
    onAuthStateChanged(auth,async account=>{
      user=account;
      if(!account){enabled=false;if(unsubscribe)unsubscribe();unsubscribe=null;announce('未ログイン');return;}
      if(localStorage.getItem(ownerKey)&&localStorage.getItem(ownerKey)!==account.uid){
        enabled=false;announce('アカウントが一致しません','このブラウザには別アカウントの記録があります。誤って混ぜないように同期を停止しました。');
        return;
      }
      announce('ログイン済み');
      if(localStorage.getItem(enabledKey(account.uid))==='yes'){
        try{await startSync(false)}catch(err){announce('同期できませんでした',err.message||String(err));}
      }
    },err=>announce('認証に失敗しました',err.message||String(err)));
  }catch(err){announce('Firebase初期化エラー',err.message||String(err));}
}
async function serialize(name,record){
  const doc={...record};
  if(name==='meals'&&doc.photo instanceof Blob){
    doc.photo=await bridge.photoToDataUrl(doc.photo);
    if(doc.photo.length>7*1024*1024)throw new Error('写真が大きすぎます。該当写真を圧縮してから同期してください。');
  }
  if(name==='meals'&&doc.photo!=null&&typeof doc.photo!=='string')throw new Error('写真を同期用に変換できませんでした');
  return JSON.parse(JSON.stringify(doc));
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
  schema:1,id:record.id,changedAt:Date.now(),writer:clientId,deleted:Boolean(deleted),
  ...(!deleted?{data:record}:{})
});
async function localMap(name){return new Map((await bridge.read(name)).map(x=>[x.id,x]));}
async function readOutbox(){return bridge.read('cloudOutbox');}
function isSame(a,b){return JSON.stringify(a)===JSON.stringify(b);}
async function submitOutbox(entry){
  if(!user||!database||!enabled)throw new Error('同期が無効です');
  const key=idKey(entry.store,entry.recordId);
  const record=(await localMap(entry.store)).get(entry.recordId);
  const act=entry.action==='delete'||!record?'delete':'put';
  const data=act==='put'?await serialize(entry.store,record):{id:entry.recordId};
  const packet=nextPacket(data,act==='delete');
  pending.add(key);
  try{
    await set(ref(database,currentRecordPath(user.uid,entry.store,entry.recordId)),packet);
    known.set(key,packet.changedAt);
    const again=(await readOutbox()).find(x=>x.id===entry.id);
    if(again&&again.changedAt===entry.changedAt)await bridge.removeOutbox(entry.id);
  }finally{pending.delete(key);}
}
async function flush(){
  if(flushPromise)return flushPromise;
  flushPromise=(async()=>{
    if(!enabled||!user||!navigator.onLine)return;
    const entries=(await readOutbox()).sort((a,b)=>a.changedAt-b.changedAt);
    for(const entry of entries){
      if(!STORE_NAMES.includes(entry.store))continue;
      await submitOutbox(entry);
    }
  })().catch(err=>{announce('同期に失敗した変更があります',err.message||String(err));throw err}).finally(()=>{flushPromise=null});
  return flushPromise;
}
async function appendOnlyUpload(){
  // Never clear cloud records or replace an existing record during migration.
  const remoteSnap=await get(ref(database,uidPath(user.uid)));
  const remote=remoteSnap.exists()?remoteSnap.val():{};
  const outbox=(await readOutbox()).map(x=>x.id);
  for(const store of STORE_NAMES){
    const collection=remote?.[store]||{};
    const records=await bridge.read(store);
    for(const record of records){
      const rid=cloudKey(record.id);
      const existing=collection[rid];
      if(existing){
        known.set(idKey(store,record.id),Number(existing.changedAt||0));
        if(!existing.deleted&&!isSame(existing.data,await serialize(store,record))&&!outbox.includes(idKey(store,record.id)))collisions++;
        continue;
      }
      const document=await serialize(store,record);
      await runTransaction(
        ref(database,currentRecordPath(user.uid,store,record.id)),
        current=>current===null?nextPacket(document,false):undefined,
        {applyLocally:false}
      );
    }
  }
}
async function applyCloudSnapshot(snapshot){
  const data=snapshot.val()||{}, outboxIds=new Set((await readOutbox()).map(x=>x.id));
  let count=0;
  for(const store of STORE_NAMES){
    const locally=await localMap(store);
    for(const packet of Object.values(data[store]||{})){
      if(!packet||typeof packet.id!=='string'||!packet.schema)continue;
      const key=idKey(store,packet.id),stamp=Number(packet.changedAt||0),previous=known.get(key);
      if(outboxIds.has(key)||pending.has(key))continue;
      if(previous!=null&&stamp<previous)continue;
      if(packet.deleted){
        // Keep pre-migration local records if they conflict with a remote tombstone;
        // apply deletion only after this client has observed the original remote revision.
        if(previous!=null&&stamp>previous&&locally.has(packet.id)){
          await bridge.deleteFromCloud(store,packet.id);locally.delete(packet.id);count++;
        }
        known.set(key,stamp);continue;
      }
      if(!packet.data||packet.data.id!==packet.id)continue;
      const current=locally.get(packet.id);
      if(!current){
        await bridge.putFromCloud(store,deserialize(store,packet.data));
        locally.set(packet.id,packet.data);count++;
      }else if(previous!=null&&stamp>previous&&packet.writer!==clientId){
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
  const base=ref(database,uidPath(user.uid));
  unsubscribe=onValue(base,snap=>{
    worker=worker.then(()=>applyCloudSnapshot(snap)).catch(err=>announce('クラウドからの受信に失敗',err.message||String(err)));
  },err=>announce('クラウドの読込権限エラー','Realtime Databaseのルールを確認：'+(err.message||String(err))));
}
async function startSync(requireBackup){
  if(!user||!database)throw new Error('ログインが必要です');
  await bridge.ready;
  if(requireBackup&&!document.getElementById('mp-cloud-backup-ok')?.checked)
    throw new Error('まず「設定 → バックアップ → 保存」でJSONを保存して、確認欄にチェックしてください。');
  const owner=localStorage.getItem(ownerKey);
  if(owner&&owner!==user.uid)throw new Error('ほかのアカウントに紐づいた端末データのため同期できません');
  if(!navigator.onLine)throw new Error('インターネット接続を確認してください');
  busy=true;announce('既存データを安全に照合中');
  try{
    // First pass adds only missing records. Neither local nor cloud records are cleared.
    await appendOnlyUpload();
    enabled=true;
    localStorage.setItem(ownerKey,user.uid);
    await flush();
    subscribe();
    localStorage.setItem(enabledKey(user.uid),'yes');
    lastSync=new Date().toLocaleString('ja-JP');
    announce('クラウド同期が有効です');
  }catch(err){
    enabled=false;announce('同期の開始に失敗しました',err.message||String(err));
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
    if(action==='mp-cloud-reset'){
      const email=document.getElementById('mp-cloud-email')?.value?.trim();
      if(!email)throw new Error('メールアドレスを入力してください');
      await sendPasswordResetEmail(auth,email);announce('再設定メールを送信しました');return;
    }
    if(action==='mp-cloud-login'||action==='mp-cloud-register'){
      const email=document.getElementById('mp-cloud-email')?.value?.trim();
      const password=document.getElementById('mp-cloud-password')?.value||'';
      if(!email||password.length<6)throw new Error('メールアドレスと6文字以上のパスワードを入力してください');
      busy=true;paint();
      try{
        await (action==='mp-cloud-register'?
          createUserWithEmailAndPassword(auth,email,password):
          signInWithEmailAndPassword(auth,email,password));
      }finally{busy=false;paint()}
      return;
    }
    if(action==='mp-cloud-logout'){
      if(unsubscribe){unsubscribe();unsubscribe=null}
      enabled=false;await signOut(auth);announce('ログアウトしました。端末内データは残っています');return;
    }
    if(action==='mp-cloud-start'){await startSync(true);return}
    if(action==='mp-cloud-resync'){
      if(!enabled)throw new Error('同期が有効ではありません');
      busy=true;announce('同期を再確認中');
      try{await flush();lastSync=new Date().toLocaleString('ja-JP');announce('再確認が完了しました')}
      finally{busy=false;paint()}
    }
  }catch(err){announce('操作が完了しませんでした',err.message||String(err));}
},true);
window.addEventListener('mealpartner:render',paint);
window.addEventListener('mealpartner:localwrite',()=>{
  if(!enabled||!user)return;
  flush().catch(()=>{});
});
window.addEventListener('online',()=>{if(enabled)flush().catch(()=>{})});
paint();
prepare();
