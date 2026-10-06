/* ============ Firebase setup ============ */
const firebaseConfig = {
  apiKey: "AIzaSyBIpWKS_RsKWhBLYF-mOpPMVabA8-Wak5U",
  authDomain: "dorosi-app-ae183.firebaseapp.com",
  projectId: "dorosi-app-ae183",
  storageBucket: "dorosi-app-ae183.firebasestorage.app",
  messagingSenderId: "890142956616",
  appId: "1:890142956616:web:5b5644c07e6c56e4a3cc7d"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
// تخزين محلي: البرنامج يفضل شغال لو النت قطع، والتعديلات بتتزامن لوحدها لما النت يرجع
db.enablePersistence({ synchronizeTabs:true }).catch(e=>console.warn('offline persistence unavailable:', e && e.code));
let currentUID = null;

/* ============ Storage ============ */
let DATA = [];    // students: {id,name,barcode,phone,parentPhone,fee,notes,groupId,attendance,payments}
let GROUPS = [];  // {id,name,days:[],time,createdAt}
let ACTIVE_SESSION = null; // الحصة المفتوحة للمسح الآن: {id,date,groupIds,openedAt,days:[],resolvedGroupIds:[]}
let SESSIONS = []; // سجل الحصص الأسبوعية القابلة للاستكمال (إضافة جديدة متوافقة مع القديم): {id,groupIds,days:[],resolvedGroupIds:[],status:'pending'|'completed',createdAt,updatedAt}
let IN_SESSION_UI = false; // هل الشاشة المعروضة الآن هي شاشة "الحصة الحالية" وليس شاشة مجموعة عادية (يمنع تداخل بيانات الحصة مع باقي الصفحات)
const DEFAULT_MSG = `السلام عليكم ورحمة الله،
حضرتك ولي أمر الطالب/ـة: {name}
نحب نبلّغ حضرتك إن الطالب تغيّب عن {count} حصص متتالية:
{dates}
{grades}برجاء المتابعة معانا.
{teacher}`;
const DEFAULT_PAY_MSG = `السلام عليكم ورحمة الله،
حضرتك ولي أمر الطالب/ـة: {name}
نفكّر حضرتك بمصروفات: {months}
المتبقي: {amount} جنيه.
{teacher}`;
const DEFAULT_SETTINGS = {
  teacherName: 'Eng. Osama Waled',
  absentThreshold: 2,
  includeGrades: true,
  msgTemplate: DEFAULT_MSG,
  payMsgTemplate: DEFAULT_PAY_MSG,
  autoBackup: false,
  lastBackupAt: 0,
  receiptSeq: 0
};
let SETTINGS = {...DEFAULT_SETTINGS};
const MONTHS = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
const DOW = ["سبت","أحد","اثنين","ثلاثاء","أربعاء","خميس","جمعة"];
const ALL_DAYS = ["السبت","الأحد","الاثنين","الثلاثاء","الأربعاء","الخميس","الجمعة"];

// يطبّع سجل حصة قديم أو ناقص الحقول بحيث يعمل بأمان مع الكود الجديد بدون فقد بيانات
function normalizeSessionRecord(rec){
  if(!rec || !Array.isArray(rec.groupIds)) return null;
  return {
    id: rec.id || uid('session'),
    groupIds: rec.groupIds,
    days: Array.isArray(rec.days) ? rec.days.slice() : (rec.date ? [rec.date] : []),
    resolvedGroupIds: Array.isArray(rec.resolvedGroupIds) ? rec.resolvedGroupIds.slice() : [],
    date: rec.date || null,
    continuation: typeof rec.continuation === 'boolean' ? rec.continuation : true,
    status: rec.status === 'completed' ? 'completed' : 'pending',
    createdAt: rec.createdAt || rec.openedAt || new Date().toISOString(),
    updatedAt: rec.updatedAt || new Date().toISOString()
  };
}
/* ============ Storage v2 ============
   - كل طالب في مستند لوحده: users/{uid}/students/{id}  (مفيش حد 1 ميجا للداتا كلها)
   - الحفظ بيكتب الطلاب اللي اتغيّروا بس (مقارنة بآخر نسخة محفوظة)
   - مزامنة لحظية بين الأجهزة على مستوى الطالب
   - لو القواعد (Rules) مش محدّثة: بيكمل بالطريقة القديمة ومبيضيّعش حاجة */
let STORAGE_MODE = 'v2';           // 'v2' | 'legacy'
let LOAD_OK = false;               // مفيش حفظ قبل ما التحميل ينجح (يمنع مسح الداتا بالغلط)
const SAVED = { students:new Map(), meta:{} };
let ARCHIVE = [];                  // الطلاب المؤرشفين (محفوظين كاملين، بس مش ظاهرين في باقي البرنامج)
function partitionArchive(){ ARCHIVE = DATA.filter(s=>s.archived); DATA = DATA.filter(s=>!s.archived); }
const META_KEYS = ['groups','activeSession','sessions','settings'];
const canon = o => JSON.stringify(o, (k,v)=> (v && typeof v==='object' && !Array.isArray(v)) ? Object.keys(v).sort().reduce((a,x)=>{ a[x]=v[x]; return a; },{}) : v);
const userRef = ()=> db.collection('users').doc(currentUID);
const studentsCol = ()=> userRef().collection('students');
const withTimeout = (p,ms)=> Promise.race([p, new Promise(r=>setTimeout(r,ms))]);
function metaPayload(){ return { groups:GROUPS, activeSession:ACTIVE_SESSION, sessions:SESSIONS, settings:SETTINGS }; }

let PENDING = 0, SAVE_RETRIES = 0;
function setSync(){
  const el = document.getElementById('syncBadge'); if(!el) return;
  let txt, cls, title;
  if(!navigator.onLine){ txt='🟠 أوفلاين'; cls='warn'; title='مفيش نت — التعديلات محفوظة على الجهاز وهتتزامن لوحدها لما النت يرجع'; }
  else if(PENDING>0){ txt='🔄 بيتزامن...'; cls='warn'; title='جاري رفع التعديلات'; }
  else { txt='🟢 متزامن'; cls='paid'; title='كل التعديلات اتحفظت'; }
  el.style.display=''; el.className='pill '+cls; el.textContent=txt; el.title=title;
}
window.addEventListener('online', ()=>{ setSync(); if(LOAD_OK) saveData(); });
window.addEventListener('offline', setSync);

async function loadData(){
  LOAD_OK = false; stopRealtimeSync();
  try{
    const ref = userRef();
    const snap = await ref.get();
    const d = snap.exists ? snap.data() : {};
    GROUPS = Array.isArray(d.groups) ? d.groups : [];
    SETTINGS = Object.assign({...DEFAULT_SETTINGS}, d.settings || {});
    SESSIONS = Array.isArray(d.sessions) ? d.sessions.map(normalizeSessionRecord).filter(Boolean) : [];
    const baseMeta = { groups:d.groups||[], activeSession:d.activeSession||null, sessions:d.sessions||[], settings:d.settings||{} };

    if(Number(d.schemaVersion) >= 2){
      const qs = await studentsCol().get();
      DATA = qs.docs.map(x=>{ const o = x.data(); if(!o.id) o.id = x.id; return o; });
      STORAGE_MODE = 'v2';
    }else{
      DATA = Array.isArray(d.students) ? d.students : [];
      await migrateToV2(ref, d);
    }
    partitionArchive();

    const raw = d.activeSession;
    let staleSingleDay = null;
    if(raw && Array.isArray(raw.groupIds) && raw.groupIds.length){
      if(raw.date !== todayKey() && raw.continuation === false){
        // حصة يوم واحد (بدون استكمال) فضلت مفتوحة لتاني يوم: تتقفل تلقائيًا بعد التحميل، بتاريخ يومها هي
        staleSingleDay = normalizeSessionRecord(raw);
        ACTIVE_SESSION = null;
      }else if(raw.date === todayKey()){
        // حصة مفتوحة من نفس اليوم: تكمل عادي زي ما هي (بيانات الحضور المسجلة فيها محفوظة كما هي)
        ACTIVE_SESSION = normalizeSessionRecord(raw);
        ACTIVE_SESSION.date = todayKey();
      }else{
        // حصة اتفتحت يوم سابق ومتقفلتش — لا نحذفها ولا نصفّرها أبدًا، ننقلها لقائمة "الحصص القابلة للاستكمال"
        const rec = normalizeSessionRecord(raw);
        if(rec && !SESSIONS.some(x=>x.id===rec.id)) SESSIONS.push(rec);
        ACTIVE_SESSION = null;
      }
    }else{
      ACTIVE_SESSION = null;
    }

    SAVED.students = new Map(DATA.concat(ARCHIVE).map(s=>[s.id, canon(s)]));
    SAVED.meta = {}; META_KEYS.forEach(k=> SAVED.meta[k] = canon(baseMeta[k]));
    LOAD_OK = true;
    if(staleSingleDay){
      const r = singleDayAbsences(staleSingleDay);
      // لو محدش اتسجل حاضر خالص، غالبًا الحصة اتفتحت بالغلط: نقفلها من غير ما نسجل غياب لحد
      if(r.anyPresent){ applySingleDayAbsences(r); showToast(`حصة ${prettyDate(r.date)} اتقفلت تلقائيًا — اتسجّل غياب ${r.notPresent.length} طالب بتاريخها`); }
      else showToast(`حصة ${prettyDate(r.date)} اتقفلت تلقائيًا بدون تسجيل غياب (محدش حضر فيها)`);
      saveData();
    }
  }catch(e){
    console.error(e);
    DATA = []; ARCHIVE = []; GROUPS = []; SESSIONS = []; LOAD_OK = false;
    showToast('تعذّر تحميل البيانات — اتأكد من النت واعمل تحديث للصفحة');
    return;
  }
  setSync();
  updateArchiveTab();
  startRealtimeSync();
  maybeAutoBackup();
}

// ترقية الحساب من الشكل القديم (كل الطلاب في مستند واحد) للشكل الجديد — آمنة: بتنسخ الأول وتتأكد وبعدين بتمسح القديم
async function migrateToV2(ref, d){
  if(!navigator.onLine){ STORAGE_MODE = 'legacy'; return; }   // الترقية بتتم أول مرة تفتح فيها والنت شغال
  try{
    if(!DATA.length){
      await ref.set({ schemaVersion:2 }, { merge:true });
      STORAGE_MODE = 'v2'; return;
    }
    showToast('جاري ترقية طريقة تخزين البيانات... متقفلش الصفحة');
    try{ downloadBackup('قبل-الترقية', true); }catch(e){}
    DATA.forEach(s=>{ if(!s.id) s.id = uid('s'); });
    const ids = new Set(DATA.map(s=>s.id));
    // نظّف أي بقايا قديمة من محاولة ترقية سابقة (طلاب اتحذفوا بعدها)
    const existing = await studentsCol().get();
    const stale = existing.docs.filter(x=>!ids.has(x.id));
    for(let i=0;i<stale.length;i+=400){
      const b = db.batch(); stale.slice(i,i+400).forEach(x=>b.delete(x.ref)); await b.commit();
    }
    for(let i=0;i<DATA.length;i+=400){
      const b = db.batch();
      DATA.slice(i,i+400).forEach(s=> b.set(studentsCol().doc(s.id), JSON.parse(JSON.stringify(s))));
      await b.commit();
    }
    const chk = await studentsCol().get({ source:'server' });
    if(chk.size < DATA.length) throw new Error('verify-failed');
    await ref.set({ schemaVersion:2, students: firebase.firestore.FieldValue.delete() }, { merge:true });
    STORAGE_MODE = 'v2';
    showToast('تمت ترقية التخزين ✔');
  }catch(e){
    console.error('migration failed', e);
    STORAGE_MODE = 'legacy';
    showToast('تعذّرت الترقية — هيكمل بالطريقة القديمة. حدّث قواعد Firestore (ملف firestore.rules)');
  }
}

async function saveData(){
  if(!currentUID) return;
  if(!LOAD_OK){ showToast('البيانات لسه ما اتحمّلتش — اعمل تحديث للصفحة قبل التعديل'); return; }
  if(saveInProgress){ saveQueued = true; return; }
  saveInProgress = true;
  try{
    if(STORAGE_MODE === 'legacy') await saveLegacy(); else await saveV2();
  }catch(e){
    console.error(e);
    showToast('حدث خطأ أثناء الحفظ — تأكد من الاتصال بالإنترنت');
  }finally{
    saveInProgress = false;
    if(saveQueued){ saveQueued = false; setTimeout(()=>saveData(), 0); }
  }
}
let saveInProgress = false;
let saveQueued = false;

async function saveLegacy(){
  const clean = o => JSON.parse(JSON.stringify(o===undefined?null:o));
  const p = userRef().set({ students:clean(DATA.concat(ARCHIVE)), groups:clean(GROUPS), activeSession:clean(ACTIVE_SESSION), sessions:clean(SESSIONS), settings:clean(SETTINGS) }, { merge:true });
  if(navigator.onLine) await withTimeout(p, 4000);
}

async function saveV2(){
  const col = studentsCol(), ref = userRef();
  const sets = [], dels = [], seen = new Set();
  DATA.concat(ARCHIVE).forEach(s=>{
    if(!s.id) s.id = uid('s');
    seen.add(s.id);
    const js = canon(s);
    if(SAVED.students.get(s.id) !== js) sets.push([s.id, js]);
  });
  SAVED.students.forEach((_,id)=>{ if(!seen.has(id)) dels.push(id); });
  const mp = metaPayload(), metaChanged = {};
  META_KEYS.forEach(k=>{
    const v = mp[k]===undefined ? null : mp[k];
    const js = canon(v);
    if(SAVED.meta[k] !== js) metaChanged[k] = { v:JSON.parse(JSON.stringify(v)), js };
  });
  const mKeys = Object.keys(metaChanged);
  if(!sets.length && !dels.length && !mKeys.length) return;

  const ops = sets.map(([id,js])=>({ t:'set', id, data:JSON.parse(js) })).concat(dels.map(id=>({ t:'del', id })));
  const promises = [];
  for(let i=0;i<ops.length;i+=400){
    const b = db.batch();
    ops.slice(i,i+400).forEach(o=> o.t==='set' ? b.set(col.doc(o.id), o.data) : b.delete(col.doc(o.id)));
    promises.push(b.commit());
  }
  if(mKeys.length){
    const payload = {}; mKeys.forEach(k=> payload[k] = metaChanged[k].v);
    promises.push(ref.set(payload, { merge:true }));
  }
  // نسجّل الحالة الجديدة فورًا (التخزين المحلي بيضمن إن الكتابة هتوصل) — ولو فشلت بنرجّعها للإعادة
  sets.forEach(([id,js])=> SAVED.students.set(id, js));
  dels.forEach(id=> SAVED.students.delete(id));
  mKeys.forEach(k=> SAVED.meta[k] = metaChanged[k].js);
  PENDING++; setSync();
  const all = Promise.all(promises).then(()=>{ PENDING--; SAVE_RETRIES = 0; setSync(); }).catch(err=>{
    PENDING--; console.error('save failed', err);
    sets.forEach(([id])=> SAVED.students.delete(id));
    dels.forEach(id=> SAVED.students.set(id, '__retry_delete__'));
    mKeys.forEach(k=> delete SAVED.meta[k]);
    setSync();
    if(SAVE_RETRIES++ < 5){
      showToast('⚠ تعذّر رفع بعض التعديلات — هنحاول تاني تلقائيًا');
      setTimeout(()=>saveData(), 15000);
    }else{
      showToast('⚠ التعديلات متحفظتش على السيرفر — راجع قواعد Firestore والاتصال');
    }
  });
  if(navigator.onLine) await withTimeout(all, 2500);
}

/* ---- مزامنة لحظية بين الأجهزة (على مستوى الطالب) ---- */
let unsubStudents = null, refreshTimer = null;
function stopRealtimeSync(){ if(unsubStudents){ try{ unsubStudents(); }catch(e){} unsubStudents = null; } }
function locateStudent(id){
  let i = DATA.findIndex(s=>s.id===id);
  if(i>=0) return { arr:DATA, i, archived:false };
  i = ARCHIVE.findIndex(s=>s.id===id);
  if(i>=0) return { arr:ARCHIVE, i, archived:true };
  return null;
}
function startRealtimeSync(){
  stopRealtimeSync();
  if(STORAGE_MODE !== 'v2' || !currentUID) return;
  unsubStudents = studentsCol().onSnapshot(snap=>{
    let changed = false;
    snap.docChanges().forEach(ch=>{
      if(ch.doc.metadata.hasPendingWrites) return;      // ده تعديل من الجهاز ده نفسه
      const id = ch.doc.id, loc = locateStudent(id);
      const local = loc ? loc.arr[loc.i] : null;
      const clean = local ? canon(local)===SAVED.students.get(id) : true;   // false = عليه تعديل لسه ما اترفعش
      if(ch.type === 'removed'){
        if(local && clean){ loc.arr.splice(loc.i,1); SAVED.students.delete(id); changed = true; }
        return;
      }
      const data = ch.doc.data(); if(!data.id) data.id = id;
      const js = canon(data), wantArchive = !!data.archived;
      if(!local){ (wantArchive?ARCHIVE:DATA).push(data); SAVED.students.set(id, js); changed = true; }
      else if(clean && js !== SAVED.students.get(id)){
        Object.keys(local).forEach(k=> delete local[k]);
        Object.assign(local, data);
        if(wantArchive !== loc.archived){ loc.arr.splice(loc.i,1); (wantArchive?ARCHIVE:DATA).push(local); }
        SAVED.students.set(id, canon(local)); changed = true;
      }
    });
    if(changed){ updateArchiveTab(); clearTimeout(refreshTimer); refreshTimer = setTimeout(softRefresh, 400); }
  }, err=> console.warn('realtime sync error', err && err.code));
}
function softRefresh(){
  if(document.querySelector('.overlay')){ refreshTimer = setTimeout(softRefresh, 3000); return; }   // مفيش تحديث والنافذة مفتوحة
  const vis = id => { const el = document.getElementById(id); return el && el.style.display !== 'none'; };
  try{
    if(vis('groupsView')) renderDashboardStats();
    else if(vis('groupView') && IN_SESSION_UI){ renderSessionCounter(); renderSessionPresentList(); renderSessionPendingList(); }
    else if(vis('groupView')){ renderGroupStudentList(); renderGroupStats(); renderGroupPayments(); }
    else if(vis('incomeView')) renderIncomeData();
    else if(vis('arrearsView')) renderArrears();
    else if(vis('archiveView')) renderArchive();
    else if(vis('profileView') && currentProfileId && DATA.some(s=>s.id===currentProfileId)) renderProfile(currentProfileId);
    showToast('🔄 اتحدّثت بيانات من جهاز تاني');
  }catch(e){ console.warn(e); }
}

/* ---- النسخ الاحتياطي ---- */
function backupPayload(){
  return { version:2, exportedAt:new Date().toISOString(), students:DATA.concat(ARCHIVE), groups:GROUPS, activeSession:ACTIVE_SESSION, sessions:SESSIONS, settings:SETTINGS };
}
function downloadBackup(label, silent){
  const blob = new Blob([JSON.stringify(backupPayload(),null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'dorosi-backup-'+todayKey()+(label?('-'+label):'')+'.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
  SETTINGS.lastBackupAt = Date.now();
  if(!silent && LOAD_OK) saveData();
}
function maybeAutoBackup(){
  try{
    if(!SETTINGS.autoBackup || !DATA.length) return;
    if(Date.now() - (Number(SETTINGS.lastBackupAt)||0) > 7*864e5){
      setTimeout(()=>{ downloadBackup('auto'); showToast('اتنزّلت نسخة احتياطية تلقائية ✔'); }, 4000);
    }
  }catch(e){}
}
function renderBackupBanner(){
  const box = document.getElementById('dashboardStats'); if(!box) return;
  let b = document.getElementById('backupBanner');
  if(!b){ b = document.createElement('div'); b.id = 'backupBanner'; box.parentNode.insertBefore(b, box); }
  const last = Number(SETTINGS.lastBackupAt)||0;
  const days = last ? Math.floor((Date.now()-last)/864e5) : null;
  if(!DATA.length || (days!==null && days<7)){ b.innerHTML = ''; return; }
  b.innerHTML = `<div class="card" style="border-color:var(--gold); display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:14px;">
    <span style="font-size:13px;">⚠ ${days===null ? 'لسه معملتش نسخة احتياطية من بياناتك' : `عدّى ${days} يوم على آخر نسخة احتياطية`}</span>
    <button class="btn gold small" id="bannerBackupBtn">⬇ نزّل نسخة دلوقتي</button></div>`;
  document.getElementById('bannerBackupBtn').onclick = ()=>{ downloadBackup(); renderBackupBanner(); showToast('تم تنزيل النسخة الاحتياطية ✔'); };
}

// أزرار السنين بتتولّد حسب السنة الحالية (مفيش سنين ثابتة)
function yearButtonsHtml(sel){
  const cy = new Date().getFullYear();
  return [...new Set([cy-1, cy, cy+1, sel])].sort().map(y=>`<button data-y="${y}">${y}</button>`).join('');
}
function uid(prefix){ return (prefix||'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function todayKey(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function ymKey(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function escapeHtml(s){ return (s||'').toString().replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(showToast._h);
  showToast._h = setTimeout(()=>t.classList.remove('show'), 1800);
}
function getGroup(id){ return GROUPS.find(g=>g.id===id); }
function groupLabel(g){
  if(!g) return '';
  const days = (g.days&&g.days.length) ? g.days.join('-') : '';
  return [days, g.time].filter(Boolean).join(' — ');
}

function arabicDayForDate(dateKey){
  const d = new Date(dateKey+'T12:00:00');
  const map = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  return map[d.getDay()];
}
function isGroupScheduledOnDate(group, dateKey){
  if(!group || !Array.isArray(group.days) || !group.days.length) return true;
  return group.days.includes(arabicDayForDate(dateKey));
}

// هل الحصة محتاجة استكمال؟ لا لو كل المجموعات المختارة يومها هو يوم فتح الحصة، نعم لو فيه مجموعة يومها في يوم تاني
function sessionModeInfo(groupIds, dateKey){
  const later = groupIds.map(getGroup).filter(g=>g && !isGroupScheduledOnDate(g, dateKey));
  return { continuation: later.length > 0, later };
}
// حصة اليوم الواحد (بدون استكمال): الطلاب اللي مسجلوش حضور يتسجل لهم غياب بتاريخ يوم الحصة نفسه
function singleDayAbsences(rec){
  const date = rec.date || todayKey();
  const dates = Array.from(new Set([...(rec.days||[]), date]));
  const members = DATA.filter(s=>rec.groupIds.includes(s.groupId));
  const isPresent = s => dates.some(d=>(s.attendance||{})[d]==='present');
  return { date, members, anyPresent: members.some(isPresent), notPresent: members.filter(s=>!isPresent(s)) };
}
function applySingleDayAbsences(r){
  r.notPresent.forEach(s=>{ s.attendance = s.attendance || {}; if(!s.attendance[r.date]) s.attendance[r.date] = 'absent'; });
}

/* ============ Navigation ============ */
let currentGroupId = null;
let currentProfileId = null;

function showView(name){
  IN_SESSION_UI = false; // أي انتقال صريح لشاشة جديدة يلغي وضع "شاشة الحصة" افتراضيًا؛ renderSessionView بيفعّله تاني بعد النداء
  document.getElementById('groupsView').style.display = name==='groups' ? '' : 'none';
  document.getElementById('groupView').style.display = name==='group' ? '' : 'none';
  document.getElementById('monthsView').style.display = name==='months' ? '' : 'none';
  document.getElementById('incomeView').style.display = name==='income' ? '' : 'none';
  document.getElementById('arrearsView').style.display = name==='arrears' ? '' : 'none';
  const _av = document.getElementById('archiveView'); if(_av) _av.style.display = name==='archive' ? '' : 'none';
  document.getElementById('dropoutsView').style.display = name==='dropouts' ? '' : 'none';
  document.getElementById('notifyView').style.display = name==='notify' ? '' : 'none';
  document.getElementById('reportsView').style.display = name==='reports' ? '' : 'none';
  document.getElementById('profileView').style.display = name==='profile' ? '' : 'none';
}

/* ============ Back navigation (نفس فكرة الـ SPA history stack) ============
   بدل ما كل زرار "رجوع" يفترض وجهة ثابتة، بنسجّل قبل كل انتقال للأمام "لقطة" لحالة
   الشاشة الحالية (closure) في NAV_STACK. زرار الرجوع بيسحب آخر لقطة وينفذها. */
let NAV_STACK = [];
function pushCurrentView(){
  const vis = id => document.getElementById(id).style.display !== 'none';
  let restore;
  if(vis('profileView')){
    const pid = currentProfileId;
    restore = ()=>{ showView('profile'); renderProfile(pid); };
  }else if(vis('groupView') && IN_SESSION_UI){
    restore = ()=> renderSessionView();
  }else if(vis('groupView')){
    const gid = currentGroupId;
    restore = ()=>{ currentGroupId = gid; showView('group'); renderGroupView(); };
  }else if(vis('monthsView')){
    const mg = monthsGroupId;
    restore = ()=>{ monthsGroupId = mg; showView('months'); renderMonths(); };
  }else if(vis('incomeView')){
    restore = ()=>{ showView('income'); renderIncome(); };
  }else if(vis('arrearsView')){
    restore = ()=>{ showView('arrears'); renderArrears(); };
  }else if(document.getElementById('archiveView') && vis('archiveView')){
    restore = ()=>{ showView('archive'); renderArchive(); };
  }else if(vis('dropoutsView')){
    restore = ()=>{ showView('dropouts'); renderDropouts(); };
  }else if(vis('notifyView')){
    restore = ()=>{ showView('notify'); renderNotify(); };
  }else if(vis('reportsView')){
    restore = ()=>{ showView('reports'); renderReports(); };
  }else{
    restore = ()=>{ showView('groups'); renderGroupsList(); };
  }
  NAV_STACK.push(restore);
}
function goBack(){
  const fn = NAV_STACK.pop();
  if(fn) fn();
  else { showView('groups'); renderGroupsList(); }
}

document.getElementById('tabs').addEventListener('click', (e)=>{
  const btn = e.target.closest('button'); if(!btn) return;
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  currentGroupId = null;
  NAV_STACK = []; // التنقل بين التابات الرئيسية بداية مسار جديد، مش خطوة تفصيلية جوه نفس المسار
  if(btn.dataset.tab==='groups'){ showView('groups'); renderGroupsList(); }
  if(btn.dataset.tab==='months'){ monthsGroupId = undefined; showView('months'); renderMonths(); }
  if(btn.dataset.tab==='income'){ showView('income'); renderIncome(); }
  if(btn.dataset.tab==='arrears'){ showView('arrears'); renderArrears(); }
  if(btn.dataset.tab==='archive'){ showView('archive'); renderArchive(); }
  if(btn.dataset.tab==='dropouts'){ showView('dropouts'); renderDropouts(); }
  if(btn.dataset.tab==='notify'){ showView('notify'); renderNotify(); }
  if(btn.dataset.tab==='reports'){ showView('reports'); renderReports(); }
});

/* ============ Dashboard summary (real data, additive — does not replace any existing logic) ============ */
function renderDashboardStats(){
  const box = document.getElementById('dashboardStats');
  if(!box) return;
  renderBackupBanner();
  const ym = ymKey();
  const totalStudents = DATA.length;
  let monthlyIncome = 0;
  DATA.forEach(s=>{
    monthlyIncome += payInfo(s, ym).received;
  });
  let present = 0, absent = 0;
  DATA.forEach(s=>{
    const att = s.attendance || {};
    Object.keys(att).forEach(k=>{
      if(!k.startsWith(ym)) return;
      if(att[k]==='present') present++;
      else if(att[k]==='absent') absent++;
    });
  });
  const attTotal = present + absent;
  const attRate = attTotal ? Math.round((present/attTotal)*100) : 0;
  let discontinued = 0;
  try{ discontinued = computeDropouts().length; }catch(e){ discontinued = 0; }

  box.innerHTML = `
    <div class="dash-card">
      <div class="dash-icon students">👨‍🎓</div>
      <div class="dash-info"><div class="dash-num">${totalStudents.toLocaleString('ar-EG')}</div><div class="dash-lbl">إجمالي الطلاب</div></div>
    </div>
    <div class="dash-card">
      <div class="dash-icon income">💰</div>
      <div class="dash-info"><div class="dash-num">${monthlyIncome.toLocaleString('ar-EG')} ج.م</div><div class="dash-lbl">دخل هذا الشهر</div></div>
    </div>
    <div class="dash-card">
      <div class="dash-icon attendance">📅</div>
      <div class="dash-info"><div class="dash-num">${attRate}%</div><div class="dash-lbl">نسبة الحضور الشهرية</div></div>
    </div>
    <div class="dash-card">
      <div class="dash-icon dropouts">🚫</div>
      <div class="dash-info"><div class="dash-num">${discontinued.toLocaleString('ar-EG')}</div><div class="dash-lbl">طلاب منقطعين</div></div>
    </div>
  `;
}

/* ============ Groups list ============ */
function sessionLabel(rec){
  const names = rec.groupIds.map(id=>getGroup(id)?.name).filter(Boolean).map(escapeHtml).join(' + ');
  const days = (rec.days||[]).slice().sort();
  const firstDay = days[0] ? prettyDate(days[0]) : '';
  return { names, firstDay, daysCount: days.length };
}
function renderGroupsList(){
  renderDashboardStats();
  const grid = document.getElementById('groupGrid');
  const pendingCount = SESSIONS.filter(x=>x.status==='pending').length;
  const startHtml = ACTIVE_SESSION ? `
    <div class="card scan-result-card" style="margin-bottom:16px;">
      <div class="sr-head">
        <div>
          <b>🟢 الحصة الحالية مفتوحة</b>
          <div style="font-size:12px;color:var(--ink-soft);margin-top:5px;">المجموعات: ${ACTIVE_SESSION.groupIds.map(id=>getGroup(id)?.name).filter(Boolean).map(escapeHtml).join(' + ')}</div>
        </div>
        <button class="btn gold" id="continueSessionBtn">استكمال الحصة</button>
      </div>
    </div>` : `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
      <div><h3 style="margin:0 0 4px;">🎯 الحصص</h3><div style="font-size:12px;color:var(--ink-soft);">${pendingCount ? `فيه ${pendingCount} حصة سابقة لسه محتاجة تُستكمل` : 'اختار مجموعة أو أكثر للحصة الحالية؛ أي طالب من المجموعات المختارة يقدر يحضر.'}</div></div>
      <button class="btn gold" id="startSessionBtn">▶ بدء حصة</button>
    </div>`;
  document.getElementById('sessionLauncher').innerHTML = startHtml;
  if(ACTIVE_SESSION) document.getElementById('continueSessionBtn').onclick=()=>{ pushCurrentView(); renderSessionView(); };
  else document.getElementById('startSessionBtn').onclick=()=>openStartSessionModal();
  let html = GROUPS.map(g=>{
    const members = DATA.filter(s=>s.groupId===g.id);
    const ym = ymKey();
    const paid = members.filter(s=>s.payments && s.payments[ym] && s.payments[ym].paid).length;
    const pct = members.length ? Math.round((paid/members.length)*100) : 0;
    return `
    <div class="group-card" data-id="${g.id}">
      <div class="gcard-top">
        <div class="gcard-icon">📚</div>
        <div>
          <div class="gname">${escapeHtml(g.name)}</div>
          <div class="gsched">${escapeHtml(groupLabel(g)) || 'بدون معاد محدد'}</div>
        </div>
      </div>
      <div class="gstats">
        <span>👥 ${members.length} طالب</span>
        <span>💰 ${paid}/${members.length} دفعوا</span>
      </div>
      <div class="gbar"><div class="gbar-fill" style="width:${pct}%"></div></div>
      <button type="button" class="btn outline small gcard-open">فتح المجموعة ←</button>
    </div>`;
  }).join('');
  const unassigned = DATA.filter(s=>!s.groupId || !getGroup(s.groupId));
  if(unassigned.length){
    html += `
    <div class="group-card" data-id="__none__">
      <div class="gcard-top">
        <div class="gcard-icon">👥</div>
        <div>
          <div class="gname">غير مصنّفين</div>
          <div class="gsched">طلاب من غير مجموعة</div>
        </div>
      </div>
      <div class="gstats"><span>👥 ${unassigned.length} طالب</span></div>
      <button type="button" class="btn outline small gcard-open">فتح ←</button>
    </div>`;
  }
  html += `<div class="add-group-card" id="addGroupCard">+ مجموعة جديدة</div>`;
  grid.innerHTML = html;
  grid.querySelectorAll('.group-card').forEach(c=>{
    c.onclick = ()=> openGroup(c.dataset.id==='__none__' ? null : c.dataset.id);
  });
  document.getElementById('addGroupCard').onclick = ()=> openGroupModal(null);
}

function openGroupModal(existing){
  const ov = document.createElement('div');
  ov.className='overlay';
  const selectedDays = existing ? (existing.days||[]) : [];
  ov.innerHTML = `
    <div class="modal">
      <h3>${existing?'تعديل المجموعة':'مجموعة جديدة'}</h3>
      <div class="field"><label>اسم المجموعة</label><input id="g_name" value="${existing?escapeHtml(existing.name):''}" placeholder="مثلاً: مجموعة الصف الأول الثانوي"></div>
      <div class="field"><label>أيام الحصة</label>
        <div class="day-chips" id="dayChips">
          ${ALL_DAYS.map(d=>`<span class="day-chip ${selectedDays.includes(d)?'active':''}" data-day="${d}">${d}</span>`).join('')}
        </div>
      </div>
      <div class="field"><label>الميعاد</label><input id="g_time" value="${existing?escapeHtml(existing.time||''):''}" placeholder="مثلاً: 6:00 مساءً"></div>
      <div class="modal-actions">
        ${existing?'<button class="btn danger" id="delGroupBtn">حذف المجموعة</button>':''}
        <button class="btn outline" id="cancelBtn">إلغاء</button>
        <button class="btn gold" id="saveGroupBtn">حفظ</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.remove(); });
  ov.querySelector('#cancelBtn').onclick = ()=> ov.remove();
  ov.querySelectorAll('.day-chip').forEach(chip=>{
    chip.onclick = ()=> chip.classList.toggle('active');
  });
  if(existing){
    ov.querySelector('#delGroupBtn').onclick = async ()=>{
      const members = DATA.filter(s=>s.groupId===existing.id).length;
      const msg = members ? `هيتم حذف المجموعة و${members} طالب فيها هيبقوا "غير مصنّفين" (بياناتهم مش هتتمسح). متأكد؟` : 'متأكد من حذف المجموعة؟';
      if(confirm(msg)){
        GROUPS = GROUPS.filter(g=>g.id!==existing.id);
        await saveData();
        ov.remove();
        showView('groups'); renderGroupsList();
        showToast('تم حذف المجموعة');
      }
    };
  }
  ov.querySelector('#saveGroupBtn').onclick = async ()=>{
    const name = document.getElementById('g_name').value.trim();
    if(!name){ showToast('اكتب اسم المجموعة'); return; }
    const days = Array.from(ov.querySelectorAll('.day-chip.active')).map(c=>c.dataset.day);
    const time = document.getElementById('g_time').value.trim();
    if(existing){
      Object.assign(existing, {name, days, time});
    }else{
      GROUPS.push({ id: uid('g'), name, days, time, createdAt: new Date().toISOString() });
    }
    await saveData();
    ov.remove();
    showToast('تم الحفظ');
    showView('groups'); renderGroupsList();
  };
}

/* ============ Group view (scan + members) ============ */
let selectedIds = new Set();
let sessionScanOrder = []; // ids of students, most-recently-scanned first (session view only)
function getVisibleGroupMembers(){
  // ملحوظة مهمة: الدالة دي بتُستخدم في صفحة "مجموعة" العادية فقط، وازاي بتتصرف
  // ما ينفعش يعتمد على وجود حصة مفتوحة في الخلفية — لازم تعرض كل طلاب المجموعة الحالية
  // حتى لو فيه حصة شغالة لمجموعات تانية (شاشة الحصة نفسها ليها عرض منفصل تمامًا).
  const q = (document.getElementById('groupSearchInput')?.value || '').trim().toLowerCase();
  let members = DATA.filter(s=> currentGroupId ? s.groupId===currentGroupId : (!s.groupId || !getGroup(s.groupId)));
  members = members.filter(s => !q || s.name.toLowerCase().includes(q) || (s.phone||'').includes(q) || (s.barcode||'').toLowerCase().includes(q) || (s.parentPhone||'').includes(q));
  members.sort((a,b)=> a.name.localeCompare(b.name,'ar'));
  return members;
}
// شاشة "بدء حصة": تختار الأول بين حصة جديدة أو استكمال حصة سابقة لسه Pending
function openStartSessionModal(){
  const pending = SESSIONS.filter(x=>x.status==='pending');
  if(!pending.length){ openNewSessionModal(); return; }
  const ov=document.createElement('div'); ov.className='overlay';
  ov.innerHTML=`<div class="modal"><h3>▶ بدء حصة</h3>
    <p style="font-size:13px;color:var(--ink-soft);">فيه حصص سابقة لسه محتاجة تُستكمل — تحب تعمل إيه؟</p>
    <div class="modal-actions" style="flex-direction:column;align-items:stretch;gap:10px;">
      <button class="btn gold" id="pickContinue">↻ استكمال حصة سابقة (${pending.length})</button>
      <button class="btn outline" id="pickNew">▶ بدء حصة جديدة</button>
      <button class="btn outline" id="cancelSession">إلغاء</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click',e=>{if(e.target===ov)ov.remove();});
  ov.querySelector('#cancelSession').onclick=()=>ov.remove();
  ov.querySelector('#pickNew').onclick=()=>{ ov.remove(); openNewSessionModal(); };
  ov.querySelector('#pickContinue').onclick=()=>{ ov.remove(); openContinueSessionModal(pending); };
}

function openNewSessionModal(){
  if(!GROUPS.length){ showToast('اعمل مجموعة واحدة على الأقل أولاً'); return; }
  const ov=document.createElement('div'); ov.className='overlay';
  ov.innerHTML=`<div class="modal"><h3>▶ بدء حصة جديدة</h3>
    <p style="font-size:13px;color:var(--ink-soft);">اختار كل المجموعات اللي هتحضر في نفس الحصة.</p>
    <div class="field"><label>المجموعات</label><div id="sessionGroups" style="display:flex;flex-direction:column;gap:8px;">
      ${GROUPS.map(g=>`<label style="display:flex;align-items:center;gap:8px;background:#1f2330;border:1px solid var(--rule);padding:10px;border-radius:8px;cursor:pointer;"><input type="checkbox" value="${g.id}"> <b>${escapeHtml(g.name)}</b><span style="margin-right:auto;color:var(--ink-soft);font-size:11px;">${escapeHtml(groupLabel(g))}</span></label>`).join('')}
    </div></div>
    <p id="sessionModeHint" style="font-size:12px;color:var(--ink-soft);margin:6px 0 0;min-height:18px;"></p>
    <div class="modal-actions"><button class="btn outline" id="cancelSession">إلغاء</button><button class="btn gold" id="confirmSession">بدء الحصة</button></div>
  </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#cancelSession').onclick=()=>ov.remove();
  ov.addEventListener('click',e=>{if(e.target===ov)ov.remove();});
  const hint = ov.querySelector('#sessionModeHint');
  const updHint = ()=>{
    const ids=[...ov.querySelectorAll('input:checked')].map(x=>x.value);
    if(!ids.length){ hint.textContent=''; return; }
    const m = sessionModeInfo(ids, todayKey());
    hint.innerHTML = m.continuation
      ? `🔁 <b>${m.later.map(g=>escapeHtml(g.name)).join(' + ')}</b> يومها مش النهارده — الحصة هتبقى قابلة للاستكمال لحد ما ييجي يومها.`
      : `✅ كل المجموعات يومها النهارده — الحصة هتخلص نهائيًا أول ما تقفلها (بدون استكمال)، ولو نسيت تقفلها هتتقفل لوحدها تاني يوم.`;
  };
  ov.querySelectorAll('input[type=checkbox]').forEach(c=>c.onchange=updHint);
  ov.querySelector('#confirmSession').onclick=async()=>{
    const groupIds=[...ov.querySelectorAll('input:checked')].map(x=>x.value);
    if(!groupIds.length){showToast('اختار مجموعة واحدة على الأقل');return;}
    const mode = sessionModeInfo(groupIds, todayKey());
    ACTIVE_SESSION={id:uid('session'),date:todayKey(),groupIds,openedAt:new Date().toISOString(),days:[],resolvedGroupIds:[],continuation:mode.continuation};
    await saveData(); ov.remove(); pushCurrentView(); renderSessionView();
  };
}

// عرض الحصص اللي لسه Pending (ما اتقفلتش نهائي) عشان يختار المستخدم يكمّل واحدة فيها
function openContinueSessionModal(pending){
  const ov=document.createElement('div'); ov.className='overlay';
  ov.innerHTML=`<div class="modal"><h3>↻ استكمال حصة سابقة</h3>
    <p style="font-size:13px;color:var(--ink-soft);">دي الحصص اللي لسه فيها مجموعات لم يُحسم موقفها بعد.</p>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${pending.map(rec=>{
        const lbl = sessionLabel(rec);
        return `<button class="btn outline continuePick" data-id="${rec.id}" style="text-align:right;display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:12px;">
          <b>حصة ${lbl.firstDay}</b>
          <span style="font-size:12px;color:var(--ink-soft);">المجموعات: ${lbl.names}</span>
          <span style="font-size:11px;color:var(--gold);">قيد الاستكمال — اشتغلت فيها ${lbl.daysCount} يوم لحد دلوقتي</span>
        </button>`;
      }).join('')}
    </div>
    <div class="modal-actions"><button class="btn outline" id="cancelSession">إلغاء</button></div>
  </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click',e=>{if(e.target===ov)ov.remove();});
  ov.querySelector('#cancelSession').onclick=()=>ov.remove();
  ov.querySelectorAll('.continuePick').forEach(b=>{
    b.onclick = async ()=>{
      const rec = SESSIONS.find(x=>x.id===b.dataset.id);
      if(!rec) return;
      SESSIONS = SESSIONS.filter(x=>x.id!==rec.id);
      ACTIVE_SESSION = { id:rec.id, groupIds:rec.groupIds, date:todayKey(), openedAt:new Date().toISOString(), days:rec.days||[], resolvedGroupIds:rec.resolvedGroupIds||[] };
      await saveData();
      ov.remove();
      pushCurrentView();
      renderSessionView();
      showToast('تم استكمال الحصة — بيانات الحضور السابقة محفوظة');
    };
  });
}

function renderSessionView(){
  if(!ACTIVE_SESSION){showView('groups');renderGroupsList();return;}
  currentGroupId=null; showView('group'); IN_SESSION_UI=true;
  const names=ACTIVE_SESSION.groupIds.map(id=>getGroup(id)?.name).filter(Boolean);
  const today=todayKey();
  const members=DATA.filter(s=>ACTIVE_SESSION.groupIds.includes(s.groupId));
  const sessionDates = Array.from(new Set([...(ACTIVE_SESSION.days||[]), today]));
  // rebuild the scanned-in order from saved attendance، شامل كل الأيام اللي اتفتحت فيها الحصة دي (مش النهارده بس) — عشان الاستكمال يعرض حضور الأيام اللي فاتت
  sessionScanOrder = members.filter(s=> sessionDates.some(d=>(s.attendance||{})[d]==='present')).map(s=>s.id);
  const view=document.getElementById('groupView');
  view.innerHTML=`
    <button class="btn outline" id="backToGroups" style="margin-bottom:14px;">→ كل المجموعات</button>
    <div class="card group-header-card"><div><h2 style="margin:0 0 4px;">🎯 الحصة الحالية</h2><div style="color:var(--cyan);font-size:13px;">${names.map(escapeHtml).join(' + ')}</div></div><button class="btn danger" id="closeSessionBtn">🔒 إغلاق الحصة</button></div>
    <div class="card scan-box"><div class="icon">🪪</div><h3 style="margin:0 0 10px;">امسح كارت الطالب</h3><input type="text" id="scanInput" class="scan-input" placeholder="وجّه الماسح هنا..." autocomplete="off"><p class="scan-hint">أي طالب مسجّل في واحدة من المجموعات المختارة هيتسجل حاضر بدون ما ننقله من مجموعته. الغياب هيتسجل فقط للطالب في يوم الحصة الخاص بمجموعته، مش لمجرد إن مجموعة تانية عندها حصة النهارده.</p></div>
    <div class="card manual-box" style="margin-top:14px;">
      <div class="manual-head"><span style="font-size:20px;">✍️</span><h3>تحضير بالاسم (لو الطالب ناسي الكارت)</h3></div>
      <input type="text" id="manualAttInput" class="manual-input" placeholder="اكتب اسم الطالب أو رقم تليفونه..." autocomplete="off">
      <div class="manual-results" id="manualAttResults"></div>
      <p class="manual-hint">اكتب حرفين على الأقل، وبعدين اضغط "✔ حضور" جنب اسم الطالب.</p>
    </div>
    <div id="scanResult"></div>
    <div class="stats-row" id="sessionCounterRow" style="margin-top:16px;"></div>
    <div class="section-title"><span>✅ الطلاب اللي حضروا</span><div class="line"></div></div>
    <button class="btn outline small" id="addStudentBtn" style="margin-bottom:10px;">+ طالب جديد</button>
    <div class="student-list" id="sessionPresentList"></div>
    <div class="section-title" style="margin-top:18px;"><span>⏳ لسه محسمناش موقفهم</span><div class="line"></div></div>
    <p class="scan-hint">دول طلاب من مجموعات الحصة لسه معملهمش تسجيل حضور؛ مش هيتسجلوا "غايب" نهائيًا إلا لما يوم مجموعتهم الأصلية ييجي وتُقفل الحصة.</p>
    <div class="student-list" id="sessionPendingList"></div>`;
  document.getElementById('backToGroups').onclick=goBack;
  document.getElementById('addStudentBtn').onclick=()=>openStudentModal(null,'',ACTIVE_SESSION.groupIds[0]);
  const scan=document.getElementById('scanInput'); scan.focus(); scan.addEventListener('keydown',e=>{if(e.key==='Enter'){const code=scan.value.trim();scan.value='';if(code)handleGroupScan(code);}});
  document.getElementById('closeSessionBtn').onclick=closeActiveSession;
  initManualAttendance();
  renderSessionCounter(); renderSessionPresentList(); renderSessionPendingList();
}

function renderSessionCounter(){
  const row=document.getElementById('sessionCounterRow');
  if(!row || !ACTIVE_SESSION) return;
  const members=DATA.filter(s=>ACTIVE_SESSION.groupIds.includes(s.groupId));
  const today=todayKey();
  const sessionDates = Array.from(new Set([...(ACTIVE_SESSION.days||[]), today]));
  const present=members.filter(s=> sessionDates.some(d=>(s.attendance||{})[d]==='present')).length;
  row.innerHTML=`
    <div class="stat"><div class="num" style="color:var(--green)">${present}</div><div class="lbl">حضروا</div></div>
    <div class="stat"><div class="num">${members.length}</div><div class="lbl">إجمالي طلاب المجموعات</div></div>
    <div class="stat"><div class="num" style="color:var(--gold)">${Math.max(members.length-present,0)}</div><div class="lbl">لم يُحسم بعد</div></div>
  `;
}

function renderSessionPresentList(){
  const list=document.getElementById('sessionPresentList');
  if(!list) return;
  if(sessionScanOrder.length===0){
    list.innerHTML=`<div class="empty">لسه محدش سكان كارته 🪪</div>`;
    return;
  }
  const ym=ymKey();
  list.innerHTML=sessionScanOrder.map(id=>{
    const s=DATA.find(x=>x.id===id);
    if(!s) return '';
    const paid=s.payments && s.payments[ym] && s.payments[ym].paid;
    const g=getGroup(s.groupId);
    return `
    <div class="student-row" data-id="${s.id}">
      <div>
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="meta">${g?escapeHtml(g.name):'بدون مجموعة'}${s.phone?(' &nbsp;|&nbsp; 📞 '+escapeHtml(s.phone)):''}</div>
      </div>
      <span class="pill ${paid?'paid':'unpaid'}">${paid?'مدفوع':'غير مدفوع'}</span>
    </div>`;
  }).join('');
  list.querySelectorAll('.student-row').forEach(row=>{
    row.onclick=()=>openProfile(row.dataset.id);
  });
}

// الطلاب اللي لسه ملهمش حضور في أي يوم من أيام الحصة دي — حالتهم "لم يُحسم بعد" مش "غائب"
function renderSessionPendingList(){
  const list=document.getElementById('sessionPendingList');
  if(!list || !ACTIVE_SESSION) return;
  const today=todayKey();
  const sessionDates = Array.from(new Set([...(ACTIVE_SESSION.days||[]), today]));
  const members=DATA.filter(s=>ACTIVE_SESSION.groupIds.includes(s.groupId));
  const pending = members.filter(s=> !sessionDates.some(d=>(s.attendance||{})[d]==='present'))
                          .sort((a,b)=>a.name.localeCompare(b.name,'ar'));
  if(pending.length===0){
    list.innerHTML = `<div class="empty">كل الطلاب حضروا ✔</div>`;
    return;
  }
  list.innerHTML = pending.map(s=>{
    const g=getGroup(s.groupId);
    const dayDue = isGroupScheduledOnDate(g, today);
    return `
    <div class="student-row" data-id="${s.id}">
      <div>
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="meta">${g?escapeHtml(g.name):'بدون مجموعة'}${s.phone?(' &nbsp;|&nbsp; 📞 '+escapeHtml(s.phone)):''}</div>
      </div>
      <span class="pill ${dayDue?'unpaid':'warn'}">${dayDue?'⏳ لم يُحسم بعد — يومه النهارده':'⏳ لم يُحسم بعد — يومه لسه ما جاش'}</span>
    </div>`;
  }).join('');
  list.querySelectorAll('.student-row').forEach(row=>{
    row.onclick=()=>openProfile(row.dataset.id);
  });
}

async function closeActiveSession(){
  if(ACTIVE_SESSION.continuation === false){
    const r = singleDayAbsences(ACTIVE_SESSION);
    if(!confirm(`الحصة تشمل ${r.members.length} طالب — كل المجموعات يومها ${prettyDate(r.date)}.\nسيُسجل الغياب لـ ${r.notPresent.length} طالب، والحصة هتخلص نهائيًا (بدون استكمال).\nمتأكد؟`)) return;
    applySingleDayAbsences(r);
    SESSIONS = SESSIONS.filter(x => x.id !== ACTIVE_SESSION.id);
    ACTIVE_SESSION = null; sessionScanOrder = [];
    await saveData();
    showToast(`تم إغلاق الحصة نهائيًا — اتسجّل غياب ${r.notPresent.length} طالب`);
    if(!offerNotifications()){ showView('groups'); renderGroupsList(); }
    return;
  }
  const today = todayKey();
  const members = DATA.filter(s => ACTIVE_SESSION.groupIds.includes(s.groupId));
  const resolvedSoFar = ACTIVE_SESSION.resolvedGroupIds || [];
  const historyDates = Array.from(new Set([...(ACTIVE_SESSION.days||[]), today]));

  // المجموعات اللي "يومها" هو النهارده، ولسه معملهاش حسم في هذه الحصة الأسبوعية
  const newlyResolvedGroupIds = ACTIVE_SESSION.groupIds.filter(gid =>
    isGroupScheduledOnDate(getGroup(gid), today) && !resolvedSoFar.includes(gid)
  );
  // نحسم غياب طلاب المجموعات دي فقط؛ طلاب مجموعة يومها لسه ما جاش يفضلوا Pending
  const eligible = members.filter(s => newlyResolvedGroupIds.includes(s.groupId));
  // الطالب يُعتبر حاضر لو حضر في أي يوم من أيام هذه الحصة (مش النهارده بس) — عشان الاستكمال يشتغل صح
  const notPresent = eligible.filter(s => !historyDates.some(d => (s.attendance || {})[d] === 'present'));

  const resolvedGroupIds = Array.from(new Set([...resolvedSoFar, ...newlyResolvedGroupIds]));
  const stillPendingGroupIds = ACTIVE_SESSION.groupIds.filter(gid => !resolvedGroupIds.includes(gid));

  const ok = confirm(
    `الحصة تشمل ${members.length} طالب.\n` +
    (eligible.length
      ? `سيتم حسم موقف ${eligible.length} طالب حسب يوم مجموعتهم، وسيُسجل الغياب لـ ${notPresent.length} منهم.\n`
      : `مفيش مجموعة يومها النهارده، فمش هيتسجل غياب لحد؛ الحصة هتفضل قيد الاستكمال.\n`) +
    (stillPendingGroupIds.length
      ? `الحصة هتفضل "قيد الاستكمال" لحد ما ييجي يوم باقي المجموعات (${stillPendingGroupIds.map(id=>getGroup(id)?.name).filter(Boolean).join(' + ')}).\n`
      : ``) +
    `متأكد؟`
  );
  if(!ok) return;

  notPresent.forEach(s => {
    s.attendance = s.attendance || {};
    s.attendance[today] = 'absent';
  });

  if(stillPendingGroupIds.length === 0){
    // كل مجموعات الحصة اتحسمت — الحصة خلصت نهائيًا ومش هتظهر تاني في "استكمال حصة سابقة"
    SESSIONS = SESSIONS.filter(x => x.id !== ACTIVE_SESSION.id);
  }else{
    const rec = {
      id: ACTIVE_SESSION.id,
      groupIds: ACTIVE_SESSION.groupIds,
      days: historyDates,
      resolvedGroupIds,
      status: 'pending',
      createdAt: ACTIVE_SESSION.createdAt || ACTIVE_SESSION.openedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const idx = SESSIONS.findIndex(x => x.id === rec.id);
    if(idx >= 0) SESSIONS[idx] = rec; else SESSIONS.push(rec);
  }

  ACTIVE_SESSION = null;
  sessionScanOrder = [];
  await saveData();
  showToast(stillPendingGroupIds.length
    ? `تم إغلاق حصة اليوم — الحصة قيد الاستكمال، واتسجّل غياب ${notPresent.length} طالب`
    : `تم إغلاق الحصة نهائيًا — اتسجّل غياب ${notPresent.length} طالب`);
  if(!offerNotifications()){ showView('groups'); renderGroupsList(); }
}

// بعد إغلاق الحصة: لو فيه طلاب اتسجل غيابهم النهارده، نسأل المدرّس يروح لشاشة الإخطارات
function offerNotifications(){
  const today = todayKey();
  const waiting = absentStudentsOnDate(today).filter(i=>!i.sent);
  if(!waiting.length) return false;
  const go = confirm(`فيه ${waiting.length} طالب اتسجل غيابهم النهارده.\nتحب تفتح شاشة إخطار أولياء الأمور دلوقتي؟`);
  if(!go) return false;
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.remove('active'));
  document.querySelector('#tabs button[data-tab="notify"]')?.classList.add('active');
  currentGroupId = null;
  notifyDate = today;
  showView('notify');
  renderNotify();
  return true;
}

function openGroup(groupId){
  pushCurrentView();
  currentGroupId = groupId;
  showView('group');
  renderGroupView();
}

function renderGroupView(){
  const g = currentGroupId ? getGroup(currentGroupId) : null;
  const view = document.getElementById('groupView');
  const title = g ? g.name : 'غير مصنّفين';
  const sched = g ? groupLabel(g) : 'طلاب من غير مجموعة محددة';
  view.innerHTML = `
    <button class="btn outline" id="backToGroups" style="margin-bottom:14px;">→ رجوع</button>
    <div class="card group-header-card">
      <div>
        <h2 style="margin:0 0 4px;">${escapeHtml(title)}</h2>
        <div style="color:var(--cyan); font-size:13px; font-family:'JetBrains Mono',monospace;">${escapeHtml(sched)}</div>
      </div>
      ${g?`<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
        <button class="btn outline" id="gradesEntryBtn">📝 رصد درجات امتحان</button>
        <button class="btn outline" id="examResultsBtn">📤 تنزيل نتيجة امتحان</button>
        <button class="btn outline" id="exportGroupExcelBtn">📊 تصدير كشف Excel</button>
        <button class="btn outline" id="importStudentsBtn">⬆ استيراد طلاب من Excel</button>
        <button class="btn outline" id="editGroupBtn">✎ تعديل المجموعة</button>
      </div>`:''}
    </div>

    <div class="card scan-box">
      <div class="icon">🪪</div>
      <h3 style="margin:0 0 10px;">ابدأ الحصة — امسح كارت الطالب</h3>
      <input type="text" id="scanInput" class="scan-input" placeholder="وجّه الماسح هنا..." autocomplete="off">
      <p class="scan-hint">هيتسجل حضور اليوم أوتوماتيك لأي طالب من المجموعة دي</p>
      ${g?`<button class="btn danger" id="closeSessionBtn" style="margin-top:16px;">🔒 إغلاق الحصة</button>
      <p class="scan-hint" style="margin-top:6px;">أي طالب في المجموعة كارته مضربش هيتسجل "غايب" أوتوماتيك</p>`:''}
    </div>

    <div class="card manual-box" style="margin-top:14px;">
      <div class="manual-head"><span style="font-size:20px;">✍️</span><h3>تحضير بالاسم (لو الطالب ناسي الكارت)</h3></div>
      <input type="text" id="manualAttInput" class="manual-input" placeholder="اكتب اسم الطالب أو رقم تليفونه..." autocomplete="off">
      <div class="manual-results" id="manualAttResults"></div>
      <p class="manual-hint">اكتب حرفين على الأقل، وبعدين اضغط "✔ حضور" جنب اسم الطالب.</p>
    </div>
    <div id="scanResult"></div>

    <div class="section-title"><span>👥 طلاب المجموعة</span><div class="line"></div></div>
    <div class="search-row">
      <input type="text" id="groupSearchInput" placeholder="ابحث بالاسم أو التليفون أو الكود...">
      <button class="btn gold" id="addStudentBtn">+ طالب جديد</button>
    </div>
    <div class="stats-row" id="groupStats"></div>
    <div class="settings-row" style="margin-top:14px; align-items:center;">
      <label style="display:flex; align-items:center; gap:6px; font-size:13px; color:var(--ink-soft); cursor:pointer;">
        <input type="checkbox" id="selectAllChk"> تحديد الكل
      </label>
      <span id="selCount" style="font-size:12px; color:var(--ink-soft);"></span>
      <button class="btn outline small" id="bulkMoveBtn" style="margin-right:auto;" disabled>➡ نقل المحددين لمجموعة تانية</button>
      <button class="btn outline small" id="bulkArchiveBtn" disabled>📦 أرشفة المحددين</button>
    </div>
    <div class="student-list" id="groupStudentList" style="margin-top:10px;"></div>

    <div class="section-title"><span>💳 تفاصيل الدفع</span><div class="line"></div><button class="btn outline small" id="groupPayExportBtn" title="تحميل تفاصيل الدفع (Excel)">📥 تحميل</button></div>
    <div class="card" id="groupPayBox"></div>
  `;
  selectedIds.clear();
  document.getElementById('backToGroups').onclick = goBack;
  if(g){
    document.getElementById('editGroupBtn').onclick = ()=> openGroupModal(g);
    document.getElementById('exportGroupExcelBtn').onclick = ()=> openExamExcelModal(g);
    document.getElementById('examResultsBtn').onclick = ()=> openExamResultsExportModal(g);
    document.getElementById('importStudentsBtn').onclick = ()=> openStudentsImportModal(g);
  }
  document.getElementById('addStudentBtn').onclick = ()=> openStudentModal(null, '', currentGroupId);
  const gradesBtn = document.getElementById('gradesEntryBtn');
  if(gradesBtn) gradesBtn.onclick = ()=> openGradesModal(g);
  if(g){
    document.getElementById('closeSessionBtn').onclick = async ()=>{
      const members = DATA.filter(s => s.groupId === currentGroupId);
      const today = todayKey();

      // لا نعتبر الطالب غائبًا إلا إذا كان اليوم الحالي من أيام مجموعته.
      const eligible = members.filter(s => isGroupScheduledOnDate(getGroup(s.groupId), today));
      const notPresent = eligible.filter(s => (s.attendance || {})[today] !== 'present');

      if(notPresent.length === 0){
        showToast('لا يوجد طلاب مستحق عليهم غياب اليوم ✓');
        return;
      }

      const ok = confirm(
        `${eligible.length} طالب مستحق عليهم الحضور اليوم.\\n` +
        `سيُسجل الغياب لـ ${notPresent.length} طالب فقط.\\n` +
        `الطلاب الذين ليس لديهم حصة اليوم لن يُسجل لهم غياب.\\nمتأكد؟`
      );
      if(!ok) return;
      notPresent.forEach(s=>{
        s.attendance = s.attendance || {};
        s.attendance[today] = 'absent';
      });
      await saveData();
      showToast(`تم إغلاق الحصة — اتسجّل غياب ${notPresent.length} طالب`);
      renderGroupStudentList();
      renderGroupStats();
      offerNotifications();
    };
  }
  document.getElementById('groupSearchInput').addEventListener('input', renderGroupStudentList);
  document.getElementById('selectAllChk').onchange = (e)=>{
    const visibleIds = getVisibleGroupMembers().map(s=>s.id);
    if(e.target.checked) visibleIds.forEach(id=>selectedIds.add(id));
    else visibleIds.forEach(id=>selectedIds.delete(id));
    renderGroupStudentList();
  };
  document.getElementById('bulkMoveBtn').onclick = ()=> openBulkMoveModal();
  document.getElementById('bulkArchiveBtn').onclick = async ()=>{
    if(!selectedIds.size) return;
    if(!confirm(`تنقل ${selectedIds.size} طالب للأرشيف؟ (بياناتهم محفوظة وتقدر ترجّعهم)`)) return;
    const n = await archiveStudents(Array.from(selectedIds));
    selectedIds.clear(); showToast(`📦 اتنقل ${n} طالب للأرشيف`); renderGroupView();
  };

  const scanInput = document.getElementById('scanInput');
  scanInput.focus();
  scanInput.addEventListener('keydown', (e)=>{
    if(e.key==='Enter'){
      const code = scanInput.value.trim();
      scanInput.value='';
      if(code) handleGroupScan(code);
    }
  });

  initManualAttendance();
  renderGroupStats();
  renderGroupStudentList();
  document.getElementById('groupPayExportBtn').onclick = ()=> openPaymentExportModal(currentGroupId || '__none__', {year:grpPayYear, month:grpPayMonth});
  renderGroupPayments();
}

function renderGroupStats(){
  // نفس ملحوظة getVisibleGroupMembers: صفحة المجموعة العادية دايمًا بتعرض إحصائيات المجموعة نفسها بغض النظر عن أي حصة مفتوحة في مكان تاني
  const members = DATA.filter(s=> currentGroupId ? s.groupId===currentGroupId : (!s.groupId || !getGroup(s.groupId)));
  const ym = ymKey();
  const paid = members.filter(s=>s.payments && s.payments[ym] && s.payments[ym].paid).length;
  document.getElementById('groupStats').innerHTML = `
    <div class="stat"><div class="num">${members.length}</div><div class="lbl">طلاب المجموعة</div></div>
    <div class="stat"><div class="num" style="color:var(--green)">${paid}</div><div class="lbl">دفعوا هذا الشهر</div></div>
    <div class="stat"><div class="num" style="color:var(--red)">${members.length-paid}</div><div class="lbl">لم يدفعوا بعد</div></div>
  `;
}

function handleGroupScan(code){
  const box=document.getElementById('scanResult'); const s=DATA.find(x=>x.barcode===code);
  if(!s){
    const ar = ARCHIVE.find(x=>x.barcode===code);
    if(ar){
      box.innerHTML = `<div class="card scan-result-card warn"><p>📦 الطالب <b>${escapeHtml(ar.name)}</b> في الأرشيف${ar.archivedAt?` (من ${escapeHtml(archDateLabel(ar.archivedAt))})`:''}.</p><div class="sr-actions"><button class="btn gold" id="restoreFromScan">♻ استعادة الطالب</button></div></div>`;
      document.getElementById('restoreFromScan').onclick = ()=> openRestoreModal(ar.id, ()=>handleGroupScan(code), currentGroupId);
      return;
    }
  }
  if(!s){box.innerHTML=`<div class="card scan-result-card miss"><p>❌ لا يوجد طالب بهذا الكود: <b>${escapeHtml(code)}</b></p><button class="btn gold" id="createFromScan">+ إضافة طالب جديد</button></div>`;document.getElementById('createFromScan').onclick=()=>openStudentModal(null,code, IN_SESSION_UI ? (ACTIVE_SESSION?.groupIds?.[0]) : currentGroupId);return;}
  if(IN_SESSION_UI && ACTIVE_SESSION && !ACTIVE_SESSION.groupIds.includes(s.groupId)){
    const other=getGroup(s.groupId);
    box.innerHTML=`<div class="card scan-result-card warn"><p>⚠ الطالب <b>${escapeHtml(s.name)}</b> مش مسجّل في أي مجموعة من مجموعات الحصة الحالية${other?`، هو في ${escapeHtml(other.name)}`:''}.</p><div class="sr-actions"><button class="btn outline" id="viewAnywayBtn">عرض بياناته فقط</button></div></div>`;
    document.getElementById('viewAnywayBtn').onclick=()=>openProfile(s.id); return;
  }
  if(!IN_SESSION_UI && s.groupId!==currentGroupId){
    const other=getGroup(s.groupId); box.innerHTML=`<div class="card scan-result-card warn"><p>⚠ الطالب <b>${escapeHtml(s.name)}</b> مسجّل في مجموعة تانية${other?(': '+escapeHtml(other.name)):''}.</p><div class="sr-actions"><button class="btn gold" id="moveHereBtn">انقله لهذه المجموعة وسجّل حضوره</button><button class="btn outline" id="viewAnywayBtn">عرض بياناته فقط</button></div></div>`;
    document.getElementById('moveHereBtn').onclick=async()=>{s.groupId=currentGroupId;markPresentToday(s);await saveData();renderScanResultCard(s,true);renderGroupStudentList();renderGroupStats();};
    document.getElementById('viewAnywayBtn').onclick=()=>openProfile(s.id); return;
  }
  if(IN_SESSION_UI && ACTIVE_SESSION && ACTIVE_SESSION.continuation===false && ACTIVE_SESSION.date && ACTIVE_SESSION.date!==todayKey()){
    showToast('الحصة دي من يوم سابق — اقفلها الأول وبعدين ابدأ حصة جديدة'); return;
  }
  const alreadyPresent=(s.attendance||{})[todayKey()] === 'present';
  markPresentToday(s);
  if(IN_SESSION_UI && ACTIVE_SESSION && !sessionScanOrder.includes(s.id)) sessionScanOrder.unshift(s.id);
  saveData();
  renderScanResultCard(s,!alreadyPresent);
  if(IN_SESSION_UI){ renderSessionCounter(); renderSessionPresentList(); renderSessionPendingList(); }
  else { renderGroupStudentList(); renderGroupStats(); }
}
/* ============ إخطار أولياء الأمور (واتساب يدوي بضغطة زرار) ============ */

// بيرجّع آخر سلسلة غياب متتالية (بيقف عند أول حضور)
function absenceStreak(s){
  const att = s.attendance || {};
  const dates = Object.keys(att).filter(k=>k >= (s.restoredAt||'')).sort();          // من الأقدم للأحدث
  const streak = [];
  for(let i = dates.length - 1; i >= 0; i--){
    if(att[dates[i]] === 'absent') streak.unshift(dates[i]);
    else break;                                    // أول حضور بيكسر السلسلة
  }
  return streak;
}

// سلسلة الغياب المتتالي المنتهية بالظبط عند تاريخ معيّن (وليس بالضرورة آخر تاريخ مسجّل للطالب).
// بتعتمد بس على أيام الحصص الفعلية المسجّلة لهذا الطالب، فأي يوم مفيهوش حصة أصلاً (مسجّلش في attendance)
// مش بيقطع السلسلة ومش بيتحسب غياب ولا حضور — تمامًا زي المطلوب.
function absenceStreakEndingAt(s, dateKey){
  const att = s.attendance || {};
  if(att[dateKey] !== 'absent') return [];
  const dates = Object.keys(att).filter(k=>k >= (s.restoredAt||'')).sort();
  const idx = dates.indexOf(dateKey);
  const streak = [dateKey];
  for(let i = idx - 1; i >= 0; i--){
    if(att[dates[i]] === 'absent') streak.unshift(dates[i]);
    else break;
  }
  return streak;
}

// كل تواريخ الحصص الفعلية (حاضر أو غايب) المسجّلة لأي طالب في المجموعة دي، جوه شهر معيّن — مرتبة تصاعديًا
function groupSessionDatesInMonth(members, ymPrefix){
  const set = new Set();
  members.forEach(s=>{
    Object.keys(s.attendance||{}).forEach(d=>{ if(d.startsWith(ymPrefix)) set.add(d); });
  });
  return Array.from(set).sort();
}

// كل تواريخ الحصص الفعلية المسجّلة لأي طالب في كل النظام (مستخدمة في اختيار يوم شاشة الإخطارات) — تصاعديًا
function allSystemSessionDates(){
  const set = new Set();
  DATA.forEach(s=> Object.keys(s.attendance||{}).forEach(d=>set.add(d)));
  return Array.from(set).sort();
}

// كل الطلاب اللي غايبين في تاريخ معيّن بالظبط، مع سلسلة غيابهم المتتالي المنتهية في هذا التاريخ
function absentStudentsOnDate(dateKey){
  const out = [];
  DATA.forEach(s=>{
    if(s.notifyParent === false) return;
    if((s.attendance||{})[dateKey] !== 'absent') return;
    const streak = absenceStreakEndingAt(s, dateKey);
    const key = streakKey(streak);
    const sent = !!(s.notified && s.notified[key]);
    out.push({ s, streak, key, sent, phone: normalizePhone(s.parentPhone) });
  });
  out.sort((a,b)=> (a.sent===b.sent ? b.streak.length-a.streak.length : (a.sent?1:-1)));
  return out;
}

// تحويل الرقم المصري لصيغة دولية صالحة للواتساب
function normalizePhone(raw){
  let p = (raw||'').toString().replace(/[^\d+]/g,'').replace(/^\+/,'');
  if(!p) return null;
  if(p.startsWith('00')) p = p.slice(2);
  if(p.startsWith('20')) { /* جاهز */ }
  else if(p.startsWith('0')) p = '20' + p.slice(1);
  else if(p.length === 10) p = '20' + p;
  else return null;
  if(p.length < 11 || p.length > 13) return null;
  return p;
}

function prettyDate(dateKey){
  const d = new Date(dateKey+'T12:00:00');
  return `${arabicDayForDate(dateKey)} ${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
}

// آخر الدرجات مرتبة من الأحدث
function studentGrades(s){
  return (s.grades||[]).slice().sort((a,b)=> (b.date||'').localeCompare(a.date||''));
}
function gradePct(gr){
  const max = Number(gr.max)||0;
  if(!max) return null;
  return Math.round((Number(gr.score)/max)*100);
}
function gradesBlock(s, limit){
  const list = studentGrades(s).slice(0, limit||2);
  if(!list.length) return '';
  const lines = list.map(gr=>{
    const pct = gradePct(gr);
    return `• ${gr.name}: ${gr.score} من ${gr.max}${pct!==null?` (${pct}%)`:''}`;
  });
  return `آخر الدرجات:\n${lines.join('\n')}\n`;
}

function buildParentMessage(s, streak, withGrades){
  const dates = streak.map(d=>'• '+prettyDate(d)).join('\n');
  return (SETTINGS.msgTemplate || DEFAULT_MSG)
    .replace(/\{name\}/g, s.name)
    .replace(/\{count\}/g, streak.length)
    .replace(/\{dates\}/g, dates)
    .replace(/\{grades\}/g, withGrades ? gradesBlock(s,2) : '')
    .replace(/\{group\}/g, getGroup(s.groupId)?.name || '')
    .replace(/\{teacher\}/g, SETTINGS.teacherName || '')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
}

// مفتاح ثابت للسلسلة الواحدة: مايتبعتش تاني لنفس السلسلة إلا لو ضغطت "إعادة إرسال"
function streakKey(streak){ return 'absent_' + streak[0]; }

// رسالة درجة لولي الأمر — بتستخدم نفس آلية إرسال رسائل الغياب (واتساب) بالظبط
function buildGradeMessage(s, grade){
  const pct = gradePct(grade);
  const lines = [
    `السلام عليكم ورحمة الله،`,
    `حضرتك ولي أمر الطالب/ـة: ${s.name}`,
    `نحيط حضرتك علمًا بأن الطالب حصل في "${grade.name}" على ${grade.score} من ${grade.max}${pct!==null?` (${pct}%)`:''}.`,
    SETTINGS.teacherName ? SETTINGS.teacherName : ''
  ].filter(Boolean);
  return lines.join('\n');
}

let notifyDate = null; // التاريخ المختار حاليًا في شاشة الإخطارات

function renderNotify(){
  const view = document.getElementById('notifyView');
  const allDates = allSystemSessionDates(); // تصاعدي (من الأقدم للأحدث)
  if(!allDates.length){
    view.innerHTML = `<div class="card"><div class="empty">لسه مفيش أي حصص متسجلة في النظام.</div></div>`;
    return;
  }
  if(!notifyDate || !allDates.includes(notifyDate)) notifyDate = allDates[allDates.length-1]; // افتراضيًا آخر يوم فيه حصة
  const idx = allDates.indexOf(notifyDate);

  view.innerHTML = `
    <div class="card">
      <div class="profile-head">
        <div>
          <h2 style="margin:0 0 4px;">📲 إخطار أولياء الأمور</h2>
          <div style="color:var(--ink-soft); font-size:13px;">اختار اليوم اللي عايز تشوف غياب طلابه — الرسالة هتتكوّن تلقائي من أيام الغياب المتتالية المنتهية في اليوم ده</div>
        </div>
        <button class="btn outline" id="notifySettingsBtn">⚙ إعدادات الرسالة</button>
      </div>
      <div class="month-nav" style="margin-top:14px;">
        <button id="notifyPrevDay" ${idx<=0?'disabled':''}>‹ يوم أقدم</button>
        <select id="notifyDateSelect" style="flex:1;text-align:center;">
          ${allDates.slice().reverse().map(d=>`<option value="${d}" ${d===notifyDate?'selected':''}>${escapeHtml(prettyDate(d))} — ${d}</option>`).join('')}
        </select>
        <button id="notifyNextDay" ${idx>=allDates.length-1?'disabled':''}>يوم أحدث ›</button>
      </div>
    </div>
    <div id="notifyStatsBox"></div>
    <div id="notifyList"></div>`;
  view.querySelector('#notifySettingsBtn').onclick = openMsgSettings;
  view.querySelector('#notifyPrevDay').onclick = ()=>{ if(idx>0){ notifyDate = allDates[idx-1]; renderNotify(); } };
  view.querySelector('#notifyNextDay').onclick = ()=>{ if(idx<allDates.length-1){ notifyDate = allDates[idx+1]; renderNotify(); } };
  view.querySelector('#notifyDateSelect').onchange = (e)=>{ notifyDate = e.target.value; renderNotify(); };
  renderNotifyForDate(notifyDate);
}

function renderNotifyForDate(dateKey){
  const items = absentStudentsOnDate(dateKey);
  const waiting = items.filter(i=>!i.sent);
  const noPhone = items.filter(i=>!i.phone);
  const statsBox = document.getElementById('notifyStatsBox');
  if(statsBox) statsBox.innerHTML = `
    <div class="card">
      <div class="stats-row">
        <div class="stat"><div class="num" style="color:var(--red)">${items.length}</div><div class="lbl">غايبين يوم ${escapeHtml(prettyDate(dateKey))}</div></div>
        <div class="stat"><div class="num" style="color:var(--gold)">${waiting.length}</div><div class="lbl">لسه محتاجين إخطار</div></div>
        <div class="stat"><div class="num" style="color:var(--green)">${items.length-waiting.length}</div><div class="lbl">اتبعتلهم</div></div>
        <div class="stat"><div class="num" style="color:var(--red)">${noPhone.length}</div><div class="lbl">رقم ولي أمر ناقص</div></div>
      </div>
    </div>`;
  renderNotifyList(items, dateKey);
}

function renderNotifyList(items, dateKey){
  const box = document.getElementById('notifyList');
  if(!box) return;
  if(!items.length){
    box.innerHTML = `<div class="card"><div class="empty">محدش غايب يوم ${escapeHtml(prettyDate(dateKey))} 👏</div></div>`;
    return;
  }

  // نجمّع الطلاب حسب مجموعتهم عشان الصفحة متبقاش كل الطلاب فاتحين على بعض في نفس الوقت
  const groupsMap = new Map(); // groupId(or '__none__') -> items[]
  items.forEach(it=>{
    const gid = it.s.groupId && getGroup(it.s.groupId) ? it.s.groupId : '__none__';
    if(!groupsMap.has(gid)) groupsMap.set(gid, []);
    groupsMap.get(gid).push(it);
  });
  // رتّب المجموعات: الأكتر طلاب محتاجين إخطار الأول
  const groupEntries = Array.from(groupsMap.entries()).sort((a,b)=>{
    const aw = a[1].filter(i=>!i.sent).length, bw = b[1].filter(i=>!i.sent).length;
    return bw - aw;
  });

  box.innerHTML = groupEntries.map(([gid, groupItems], gi)=>{
    const g = gid==='__none__' ? null : getGroup(gid);
    const waitingCount = groupItems.filter(i=>!i.sent).length;
    const cardsHtml = groupItems.map(it=>{
      const s = it.s;
      const msg = buildParentMessage(s, it.streak, SETTINGS.includeGrades);
      const sentAt = it.sent ? new Date(s.notified[it.key].at).toLocaleString('ar-EG',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
      const action = !it.phone
        ? `<button class="btn outline small notify-edit" data-id="${s.id}">✎ أضف رقم ولي الأمر</button>`
        : `<button class="btn ${it.sent?'outline':'gold'} small notify-send" data-id="${s.id}" data-key="${it.key}">${it.sent?'↻ إعادة الإرسال':'📲 ابعت على واتساب'}</button>`;
      return `
      <div class="card notify-card ${it.sent?'done':''}">
        <div class="notify-top">
          <div>
            <div class="name">${escapeHtml(s.name)} ${it.sent?'<span class="pill paid">✔ اتبعت</span>':`<span class="pill unpaid">${it.streak.length} غياب متتالي</span>`}</div>
            <div class="meta">ولي الأمر: ${escapeHtml(s.parentPhone||'— غير مسجّل')}${sentAt?` &nbsp;|&nbsp; آخر إرسال: ${sentAt}`:''}</div>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            ${action}
            <button class="btn outline small notify-copy" data-id="${s.id}">📋 نسخ</button>
            <button class="btn outline small notify-skip" data-id="${s.id}">🔕 تجاهل</button>
          </div>
        </div>
        <pre class="notify-msg">${escapeHtml(msg)}</pre>
      </div>`;
    }).join('');
    return `
    <details class="card notify-group" ${gi===0 ? 'open' : ''}>
      <summary class="notify-group-summary">
        <span>📁 ${g?escapeHtml(g.name):'بدون مجموعة'}</span>
        <span class="pill ${waitingCount?'unpaid':'paid'}">${waitingCount ? `${waitingCount} محتاجين إخطار` : 'كلهم اتبعتلهم ✔'} — ${groupItems.length} إجمالي</span>
      </summary>
      <div class="notify-group-body">${cardsHtml}</div>
    </details>`;
  }).join('');

  const byId = id => items.find(i=>i.s.id===id);

  box.querySelectorAll('.notify-send').forEach(b=>{
    b.onclick = async ()=>{
      const it = byId(b.dataset.id); if(!it) return;
      const msg = buildParentMessage(it.s, it.streak, SETTINGS.includeGrades);
      window.open(`https://wa.me/${it.phone}?text=${encodeURIComponent(msg)}`, '_blank');
      it.s.notified = it.s.notified || {};
      it.s.notified[it.key] = { at: Date.now(), streak: it.streak.length, via: 'whatsapp' };
      await saveData();
      showToast('اتفتح واتساب — اضغط إرسال هناك');
      renderNotify();
    };
  });
  box.querySelectorAll('.notify-copy').forEach(b=>{
    b.onclick = ()=>{
      const it = byId(b.dataset.id); if(!it) return;
      const msg = buildParentMessage(it.s, it.streak, SETTINGS.includeGrades);
      navigator.clipboard?.writeText(msg).then(
        ()=>showToast('الرسالة اتنسخت ✔'),
        ()=>showToast('متعرفش تنسخ من المتصفح ده')
      );
    };
  });
  box.querySelectorAll('.notify-edit').forEach(b=>{
    b.onclick = ()=> openStudentModal(b.dataset.id, '', byId(b.dataset.id)?.s.groupId);
  });
  box.querySelectorAll('.notify-skip').forEach(b=>{
    b.onclick = async ()=>{
      const it = byId(b.dataset.id); if(!it) return;
      if(!confirm(`إيقاف إخطارات ولي أمر ${it.s.name} نهائيًا؟ (تقدر ترجّعها من تعديل بيانات الطالب)`)) return;
      it.s.notifyParent = false;
      await saveData();
      renderNotify();
    };
  });
}

function openMsgSettings(){
  const ov = document.createElement('div');
  ov.className='overlay';
  ov.innerHTML = `
    <div class="modal">
      <h3>⚙ إعدادات رسالة ولي الأمر</h3>
      <div class="field"><label>اسم المدرّس (يظهر في آخر الرسالة)</label><input id="ms_teacher" value="${escapeHtml(SETTINGS.teacherName||'')}"></div>
      <label style="display:flex; align-items:center; gap:8px; font-size:13px; margin:10px 0;">
        <input type="checkbox" id="ms_grades" ${SETTINGS.includeGrades?'checked':''}> إرفاق آخر درجتين للطالب في الرسالة
      </label>
      <div class="field"><label>نص الرسالة</label><textarea id="ms_tpl" rows="9">${escapeHtml(SETTINGS.msgTemplate||DEFAULT_MSG)}</textarea></div>
      <p class="scan-hint" style="text-align:right;">المتغيرات المتاحة: <code>{name}</code> اسم الطالب، <code>{count}</code> عدد الغياب، <code>{dates}</code> تواريخ الغياب، <code>{grades}</code> الدرجات، <code>{group}</code> المجموعة، <code>{teacher}</code> اسم المدرّس.</p>
      <div class="modal-actions">
        <button class="btn outline" id="ms_reset">استرجاع النص الافتراضي</button>
        <button class="btn outline" id="ms_cancel">إلغاء</button>
        <button class="btn gold" id="ms_save">حفظ</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.remove(); });
  ov.querySelector('#ms_cancel').onclick = ()=>ov.remove();
  ov.querySelector('#ms_reset').onclick = ()=>{ ov.querySelector('#ms_tpl').value = DEFAULT_MSG; };
  ov.querySelector('#ms_save').onclick = async ()=>{
    SETTINGS.teacherName = ov.querySelector('#ms_teacher').value.trim();
    SETTINGS.includeGrades = ov.querySelector('#ms_grades').checked;
    SETTINGS.msgTemplate = ov.querySelector('#ms_tpl').value || DEFAULT_MSG;
    await saveData();
    ov.remove();
    showToast('تم حفظ الإعدادات');
    renderNotify();
  };
}

/* ============ الدرجات ============ */

// رصد درجات امتحان لمجموعة كاملة في شاشة واحدة
function openGradesModal(group){
  const members = DATA.filter(s=> group ? s.groupId===group.id : (!s.groupId || !getGroup(s.groupId)));
  if(!members.length){ showToast('مفيش طلاب في المجموعة دي'); return; }
  const ov = document.createElement('div');
  ov.className='overlay';
  ov.innerHTML = `
    <div class="modal" style="max-width:620px;">
      <div class="modal-head"><h3>📝 رصد درجات امتحان</h3><button class="close" id="gr_close">×</button></div>
      <div class="field"><label>اسم الامتحان</label><input id="gr_name" value="امتحان ${new Date().toLocaleDateString('ar-EG')}" placeholder="مثال: امتحان الدرس الأول"></div>
      <div style="display:flex; gap:10px;">
        <div class="field" style="flex:1;"><label>الدرجة النهائية</label><input id="gr_max" type="number" min="1" value="40"></div>
        <div class="field" style="flex:1;"><label>تاريخ الامتحان</label><input id="gr_date" type="date" value="${todayKey()}"></div>
      </div>
      <p class="scan-hint" style="text-align:right;">سيب خانة أي طالب فاضية لو مدخلش الامتحان — مش هتتسجّل له درجة.</p>
      <div class="search-row"><input type="text" id="gr_search" placeholder="🔍 ابحث بالاسم عشان تلاقي دور الطالب بسرعة..."></div>
      <div class="grades-entry" id="gr_rows">
        ${members.map(s=>`
          <div class="grade-row" data-name="${escapeHtml(s.name.toLowerCase())}">
            <span class="gname">${escapeHtml(s.name)}</span>
            <input type="number" class="gscore" data-id="${s.id}" min="0" step="0.5" placeholder="—">
          </div>`).join('')}
      </div>
      <p class="scan-hint" id="gr_noMatch" style="display:none;">مفيش طالب بالاسم ده</p>
      <div class="modal-actions">
        <button class="btn outline" id="gr_cancel">إلغاء</button>
        <button class="btn gold" id="gr_save">حفظ الدرجات</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.remove(); });
  ov.querySelector('#gr_close').onclick = ()=>ov.remove();
  ov.querySelector('#gr_cancel').onclick = ()=>ov.remove();

  const rows = [...ov.querySelectorAll('.grade-row')];
  const searchInput = ov.querySelector('#gr_search');
  const noMatch = ov.querySelector('#gr_noMatch');
  searchInput.addEventListener('input', ()=>{
    const q = searchInput.value.trim().toLowerCase();
    let visibleCount = 0;
    rows.forEach(row=>{
      const match = !q || row.dataset.name.includes(q);
      row.style.display = match ? '' : 'none';
      if(match) visibleCount++;
    });
    noMatch.style.display = visibleCount ? 'none' : '';
  });
  searchInput.addEventListener('keydown', e=>{
    if(e.key==='Enter'){
      e.preventDefault();
      const firstVisible = rows.find(r=>r.style.display!=='none');
      if(firstVisible) firstVisible.querySelector('.gscore').focus();
    }
  });

  // Enter ينقل للخانة اللي بعدها (بيتخطى الصفوف المخفية بالبحث)
  const inputs = rows.map(r=>r.querySelector('.gscore'));
  inputs.forEach((inp,i)=>{
    inp.addEventListener('keydown', e=>{
      if(e.key==='Enter'){
        e.preventDefault();
        const next = rows.slice(i+1).find(r=>r.style.display!=='none');
        (next ? next.querySelector('.gscore') : ov.querySelector('#gr_save')).focus();
      }
    });
  });
  ov.querySelector('#gr_save').onclick = async ()=>{
    const name = ov.querySelector('#gr_name').value.trim();
    const max  = Number(ov.querySelector('#gr_max').value);
    const date = ov.querySelector('#gr_date').value || todayKey();
    if(!name){ showToast('اكتب اسم الامتحان'); return; }
    if(!Number.isFinite(max) || max<=0){ showToast('اكتب درجة نهائية صحيحة'); return; }
    let n = 0, bad = 0;
    inputs.forEach(inp=>{
      const raw = inp.value.trim();
      if(raw==='') return;
      const score = Number(raw);
      if(!Number.isFinite(score) || score<0 || score>max){ bad++; return; }
      const s = DATA.find(x=>x.id===inp.dataset.id);
      if(!s) return;
      s.grades = s.grades || [];
      s.grades.push({ id: uid('gr'), name, score, max, date });
      n++;
    });
    if(bad){ showToast(`فيه ${bad} درجة غير صالحة (أكبر من النهاية العظمى أو مش رقم)`); return; }
    if(!n){ showToast('مدخلتش أي درجة'); return; }
    await saveData();
    ov.remove();
    showToast(`تم رصد ${n} درجة ✔`);
    if(document.getElementById('groupView').style.display!=='none') renderGroupStudentList();
  };
}

// درجات الطالب داخل صفحته الشخصية
function renderProfileGrades(s){
  const box = document.getElementById('profileGrades');
  if(!box) return;
  const list = studentGrades(s);
  if(!list.length){
    box.innerHTML = `<div class="empty">لسه مفيش درجات مسجّلة</div>`;
  }else{
    const phone = normalizePhone(s.parentPhone);
    box.innerHTML = list.map(gr=>{
      const pct = gradePct(gr);
      const cls = pct===null ? '' : (pct>=75 ? 'paid' : (pct>=50 ? 'warn' : 'unpaid'));
      const sentAt = gr.notifiedAt ? new Date(gr.notifiedAt).toLocaleString('ar-EG',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
      return `
      <div class="grade-item">
        <div>
          <div class="name">${escapeHtml(gr.name)}</div>
          <div class="meta">${escapeHtml(gr.date||'')}${sentAt?` &nbsp;|&nbsp; اتبعتت لولي الأمر: ${sentAt}`:''}</div>
        </div>
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <span class="pill ${cls}">${gr.score} / ${gr.max}${pct!==null?` — ${pct}%`:''}</span>
          ${phone ? `<button class="btn ${gr.notifiedAt?'outline':'gold'} small send-grade" data-gid="${gr.id}">${gr.notifiedAt?'↻ إعادة الإرسال':'📲 إرسال لولي الأمر'}</button>` : `<button class="btn outline small add-parent-phone" data-gid="${gr.id}">✎ أضف رقم ولي الأمر</button>`}
          <button class="btn outline small del-grade" data-gid="${gr.id}">حذف</button>
        </div>
      </div>`;
    }).join('');
    box.querySelectorAll('.del-grade').forEach(b=>{
      b.onclick = async ()=>{
        if(!confirm('حذف الدرجة دي؟')) return;
        s.grades = (s.grades||[]).filter(x=>x.id!==b.dataset.gid);
        await saveData();
        renderProfileGrades(s);
      };
    });
    box.querySelectorAll('.send-grade').forEach(b=>{
      b.onclick = async ()=>{
        const gr = (s.grades||[]).find(x=>x.id===b.dataset.gid);
        if(!gr) return;
        const ph = normalizePhone(s.parentPhone);
        if(!ph){ showToast('رقم ولي الأمر غير صالح'); return; }
        const msg = buildGradeMessage(s, gr);
        window.open(`https://wa.me/${ph}?text=${encodeURIComponent(msg)}`, '_blank');
        gr.notifiedAt = Date.now();
        await saveData();
        showToast('اتفتح واتساب — اضغط إرسال هناك');
        renderProfileGrades(s);
      };
    });
    box.querySelectorAll('.add-parent-phone').forEach(b=>{
      b.onclick = ()=> openStudentModal(s.id, '', s.groupId);
    });
  }
}

function openSingleGradeModal(s){
  const ov = document.createElement('div');
  ov.className='overlay';
  ov.innerHTML = `
    <div class="modal">
      <h3>➕ إضافة درجة لـ ${escapeHtml(s.name)}</h3>
      <div class="field"><label>اسم الامتحان</label><input id="sg_name" placeholder="مثال: امتحان الوحدة الأولى"></div>
      <div style="display:flex; gap:10px;">
        <div class="field" style="flex:1;"><label>الدرجة</label><input id="sg_score" type="number" min="0" step="0.5"></div>
        <div class="field" style="flex:1;"><label>من</label><input id="sg_max" type="number" min="1" value="40"></div>
      </div>
      <div class="field"><label>التاريخ</label><input id="sg_date" type="date" value="${todayKey()}"></div>
      <div class="modal-actions">
        <button class="btn outline" id="sg_cancel">إلغاء</button>
        <button class="btn gold" id="sg_save">حفظ</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.remove(); });
  ov.querySelector('#sg_cancel').onclick = ()=>ov.remove();
  ov.querySelector('#sg_save').onclick = async ()=>{
    const name = ov.querySelector('#sg_name').value.trim();
    const score = Number(ov.querySelector('#sg_score').value);
    const max = Number(ov.querySelector('#sg_max').value);
    const date = ov.querySelector('#sg_date').value || todayKey();
    if(!name){ showToast('اكتب اسم الامتحان'); return; }
    if(!Number.isFinite(max)||max<=0){ showToast('اكتب الدرجة النهائية'); return; }
    if(!Number.isFinite(score)||score<0||score>max){ showToast('الدرجة غير صالحة'); return; }
    s.grades = s.grades || [];
    s.grades.push({ id: uid('gr'), name, score, max, date });
    await saveData();
    ov.remove();
    showToast('تم حفظ الدرجة ✔');
    renderProfileGrades(s);
  };
}

function markPresentToday(s){
  s.attendance = s.attendance || {};
  s.attendance[todayKey()] = 'present';
}

/* ===== تحضير بالاسم (للطالب اللي نسي الكارت) ===== */
function normalizeAr(t){
  return (t||'').toString().toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g,'')   // تشكيل وتطويل
    .replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه')
    .replace(/\s+/g,' ').trim();
}
function manualScopeMembers(){
  if(IN_SESSION_UI && ACTIVE_SESSION) return DATA.filter(s=>ACTIVE_SESSION.groupIds.includes(s.groupId));
  if(currentGroupId) return DATA.filter(s=>s.groupId===currentGroupId);
  return DATA.filter(s=>!s.groupId || !getGroup(s.groupId));
}
function initManualAttendance(){
  const input=document.getElementById('manualAttInput');
  if(!input) return;
  input.addEventListener('input', ()=>renderManualAttendance());
  input.addEventListener('keydown', e=>{
    if(e.key==='Enter'){
      e.preventDefault();
      const first=document.querySelector('#manualAttResults .manual-mark-btn');
      if(first) first.click();
    }
  });
  renderManualAttendance();
}
function renderManualAttendance(){
  const input=document.getElementById('manualAttInput');
  const box=document.getElementById('manualAttResults');
  if(!input||!box) return;
  const q=normalizeAr(input.value);
  if(q.length<2){ box.innerHTML=''; return; }

  const today=todayKey();
  const scope=manualScopeMembers();
  const scopeIds=new Set(scope.map(s=>s.id));
  const match=s=> normalizeAr(s.name).includes(q) || (s.phone||'').includes(q) || (s.parentPhone||'').includes(q);

  const inScope=scope.filter(match).slice(0,12);
  const outScope=DATA.filter(s=>!scopeIds.has(s.id) && match(s)).slice(0,5);

  if(inScope.length===0 && outScope.length===0){
    box.innerHTML=`<div class="manual-item"><div class="name" style="font-weight:500;color:var(--ink-soft);">مفيش طالب بالاسم ده 🤔</div></div>`;
    return;
  }

  const rowHtml=(s,out)=>{
    const g=getGroup(s.groupId);
    const present=(s.attendance||{})[today]==='present';
    const btn = out
      ? `<button class="btn outline small manual-view-btn" data-id="${s.id}">عرض البيانات</button>`
      : (present
          ? `<span class="pill paid">✔ حاضر</span>`
          : `<button class="btn gold small manual-mark-btn" data-id="${s.id}">✔ حضور</button>`);
    return `<div class="manual-item ${out?'out':''}">
      <div>
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="meta">${g?escapeHtml(g.name):'بدون مجموعة'}${out?' — بره مجموعات الحصة':''}${s.phone?(' &nbsp;|&nbsp; 📞 '+escapeHtml(s.phone)):''}</div>
      </div>
      ${btn}
    </div>`;
  };

  box.innerHTML = inScope.map(s=>rowHtml(s,false)).join('') + outScope.map(s=>rowHtml(s,true)).join('');
  box.querySelectorAll('.manual-mark-btn').forEach(b=>{
    b.onclick=()=>manualMarkPresent(b.dataset.id);
  });
  box.querySelectorAll('.manual-view-btn').forEach(b=>{
    b.onclick=()=>openProfile(b.dataset.id);
  });
}
function manualMarkPresent(id){
  const s=DATA.find(x=>x.id===id);
  if(!s) return;
  const alreadyPresent=(s.attendance||{})[todayKey()]==='present';
  markPresentToday(s);
  s.manualAttendance = s.manualAttendance || {};
  s.manualAttendance[todayKey()] = true;   // علامة إن الحضور اتسجل يدوي مش بالكارت
  if(IN_SESSION_UI && ACTIVE_SESSION && !sessionScanOrder.includes(s.id)) sessionScanOrder.unshift(s.id);
  saveData();
  showToast(alreadyPresent ? `${s.name} كان متسجّل حاضر بالفعل` : `تم تسجيل حضور ${s.name} بالاسم ✔`);
  renderScanResultCard(s,!alreadyPresent);
  if(IN_SESSION_UI){ renderSessionCounter(); renderSessionPresentList(); renderSessionPendingList(); }
  else { renderGroupStudentList(); renderGroupStats(); }
  const input=document.getElementById('manualAttInput');
  if(input){ input.value=''; input.focus(); }
  renderManualAttendance();
}
function getLastSessionInfo(s){
  const today = todayKey();
  const att = s.attendance || {};
  const dates = Object.keys(att).filter(d=> d !== today).sort();
  if(dates.length===0) return null;
  const lastDate = dates[dates.length-1];
  return { date: lastDate, status: att[lastDate] };
}
function paymentYmOffset(offset){
  const d=new Date(); d.setDate(1); d.setMonth(d.getMonth()+offset); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function ymParts(ym){const [y,m]=ym.split('-').map(Number);return {year:y,month:m};}
function renderScanResultCard(s,justRegistered){
  const box=document.getElementById('scanResult');
  const currentYm=paymentYmOffset(0), prevYm=paymentYmOffset(-1);
  const currentPay=s.payments?.[currentYm]; const prevPay=s.payments?.[prevYm];
  const currentPaid=!!(currentPay&&currentPay.paid), prevPaid=!!(prevPay&&prevPay.paid);
  const curNum=ymParts(currentYm).month, prevNum=ymParts(prevYm).month;
  const last=getLastSessionInfo(s);
  const lastHtml=!last?`<span class="pill warn">لا يوجد حصص سابقة</span>`:`<span class="pill ${last.status==='present'?'paid':'unpaid'}">${last.status==='present'?'✔ حاضر الحصة اللي فاتت':'✘ غايب الحصة اللي فاتت'} (${escapeHtml(last.date)})</span>`;
  let payHtml;
  if(currentPaid){payHtml=`<span class="pill paid">دفع شهر ${curNum} ✓</span>${!prevPaid?`<div style="margin-top:7px;"><span class="pill unpaid">لم يتم دفع شهر ${prevNum}</span></div>`:''}`;}
  else if(prevPaid){payHtml=`<div style="display:flex;flex-direction:column;gap:8px;"><span class="pill paid" style="width:max-content;">دفع شهر ${prevNum} ✓</span><button class="btn gold" id="payCurrentBtn">💳 دفع الشهر الحالي (${curNum})</button></div>`;}
  else{payHtml=`<div style="display:flex;flex-direction:column;gap:8px;"><span class="pill unpaid" style="width:max-content;">لم يتم دفع شهر ${prevNum}</span><div class="sr-actions" style="margin-top:0;"><button class="btn gold" id="payCurrentBtn">💳 دفع الشهر الحالي (${curNum})</button><button class="btn outline" id="payPreviousBtn">💳 دفع الشهر السابق (${prevNum})</button></div></div>`;}
  box.innerHTML=`<div class="card scan-result-card"><div class="sr-head"><div><p class="sr-name">✔ ${escapeHtml(s.name)}</p><div style="color:var(--ink-soft);font-size:12px;">${justRegistered?'تم تسجيل حضور اليوم':'الطالب مسجّل حضور اليوم بالفعل'}</div><div style="margin-top:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">${lastHtml}</div></div><div>${payHtml}</div></div><div class="info-grid" style="margin-top:12px;"><div class="info-item"><div class="k">تليفون الطالب</div><div class="v">${escapeHtml(s.phone||'—')}</div></div><div class="info-item"><div class="k">تليفون ولي الأمر</div><div class="v">${escapeHtml(s.parentPhone||'—')}</div></div><div class="info-item"><div class="k">الاشتراك الشهري</div><div class="v">${s.fee||0} ج.م</div></div></div><div class="sr-actions"><button class="btn outline" id="editFromScanBtn">✎ تعديل بيانات</button><button class="btn outline" id="fullProfileBtn">📅 السجل الكامل</button></div></div>`;
  function recordPayment(ym){
    openPaymentModal(s, ym, ()=>{ renderScanResultCard(s,false); renderGroupStudentList(); renderGroupStats(); renderGroupPayments(); });
  }
  document.getElementById('payCurrentBtn')?.addEventListener('click',()=>recordPayment(currentYm));
  document.getElementById('payPreviousBtn')?.addEventListener('click',()=>recordPayment(prevYm));
  document.getElementById('editFromScanBtn').onclick=()=>openStudentModal(s.id,'',s.groupId);
  document.getElementById('fullProfileBtn').onclick=()=>openProfile(s.id);
}
function renderGroupStudentList(){
  const list = document.getElementById('groupStudentList');
  const ym = ymKey();
  const members = getVisibleGroupMembers();
  if(members.length===0){
    list.innerHTML = `<div class="empty">لا يوجد طلاب مطابقين.</div>`;
  }else{
    list.innerHTML = members.map(s=>{
      const paid = s.payments && s.payments[ym] && s.payments[ym].paid;
      return `
      <div class="student-row" data-id="${s.id}">
        <div style="display:flex; align-items:center; gap:12px;">
          <input type="checkbox" class="rowChk" data-id="${s.id}" ${selectedIds.has(s.id)?'checked':''} onclick="event.stopPropagation()">
          <div>
            <div class="name">${escapeHtml(s.name)}</div>
            <div class="meta">📞 ${escapeHtml(s.phone||'—')} &nbsp;|&nbsp; كود: ${escapeHtml(s.barcode||'—')}${(()=>{const lg=studentGrades(s)[0]; return lg?` &nbsp;|&nbsp; 📝 ${escapeHtml(lg.name)}: ${lg.score}/${lg.max}`:'';})()}</div>
          </div>
        </div>
        <span class="pill ${paid?'paid':'unpaid'}">${paid?'مدفوع':'غير مدفوع'}</span>
      </div>`;
    }).join('');
    list.querySelectorAll('.student-row').forEach(row=>{
      row.onclick = ()=> openProfile(row.dataset.id);
    });
    list.querySelectorAll('.rowChk').forEach(chk=>{
      chk.onchange = ()=>{
        if(chk.checked) selectedIds.add(chk.dataset.id); else selectedIds.delete(chk.dataset.id);
        updateBulkToolbar();
      };
    });
  }
  updateBulkToolbar();
}
function updateBulkToolbar(){
  const countEl = document.getElementById('selCount');
  const btn = document.getElementById('bulkMoveBtn');
  const all = document.getElementById('selectAllChk');
  if(!countEl) return;
  countEl.textContent = selectedIds.size ? `${selectedIds.size} محدد` : '';
  btn.disabled = selectedIds.size===0;
  const ab = document.getElementById('bulkArchiveBtn'); if(ab) ab.disabled = selectedIds.size===0;
  const visible = getVisibleGroupMembers();
  all.checked = visible.length>0 && visible.every(s=>selectedIds.has(s.id));
}
function openBulkMoveModal(){
  const ov = document.createElement('div');
  ov.className='overlay';
  ov.innerHTML = `
    <div class="modal">
      <h3>نقل ${selectedIds.size} طالب</h3>
      <div class="field"><label>انقلهم إلى</label>
        <select id="bm_group">
          <option value="">بدون مجموعة</option>
          ${GROUPS.map(g=>`<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn outline" id="bmCancel">إلغاء</button>
        <button class="btn gold" id="bmConfirm">نقل</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.remove(); });
  ov.querySelector('#bmCancel').onclick = ()=> ov.remove();
  ov.querySelector('#bmConfirm').onclick = async ()=>{
    const newGroupId = document.getElementById('bm_group').value || null;
    DATA.forEach(s=>{ if(selectedIds.has(s.id)) s.groupId = newGroupId; });
    await saveData();
    ov.remove();
    selectedIds.clear();
    showToast('تم نقل الطلاب بنجاح');
    renderGroupView();
  };
}

/* ============ Student modal (add/edit) ============ */
function openStudentModal(id, prefillBarcode, forcedGroupId){
  const existing = id ? DATA.find(s=>s.id===id) : null;
  const ov = document.createElement('div');
  ov.className='overlay';
  const groupIdVal = existing ? (existing.groupId||'') : (forcedGroupId||'');
  ov.innerHTML = `
    <div class="modal">
      <h3>${existing?'تعديل بيانات الطالب':'طالب جديد'}</h3>
      <div class="field"><label>اسم الطالب</label><input id="f_name" value="${existing?escapeHtml(existing.name):''}"></div>
      <div class="field"><label>كود الباركود</label>
        <div class="scan-mini">
          <input id="f_barcode" value="${existing?escapeHtml(existing.barcode):escapeHtml(prefillBarcode||'')}" placeholder="امسح الكارت هنا">
        </div>
      </div>
      <div class="field"><label>المجموعة</label>
        <select id="f_group">
          <option value="">بدون مجموعة</option>
          ${GROUPS.map(g=>`<option value="${g.id}" ${groupIdVal===g.id?'selected':''}>${escapeHtml(g.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>رقم تليفون الطالب</label><input id="f_phone" value="${existing?escapeHtml(existing.phone||''):''}"></div>
      <div class="field"><label>رقم تليفون ولي الأمر</label><input id="f_parent" value="${existing?escapeHtml(existing.parentPhone||''):''}"></div>
      <div class="field"><label>الاشتراك الشهري (جنيه)</label><input id="f_fee" type="number" value="${existing?existing.fee||'':''}"></div>
      <label style="display:flex; align-items:center; gap:8px; font-size:13px; margin:4px 0 12px;">
        <input type="checkbox" id="f_notify" ${(!existing || existing.notifyParent!==false)?'checked':''}> إرسال إخطارات الغياب لولي الأمر
      </label>
      <div class="field"><label>ملاحظات</label><textarea id="f_notes" rows="2">${existing?escapeHtml(existing.notes||''):''}</textarea></div>
      <div class="modal-actions">
        ${existing?'<button class="btn danger" id="delBtn">حذف نهائي</button><button class="btn outline" id="archBtn">📦 أرشفة</button>':''}
        <button class="btn outline" id="cancelBtn">إلغاء</button>
        <button class="btn gold" id="saveBtn">حفظ</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  document.getElementById('f_barcode').focus();
  ov.querySelector('#cancelBtn').onclick = ()=> ov.remove();
  ov.addEventListener('click', (e)=>{ if(e.target===ov) ov.remove(); });
  if(existing){
    ov.querySelector('#archBtn').onclick = async ()=>{
      if(!confirm(`تنقل "${existing.name}" للأرشيف؟ (بياناته وحضوره وفلوسه محفوظة وتقدر ترجّعه)`)) return;
      await archiveStudents([existing.id]);
      ov.remove(); showView('group'); renderGroupView();
      showToast('📦 اتنقل للأرشيف');
    };
    ov.querySelector('#delBtn').onclick = async ()=>{
      if(confirm('حذف نهائي؟ مش هتقدر ترجّع الطالب ده. (لو عايزه يرجع بعدين استخدم 📦 أرشفة بدل الحذف)')){
        DATA = DATA.filter(s=>s.id!==existing.id);
        await saveData();
        ov.remove();
        showView('group');
        renderGroupView();
        showToast('تم حذف الطالب');
      }
    };
  }
  ov.querySelector('#saveBtn').onclick = async ()=>{
    const name = document.getElementById('f_name').value.trim();
    const barcode = document.getElementById('f_barcode').value.trim();
    if(!name){ showToast('اكتب اسم الطالب'); return; }
    if(!barcode){ showToast('لازم كود باركود للطالب'); return; }
    const dup = DATA.find(s=> s.barcode===barcode && (!existing || s.id!==existing.id));
    if(dup){ showToast('هذا الكود مستخدم لطالب آخر بالفعل'); return; }
    const dupArch = ARCHIVE.find(s=> s.barcode===barcode);
    if(dupArch){ showToast(`الكود ده بتاع طالب في الأرشيف (${dupArch.name}) — استعيده أو غيّر الكود`); return; }
    const groupId = document.getElementById('f_group').value || null;
    const phone = document.getElementById('f_phone').value.trim();
    const parentPhone = document.getElementById('f_parent').value.trim();
    const fee = parseFloat(document.getElementById('f_fee').value) || 0;
    const notes = document.getElementById('f_notes').value.trim();
    const notifyParent = document.getElementById('f_notify').checked;
    let savedId;
    if(existing){
      Object.assign(existing, {name, barcode, groupId, phone, parentPhone, fee, notes, notifyParent});
      savedId = existing.id;
    }else{
      savedId = uid('s');
      DATA.push({ id: savedId, name, barcode, groupId, phone, parentPhone, fee, notes, notifyParent,
        createdAt: new Date().toISOString(), attendance:{}, payments:{}, grades:[], notified:{} });
    }
    if(IN_SESSION_UI && ACTIVE_SESSION && groupId && ACTIVE_SESSION.groupIds.includes(groupId)){
      const newStudent = DATA.find(x=>x.id===savedId);
      markPresentToday(newStudent);
      if(!sessionScanOrder.includes(savedId)) sessionScanOrder.unshift(savedId);
      await saveData();
      ov.remove();
      showToast('تم الحفظ وتسجيل الحضور');
      renderSessionView();
      return;
    }
    await saveData();
    ov.remove();
    showToast('تم الحفظ');
    currentGroupId = groupId;
    showView('group');
    renderGroupView();
  };
}

/* ============ Profile view ============ */
let currentMonth = new Date().getMonth();
let currentYear = new Date().getFullYear();
let payYear = new Date().getFullYear();

let profileReturnGroupId = null; // متبقّية للتوافق فقط؛ الرجوع الفعلي بقى بيعتمد على NAV_STACK
function openProfile(id){
  const s = DATA.find(x=>x.id===id);
  if(!s) return;
  pushCurrentView();
  profileReturnGroupId = IN_SESSION_UI ? '__session__' : (currentGroupId || s.groupId || null);
  currentMonth = new Date().getMonth();
  currentYear = new Date().getFullYear();
  payYear = new Date().getFullYear();
  currentProfileId = s.id;
  showView('profile');
  renderProfile(s.id);
}

function renderProfile(id){
  const s = DATA.find(x=>x.id===id);
  const g = getGroup(s.groupId);
  const view = document.getElementById('profileView');
  view.innerHTML = `
    <button class="btn outline" id="backBtn" style="margin-bottom:14px;">→ رجوع</button>
    <div class="card">
      <div class="profile-head">
        <div>
          <h2>${escapeHtml(s.name)}</h2>
          <div style="color:var(--ink-soft); font-size:13px;">كود الباركود: ${escapeHtml(s.barcode)} ${g?(' | مجموعة: '+escapeHtml(g.name)):' | بدون مجموعة'}</div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn outline" id="editBtn">✎ تعديل</button>
          <button class="btn outline" id="archiveProfileBtn">📦 أرشفة</button>
        </div>
      </div>
      <div class="info-grid">
        <div class="info-item"><div class="k">تليفون الطالب</div><div class="v">${escapeHtml(s.phone||'—')}</div></div>
        <div class="info-item"><div class="k">تليفون ولي الأمر</div><div class="v">${escapeHtml(s.parentPhone||'—')} ${s.notifyParent===false?'<span class="pill unpaid" style="font-size:10px;">الإخطارات موقوفة</span>':''}</div></div>
        <div class="info-item"><div class="k">الاشتراك الشهري</div><div class="v">${s.fee||0} ج.م</div></div>
        <div class="info-item"><div class="k">تاريخ التسجيل في السيستم</div><div class="v">${s.createdAt ? new Date(s.createdAt).toLocaleDateString('ar-EG', {day:'2-digit', month:'2-digit', year:'numeric'}) : 'تاريخ التسجيل غير متوفر'}</div></div>
      </div>
      ${s.notes?`<p style="margin-top:12px; font-size:13px; color:var(--ink-soft);">📝 ${escapeHtml(s.notes)}</p>`:''}
    </div>

    <div class="card">
      <div class="section-title"><span>📅 الحضور والغياب</span><div class="line"></div></div>
      <div class="month-nav">
        <button id="prevM">‹</button>
        <div class="mlabel" id="profileMlabel">${MONTHS[currentMonth]} ${currentYear}</div>
        <button id="nextM">›</button>
      </div>
      <div class="cal" id="calGrid"></div>
      <div class="legend">
        <span><i class="dot" style="background:var(--green-soft); border:1px solid var(--green);"></i>حاضر</span>
        <span><i class="dot" style="background:var(--red-soft); border:1px solid var(--red);"></i>غائب</span>
        <span><i class="dot" style="background:#1f2330; border:1px solid var(--rule);"></i>لم يُسجَّل</span>
      </div>
    </div>

    <div class="card">
      <div class="section-title"><span>📝 الدرجات</span><div class="line"></div></div>
      <button class="btn outline small" id="addGradeBtn" style="margin-bottom:10px;">➕ إضافة درجة</button>
      <div id="profileGrades"></div>
    </div>

    <div class="card">
      <div class="section-title"><span>💳 المدفوعات الشهرية</span><div class="line"></div></div>
      <div class="years" id="yearBtns">
        ${yearButtonsHtml(payYear)}
      </div>
      <div class="pay-grid" id="payGrid"></div>
    </div>
  `;
  document.getElementById('backBtn').onclick = goBack;
  document.getElementById('editBtn').onclick = ()=> openStudentModal(s.id, '', s.groupId);
  document.getElementById('archiveProfileBtn').onclick = async ()=>{
    if(!confirm(`تنقل "${s.name}" للأرشيف؟ (بياناته وحضوره وفلوسه محفوظة وتقدر ترجّعه)`)) return;
    await archiveStudents([s.id]);
    showToast('📦 اتنقل للأرشيف');
    NAV_STACK = []; showView('groups'); renderGroupsList();
  };
  document.getElementById('addGradeBtn').onclick = ()=> openSingleGradeModal(s);
  renderProfileGrades(s);
  document.getElementById('prevM').onclick = ()=>{ currentMonth--; if(currentMonth<0){currentMonth=11; currentYear--;} renderCalendar(s); };
  document.getElementById('nextM').onclick = ()=>{ currentMonth++; if(currentMonth>11){currentMonth=0; currentYear++;} renderCalendar(s); };
  renderCalendar(s);

  document.getElementById('yearBtns').querySelectorAll('button').forEach(b=>{
    if(parseInt(b.dataset.y)===payYear) b.classList.add('active');
    b.onclick = ()=>{ payYear = parseInt(b.dataset.y); renderProfile(s.id); };
  });
  renderPayGrid(s);
}

function renderCalendar(s){
  const profileLabel = document.getElementById('profileMlabel');
  if(profileLabel) profileLabel.textContent = `${MONTHS[currentMonth]} ${currentYear}`;
  const grid = document.getElementById('calGrid');
  const first = new Date(currentYear, currentMonth, 1);
  const daysInMonth = new Date(currentYear, currentMonth+1, 0).getDate();
  const offset = (first.getDay()+1)%7;
  let html = DOW.map(d=>`<div class="dow">${d}</div>`).join('');
  for(let i=0;i<offset;i++) html += `<div class="day blank"></div>`;
  for(let d=1; d<=daysInMonth; d++){
    const key = `${currentYear}-${String(currentMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const status = (s.attendance||{})[key];
    const cls = status==='present'?'present':status==='absent'?'absent':'';
    const mark = status==='present'?'✔':status==='absent'?'✕':'';
    html += `<div class="day ${cls}" data-key="${key}">${d}<span class="mark">${mark}</span></div>`;
  }
  grid.innerHTML = html;
  grid.querySelectorAll('.day:not(.blank)').forEach(cell=>{
    cell.onclick = async ()=>{
      const key = cell.dataset.key;
      s.attendance = s.attendance || {};
      const cur = s.attendance[key];
      const next = cur===undefined ? 'present' : cur==='present' ? 'absent' : undefined;
      if(next===undefined) delete s.attendance[key]; else s.attendance[key]=next;
      await saveData();
      renderCalendar(s);
    };
  });
}

function renderPayGrid(s){
  const grid = document.getElementById('payGrid');
  grid.innerHTML = MONTHS.map((mName, idx)=>{
    const ym = `${payYear}-${String(idx+1).padStart(2,'0')}`;
    const i = payInfo(s, ym);
    const amtTxt = i.settled ? (i.exempt ? 'معفى' : ('دُفع '+i.received+' ج.م')) : i.partial ? `جزئي ${i.received}/${i.due} ج.م` : (i.due ? i.due+' ج.م' : '—');
    return `
      <div class="pay-cell ${i.settled?'paid':''}" data-ym="${ym}">
        <div class="m">${mName}</div>
        <div class="amt">${amtTxt}</div>
        ${i.settled?`<div class="stamp">${i.exempt?'معفى':'مدفوع'}<small>${i.date||''}</small></div>`:''}
        ${i.partial?`<div style="font-size:11px;color:var(--gold);">متبقي ${i.remaining}</div>`:''}
      </div>`;
  }).join('');
  grid.querySelectorAll('.pay-cell').forEach(cell=>{
    cell.onclick = ()=> openPaymentModal(s, cell.dataset.ym, ()=>renderPayGrid(s));
  });
}

/* ============ Months / attendance ranking view ============ */
let monthsYear = new Date().getFullYear();
let monthsMonth = new Date().getMonth();
let monthsGroupId = undefined; // undefined => لسه في شاشة اختيار المجموعة
let monthsSubView = 'day';     // 'day' = غياب يوم محدد | 'full' = غياب الشهر كاملًا
let monthsSelectedDate = null; // التاريخ المختار في وضع "يوم محدد"

function renderMonths(){
  const view = document.getElementById('monthsView');
  view.innerHTML = `
    <div class="section-title"><span>📅 غياب الطلاب بالشهر</span><div class="line"></div></div>
    <div class="card">
      <div class="month-nav" style="margin-bottom:0;">
        <button id="moPrevM">‹</button>
        <div class="mlabel" id="moMlabel"></div>
        <button id="moNextM">›</button>
      </div>
    </div>
    <div id="monthsBody"></div>
  `;
  document.getElementById('moMlabel').textContent = `${MONTHS[monthsMonth]} ${monthsYear}`;
  document.getElementById('moPrevM').onclick = ()=>{ monthsMonth--; if(monthsMonth<0){monthsMonth=11; monthsYear--;} monthsSelectedDate=null; renderMonths(); };
  document.getElementById('moNextM').onclick = ()=>{ monthsMonth++; if(monthsMonth>11){monthsMonth=0; monthsYear++;} monthsSelectedDate=null; renderMonths(); };
  renderMonthsBody();
}

function renderMonthsBody(){
  const body = document.getElementById('monthsBody');

  if(monthsGroupId===undefined){
    const unassigned = DATA.filter(s=>!s.groupId || !getGroup(s.groupId));
    if(GROUPS.length===0 && unassigned.length===0){
      body.innerHTML = `<div class="empty">لا يوجد طلاب أو مجموعات بعد.</div>`;
      return;
    }
    let html = `<div class="group-grid">` + GROUPS.map(g=>{
      const members = DATA.filter(s=>s.groupId===g.id);
      const ymPrefix = `${monthsYear}-${String(monthsMonth+1).padStart(2,'0')}`;
      const gDates = groupSessionDatesInMonth(members, ymPrefix);
      const lastDate = gDates[gDates.length-1];
      const absentNow = lastDate ? members.filter(s=>(s.attendance||{})[lastDate]==='absent').length : 0;
      return `
      <div class="group-card" data-id="${g.id}">
        <div class="gcard-top">
          <div class="gcard-icon">📅</div>
          <div>
            <div class="gname">${escapeHtml(g.name)}</div>
            <div class="gsched">${escapeHtml(groupLabel(g)) || 'بدون معاد محدد'}</div>
          </div>
        </div>
        <div class="gstats">
          <span>👥 ${members.length} طالب</span>
          ${lastDate ? `<span class="pill ${absentNow?'unpaid':'paid'}">${absentNow ? `🔴 ${absentNow} غايب آخر حصة` : '✔ كلهم حضروا آخر حصة'}</span>` : ''}
        </div>
      </div>`;
    }).join('');
    if(unassigned.length){
      const ymPrefix = `${monthsYear}-${String(monthsMonth+1).padStart(2,'0')}`;
      const uDates = groupSessionDatesInMonth(unassigned, ymPrefix);
      const uLastDate = uDates[uDates.length-1];
      const uAbsentNow = uLastDate ? unassigned.filter(s=>(s.attendance||{})[uLastDate]==='absent').length : 0;
      html += `
      <div class="group-card" data-id="__none__">
        <div class="gcard-top">
          <div class="gcard-icon">👥</div>
          <div>
            <div class="gname">غير مصنّفين</div>
            <div class="gsched">طلاب من غير مجموعة</div>
          </div>
        </div>
        <div class="gstats">
          <span>👥 ${unassigned.length} طالب</span>
          ${uLastDate ? `<span class="pill ${uAbsentNow?'unpaid':'paid'}">${uAbsentNow ? `🔴 ${uAbsentNow} غايب آخر حصة` : '✔ كلهم حضروا آخر حصة'}</span>` : ''}
        </div>
      </div>`;
    }
    html += `</div>`;
    body.innerHTML = html;
    body.querySelectorAll('.group-card').forEach(c=>{
      c.onclick = ()=>{ pushCurrentView(); monthsGroupId = c.dataset.id; monthsSubView='day'; monthsSelectedDate=null; renderMonthsBody(); };
    });
    return;
  }

  const g = monthsGroupId==='__none__' ? null : getGroup(monthsGroupId);
  const title = g ? g.name : 'غير مصنّفين';
  const members = DATA.filter(s=> monthsGroupId==='__none__' ? (!s.groupId || !getGroup(s.groupId)) : s.groupId===monthsGroupId)
                       .sort((a,b)=>a.name.localeCompare(b.name,'ar'));
  const ymPrefix = `${monthsYear}-${String(monthsMonth+1).padStart(2,'0')}`;
  const sessionDates = groupSessionDatesInMonth(members, ymPrefix); // تصاعديًا — دي "الحصص الفعلية" في الشهر ده

  let html = `<button class="btn outline" id="backToMonthsGroups" style="margin:14px 0;">→ رجوع</button>`;
  html += `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
      <div>
        <h2 style="margin:0 0 4px;">${escapeHtml(title)}</h2>
        <div style="color:var(--ink-soft);font-size:13px;">${MONTHS[monthsMonth]} ${monthsYear} — ${sessionDates.length} حصة فعلية متسجّلة</div>
      </div>
      <button class="btn gold" id="downloadMonthBtn" ${sessionDates.length?'':'disabled'}>⬇ تحميل غياب الشهر</button>
    </div>
    <div class="card" style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn ${monthsSubView==='day'?'gold':'outline'}" id="modeDayBtn">📅 غياب يوم محدد</button>
      <button class="btn ${monthsSubView==='full'?'gold':'outline'}" id="modeFullBtn">🗓 غياب الشهر كاملًا</button>
    </div>`;

  body.innerHTML = html + `<div id="monthsSubBody"></div>`;
  document.getElementById('backToMonthsGroups').onclick = goBack;
  document.getElementById('downloadMonthBtn').onclick = ()=> downloadMonthAttendance(title, members, sessionDates);
  document.getElementById('modeDayBtn').onclick = ()=>{ monthsSubView='day'; renderMonthsBody(); };
  document.getElementById('modeFullBtn').onclick = ()=>{ monthsSubView='full'; renderMonthsBody(); };

  if(members.length===0){
    document.getElementById('monthsSubBody').innerHTML = `<div class="empty">لا يوجد طلاب في هذه المجموعة.</div>`;
  }else if(!sessionDates.length){
    document.getElementById('monthsSubBody').innerHTML = `<div class="empty">لا توجد حصص مسجّلة لهذه المجموعة في ${MONTHS[monthsMonth]} ${monthsYear}.</div>`;
  }else if(monthsSubView==='day'){
    renderMonthsDayView(members, sessionDates);
  }else{
    renderMonthsFullView(members, sessionDates);
  }
}

// وضع "غياب يوم محدد": تختار تاريخ من ضمن أيام الحصص الفعلية بس، وتشوف مين غاب فيه
function renderMonthsDayView(members, sessionDates){
  if(!monthsSelectedDate || !sessionDates.includes(monthsSelectedDate)) monthsSelectedDate = sessionDates[sessionDates.length-1];
  const idx = sessionDates.indexOf(monthsSelectedDate);
  const box = document.getElementById('monthsSubBody');
  box.innerHTML = `
    <div class="card">
      <div class="month-nav">
        <button id="moPrevDay" ${idx<=0?'disabled':''}>‹ حصة أقدم</button>
        <select id="moDaySelect" style="flex:1;text-align:center;">
          ${sessionDates.slice().reverse().map((d,i)=>`<option value="${d}" ${d===monthsSelectedDate?'selected':''}>حصة ${sessionDates.length-i} — ${escapeHtml(prettyDate(d))}</option>`).join('')}
        </select>
        <button id="moNextDay" ${idx>=sessionDates.length-1?'disabled':''}>حصة أحدث ›</button>
      </div>
    </div>
    <div id="moDayTable"></div>`;
  box.querySelector('#moPrevDay').onclick = ()=>{ if(idx>0){ monthsSelectedDate=sessionDates[idx-1]; renderMonthsDayView(members, sessionDates); } };
  box.querySelector('#moNextDay').onclick = ()=>{ if(idx<sessionDates.length-1){ monthsSelectedDate=sessionDates[idx+1]; renderMonthsDayView(members, sessionDates); } };
  box.querySelector('#moDaySelect').onchange = (e)=>{ monthsSelectedDate=e.target.value; renderMonthsDayView(members, sessionDates); };

  const sessionNum = idx+1;
  const absentToday = members.filter(s=>(s.attendance||{})[monthsSelectedDate]==='absent');
  const tbl = document.getElementById('moDayTable');
  if(!absentToday.length){
    tbl.innerHTML = `<div class="card"><div class="empty">محدش غاب في حصة ${sessionNum} (${escapeHtml(prettyDate(monthsSelectedDate))}) 👏</div></div>`;
    return;
  }
  tbl.innerHTML = `<div class="student-list">` + absentToday.map(s=>`
    <div class="student-row" data-id="${s.id}">
      <div><div class="name">${escapeHtml(s.name)}</div><div class="meta">📞 ${escapeHtml(s.phone||'—')}</div></div>
      <span class="pill unpaid">حصة ${sessionNum} — غائب</span>
    </div>`).join('') + `</div>`;
  tbl.querySelectorAll('.student-row').forEach(row=> row.onclick = ()=>openProfile(row.dataset.id));
}

// وضع "غياب الشهر كاملًا": جدول — الأعمدة هي أيام الحصص الفعلية بالترتيب، والصفوف الطلاب
function renderMonthsFullView(members, sessionDates){
  const box = document.getElementById('monthsSubBody');
  const headCols = sessionDates.map((d,i)=>`<th title="${escapeHtml(prettyDate(d))}">حصة ${i+1}<br><span style="font-weight:400;opacity:.7;">${d.slice(5)}</span></th>`).join('');
  const bodyRows = members.map(s=>{
    const att = s.attendance||{};
    const cells = sessionDates.map(d=>{
      const v = att[d];
      const mark = v==='present' ? `<span style="color:var(--green);font-weight:800;">✓</span>`
                 : v==='absent' ? `<span style="color:var(--red);font-weight:800;">✗</span>`
                 : `<span style="color:var(--ink-soft);">–</span>`;
      return `<td style="text-align:center;">${mark}</td>`;
    }).join('');
    return `<tr><td>${escapeHtml(s.name)}</td>${cells}</tr>`;
  }).join('');
  box.innerHTML = `<div class="card" style="overflow:auto;">
    <table class="income-table">
      <thead><tr><th>الطالب</th>${headCols}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </div>`;
}

// تصدير Excel لغياب الشهر بالكامل — عمود لكل حصة فعلية بتاريخها
function downloadMonthAttendance(title, members, sessionDates){
  const safeTitle = title.replace(/[\\/:*?"<>|]/g,'_');
  const rows = members.map(s=>{
    const att = s.attendance||{};
    const row = { 'اسم الطالب': s.name||'', 'رقم الهاتف': s.phone||'' };
    sessionDates.forEach((d,i)=>{
      const v = att[d];
      row[`حصة ${i+1} (${d})`] = v==='present' ? 'حاضر' : v==='absent' ? 'غايب' : '';
    });
    return row;
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{wch:26},{wch:16}, ...sessionDates.map(()=>({wch:16}))];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'غياب الشهر');
  XLSX.writeFile(wb, `غياب_${safeTitle}_${MONTHS[monthsMonth]}_${monthsYear}.xlsx`);
  showToast('تم تحميل ملف غياب الشهر ✔');
}

/* ============ Income view ============ */
let incomeYear = new Date().getFullYear();
let incomeMonth = new Date().getMonth();

function renderIncome(){
  const view = document.getElementById('incomeView');
  view.innerHTML = `
    <div class="section-title"><span>💰 الدخل الشهري</span><div class="line"></div><button class="btn outline small" id="incExportBtn" title="تحميل تفاصيل الدفع (Excel) مقسّمة على المجموعات">📥 تفاصيل الدفع</button></div>
    <div class="card">
      <div class="years" id="incYearBtns">
        ${yearButtonsHtml(incomeYear)}
      </div>
      <div class="month-nav" style="margin-bottom:6px;">
        <button id="incPrevM">‹</button>
        <div class="mlabel" id="incMlabel"></div>
        <button id="incNextM">›</button>
      </div>
      <div class="big-total" id="incTotal">0 ج.م</div>
      <div style="text-align:center; color:var(--ink-soft); font-size:12px;" id="incSub"></div>
    </div>
    <div class="card">
      <div class="section-title" style="margin-top:0;"><span>توزيع الدخل على المجموعات</span><div class="line"></div></div>
      <table class="income-table" id="incTable"></table>
    </div>
    <div class="card">
      <div class="section-title" style="margin-top:0;"><span>💳 تفاصيل الدفع حسب المجموعة</span><div class="line"></div></div>
      <div id="incPayDetails"></div>
    </div>
    <div class="card">
      <div class="section-title" style="margin-top:0;"><span style="color:var(--green);">✅ دفعوا الشهر ده</span><div class="line"></div></div>
      <div id="incPaidList"></div>
    </div>
    <div class="card">
      <div class="section-title" style="margin-top:0;"><span style="color:var(--red);">❌ لسه مدفعوش</span><div class="line"></div></div>
      <div id="incUnpaidList"></div>
    </div>
  `;
  document.getElementById('incYearBtns').querySelectorAll('button').forEach(b=>{
    if(parseInt(b.dataset.y)===incomeYear) b.classList.add('active');
    b.onclick = ()=>{ incomeYear = parseInt(b.dataset.y); renderIncomeData(); document.querySelectorAll('#incYearBtns button').forEach(x=>x.classList.toggle('active', parseInt(x.dataset.y)===incomeYear)); };
  });
  document.getElementById('incExportBtn').onclick = ()=> openPaymentExportModal(undefined, {year:incomeYear, month:incomeMonth});
  document.getElementById('incPrevM').onclick = ()=>{ incomeMonth--; if(incomeMonth<0){incomeMonth=11; incomeYear--;} renderIncome(); };
  document.getElementById('incNextM').onclick = ()=>{ incomeMonth++; if(incomeMonth>11){incomeMonth=0; incomeYear++;} renderIncome(); };
  renderIncomeData();
}

function renderIncomeData(){
  document.getElementById('incMlabel').textContent = `${MONTHS[incomeMonth]} ${incomeYear}`;
  const ym = `${incomeYear}-${String(incomeMonth+1).padStart(2,'0')}`;
  let total = 0, paidCount = 0;
  const perGroup = {};
  GROUPS.forEach(g=> perGroup[g.id] = { id:g.id, name:g.name, total:0, paid:0, count:0 });
  perGroup['__none__'] = { id:'__none__', name:'غير مصنّفين', total:0, paid:0, count:0 };

  DATA.forEach(s=>{
    const key = (s.groupId && getGroup(s.groupId)) ? s.groupId : '__none__';
    perGroup[key].count++;
    const pi = payInfo(s, ym);
    total += pi.received;
    perGroup[key].total += pi.received;
    if(pi.settled){ paidCount++; perGroup[key].paid++; }
  });
  document.getElementById('incTotal').textContent = total.toLocaleString('ar-EG') + ' ج.م';
  document.getElementById('incSub').textContent = `${paidCount} من ${DATA.length} طالب دفعوا في هذا الشهر`;

  const rows = Object.values(perGroup).filter(g=>g.count>0);
  const table = document.getElementById('incTable');
  if(rows.length===0){
    table.innerHTML = `<tr><td class="empty">لا يوجد طلاب بعد</td></tr>`;
  }else{
    table.innerHTML = `
      <tr><th>المجموعة</th><th>عدد الطلاب</th><th>دفعوا</th><th>الإجمالي</th><th></th></tr>
      ${rows.map(r=>`<tr><td>${escapeHtml(r.name)}</td><td>${r.count}</td><td>${r.paid}</td><td class="amt">${r.total.toLocaleString('ar-EG')} ج.م</td><td><button class="btn outline small" data-pay-gid="${escapeHtml(r.id)}" title="تحميل تفاصيل دفع المجموعة دي">📥</button></td></tr>`).join('')}
    `;
    table.querySelectorAll('[data-pay-gid]').forEach(b=>{
      b.onclick = ()=> openPaymentExportModal(b.dataset.payGid, {year:incomeYear, month:incomeMonth});
    });
  }

  renderIncomePaymentDetails(ym);
  renderIncomePaymentLists(ym);
}

function renderIncomePaymentDetails(ym){
  const box = document.getElementById('incPayDetails');
  if(!box) return;
  const scopes = paymentScopes(undefined).filter(sc=>sc.members.length);
  if(!scopes.length){ box.innerHTML = `<div class="empty">لا يوجد طلاب بعد</div>`; return; }
  box.innerHTML = scopes.map(sc=>{
    const { rows, total, paidCount } = paymentTableRows(sc.members, ym, true);
    return `<details open style="margin-bottom:14px;">
      <summary style="cursor:pointer;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-weight:800;padding:6px 0;">
        <span>${escapeHtml(sc.name)}</span>
        <span class="pill warn">${paidCount}/${sc.members.length} سدّدوا</span>
        <span class="pill paid">${total.toLocaleString('ar-EG')} ج.م</span>
        <button class="btn outline small" data-dl-gid="${escapeHtml(sc.id)}" style="margin-right:auto;" title="تحميل تفاصيل المجموعة دي">📥 تحميل</button>
      </summary>
      <div style="overflow:auto;"><table class="income-table">
        <tr><th>الطالب</th><th>تليفونه</th><th>ولي الأمر</th><th>الحالة</th><th>المبلغ</th><th>تاريخ الدفع</th><th></th></tr>${rows}
      </table></div>
    </details>`;
  }).join('');
  box.querySelectorAll('[data-dl-gid]').forEach(b=>{
    b.onclick = (e)=>{ e.preventDefault(); e.stopPropagation(); openPaymentExportModal(b.dataset.dlGid, {year:incomeYear, month:incomeMonth}); };
  });
  box.querySelectorAll('[data-prof]').forEach(td=> td.onclick = ()=> openProfile(td.dataset.prof));
  box.querySelectorAll('[data-payid]').forEach(b=> b.onclick = ()=>{
    const s = DATA.find(x=>x.id===b.dataset.payid); if(s) openPaymentModal(s, ym, ()=>renderIncomeData());
  });
}

function renderIncomePaymentLists(ym){
  const paidByGroup = {};
  const unpaidByGroup = {};
  GROUPS.forEach(g=>{ paidByGroup[g.id] = { name:g.name, students:[] }; unpaidByGroup[g.id] = { name:g.name, students:[] }; });
  paidByGroup['__none__'] = { name:'غير مصنّفين', students:[] };
  unpaidByGroup['__none__'] = { name:'غير مصنّفين', students:[] };

  const ymPrefix = ym; // "YYYY-MM"
  function presentCount(s){
    const att = s.attendance || {};
    let n = 0;
    Object.keys(att).forEach(k=>{ if(k.startsWith(ymPrefix) && att[k]==='present') n++; });
    return n;
  }

  DATA.forEach(s=>{
    const key = (s.groupId && getGroup(s.groupId)) ? s.groupId : '__none__';
    const pay = s.payments && s.payments[ym];
    if(pay && pay.paid) paidByGroup[key].students.push(s);
    else unpaidByGroup[key].students.push(s);
  });

  function buildGroupsHtml(byGroup, emptyMsg, cls, showAttendance){
    const groups = Object.values(byGroup).filter(g=>g.students.length>0);
    if(groups.length===0) return `<p class="empty" style="margin:6px 0; color:var(--ink-soft); font-size:13px;">${emptyMsg}</p>`;
    return groups.map(g=>`
      <div style="margin-bottom:14px;">
        <div style="font-family:'JetBrains Mono',monospace; font-size:12px; color:var(--ink-soft); margin-bottom:6px;">${escapeHtml(g.name)} <span style="color:var(--ink-soft);">(${g.students.length})</span></div>
        <div class="student-list">
          ${g.students.map(s=>`
            <div class="student-row" style="cursor:default;">
              <div>
                <div class="name">${escapeHtml(s.name)}</div>
                <div class="meta">${s.fee?s.fee+' ج.م':'—'}</div>
              </div>
              <div style="display:flex; align-items:center; gap:8px;">
                ${showAttendance?`<span class="pill warn">حضر ${presentCount(s)} حصة</span>`:''}
                <span class="pill ${cls}">${cls==='paid'?'مدفوع':'غير مدفوع'}</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');
  }

  document.getElementById('incPaidList').innerHTML = buildGroupsHtml(paidByGroup, 'محدش دفع لسه الشهر ده.', 'paid', false);
  document.getElementById('incUnpaidList').innerHTML = buildGroupsHtml(unpaidByGroup, 'الكل دفع الشهر ده 🎉', 'unpaid', true);
}

/* ============ Payments v2: دفعات متعددة + إيصالات + متأخرات + تصدير ============
   شكل السجل: payments[ym] = { paid, amount, date, due, exempt, entries:[{id,amount,date,note,no}] }
   paid/amount/date حقول مجمّعة بتتحدّث أوتوماتيك (باقي البرنامج بيقراها زي ما هي).
   السجلات القديمة {paid,amount,date} شغالة زي ما هي وبتتحوّل تلقائيًا أول ما تفتحها. */
let grpPayYear = new Date().getFullYear();
let grpPayMonth = new Date().getMonth();

function payYm(y, m){ return `${y}-${String(m+1).padStart(2,'0')}`; }
function ymLabel(ym){ const [y,m] = ym.split('-').map(Number); return `${MONTHS[m-1]} ${y}`; }
function ymAdd(ym, n){
  let [y,m] = ym.split('-').map(Number);
  m += n; y += Math.floor((m-1)/12); m = (((m-1)%12)+12)%12 + 1;
  return `${y}-${String(m).padStart(2,'0')}`;
}
function monthsBetween(startYm, endYm){
  const out = []; let cur = startYm;
  while(cur <= endYm && out.length < 240){ out.push(cur); cur = ymAdd(cur, 1); }
  return out;
}

function payEntries(pay){
  if(!pay) return [];
  if(Array.isArray(pay.entries)) return pay.entries;
  const amt = Number(pay.amount)||0;
  return (pay.paid && amt>0) ? [{ id:'legacy', amount:amt, date:pay.date||'', note:'' }] : [];
}
function payInfo(s, ym){
  const pay = (s.payments||{})[ym];
  const entries = payEntries(pay);
  const received = entries.reduce((a,e)=>a+(Number(e.amount)||0), 0);
  const exempt = !!(pay && pay.exempt);
  const due = (pay && pay.due!=null && pay.due!=='') ? (Number(pay.due)||0) : (Number(s.fee)||0);
  const legacyPaid = !!(pay && pay.paid && !Array.isArray(pay.entries));
  const settled = exempt || legacyPaid || (due>0 ? received>=due : received>0);
  const dates = entries.map(e=>e.date).filter(Boolean).sort();
  return { rec:!!pay, entries, received, due, exempt, settled, partial:(!settled && received>0),
           remaining: settled ? 0 : Math.max(0, due-received), date: dates[dates.length-1]||'', dates };
}
// يعيد حساب الحقول المجمّعة بعد أي تعديل، ويمسح السجل لو بقى فاضي
function syncPayRecord(s, ym){
  const pay = (s.payments||{})[ym]; if(!pay) return;
  const entries = Array.isArray(pay.entries) ? pay.entries : [];
  if(!entries.length && !pay.exempt){ delete s.payments[ym]; return; }
  const i = payInfo(s, ym);
  pay.paid = i.settled; pay.amount = i.received; pay.date = i.date || '';
}
function payStatusPill(i){
  if(i.settled) return `<span class="pill paid">${i.exempt?'معفى':'مدفوع'}</span>`;
  if(i.partial) return `<span class="pill warn">جزئي</span>`;
  return `<span class="pill unpaid">غير مدفوع</span>`;
}
function payStatusText(i){ return i.settled ? (i.exempt?'معفى':'مدفوع') : i.partial ? 'جزئي' : 'غير مدفوع'; }

/* ---------- نافذة تسجيل/تعديل الدفع ---------- */
function openPaymentModal(s, ym, onDone){
  s.payments = s.payments || {};
  const old = s.payments[ym];
  if(old && !Array.isArray(old.entries)){          // ترقية سجل قديم بدون تغيير حالته
    const amt = Number(old.amount)||0;
    old.entries = (old.paid && amt>0) ? [{ id:uid('p'), amount:amt, date:old.date||'', note:'' }] : [];
    if(old.paid){ if(amt>0) old.due = amt; else old.exempt = true; }
  }
  let dueDraft = null;
  const ov = document.createElement('div'); ov.className = 'overlay';
  document.body.appendChild(ov);
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.remove(); });
  const getRec = ()=>{ if(!s.payments[ym]) s.payments[ym] = { paid:false, amount:0, date:'', due:Number(s.fee)||0, entries:[] }; return s.payments[ym]; };
  async function commit(msg){
    syncPayRecord(s, ym);
    await saveData();
    if(onDone) onDone();
    render();
    if(msg) showToast(msg);
  }
  function render(){
    const i = payInfo(s, ym);
    const shownDue = dueDraft!=null ? dueDraft : i.due;
    const entriesHtml = i.entries.length ? i.entries.map(e=>`
      <div class="student-row" style="cursor:default; padding:8px 10px;">
        <div><div class="name">${(Number(e.amount)||0).toLocaleString('ar-EG')} ج.م ${e.no?`<span style="color:var(--ink-soft);font-size:11px;">إيصال #${String(e.no).padStart(4,'0')}</span>`:''}</div>
          <div class="meta">📅 ${escapeHtml(e.date||'بدون تاريخ')}${e.note?` — ${escapeHtml(e.note)}`:''}</div></div>
        <div style="display:flex; gap:6px;">
          <button class="btn outline small" data-act="print" data-id="${e.id}" title="طباعة إيصال">🧾</button>
          <button class="btn outline small" data-act="wa" data-id="${e.id}" title="إرسال الإيصال واتساب">📲</button>
          <button class="btn danger small" data-act="del" data-id="${e.id}" title="حذف الدفعة">🗑</button>
        </div>
      </div>`).join('') : `<div class="empty" style="padding:10px;">مفيش دفعات متسجّلة للشهر ده</div>`;
    ov.innerHTML = `
      <div class="modal">
        <div class="modal-head"><h3>💳 ${escapeHtml(s.name)} — ${ymLabel(ym)}</h3><button class="close" id="pmClose">×</button></div>
        <div class="modal-body">
          <div class="stats-row">
            <div class="stat"><div class="num">${shownDue.toLocaleString('ar-EG')}</div><div class="lbl">المطلوب</div></div>
            <div class="stat"><div class="num" style="color:var(--green)">${i.received.toLocaleString('ar-EG')}</div><div class="lbl">المدفوع</div></div>
            <div class="stat"><div class="num" style="color:var(--red)">${(i.exempt?0:Math.max(0,shownDue-i.received)).toLocaleString('ar-EG')}</div><div class="lbl">المتبقي</div></div>
          </div>
          <div class="field"><label>المطلوب لهذا الشهر (جنيه) — عدّله لو فيه خصم</label>
            <input id="pmDue" type="number" min="0" step="0.01" value="${shownDue}"></div>
          <label style="display:flex; align-items:center; gap:8px; font-size:13px;">
            <input type="checkbox" id="pmExempt" ${i.exempt?'checked':''}> معفى من دفع هذا الشهر
          </label>
          <div class="student-list">${entriesHtml}</div>
          <div class="section-title" style="margin:10px 0 0;"><span>➕ تسجيل دفعة</span><div class="line"></div></div>
          <div class="field"><label>المبلغ (جنيه)</label>
            <input id="pmAmt" type="number" min="0" step="0.01" value="${i.remaining>0 ? i.remaining : (i.settled ? '' : (shownDue||''))}"></div>
          <div class="field"><label>تاريخ الدفع الفعلي</label><input id="pmDate" type="date" value="${todayKey()}"></div>
          <div class="field"><label>ملاحظة (اختياري)</label><input id="pmNote" placeholder="كاش / فودافون كاش / قسط أول..."></div>
          <button class="btn gold" id="pmAdd">💾 تسجيل الدفعة</button>
        </div>
      </div>`;
    ov.querySelector('#pmClose').onclick = ()=> ov.remove();
    ov.querySelector('#pmDue').onchange = async (e)=>{
      const v = Math.max(0, Number(e.target.value)||0);
      const hasRec = !!s.payments[ym];
      if(hasRec){ s.payments[ym].due = v; dueDraft = null; await commit(); } else { dueDraft = v; render(); }
    };
    ov.querySelector('#pmExempt').onchange = async (e)=>{
      if(e.target.checked){ const r = getRec(); r.exempt = true; if(dueDraft!=null) r.due = dueDraft; }
      else if(s.payments[ym]) s.payments[ym].exempt = false;
      await commit(e.target.checked ? 'اتسجّل الشهر معفى' : null);
    };
    ov.querySelector('#pmAdd').onclick = async ()=>{
      const amount = Number(ov.querySelector('#pmAmt').value);
      const date = ov.querySelector('#pmDate').value;
      const note = ov.querySelector('#pmNote').value.trim();
      if(!Number.isFinite(amount) || amount<=0){ showToast('اكتب مبلغًا صحيحًا'); return; }
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){ showToast('اختار تاريخ الدفع'); return; }
      const rec = getRec();
      if(dueDraft!=null){ rec.due = dueDraft; dueDraft = null; }
      SETTINGS.receiptSeq = (Number(SETTINGS.receiptSeq)||0) + 1;
      rec.entries.push({ id:uid('p'), amount, date, note, no:SETTINGS.receiptSeq });
      await commit('تم تسجيل الدفعة: '+amount+' جنيه');
    };
    ov.querySelectorAll('[data-act]').forEach(btn=>{
      btn.onclick = async ()=>{
        const rec = s.payments[ym]; if(!rec) return;
        const entry = rec.entries.find(x=>x.id===btn.dataset.id); if(!entry) return;
        if(btn.dataset.act==='print') printReceipt(s, ym, entry);
        else if(btn.dataset.act==='wa') sendReceiptWhatsApp(s, ym, entry);
        else if(btn.dataset.act==='del'){
          if(!confirm('حذف الدفعة دي؟')) return;
          rec.entries = rec.entries.filter(x=>x.id!==entry.id);
          await commit('تم حذف الدفعة');
        }
      };
    });
  }
  render();
}

/* ---------- الإيصالات ---------- */
function receiptText(s, ym, e){
  const i = payInfo(s, ym), g = getGroup(s.groupId);
  return `إيصال دفع${e.no?(' رقم '+String(e.no).padStart(4,'0')):''}\nالطالب: ${s.name}\n${g?('المجموعة: '+g.name+'\n'):''}الشهر: ${ymLabel(ym)}\nالمبلغ: ${e.amount} جنيه\nالتاريخ: ${e.date||'—'}\n${i.remaining>0?('المتبقي: '+i.remaining+' جنيه\n'):'✔ تم سداد الشهر بالكامل\n'}${SETTINGS.teacherName||''}`;
}
function sendReceiptWhatsApp(s, ym, e){
  const ph = normalizePhone(s.parentPhone) || normalizePhone(s.phone);
  if(!ph){ showToast('مفيش رقم صالح للواتساب للطالب ده'); return; }
  window.open(`https://wa.me/${ph}?text=${encodeURIComponent(receiptText(s, ym, e))}`, '_blank');
}
function printReceipt(s, ym, e){
  const i = payInfo(s, ym), g = getGroup(s.groupId);
  const w = window.open('', '_blank', 'width=440,height=680');
  if(!w){ showToast('المتصفح منع النافذة — اسمح بالنوافذ المنبثقة (pop-ups)'); return; }
  const row = (k,v)=>`<div class="row"><span>${k}</span><b>${escapeHtml(v)}</b></div>`;
  w.document.write(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>إيصال دفع</title>
  <style>body{font-family:Tahoma,Arial,sans-serif;padding:24px;max-width:380px;margin:auto;color:#111}h2{text-align:center;margin:0 0 4px}
  .sub{text-align:center;color:#666;font-size:13px;margin-bottom:18px}.row{display:flex;justify-content:space-between;border-bottom:1px dashed #bbb;padding:9px 0;font-size:14px}
  .amt{font-size:24px;font-weight:700;text-align:center;margin:18px 0}.foot{text-align:center;color:#666;font-size:12px;margin-top:22px}
  @media print{.noprint{display:none}}</style></head><body>
  <h2>إيصال دفع</h2><div class="sub">${escapeHtml(SETTINGS.teacherName||'')}${e.no?` — رقم ${String(e.no).padStart(4,'0')}`:''}</div>
  ${row('الطالب', s.name)}${g?row('المجموعة', g.name):''}${row('الشهر', ymLabel(ym))}${row('تاريخ الدفع', e.date||'—')}${e.note?row('ملاحظة', e.note):''}
  <div class="amt">${Number(e.amount).toLocaleString('ar-EG')} جنيه</div>
  ${i.remaining>0 ? row('المتبقي من الشهر', i.remaining+' جنيه') : '<div style="text-align:center;color:#157347;font-weight:700;">✔ تم سداد الشهر بالكامل</div>'}
  <div class="foot">شكرًا لكم</div>
  <script>window.onload=function(){setTimeout(function(){window.print();},250);}<\/script></body></html>`);
  w.document.close();
}

/* ---------- تفاصيل الدفع (شاشة المجموعة + الدخل + التصدير) ---------- */
function paymentMembersFor(groupId){
  const list = (groupId==='__none__')
    ? DATA.filter(s=>!s.groupId || !getGroup(s.groupId))
    : DATA.filter(s=>s.groupId===groupId);
  return list.slice().sort((a,b)=>(a.name||'').localeCompare(b.name||'','ar'));
}
// groupId === undefined => كل المجموعات (+ غير المصنفين لو موجودين)
function paymentScopes(groupId){
  if(groupId!==undefined){
    const g = groupId==='__none__' ? null : getGroup(groupId);
    return [{ id:groupId, name: g ? g.name : 'غير مصنّفين', members: paymentMembersFor(groupId) }];
  }
  const scopes = GROUPS.map(g=>({ id:g.id, name:g.name, members:paymentMembersFor(g.id) }));
  const none = paymentMembersFor('__none__');
  if(none.length) scopes.push({ id:'__none__', name:'غير مصنّفين', members:none });
  return scopes;
}
function paidInfo(s, ym){
  const i = payInfo(s, ym);
  return { paid:i.settled, partial:i.partial, exempt:i.exempt, amount:i.received, due:i.due, remaining:i.remaining,
           date:i.date, dates:i.dates.join(' ، '), status:payStatusText(i), pill:payStatusPill(i) };
}
function paymentTableRows(members, ym, withContacts){
  let total = 0, paidCount = 0;
  const rows = members.map(s=>{
    const p = paidInfo(s, ym);
    total += p.amount; if(p.paid) paidCount++;
    return `<tr>
      <td data-prof="${s.id}" style="cursor:pointer;">${escapeHtml(s.name)}${withContacts?'':`<div style="color:var(--ink-soft);font-size:11px;">📞 ${escapeHtml(s.phone||'—')}</div>`}</td>
      ${withContacts?`<td>${escapeHtml(s.phone||'—')}</td><td>${escapeHtml(s.parentPhone||'—')}</td>`:''}
      <td>${p.pill}</td>
      <td class="amt">${p.amount>0 ? p.amount.toLocaleString('ar-EG')+' ج.م' : '—'}${p.partial?`<div style="color:var(--ink-soft);font-size:11px;font-weight:400;">من ${p.due} (متبقي ${p.remaining})</div>`:''}</td>
      <td>${escapeHtml(p.dates)||'—'}</td>
      <td><button class="btn outline small" data-payid="${s.id}" title="تسجيل/تعديل دفعة">💳</button></td>
    </tr>`;
  }).join('');
  return { rows, total, paidCount };
}

function renderGroupPayments(){
  const box = document.getElementById('groupPayBox');
  if(!box) return;
  const gid = currentGroupId || '__none__';
  const ym = payYm(grpPayYear, grpPayMonth);
  const members = paymentMembersFor(gid);
  const { rows, total, paidCount } = paymentTableRows(members, ym, false);
  box.innerHTML = `
    <div class="month-nav" style="margin-bottom:10px;">
      <button id="gpPrev">‹</button>
      <div class="mlabel">${MONTHS[grpPayMonth]} ${grpPayYear}</div>
      <button id="gpNext">›</button>
    </div>
    <div class="stats-row">
      <div class="stat"><div class="num" style="color:var(--green)">${total.toLocaleString('ar-EG')}</div><div class="lbl">إجمالي المحصّل (ج.م)</div></div>
      <div class="stat"><div class="num" style="color:var(--green)">${paidCount}</div><div class="lbl">سدّدوا</div></div>
      <div class="stat"><div class="num" style="color:var(--red)">${members.length-paidCount}</div><div class="lbl">لم يسدّدوا</div></div>
    </div>
    ${members.length ? `<div style="overflow:auto;"><table class="income-table">
      <tr><th>الطالب</th><th>الحالة</th><th>المبلغ</th><th>تاريخ الدفع</th><th></th></tr>${rows}
    </table></div>` : `<div class="empty">لا يوجد طلاب في المجموعة.</div>`}
  `;
  box.querySelector('#gpPrev').onclick = ()=>{ grpPayMonth--; if(grpPayMonth<0){grpPayMonth=11; grpPayYear--;} renderGroupPayments(); };
  box.querySelector('#gpNext').onclick = ()=>{ grpPayMonth++; if(grpPayMonth>11){grpPayMonth=0; grpPayYear++;} renderGroupPayments(); };
  box.querySelectorAll('[data-prof]').forEach(td=> td.onclick = ()=> openProfile(td.dataset.prof));
  box.querySelectorAll('[data-payid]').forEach(b=> b.onclick = ()=>{
    const s = DATA.find(x=>x.id===b.dataset.payid); if(!s) return;
    openPaymentModal(s, ym, ()=>{ renderGroupPayments(); renderGroupStudentList(); renderGroupStats(); });
  });
}

function openPaymentExportModal(groupId, defaults){
  const scopes = paymentScopes(groupId);
  if(!scopes.some(sc=>sc.members.length)){ showToast('لا يوجد طلاب للتصدير'); return; }
  const d = defaults || {};
  const y0 = d.year ?? new Date().getFullYear();
  const m0 = d.month ?? new Date().getMonth();
  const years = []; for(let y=y0-2; y<=y0+1; y++) years.push(y);
  const scopeLabel = groupId===undefined ? `كل المجموعات (${scopes.length})` : scopes[0].name;
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>📥 تحميل تفاصيل الدفع</h3><button class="close" id="payExpClose">×</button></div>
      <div class="modal-body">
        <div class="info-item"><div class="k">النطاق</div><div class="v">${escapeHtml(scopeLabel)}</div></div>
        <div class="field"><label>نوع الملف</label>
          <select id="payExpMode">
            <option value="month">شهر محدد — شيت لكل مجموعة</option>
            <option value="year">سنة كاملة — عمود لكل شهر (مبلغ + تاريخ)</option>
          </select>
        </div>
        <div class="field" id="payExpMonthWrap"><label>الشهر</label>
          <select id="payExpMonth">${MONTHS.map((n,i)=>`<option value="${i}" ${i===m0?'selected':''}>${n}</option>`).join('')}</select>
        </div>
        <div class="field"><label>السنة</label>
          <select id="payExpYear">${years.map(y=>`<option value="${y}" ${y===y0?'selected':''}>${y}</option>`).join('')}</select>
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink-soft);cursor:pointer;" id="payExpUnpaidWrap">
          <input type="checkbox" id="payExpUnpaid" checked> يشمل اللي لسه مدفعوش
        </label>
        <p class="scan-hint">الملف فيه بيانات الطالب (الاسم، الكود، تليفونه وتليفون ولي الأمر)، حالة الدفع، المطلوب والمدفوع والمتبقي، وتواريخ الدفع بالظبط.</p>
        <button class="btn gold" id="payExpGo">⬇ تحميل Excel</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = ()=> ov.remove();
  ov.querySelector('#payExpClose').onclick = close;
  ov.addEventListener('click', e=>{ if(e.target===ov) close(); });
  const modeSel = ov.querySelector('#payExpMode');
  const syncMode = ()=>{
    const isMonth = modeSel.value==='month';
    ov.querySelector('#payExpMonthWrap').style.display = isMonth ? '' : 'none';
    ov.querySelector('#payExpUnpaidWrap').style.display = isMonth ? '' : 'none';
  };
  modeSel.onchange = syncMode; syncMode();
  ov.querySelector('#payExpGo').onclick = ()=>{
    exportPaymentsExcel(groupId, {
      mode: modeSel.value,
      year: Number(ov.querySelector('#payExpYear').value),
      month: Number(ov.querySelector('#payExpMonth').value),
      includeUnpaid: ov.querySelector('#payExpUnpaid').checked
    });
    close();
  };
}

function safeSheetName(name, used){
  const base = (name||'شيت').replace(/[\\\/\?\*\[\]:]/g,'_').slice(0,28) || 'شيت';
  let n = base, i = 2;
  while(used.has(n)){ n = `${base.slice(0,25)}_${i++}`; }
  used.add(n);
  return n;
}
function studentInfoCols(s, groupName){
  return {
    'اسم الطالب': s.name||'',
    'كود الطالب': s.barcode||'',
    'رقم الطالب': s.phone||'',
    'رقم ولي الأمر': s.parentPhone||'',
    'المجموعة': groupName,
    'الاشتراك الشهري (ج.م)': Number(s.fee)||''
  };
}

function exportPaymentsExcel(groupId, opt){
  const scopes = paymentScopes(groupId).filter(sc=>sc.members.length);
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views:[{ RTL:true }] };
  const used = new Set();
  const summary = [];
  let fileTitle;

  if(opt.mode==='month'){
    const ym = payYm(opt.year, opt.month);
    const monthLabel = `${MONTHS[opt.month]} ${opt.year}`;
    fileTitle = monthLabel;
    scopes.forEach(sc=>{
      let total = 0, paidCount = 0, remainingTotal = 0;
      let rows = [];
      sc.members.forEach(s=>{
        const p = paidInfo(s, ym);
        total += p.amount; remainingTotal += p.remaining; if(p.paid) paidCount++;
        if(!p.paid && !p.partial && !opt.includeUnpaid) return;
        rows.push({
          ...studentInfoCols(s, sc.name),
          'الشهر': monthLabel,
          'حالة الدفع': p.status,
          'المطلوب (ج.م)': p.due,
          'المبلغ المدفوع (ج.م)': p.amount || '',
          'المتبقي (ج.م)': p.remaining || '',
          'تاريخ الدفع': p.dates
        });
      });
      summary.push({ 'المجموعة': sc.name, 'عدد الطلاب': sc.members.length, 'سدّدوا': paidCount, 'لم يسدّدوا': sc.members.length-paidCount, 'إجمالي المحصّل (ج.م)': total, 'إجمالي المتبقي (ج.م)': remainingTotal });
      if(!rows.length) rows = [{ 'اسم الطالب':'لا توجد دفعات في هذا الشهر' }];
      else rows.push({ 'اسم الطالب':'الإجمالي', 'حالة الدفع':`${paidCount} سدّدوا`, 'المبلغ المدفوع (ج.م)': total, 'المتبقي (ج.م)': remainingTotal });
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{wch:28},{wch:14},{wch:16},{wch:16},{wch:22},{wch:18},{wch:16},{wch:14},{wch:14},{wch:14},{wch:14},{wch:26}];
      XLSX.utils.book_append_sheet(wb, ws, safeSheetName(sc.name, used));
    });
  }else{
    fileTitle = String(opt.year);
    scopes.forEach(sc=>{
      let groupTotal = 0;
      const rows = sc.members.map(s=>{
        const row = studentInfoCols(s, sc.name);
        let total = 0, months = 0;
        MONTHS.forEach((mn,i)=>{
          const p = paidInfo(s, payYm(opt.year, i));
          row[`${mn} - المبلغ`] = p.amount || '';
          row[`${mn} - تاريخ الدفع`] = p.dates;
          total += p.amount; if(p.paid) months++;
        });
        row['عدد الشهور المسدّدة'] = months;
        row[`إجمالي ${opt.year} (ج.م)`] = total;
        groupTotal += total;
        return row;
      });
      const totalRow = { 'اسم الطالب':'الإجمالي' };
      MONTHS.forEach((mn,i)=>{
        totalRow[`${mn} - المبلغ`] = sc.members.reduce((a,s)=>a+paidInfo(s, payYm(opt.year,i)).amount, 0);
      });
      totalRow[`إجمالي ${opt.year} (ج.م)`] = groupTotal;
      rows.push(totalRow);
      summary.push({ 'المجموعة': sc.name, 'عدد الطلاب': sc.members.length, [`إجمالي ${opt.year} (ج.م)`]: groupTotal });
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{wch:28},{wch:14},{wch:16},{wch:16},{wch:22},{wch:18}, ...MONTHS.flatMap(()=>[{wch:14},{wch:20}]), {wch:16},{wch:18}];
      XLSX.utils.book_append_sheet(wb, ws, safeSheetName(sc.name, used));
    });
  }

  if(scopes.length>1){
    const sws = XLSX.utils.json_to_sheet(summary);
    sws['!cols'] = [{wch:26},{wch:14},{wch:12},{wch:12},{wch:22},{wch:22}];
    XLSX.utils.book_append_sheet(wb, sws, 'ملخص');
    wb.SheetNames.unshift(wb.SheetNames.pop());   // الملخص أول شيت
  }
  const scopeName = groupId===undefined ? 'كل_المجموعات' : scopes[0].name;
  const safe = `${scopeName}_${fileTitle}`.replace(/[\\\/:*?"<>|]/g,'_').replace(/\s+/g,'_');
  XLSX.writeFile(wb, `تفاصيل_الدفع_${safe}.xlsx`);
  showToast('تم تحميل ملف تفاصيل الدفع ✔');
}

/* ---------- المتأخرات ---------- */
const arrState = { period:'all', group:'all', incCur:true, q:'' };

function studentStartYm(s){
  const d = s.createdAt ? new Date(s.createdAt) : null;
  let ym = (d && !isNaN(d)) ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` : null;
  const keys = Object.keys(s.attendance||{}).concat(Object.keys(s.payments||{})).map(k=>k.slice(0,7)).filter(k=>/^\d{4}-\d{2}$/.test(k)).sort();
  if(keys[0] && (!ym || keys[0] < ym)) ym = keys[0];
  return ym || ymKey();
}
function computeArrears(){
  const nowYm = ymKey();
  const endYm = arrState.incCur ? nowYm : ymAdd(nowYm, -1);
  let floorYm = null;
  if(arrState.period==='3') floorYm = ymAdd(nowYm, -2);
  else if(arrState.period==='6') floorYm = ymAdd(nowYm, -5);
  else if(arrState.period==='year') floorYm = `${new Date().getFullYear()}-01`;
  const q = normalizeAr(arrState.q);
  const out = [];
  DATA.forEach(s=>{
    const key = (s.groupId && getGroup(s.groupId)) ? s.groupId : '__none__';
    if(arrState.group!=='all' && arrState.group!==key) return;
    if(q && !normalizeAr(s.name).includes(q) && !(s.phone||'').includes(q) && !(s.parentPhone||'').includes(q)) return;
    let start = studentStartYm(s); if(floorYm && floorYm > start) start = floorYm;
    const owed = [];
    monthsBetween(start, endYm).forEach(ym=>{ if(inArchiveGap(s, ym)) return; const i = payInfo(s, ym); if(!i.settled && i.remaining>0) owed.push({ ym, remaining:i.remaining, partial:i.partial }); });
    if(owed.length) out.push({ s, key, owed, total: owed.reduce((a,x)=>a+x.remaining,0) });
  });
  return out;
}
function buildPayReminder(s, owed){
  const tpl = SETTINGS.payMsgTemplate || DEFAULT_PAY_MSG;
  const total = owed.reduce((a,x)=>a+x.remaining,0);
  return tpl.replace(/\{name\}/g, ()=>s.name||'').replace(/\{months\}/g, ()=>owed.map(x=>ymLabel(x.ym)).join(' ، '))
            .replace(/\{amount\}/g, ()=>String(total)).replace(/\{teacher\}/g, ()=>SETTINGS.teacherName||'');
}

function renderArrears(){
  const view = document.getElementById('arrearsView');
  if(!view) return;
  const list = computeArrears();
  const grand = list.reduce((a,x)=>a+x.total,0);
  const byGroup = {};
  list.forEach(x=>{ (byGroup[x.key] = byGroup[x.key] || []).push(x); });
  const groupName = k => k==='__none__' ? 'غير مصنّفين' : (getGroup(k)||{}).name || '—';
  const keys = Object.keys(byGroup).sort((a,b)=>groupName(a).localeCompare(groupName(b),'ar'));
  const groupOpts = [`<option value="all">كل المجموعات</option>`].concat(GROUPS.map(g=>`<option value="${g.id}" ${arrState.group===g.id?'selected':''}>${escapeHtml(g.name)}</option>`))
    .concat(DATA.some(s=>!s.groupId||!getGroup(s.groupId)) ? [`<option value="__none__" ${arrState.group==='__none__'?'selected':''}>غير مصنّفين</option>`] : []).join('');
  view.innerHTML = `
    <div class="section-title"><span>⏰ المتأخرات</span><div class="line"></div><button class="btn outline small" id="arrExportBtn">📥 تحميل Excel</button></div>
    <div class="card">
      <div class="search-row" style="flex-wrap:wrap;">
        <input type="text" id="arrQ" placeholder="ابحث بالاسم أو التليفون..." value="${escapeHtml(arrState.q)}">
        <select id="arrGroup">${groupOpts}</select>
        <select id="arrPeriod">
          <option value="all" ${arrState.period==='all'?'selected':''}>كل المدة</option>
          <option value="year" ${arrState.period==='year'?'selected':''}>السنة دي</option>
          <option value="6" ${arrState.period==='6'?'selected':''}>آخر 6 شهور</option>
          <option value="3" ${arrState.period==='3'?'selected':''}>آخر 3 شهور</option>
        </select>
      </div>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink-soft);margin-top:8px;">
        <input type="checkbox" id="arrCur" ${arrState.incCur?'checked':''}> يشمل الشهر الحالي
      </label>
      <div class="big-total" style="color:var(--red);">${grand.toLocaleString('ar-EG')} ج.م</div>
      <div style="text-align:center; color:var(--ink-soft); font-size:12px;">${list.length} طالب عليهم متأخرات</div>
    </div>
    ${keys.length ? keys.map(k=>`
      <div class="card">
        <div class="section-title" style="margin-top:0;"><span>${escapeHtml(groupName(k))}</span>
          <span class="pill unpaid">${byGroup[k].reduce((a,x)=>a+x.total,0).toLocaleString('ar-EG')} ج.م</span><div class="line"></div></div>
        <div class="student-list">
          ${byGroup[k].sort((a,b)=>(a.s.name||'').localeCompare(b.s.name||'','ar')).map(x=>`
            <div class="student-row" style="cursor:default; align-items:flex-start; gap:10px; flex-wrap:wrap;">
              <div style="flex:1; min-width:200px;">
                <div class="name">${escapeHtml(x.s.name)}</div>
                <div class="meta">📞 ${escapeHtml(x.s.phone||'—')} &nbsp;|&nbsp; ولي الأمر: ${escapeHtml(x.s.parentPhone||'—')}</div>
                <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
                  ${x.owed.map(o=>`<span class="pill ${o.partial?'warn':'unpaid'}" data-pay="${x.s.id}" data-ym="${o.ym}" style="cursor:pointer;" title="دوس لتسجيل دفعة">${MONTHS[Number(o.ym.slice(5))-1]} — ${o.remaining}</span>`).join('')}
                </div>
              </div>
              <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                <span class="pill unpaid">متبقي ${x.total.toLocaleString('ar-EG')} ج.م</span>
                <button class="btn outline small" data-wa="${x.s.id}">📲 تذكير</button>
                <button class="btn outline small" data-prof="${x.s.id}">👤</button>
              </div>
            </div>`).join('')}
        </div>
      </div>`).join('') : `<div class="card"><div class="empty">مفيش متأخرات 🎉</div></div>`}
  `;
  const re = ()=> renderArrears();
  view.querySelector('#arrQ').oninput = (e)=>{ arrState.q = e.target.value; clearTimeout(renderArrears._t); renderArrears._t = setTimeout(()=>{ re(); const el=document.getElementById('arrQ'); if(el){ el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 250); };
  view.querySelector('#arrGroup').onchange = (e)=>{ arrState.group = e.target.value; re(); };
  view.querySelector('#arrPeriod').onchange = (e)=>{ arrState.period = e.target.value; re(); };
  view.querySelector('#arrCur').onchange = (e)=>{ arrState.incCur = e.target.checked; re(); };
  view.querySelector('#arrExportBtn').onclick = ()=> exportArrearsExcel(list, groupName);
  view.querySelectorAll('[data-pay]').forEach(p=> p.onclick = ()=>{
    const s = DATA.find(x=>x.id===p.dataset.pay); if(s) openPaymentModal(s, p.dataset.ym, re);
  });
  view.querySelectorAll('[data-prof]').forEach(b=> b.onclick = ()=> openProfile(b.dataset.prof));
  view.querySelectorAll('[data-wa]').forEach(b=> b.onclick = ()=>{
    const x = list.find(y=>y.s.id===b.dataset.wa); if(!x) return;
    const ph = normalizePhone(x.s.parentPhone) || normalizePhone(x.s.phone);
    if(!ph){ showToast('مفيش رقم صالح للواتساب للطالب ده'); return; }
    window.open(`https://wa.me/${ph}?text=${encodeURIComponent(buildPayReminder(x.s, x.owed))}`, '_blank');
  });
}

function exportArrearsExcel(list, groupName){
  if(!list.length){ showToast('مفيش متأخرات للتصدير'); return; }
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views:[{ RTL:true }] };
  const used = new Set(), summary = [];
  const byGroup = {};
  list.forEach(x=>{ (byGroup[x.key] = byGroup[x.key] || []).push(x); });
  Object.keys(byGroup).forEach(k=>{
    const items = byGroup[k].sort((a,b)=>(a.s.name||'').localeCompare(b.s.name||'','ar'));
    const total = items.reduce((a,x)=>a+x.total,0);
    const rows = items.map(x=>({
      'اسم الطالب': x.s.name||'', 'كود الطالب': x.s.barcode||'', 'رقم الطالب': x.s.phone||'', 'رقم ولي الأمر': x.s.parentPhone||'',
      'المجموعة': groupName(k),
      'الشهور المتأخرة': x.owed.map(o=>ymLabel(o.ym)).join(' ، '),
      'عدد الشهور': x.owed.length, 'إجمالي المتبقي (ج.م)': x.total
    }));
    rows.push({ 'اسم الطالب':'الإجمالي', 'عدد الشهور': items.reduce((a,x)=>a+x.owed.length,0), 'إجمالي المتبقي (ج.م)': total });
    summary.push({ 'المجموعة': groupName(k), 'عدد الطلاب المتأخرين': items.length, 'إجمالي المتأخرات (ج.م)': total });
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{wch:28},{wch:14},{wch:16},{wch:16},{wch:22},{wch:40},{wch:12},{wch:18}];
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(groupName(k), used));
  });
  if(summary.length>1){
    const sws = XLSX.utils.json_to_sheet(summary); sws['!cols'] = [{wch:26},{wch:20},{wch:22}];
    XLSX.utils.book_append_sheet(wb, sws, 'ملخص'); wb.SheetNames.unshift(wb.SheetNames.pop());
  }
  XLSX.writeFile(wb, `المتأخرات_${todayKey()}.xlsx`);
  showToast('تم تحميل ملف المتأخرات ✔');
}

/* ============ Import students from Excel ============ */
function mapStudentHeader(h){
  const t = normalizeAr(h).replace(/[\s_\-\.\(\)]/g,'');
  if(!t) return null;
  if(t.includes('ولي') || t.includes('parent') || t.includes('guardian') || t.includes('الاهل')){
    return t.includes('اسم') || t.includes('name') ? null : 'parentPhone';
  }
  if(t.includes('كود') || t.includes('باركود') || t.includes('barcode') || t==='code' || t==='id') return 'barcode';
  if(t.includes('اشتراك') || t.includes('مصروف') || t.includes('رسوم') || t.includes('fee') || t.includes('سعر') || t.includes('مبلغ')) return 'fee';
  if(t.includes('تليفون') || t.includes('هاتف') || t.includes('موبايل') || t.includes('محمول') || t.includes('phone') || t.includes('mobile') || t==='رقم' || t.includes('رقمالطالب')) return 'phone';
  if(t.includes('ملاحظ') || t.includes('note')) return 'notes';
  if(t.includes('اسم') || t.includes('name') || t==='الطالب' || t==='student') return 'name';
  return null;
}
function cleanPhone(v){
  let p = String(v==null?'':v).replace(/[^\d]/g,'');
  if(p.length===10 && p[0]==='1') p = '0'+p;     // إكسيل بيشيل الصفر من أول الرقم
  return p;
}
function parseStudentsSheet(aoa){
  const rows = aoa.filter(r=>Array.isArray(r) && r.some(c=>String(c).trim()!==''));
  if(!rows.length) return { error:'الملف فاضي' };
  const map = {};
  rows[0].forEach((h,idx)=>{ const f = mapStudentHeader(h); if(f && map[f]===undefined) map[f] = idx; });
  if(map.name===undefined) return { error:'مش لاقي عمود "اسم الطالب" في أول صف — حمّل النموذج واستخدمه' };
  const out = rows.slice(1).map(r=>({
    name: String(r[map.name]??'').trim(),
    barcode: map.barcode!==undefined ? String(r[map.barcode]??'').trim() : '',
    phone: map.phone!==undefined ? cleanPhone(r[map.phone]) : '',
    parentPhone: map.parentPhone!==undefined ? cleanPhone(r[map.parentPhone]) : '',
    fee: map.fee!==undefined ? (parseFloat(String(r[map.fee]).replace(/[^\d.]/g,''))||0) : 0,
    notes: map.notes!==undefined ? String(r[map.notes]??'').trim() : ''
  }));
  return { rows:out, found:Object.keys(map) };
}
function barcodeGen(){
  const taken = new Set(DATA.concat(ARCHIVE).map(s=>String(s.barcode||'')));
  let max = 1000;
  taken.forEach(b=>{ if(/^\d{1,9}$/.test(b)) max = Math.max(max, Number(b)); });
  let n = max;
  return { next(){ do{ n++; }while(taken.has(String(n))); taken.add(String(n)); return String(n); }, take(b){ taken.add(String(b)); } };
}
function openStudentsImportModal(g){
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>⬆ استيراد طلاب من Excel</h3><button class="close" id="impClose">×</button></div>
      <div class="modal-body">
        <div class="info-item"><div class="k">هتتضاف للمجموعة</div><div class="v">${escapeHtml(g.name)}</div></div>
        <p class="scan-hint">أول صف عناوين الأعمدة: اسم الطالب، الكود (اختياري)، رقم الطالب، رقم ولي الأمر، الاشتراك الشهري، ملاحظات. لو الكود فاضي بيتولّد أوتوماتيك.</p>
        <button class="btn outline" id="impTpl">⬇ تحميل نموذج Excel</button>
        <div class="field"><label>اختار ملف Excel أو CSV</label><input type="file" id="impFile" accept=".xlsx,.xls,.csv"></div>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink-soft);">
          <input type="checkbox" id="impSkip" checked> تخطي المكرر (نفس الكود، أو نفس الاسم والتليفون)
        </label>
        <div id="impPreview"></div>
        <button class="btn gold" id="impGo" disabled>⬆ استيراد</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = ()=> ov.remove();
  ov.querySelector('#impClose').onclick = close;
  ov.addEventListener('click', e=>{ if(e.target===ov) close(); });
  let parsed = null;

  ov.querySelector('#impTpl').onclick = ()=>{
    const ws = XLSX.utils.aoa_to_sheet([
      ['اسم الطالب','الكود (اختياري)','رقم الطالب','رقم ولي الأمر','الاشتراك الشهري','ملاحظات'],
      ['أحمد محمد','','01012345678','01112345678',200,''],
      ['سارة علي','','01212345678','01512345678',200,'خصم أخوات']
    ]);
    ws['!cols'] = [{wch:28},{wch:18},{wch:16},{wch:16},{wch:16},{wch:24}];
    const wb = XLSX.utils.book_new(); wb.Workbook = { Views:[{ RTL:true }] };
    XLSX.utils.book_append_sheet(wb, ws, 'الطلاب');
    XLSX.writeFile(wb, 'نموذج_استيراد_الطلاب.xlsx');
  };

  function classify(){
    const skip = ov.querySelector('#impSkip').checked;
    const seenBar = new Set(DATA.concat(ARCHIVE).map(s=>String(s.barcode||'')).filter(Boolean));
    const seenKey = new Set(DATA.concat(ARCHIVE).map(s=>normalizeAr(s.name)+'|'+(s.phone||s.parentPhone||'')));
    return parsed.rows.map(r=>{
      if(!r.name) return { ...r, status:'skip', why:'بدون اسم' };
      const key = normalizeAr(r.name)+'|'+(r.phone||r.parentPhone||'');
      let dup = (r.barcode && seenBar.has(r.barcode)) || seenKey.has(key);
      if(dup && skip) return { ...r, status:'skip', why:'مكرر' };
      if(r.barcode) seenBar.add(r.barcode); seenKey.add(key);
      return { ...r, status:'ok', why: dup ? 'مكرر (هيتضاف برضو)' : '' };
    });
  }
  function showPreview(){
    const rows = classify();
    const ok = rows.filter(r=>r.status==='ok');
    ov.querySelector('#impPreview').innerHTML = `
      <div class="stats-row">
        <div class="stat"><div class="num" style="color:var(--green)">${ok.length}</div><div class="lbl">هيتضافوا</div></div>
        <div class="stat"><div class="num" style="color:var(--red)">${rows.length-ok.length}</div><div class="lbl">هيتخطّوا</div></div>
      </div>
      <div style="overflow:auto; max-height:200px;"><table class="income-table">
        <tr><th>الاسم</th><th>التليفون</th><th>ولي الأمر</th><th>الاشتراك</th><th></th></tr>
        ${rows.slice(0,8).map(r=>`<tr><td>${escapeHtml(r.name)||'—'}</td><td>${escapeHtml(r.phone)||'—'}</td><td>${escapeHtml(r.parentPhone)||'—'}</td><td>${r.fee||'—'}</td>
          <td>${r.status==='ok'?`<span class="pill paid">${escapeHtml(r.why)||'جديد'}</span>`:`<span class="pill unpaid">${escapeHtml(r.why)}</span>`}</td></tr>`).join('')}
      </table></div>${rows.length>8?`<p class="scan-hint">+ ${rows.length-8} صف تانيين...</p>`:''}`;
    const go = ov.querySelector('#impGo'); go.disabled = !ok.length; go.textContent = ok.length ? `⬆ استيراد ${ok.length} طالب` : 'مفيش حاجة للاستيراد';
    return ok;
  }
  ov.querySelector('#impSkip').onchange = ()=>{ if(parsed) showPreview(); };
  ov.querySelector('#impFile').onchange = async (e)=>{
    const f = e.target.files[0]; if(!f) return;
    try{
      const buf = await f.arrayBuffer();
      const wb = XLSX.read(buf, { type:'array', codepage:65001 });
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header:1, defval:'', raw:false });
      const res = parseStudentsSheet(aoa);
      if(res.error){ parsed = null; ov.querySelector('#impPreview').innerHTML = `<p class="empty" style="color:var(--red)">${escapeHtml(res.error)}</p>`; ov.querySelector('#impGo').disabled = true; return; }
      parsed = res; showPreview();
    }catch(err){ console.error(err); showToast('تعذّرت قراءة الملف'); }
  };
  ov.querySelector('#impGo').onclick = async ()=>{
    if(!parsed) return;
    const ok = classify().filter(r=>r.status==='ok');
    const gen = barcodeGen();
    const now = new Date().toISOString();
    ok.forEach(r=>{
      let bc = r.barcode;
      if(!bc || DATA.concat(ARCHIVE).some(s=>String(s.barcode)===bc)) bc = gen.next(); else gen.take(bc);
      DATA.push({ id:uid('s'), name:r.name, barcode:bc, groupId:g.id, phone:r.phone, parentPhone:r.parentPhone, fee:r.fee, notes:r.notes,
        notifyParent:true, createdAt:now, attendance:{}, payments:{}, grades:[], notified:{} });
    });
    await saveData();
    close();
    showToast(`تم استيراد ${ok.length} طالب ✔`);
    renderGroupView();
  };
}

/* ============ الأرشيف: طالب مبيحضرش؟ انقله هنا بدل ما تمسحه — وارجّعه وقت ما يرجع ============
   الطالب المؤرشف بيتخزّن بنفس بياناته (حضور/دفع/درجات) وعليه علامة archived:true،
   ومبيظهرش في المجموعات ولا الحضور ولا الدخل ولا المتأخرات ولا الإخطارات ولا التقارير. */
function ensureArchiveUI(){
  const tabs = document.getElementById('tabs');
  if(tabs && !tabs.querySelector('[data-tab="archive"]')){
    const b = document.createElement('button'); b.dataset.tab = 'archive'; b.textContent = '📦 الأرشيف';
    const anchor = tabs.querySelector('[data-tab="dropouts"]');
    if(anchor && anchor.nextSibling) tabs.insertBefore(b, anchor.nextSibling); else tabs.appendChild(b);
  }
  if(!document.getElementById('archiveView')){
    const v = document.createElement('div'); v.id = 'archiveView'; v.style.display = 'none';
    const ref = document.getElementById('dropoutsView');
    if(ref) ref.parentNode.insertBefore(v, ref.nextSibling);
  }
}
function updateArchiveTab(){
  const b = document.querySelector('#tabs [data-tab="archive"]');
  if(b) b.textContent = ARCHIVE.length ? `📦 الأرشيف (${ARCHIVE.length})` : '📦 الأرشيف';
}
function archDateLabel(iso){
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('ar-EG', { day:'2-digit', month:'2-digit', year:'numeric' });
}
function ymOfIso(iso){
  const d = new Date(iso);
  return isNaN(d) ? ymKey() : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function inArchiveGap(s, ym){
  return (s.archiveGaps||[]).some(g=> ym >= g.from && ym <= g.to);
}

async function archiveStudents(ids){
  const now = new Date().toISOString(); let n = 0;
  ids.forEach(id=>{
    const i = DATA.findIndex(s=>s.id===id); if(i<0) return;
    const s = DATA.splice(i,1)[0];
    const g = getGroup(s.groupId);
    s.archived = true; s.archivedAt = now;
    s.archivedGroupId = g ? g.id : null; s.archivedGroupName = g ? g.name : '';
    ARCHIVE.push(s); selectedIds.delete(id); n++;
  });
  updateArchiveTab();
  await saveData();
  return n;
}

function openRestoreModal(id, onDone, defaultGroupId){
  const s = ARCHIVE.find(x=>x.id===id); if(!s) return;
  const preferred = [defaultGroupId, s.archivedGroupId, s.groupId].find(g=> g && getGroup(g)) || '';
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>♻ استعادة ${escapeHtml(s.name)}</h3><button class="close" id="rsClose">×</button></div>
      <div class="modal-body">
        <div class="field"><label>يرجع لأنهي مجموعة؟</label>
          <select id="rsGroup"><option value="">بدون مجموعة</option>${GROUPS.map(g=>`<option value="${g.id}" ${g.id===preferred?'selected':''}>${escapeHtml(g.name)}</option>`).join('')}</select></div>
        <label style="display:flex; align-items:flex-start; gap:8px; font-size:13px; color:var(--ink-soft);">
          <input type="checkbox" id="rsGap" checked style="margin-top:3px;"> الشهور اللي كان فيها مؤرشف متتحسبش عليه متأخرات
        </label>
        <p class="scan-hint">حضوره ودفعاته وكل بياناته القديمة هترجع زي ما هي، وعدّاد الغياب بيبدأ من جديد من النهارده.</p>
        <button class="btn gold" id="rsGo">♻ استعادة</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#rsClose').onclick = ()=> ov.remove();
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.remove(); });
  ov.querySelector('#rsGo').onclick = async ()=>{
    const r = await restoreStudent(id, ov.querySelector('#rsGroup').value || null, ov.querySelector('#rsGap').checked);
    ov.remove();
    if(r) showToast(`♻ تمت استعادة ${r.name}${r.note||''}`);
    if(onDone) onDone(r);
    if(document.getElementById('archiveView') && document.getElementById('archiveView').style.display!=='none') renderArchive();
  };
}
async function restoreStudent(id, groupId, exemptGap){
  const i = ARCHIVE.findIndex(x=>x.id===id); if(i<0) return null;
  const s = ARCHIVE[i]; let note = '';
  if(DATA.some(x=>String(x.barcode)===String(s.barcode))){
    s.barcode = barcodeGen().next(); note = ` (الكود اتغيّر لـ ${s.barcode} لأن القديم مستخدم مع طالب تاني)`;
  }
  ARCHIVE.splice(i,1);
  const from = ymAdd(ymOfIso(s.archivedAt), 1), to = ymAdd(ymKey(), -1);
  if(exemptGap && from <= to){ s.archiveGaps = s.archiveGaps || []; s.archiveGaps.push({ from, to }); }
  s.groupId = groupId || null;
  s.restoredAt = todayKey();
  delete s.archived; delete s.archivedAt; delete s.archivedGroupId; delete s.archivedGroupName;
  DATA.push(s);
  updateArchiveTab();
  await saveData();
  return { id:s.id, name:s.name, note };
}

const archState = { q:'' };
function archStudentStats(s){
  const att = s.attendance || {};
  const keys = Object.keys(att).filter(k=>att[k]==='present'||att[k]==='absent').sort();
  const present = keys.filter(k=>att[k]==='present'), absent = keys.filter(k=>att[k]==='absent');
  let paid = 0; Object.keys(s.payments||{}).forEach(ym=>{ paid += payInfo(s, ym).received; });
  return { present:present.length, absent:absent.length, lastPresent: present[present.length-1]||'', paid };
}
function openArchiveDetails(id){
  const s = ARCHIVE.find(x=>x.id===id); if(!s) return;
  const st = archStudentStats(s);
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `
    <div class="modal">
      <div class="modal-head"><h3>📄 ${escapeHtml(s.name)}</h3><button class="close" id="adClose">×</button></div>
      <div class="modal-body">
        <div class="info-grid">
          <div class="info-item"><div class="k">كود الباركود</div><div class="v">${escapeHtml(s.barcode||'—')}</div></div>
          <div class="info-item"><div class="k">المجموعة وقت الأرشفة</div><div class="v">${escapeHtml(s.archivedGroupName||'بدون مجموعة')}</div></div>
          <div class="info-item"><div class="k">تليفون الطالب</div><div class="v">${escapeHtml(s.phone||'—')}</div></div>
          <div class="info-item"><div class="k">تليفون ولي الأمر</div><div class="v">${escapeHtml(s.parentPhone||'—')}</div></div>
          <div class="info-item"><div class="k">حضر / غاب</div><div class="v">${st.present} / ${st.absent}</div></div>
          <div class="info-item"><div class="k">آخر حضور</div><div class="v">${escapeHtml(st.lastPresent||'—')}</div></div>
          <div class="info-item"><div class="k">إجمالي اللي دفعه</div><div class="v">${st.paid.toLocaleString('ar-EG')} ج.م</div></div>
          <div class="info-item"><div class="k">تاريخ الأرشفة</div><div class="v">${escapeHtml(archDateLabel(s.archivedAt)||'—')}</div></div>
        </div>
        ${s.notes?`<p style="margin-top:10px; font-size:13px; color:var(--ink-soft);">📝 ${escapeHtml(s.notes)}</p>`:''}
        <button class="btn gold" id="adRestore">♻ استعادة</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector('#adClose').onclick = ()=> ov.remove();
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.remove(); });
  ov.querySelector('#adRestore').onclick = ()=>{ ov.remove(); openRestoreModal(id); };
}
function renderArchive(){
  const view = document.getElementById('archiveView'); if(!view) return;
  const q = normalizeAr(archState.q);
  const list = ARCHIVE.filter(s=> !q || normalizeAr(s.name).includes(q) || (s.phone||'').includes(q) || (s.parentPhone||'').includes(q) || String(s.barcode||'').includes(q))
    .sort((a,b)=> (b.archivedAt||'').localeCompare(a.archivedAt||''));
  view.innerHTML = `
    <div class="section-title"><span>📦 الأرشيف</span><span class="pill warn">${ARCHIVE.length} طالب</span><div class="line"></div></div>
    <div class="card">
      <p class="scan-hint">الطلاب هنا مش بيظهروا في الحضور ولا الدخل ولا المتأخرات ولا الإخطارات، وبياناتهم محفوظة كاملة. لما حد يرجع دوس ♻ استعادة (أو اعمل مسح لكارته وهيعرض عليك الاستعادة).</p>
      <div class="search-row"><input type="text" id="archQ" placeholder="ابحث بالاسم أو الكود أو التليفون..." value="${escapeHtml(archState.q)}"></div>
    </div>
    ${list.length ? `<div class="student-list">${list.map(s=>`
      <div class="student-row" style="cursor:default; flex-wrap:wrap; gap:10px;">
        <div style="flex:1; min-width:200px;">
          <div class="name">${escapeHtml(s.name)}</div>
          <div class="meta">${escapeHtml(s.archivedGroupName||'بدون مجموعة')} &nbsp;|&nbsp; اتأرشف: ${escapeHtml(archDateLabel(s.archivedAt)||'—')}</div>
          <div class="meta">📞 ${escapeHtml(s.phone||'—')} &nbsp;|&nbsp; ولي الأمر: ${escapeHtml(s.parentPhone||'—')} &nbsp;|&nbsp; كود: ${escapeHtml(s.barcode||'—')}</div>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
          <button class="btn gold small" data-restore="${s.id}">♻ استعادة</button>
          <button class="btn outline small" data-details="${s.id}">📄 تفاصيل</button>
          <button class="btn danger small" data-del="${s.id}">🗑 حذف نهائي</button>
        </div>
      </div>`).join('')}</div>` : `<div class="card"><div class="empty">${ARCHIVE.length ? 'مفيش نتايج مطابقة.' : 'الأرشيف فاضي. أي طالب بتأرشفه هيظهر هنا.'}</div></div>`}
  `;
  view.querySelector('#archQ').oninput = (e)=>{
    archState.q = e.target.value; clearTimeout(renderArchive._t);
    renderArchive._t = setTimeout(()=>{ renderArchive(); const el = document.getElementById('archQ'); if(el){ el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 250);
  };
  view.querySelectorAll('[data-restore]').forEach(b=> b.onclick = ()=> openRestoreModal(b.dataset.restore));
  view.querySelectorAll('[data-details]').forEach(b=> b.onclick = ()=> openArchiveDetails(b.dataset.details));
  view.querySelectorAll('[data-del]').forEach(b=> b.onclick = async ()=>{
    const s = ARCHIVE.find(x=>x.id===b.dataset.del); if(!s) return;
    if(!confirm(`حذف نهائي لـ "${s.name}"؟ مش هتقدر ترجّعه تاني.`)) return;
    ARCHIVE = ARCHIVE.filter(x=>x.id!==s.id);
    updateArchiveTab(); await saveData();
    showToast('تم الحذف النهائي'); renderArchive();
  });
}
ensureArchiveUI();

/* ============ Reports & Statistics ============ */
let reportsYear = new Date().getFullYear();
let reportsMonth = new Date().getMonth();

function reportMonthKey(){ return `${reportsYear}-${String(reportsMonth+1).padStart(2,'0')}`; }
function reportMonthLabel(){ return `${MONTHS[reportsMonth]} ${reportsYear}`; }
function reportAttendanceStats(s, ym){
  const att = s.attendance || {};
  let present=0, absent=0;
  Object.keys(att).forEach(k=>{
    if(!k.startsWith(ym)) return;
    if(att[k]==='present') present++;
    else if(att[k]==='absent') absent++;
  });
  return {present, absent, total:present+absent};
}

function renderReports(){
  const view = document.getElementById('reportsView');
  view.innerHTML = `
    <div class="section-title"><span>📊 التقارير والإحصائيات</span><div class="line"></div></div>
    <div class="card">
      <div class="month-nav" style="margin-bottom:0;">
        <button id="repPrevM">‹</button>
        <div class="mlabel" id="repMlabel"></div>
        <button id="repNextM">›</button>
      </div>
    </div>
    <div id="reportsBody"></div>
  `;
  document.getElementById('repPrevM').onclick=()=>{ reportsMonth--; if(reportsMonth<0){reportsMonth=11; reportsYear--;} renderReports(); };
  document.getElementById('repNextM').onclick=()=>{ reportsMonth++; if(reportsMonth>11){reportsMonth=0; reportsYear++;} renderReports(); };
  renderReportsData();
}

function renderReportsData(){
  const ym=reportMonthKey();
  document.getElementById('repMlabel').textContent=reportMonthLabel();
  const body=document.getElementById('reportsBody');

  let present=0, absent=0, collected=0, paidCount=0, expected=0, newStudents=0;
  const perGroup={};
  GROUPS.forEach(g=>perGroup[g.id]={name:g.name,count:0,present:0,absent:0,collected:0,paid:0,expected:0});
  perGroup.__none__={name:'غير مصنّفين',count:0,present:0,absent:0,collected:0,paid:0,expected:0};

  DATA.forEach(s=>{
    const key=(s.groupId && getGroup(s.groupId)) ? s.groupId : '__none__';
    const r=perGroup[key]; r.count++;
    const a=reportAttendanceStats(s,ym);
    r.present+=a.present; r.absent+=a.absent; present+=a.present; absent+=a.absent;
    const pay=s.payments && s.payments[ym];
    { const pi=payInfo(s,ym); r.collected+=pi.received; collected+=pi.received; if(pi.settled){ r.paid++; paidCount++; } }
    const fee=Number(s.fee)||0; r.expected+=fee; expected+=fee;
    if(s.createdAt && String(s.createdAt).slice(0,7)===ym) newStudents++;
  });

  const attendanceTotal=present+absent;
  const attendanceRate=attendanceTotal ? Math.round(present/attendanceTotal*100) : 0;
  const remaining=Math.max(expected-collected,0);
  const activeStudents=DATA.length;
  const groupsCount=GROUPS.length;
  const rows=Object.values(perGroup).filter(r=>r.count>0);

  const studentRanking=DATA.map(s=>{
    const a=reportAttendanceStats(s,ym); const g=getGroup(s.groupId);
    return {s,g,a};
  }).filter(x=>x.a.total>0).sort((a,b)=> (b.a.present/b.a.total)-(a.a.present/a.a.total));
  const best=studentRanking.slice(0,5);
  const mostAbsent=DATA.map(s=>{const a=reportAttendanceStats(s,ym);return {s,a,g:getGroup(s.groupId)};})
    .filter(x=>x.a.absent>0).sort((a,b)=>b.a.absent-a.a.absent).slice(0,5);

  document.getElementById('reportsBody').innerHTML=`
    <div class="group-grid" style="margin-top:14px;">
      <div class="card"><div class="meta">👥 إجمالي الطلاب</div><div class="big-total">${activeStudents.toLocaleString('ar-EG')}</div></div>
      <div class="card"><div class="meta">🗂 المجموعات</div><div class="big-total">${groupsCount.toLocaleString('ar-EG')}</div></div>
      <div class="card"><div class="meta">🆕 طلاب جدد هذا الشهر</div><div class="big-total">${newStudents.toLocaleString('ar-EG')}</div></div>
      <div class="card"><div class="meta">💰 المحصل هذا الشهر</div><div class="big-total">${collected.toLocaleString('ar-EG')} ج.م</div></div>
      <div class="card"><div class="meta">📌 المتوقع حسب الرسوم</div><div class="big-total">${expected.toLocaleString('ar-EG')} ج.م</div></div>
      <div class="card"><div class="meta">💸 المتبقي</div><div class="big-total">${remaining.toLocaleString('ar-EG')} ج.م</div></div>
      <div class="card"><div class="meta">✅ الحضور</div><div class="big-total">${present.toLocaleString('ar-EG')}</div></div>
      <div class="card"><div class="meta">❌ الغياب</div><div class="big-total">${absent.toLocaleString('ar-EG')}</div></div>
      <div class="card"><div class="meta">📈 نسبة الحضور</div><div class="big-total">${attendanceRate}%</div></div>
      <div class="card"><div class="meta">💳 عدد من دفعوا</div><div class="big-total">${paidCount.toLocaleString('ar-EG')}</div></div>
    </div>

    <div class="card" style="margin-top:16px;">
      <div class="section-title" style="margin-top:0;"><span>🗂 أداء المجموعات — ${reportMonthLabel()}</span><div class="line"></div></div>
      ${rows.length ? `<div style="overflow:auto"><table class="income-table">
        <tr><th>المجموعة</th><th>الطلاب</th><th>حضور</th><th>غياب</th><th>نسبة الحضور</th><th>دفعوا</th><th>المحصل</th></tr>
        ${rows.map(r=>{const t=r.present+r.absent; const rate=t?Math.round(r.present/t*100):0; return `<tr><td>${escapeHtml(r.name)}</td><td>${r.count}</td><td>${r.present}</td><td>${r.absent}</td><td>${rate}%</td><td>${r.paid}</td><td class="amt">${r.collected.toLocaleString('ar-EG')} ج.م</td></tr>`;}).join('')}
      </table></div>` : `<div class="empty">لا توجد مجموعات أو طلاب بعد.</div>`}
    </div>

    <div class="group-grid" style="margin-top:16px;">
      <div class="card">
        <div class="section-title" style="margin-top:0;"><span>🏆 أعلى حضور</span><div class="line"></div></div>
        ${best.length ? `<div class="student-list">${best.map(x=>{const rate=Math.round(x.a.present/x.a.total*100);return `<div class="student-row" style="cursor:default"><div><div class="name">${escapeHtml(x.s.name)}</div><div class="meta">${x.g?escapeHtml(x.g.name):'بدون مجموعة'}</div></div><span class="pill paid">${rate}% (${x.a.present}/${x.a.total})</span></div>`}).join('')}</div>` : `<div class="empty">لا توجد بيانات حضور لهذا الشهر.</div>`}
      </div>
      <div class="card">
        <div class="section-title" style="margin-top:0;"><span>⚠️ الأكثر غيابًا</span><div class="line"></div></div>
        ${mostAbsent.length ? `<div class="student-list">${mostAbsent.map(x=>`<div class="student-row" style="cursor:default"><div><div class="name">${escapeHtml(x.s.name)}</div><div class="meta">${x.g?escapeHtml(x.g.name):'بدون مجموعة'}</div></div><span class="pill unpaid">${x.a.absent} غياب</span></div>`).join('')}</div>` : `<div class="empty">لا يوجد غياب مسجل لهذا الشهر 🎉</div>`}
      </div>
    </div>
  `;
}

/* ============ Exam Excel Export ============ */
function openExamExcelModal(group){
  const members = DATA.filter(s=>s.groupId===group.id).sort((a,b)=>a.name.localeCompare(b.name,'ar'));
  if(!members.length){ showToast('المجموعة لا تحتوي على طلاب'); return; }
  const ov=document.createElement('div'); ov.className='overlay';
  ov.innerHTML=`
    <div class="modal">
      <div class="modal-head"><h3>📊 تصدير كشف امتحان</h3><button class="close" id="closeExamExcel">×</button></div>
      <div class="modal-body">
        <div class="info-item"><div class="k">المجموعة</div><div class="v">${escapeHtml(group.name)}</div></div>
        <div class="info-item"><div class="k">عدد الطلاب</div><div class="v">${members.length}</div></div>
        <label>اسم الامتحان
          <input id="examNameInput" class="field" value="امتحان ${new Date().toLocaleDateString('ar-EG')}" placeholder="مثال: امتحان الدرس الأول">
        </label>
        <label>الدرجة النهائية
          <input id="examMaxInput" class="field" type="number" min="1" step="1" value="40" placeholder="مثال: 40">
        </label>
        <p class="scan-hint">هيتعمل ملف Excel فيه أسماء الطلاب جاهزة، ومع كل طالب خانة للدرجة والملاحظات. تقدر تفتحه وتسجل الدرجات مباشرة.</p>
        <button class="btn gold" id="doExportExamExcel">⬇ تصدير Excel</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.querySelector('#closeExamExcel').onclick=close;
  ov.addEventListener('click',e=>{if(e.target===ov)close();});
  ov.querySelector('#doExportExamExcel').onclick=()=>{
    const examName=(ov.querySelector('#examNameInput').value||'امتحان').trim();
    const max=Number(ov.querySelector('#examMaxInput').value);
    if(!examName){ showToast('اكتب اسم الامتحان'); return; }
    if(!Number.isFinite(max) || max<=0){ showToast('اكتب درجة نهائية صحيحة'); return; }
    const rows=members.map((s,i)=>({
      'م':i+1,
      'اسم الطالب':s.name||'',
      'رقم الهاتف':s.phone||'',
      'الكود':s.barcode||'',
      'المجموعة':group.name||'',
      'الامتحان':examName,
      'الدرجة النهائية':max,
      'الدرجة': '',
      'النسبة %':'',
      'ملاحظات':''
    }));
    const ws=XLSX.utils.json_to_sheet(rows);
    ws['!cols']=[{wch:6},{wch:30},{wch:16},{wch:16},{wch:22},{wch:28},{wch:16},{wch:12},{wch:12},{wch:30}];
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,'درجات الامتحان');
    const safeGroup=group.name.replace(/[\\/:*?"<>|]/g,'_');
    const safeExam=examName.replace(/[\\/:*?"<>|]/g,'_');
    XLSX.writeFile(wb,`كشف_${safeGroup}_${safeExam}.xlsx`);
    close();
    showToast(`تم تصدير ${members.length} طالب إلى Excel ✓`);
  };
}

// يجمع كل الامتحانات المسجّلة فعليًا لطلاب المجموعة دي (من خلال رصد الدرجات) — كل امتحان اتعمله دفعة رصد واحدة بنفس الاسم/التاريخ/الدرجة النهائية
function getGroupExams(group){
  const members = DATA.filter(s=>s.groupId===group.id);
  const map = new Map();
  members.forEach(s=>{
    (s.grades||[]).forEach(gr=>{
      const key = `${gr.name}|||${gr.date||''}|||${gr.max}`;
      if(!map.has(key)) map.set(key, { name: gr.name, date: gr.date||'', max: gr.max, count: 0 });
      map.get(key).count++;
    });
  });
  return Array.from(map.values()).sort((a,b)=> (b.date||'').localeCompare(a.date||''));
}

// شاشة اختيار الامتحان اللي عايز تنزّل نتيجته — بتعرض كل الامتحانات المسجّلة فعليًا في المجموعة دي
function openExamResultsExportModal(group){
  const members = DATA.filter(s=>s.groupId===group.id).sort((a,b)=>a.name.localeCompare(b.name,'ar'));
  if(!members.length){ showToast('المجموعة لا تحتوي على طلاب'); return; }
  const exams = getGroupExams(group);
  if(!exams.length){ showToast('لسه مفيش درجات متسجلة لأي امتحان في المجموعة دي — استخدم "رصد درجات امتحان" الأول'); return; }
  const ov=document.createElement('div'); ov.className='overlay';
  ov.innerHTML=`
    <div class="modal">
      <div class="modal-head"><h3>📤 تنزيل نتيجة امتحان</h3><button class="close" id="close_er">×</button></div>
      <p class="scan-hint" style="text-align:right;">اختار الامتحان اللي عايز تنزّل نتيجته. هيتنزّلك ملفين: واحد للحاصلين على الدرجة النهائية بس، وواحد فيه كل طلاب المجموعة (واللي مترصدلوش درجة في الامتحان ده هتفضل خانة درجته فاضية).</p>
      <div style="display:flex;flex-direction:column;gap:8px;max-height:320px;overflow-y:auto;">
        ${exams.map((ex,i)=>`
          <button class="btn outline exam-pick" data-i="${i}" style="text-align:right;display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:12px;">
            <b>${escapeHtml(ex.name)}</b>
            <span style="font-size:12px;color:var(--ink-soft);">${ex.date?escapeHtml(prettyDate(ex.date))+' — ':''}من ${ex.max} &nbsp;|&nbsp; اتقيّم ${ex.count} من ${members.length} طالب</span>
          </button>`).join('')}
      </div>
      <div class="modal-actions"><button class="btn outline" id="cancel_er">إلغاء</button></div>
    </div>`;
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.querySelector('#close_er').onclick=close;
  ov.querySelector('#cancel_er').onclick=close;
  ov.addEventListener('click',e=>{if(e.target===ov)close();});
  ov.querySelectorAll('.exam-pick').forEach(b=>{
    b.onclick=()=>{
      const ex = exams[Number(b.dataset.i)];
      exportExamResults(group, members, ex);
      close();
    };
  });
}

// بيطلّع فعليًا الملفين (الحاصلين على الدرجة النهائية + كل طلاب المجموعة) لامتحان معيّن
function exportExamResults(group, members, exam){
  const safeGroup = group.name.replace(/[\\/:*?"<>|]/g,'_');
  const safeExam = exam.name.replace(/[\\/:*?"<>|]/g,'_');
  const findGrade = s => (s.grades||[]).find(g => g.name===exam.name && (g.date||'')===exam.date && g.max===exam.max);
  const cols = [{wch:6},{wch:30},{wch:16},{wch:16},{wch:22},{wch:28},{wch:14},{wch:16},{wch:12}];

  // ملف 1: الحاصلين على الدرجة النهائية فقط (بيتنزّل بس لو فيه حد فعلاً جابها)
  const fullMarkers = members.filter(s=>{ const g=findGrade(s); return g && g.score===g.max; });
  if(fullMarkers.length){
    const rowsFull = fullMarkers.map((s,i)=>({
      'م': i+1, 'اسم الطالب': s.name||'', 'رقم الهاتف': s.phone||'', 'الكود': s.barcode||'',
      'المجموعة': group.name||'', 'الامتحان': exam.name, 'الدرجة': exam.max, 'الدرجة النهائية': exam.max, 'النسبة %': 100
    }));
    const ws1=XLSX.utils.json_to_sheet(rowsFull);
    ws1['!cols']=cols;
    const wb1=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb1,ws1,'الدرجة النهائية');
    XLSX.writeFile(wb1,`الحاصلين_على_الدرجة_النهائية_${safeGroup}_${safeExam}.xlsx`);
  }

  // ملف 2: كل طلاب المجموعة — واللي مترصدلوش درجة في الامتحان ده تفضل خانته فاضية، مش بيتشال من الملف
  const rowsAll = members.map((s,i)=>{
    const g = findGrade(s);
    const pct = g ? Math.round((g.score/g.max)*100) : '';
    return {
      'م': i+1, 'اسم الطالب': s.name||'', 'رقم الهاتف': s.phone||'', 'الكود': s.barcode||'',
      'المجموعة': group.name||'', 'الامتحان': exam.name, 'الدرجة': g ? g.score : '', 'الدرجة النهائية': exam.max, 'النسبة %': pct
    };
  });
  const ws2=XLSX.utils.json_to_sheet(rowsAll);
  ws2['!cols']=cols;
  const wb2=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2,ws2,'نتيجة الامتحان');
  XLSX.writeFile(wb2,`نتيجة_${safeGroup}_${safeExam}.xlsx`);

  showToast(fullMarkers.length
    ? `تم تنزيل الملفين ✔ (${fullMarkers.length} حاصل على الدرجة النهائية من ${members.length})`
    : `تم تنزيل ملف النتيجة الكاملة — محدش حصل على الدرجة النهائية في الامتحان ده`);
}

/* ============ Dropouts: students who missed their last N sessions in a row ============ */
let dropoutThreshold = 4;

function computeDropouts(){
  const result = [];
  DATA.forEach(s=>{
    const att = s.attendance || {};
    const entries = Object.keys(att)
      .filter(k=> (att[k]==='present' || att[k]==='absent') && k >= (s.restoredAt||''))
      .sort((a,b)=> b.localeCompare(a)); // أحدث تاريخ الأول
    if(entries.length < dropoutThreshold) return; // مفيش سجل كافي نحكم بيه لسه
    const lastN = entries.slice(0, dropoutThreshold);
    const allAbsent = lastN.every(k=> att[k]==='absent');
    if(!allAbsent) return;
    const lastPresentKey = entries.find(k=> att[k]==='present') || null;
    result.push({ s, lastPresent: lastPresentKey });
  });
  result.sort((a,b)=>{
    if(!a.lastPresent && b.lastPresent) return -1;
    if(a.lastPresent && !b.lastPresent) return 1;
    if(a.lastPresent && b.lastPresent) return a.lastPresent.localeCompare(b.lastPresent);
    return a.s.name.localeCompare(b.s.name,'ar');
  });
  return result;
}

function renderDropouts(){
  const view = document.getElementById('dropoutsView');
  view.innerHTML = `
    <div class="section-title"><span>🚫 الطلاب المنقطعين</span><div class="line"></div></div>
    <div class="card" style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
      <label style="font-size:13px; color:var(--ink-soft); display:flex; align-items:center; gap:8px;">
        اعتبر الطالب منقطع لو غاب آخر
        <input type="number" id="dropoutThresholdInput" min="1" value="${dropoutThreshold}" style="width:60px; padding:6px 8px; border-radius:6px; border:1px solid var(--rule); background:#1f2330; color:#fff; text-align:center;">
        حصص على التوالي
      </label>
      <button class="btn gold" id="applyThresholdBtn">تطبيق</button>
      <button class="btn gold" id="archiveAllDropoutsBtn" style="margin-right:auto;">📦 أرشفة كل اللي في القايمة</button>
    </div>
    <div id="dropoutsList"></div>
  `;
  document.getElementById('applyThresholdBtn').onclick = ()=>{
    const v = parseInt(document.getElementById('dropoutThresholdInput').value);
    dropoutThreshold = (v && v>0) ? v : 4;
    renderDropoutsList();
  };
  document.getElementById('archiveAllDropoutsBtn').onclick = async ()=>{
    const rows = computeDropouts();
    if(rows.length===0){ showToast('مفيش حد في القايمة'); return; }
    if(!confirm(`هتنقل ${rows.length} طالب للأرشيف. بياناتهم محفوظة كاملة وتقدر ترجّعهم في أي وقت. تمام؟`)) return;
    const n = await archiveStudents(rows.map(r=>r.s.id));
    showToast(`📦 اتنقل ${n} طالب للأرشيف`);
    renderDropoutsList();
  };
  renderDropoutsList();
}

function renderDropoutsList(){
  const list = document.getElementById('dropoutsList');
  const rows = computeDropouts();
  if(rows.length===0){
    list.innerHTML = `<div class="empty">مفيش طلاب منقطعين حسب الشرط ده 🎉</div>`;
    return;
  }
  list.innerHTML = `<div class="student-list" style="margin-top:14px;">` + rows.map(r=>{
    const { s, lastPresent } = r;
    const g = getGroup(s.groupId);
    const lastTxt = lastPresent ? `آخر حضور: ${lastPresent}` : 'لسه محضرش ولا حصة خالص';
    return `
    <div class="student-row" style="cursor:default;">
      <div>
        <div class="name">${escapeHtml(s.name)}</div>
        <div class="meta">${g?escapeHtml(g.name):'بدون مجموعة'} &nbsp;|&nbsp; ${lastTxt}</div>
        <div class="meta">📞 ${escapeHtml(s.phone||'—')} &nbsp;|&nbsp; ولي الأمر: ${escapeHtml(s.parentPhone||'—')}</div>
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        <button class="btn outline small viewProfileBtn" data-id="${s.id}">👤 بروفايل</button>
        <button class="btn gold small archDropoutBtn" data-id="${s.id}">📦 أرشفة</button>
      </div>
    </div>`;
  }).join('') + `</div>`;
  list.querySelectorAll('.viewProfileBtn').forEach(b=>{
    b.onclick = ()=> openProfile(b.dataset.id);
  });
  list.querySelectorAll('.archDropoutBtn').forEach(b=>{
    b.onclick = async ()=>{
      const s = DATA.find(x=>x.id===b.dataset.id);
      if(!s) return;
      if(confirm(`تنقل "${s.name}" للأرشيف؟ (بياناته محفوظة وتقدر ترجّعه)`)){
        await archiveStudents([s.id]);
        showToast('📦 اتنقل للأرشيف');
        renderDropoutsList();
      }
    };
  });
}

/* ============ Theme toggle (additive UI preference only; does not touch Firebase data) ============ */
const themeToggleBtn = document.getElementById('themeToggleBtn');
if(themeToggleBtn){
  function reflectThemeIcon(){
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    themeToggleBtn.textContent = isLight ? '🌙' : '☀️';
  }
  reflectThemeIcon();
  themeToggleBtn.onclick = ()=>{
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const next = isLight ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try{ localStorage.setItem('dorosi-theme', next); }catch(e){}
    reflectThemeIcon();
  };
}

/* ============ Settings: backup / import / password / reset ============ */
document.getElementById('settingsBtn').onclick = ()=>{
  const ov = document.createElement('div');
  ov.className='overlay';
  const last = Number(SETTINGS.lastBackupAt)||0;
  ov.innerHTML = `
    <div class="modal">
      <h3>⚙ الإعدادات</h3>
      <p style="font-size:13px; color:var(--ink-soft);">نسخ احتياطي لبيانات الطلاب والمجموعات أو استعادتها.</p>
      <div class="settings-row">
        <button class="btn outline" id="exportBtn">⬇ تنزيل نسخة احتياطية</button>
        <label class="btn outline" style="cursor:pointer;">⬆ استيراد نسخة
          <input type="file" id="importFile" accept="application/json" style="display:none;">
        </label>
      </div>
      <p style="font-size:12px; color:var(--ink-soft); margin:8px 0;">آخر نسخة احتياطية: ${last ? new Date(last).toLocaleString('ar-EG') : 'لسه معملتش'}</p>
      <label style="display:flex; align-items:center; gap:8px; font-size:13px; margin:6px 0 14px;">
        <input type="checkbox" id="autoBackupChk" ${SETTINGS.autoBackup?'checked':''}> نسخة احتياطية تلقائية كل أسبوع (بتتنزّل لما تفتح البرنامج)
      </label>
      <div class="field"><label>رسالة تذكير الدفع لولي الأمر — المتغيرات: {name} {months} {amount} {teacher}</label>
        <textarea id="payMsgTpl" rows="5">${escapeHtml(SETTINGS.payMsgTemplate||DEFAULT_PAY_MSG)}</textarea></div>
      <div class="settings-row" style="margin-bottom:6px;">
        <button class="btn outline small" id="savePayMsgBtn">💾 حفظ رسالة التذكير</button>
        <button class="btn outline small" id="changePassBtn">🔑 تغيير كلمة المرور (بالإيميل)</button>
      </div>
      <div class="modal-actions">
        <button class="btn danger" id="resetBtn">حذف كل البيانات</button>
        <button class="btn outline" id="signOutBtn">🚪 تسجيل الخروج</button>
        <button class="btn outline" id="closeSettings">إغلاق</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.remove(); });
  ov.querySelector('#closeSettings').onclick = ()=>ov.remove();
  ov.querySelector('#signOutBtn').onclick = ()=> auth.signOut();
  ov.querySelector('#exportBtn').onclick = ()=>{ downloadBackup(); ov.remove(); showToast('تم تنزيل النسخة الاحتياطية ✔'); };
  ov.querySelector('#autoBackupChk').onchange = async (e)=>{ SETTINGS.autoBackup = e.target.checked; await saveData(); showToast(e.target.checked?'النسخ التلقائي مفعّل':'النسخ التلقائي متوقف'); };
  ov.querySelector('#savePayMsgBtn').onclick = async ()=>{ SETTINGS.payMsgTemplate = ov.querySelector('#payMsgTpl').value.trim() || DEFAULT_PAY_MSG; await saveData(); showToast('تم حفظ رسالة التذكير ✔'); };
  ov.querySelector('#changePassBtn').onclick = async ()=>{
    try{ await auth.sendPasswordResetEmail(auth.currentUser.email); showToast('اتبعتلك رابط تغيير كلمة المرور على إيميلك'); }
    catch(e){ showToast(translateAuthErr(e)); }
  };
  ov.querySelector('#importFile').onchange = async (e)=>{
    const file = e.target.files[0]; if(!file) return;
    const text = await file.text();
    try{
      const parsed = JSON.parse(text);
      if(!confirm('الاستيراد هيستبدل البيانات الحالية بمحتوى الملف. متأكد؟')) return;
      if(Array.isArray(parsed)){
        DATA = parsed; GROUPS = []; ACTIVE_SESSION = null; SESSIONS = [];
      }else if(parsed && Array.isArray(parsed.students)){
        DATA = parsed.students; GROUPS = Array.isArray(parsed.groups) ? parsed.groups : []; ACTIVE_SESSION = parsed.activeSession || null;
        SESSIONS = Array.isArray(parsed.sessions) ? parsed.sessions.map(normalizeSessionRecord).filter(Boolean) : [];
        if(parsed.settings && typeof parsed.settings==='object') SETTINGS = Object.assign({...DEFAULT_SETTINGS}, parsed.settings);
      }else{ showToast('ملف غير صالح'); return; }
      DATA.forEach(s=>{ if(!s.id) s.id = uid('s'); });
      partitionArchive(); updateArchiveTab();
      await saveData();
      showToast('تم استيراد البيانات');
      ov.remove();
      showView('groups'); renderGroupsList();
    }catch(err){ showToast('تعذّرت قراءة الملف'); }
  };
  ov.querySelector('#resetBtn').onclick = async ()=>{
    if(confirm('هل أنت متأكد من حذف كل البيانات (الطلاب والمجموعات)؟ لا يمكن التراجع.')){
      downloadBackup('قبل-الحذف', true);
      DATA = []; ARCHIVE = []; GROUPS = []; ACTIVE_SESSION = null; SESSIONS = [];
      updateArchiveTab();
      await saveData();
      ov.remove();
      showView('groups'); renderGroupsList();
      showToast('تم حذف كل البيانات (نزلتلك نسخة احتياطية قبل الحذف)');
    }
  };
};

/* ============ Auth ============ */
function authErr(msg){ document.getElementById('authError').textContent = msg; }
document.getElementById('loginBtn').onclick = async ()=>{
  authErr('');
  const email = document.getElementById('authEmail').value.trim();
  const pass = document.getElementById('authPass').value;
  if(!email || !pass){ authErr('اكتب الإيميل وكلمة المرور'); return; }
  try{ await auth.signInWithEmailAndPassword(email, pass); }
  catch(e){ authErr(translateAuthErr(e)); }
};
document.getElementById('signupBtn').onclick = async ()=>{
  authErr('');
  const email = document.getElementById('authEmail').value.trim();
  const pass = document.getElementById('authPass').value;
  if(!email || !pass){ authErr('اكتب الإيميل وكلمة المرور'); return; }
  if(pass.length < 6){ authErr('كلمة المرور لازم 6 حروف/أرقام على الأقل'); return; }
  try{ await auth.createUserWithEmailAndPassword(email, pass); }
  catch(e){ authErr(translateAuthErr(e)); }
};
document.getElementById('forgotBtn').onclick = async ()=>{
  authErr('');
  const email = document.getElementById('authEmail').value.trim();
  if(!email){ authErr('اكتب الإيميل الأول وبعدين دوس "نسيت كلمة المرور"'); return; }
  try{
    await auth.sendPasswordResetEmail(email);
    showToast('اتبعتلك رابط إعادة تعيين كلمة المرور على الإيميل (شوف الـ Spam كمان)');
  }catch(e){ authErr(translateAuthErr(e)); }
};
function translateAuthErr(e){
  const map = {
    'auth/email-already-in-use':'الإيميل ده مستخدم بالفعل — دوس دخول بدل إنشاء حساب',
    'auth/invalid-email':'الإيميل غير صحيح',
    'auth/weak-password':'كلمة المرور ضعيفة، اكتب 6 حروف على الأقل',
    'auth/wrong-password':'كلمة المرور غلط',
    'auth/user-not-found':'مفيش حساب بهذا الإيميل — اعمل حساب جديد',
    'auth/invalid-credential':'بيانات الدخول غير صحيحة',
    'auth/too-many-requests':'محاولات كتير — استنى شوية وجرّب تاني',
    'auth/network-request-failed':'مفيش اتصال بالإنترنت'
  };
  return map[e.code] || ('خطأ: ' + e.message);
}
auth.onAuthStateChanged(async (user)=>{
  if(user){
    currentUID = user.uid;
    document.getElementById('authScreen').style.display='none';
    document.getElementById('appWrap').style.display='';
    await loadData();
    NAV_STACK = [];
    showView('groups');
    renderGroupsList();
  }else{
    stopRealtimeSync(); LOAD_OK = false; DATA = []; ARCHIVE = []; GROUPS = []; SESSIONS = []; ACTIVE_SESSION = null;
    currentUID = null;
    document.getElementById('authScreen').style.display='';
    document.getElementById('appWrap').style.display='none';
  }
});

/* ============ PWA: تثبيت على الموبايل + فتح البرنامج بدون نت ============ */
if('serviceWorker' in navigator && /^https?:$/.test(location.protocol)){
  window.addEventListener('load', ()=>{ navigator.serviceWorker.register('sw.js').catch(()=>{}); });
}
