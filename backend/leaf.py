"""手机 / 平板作为「叶子节点」接入本机 hub。

手机不跑模型、不存整库，只是在同一局域网里打开 hub 提供的轻量页面：
配对一次后，所有读写都直接落到这台电脑（同源 API），所以电脑上看到的永远是最新稿。

安全边界：配对码只在本机页面可见，局域网设备拿不到；拿到码换取 token 后才能
访问项目读写接口。token 存 localStorage，换电脑/清缓存需重新配对。
"""

import json
import secrets
import socket
import threading
import time

import storage

_LEAF_PATH = storage.DATA_ROOT / "leaf.json"

# 6 位码只有一百万种，不做限制的话同网段可以暴力枚举。10 分钟内错 10 次就先锁住。
_FAIL_LOCK = threading.Lock()
_FAILS: list[float] = []
_FAIL_WINDOW = 600
_FAIL_LIMIT = 10


def _load() -> dict | None:
    if not _LEAF_PATH.exists():
        return None
    try:
        return json.loads(_LEAF_PATH.read_text(encoding="utf-8"))
    except Exception:
        return None


def state() -> dict:
    """配对码与 token 持久化：重启后端后手机不必重新配对。"""
    data = _load()
    if data and data.get("code") and data.get("token"):
        return data
    data = {"code": f"{secrets.randbelow(1000000):06d}", "token": secrets.token_urlsafe(24)}
    storage._write_json(_LEAF_PATH, data)
    return data


def token_ok(token: str) -> bool:
    if not token:
        return False
    return secrets.compare_digest(str(token), str(state()["token"]))


def too_many_attempts() -> bool:
    now = time.time()
    with _FAIL_LOCK:
        _FAILS[:] = [t for t in _FAILS if now - t < _FAIL_WINDOW]
        return len(_FAILS) >= _FAIL_LIMIT


def note_failure() -> None:
    with _FAIL_LOCK:
        _FAILS.append(time.time())


def verify(code: str) -> str | None:
    """配对码正确才发 token；比较用常数时间，避免尝试次数泄露前缀。"""
    code = str(code or "").strip()
    if len(code) != 6 or not code.isdigit():
        return None
    if not secrets.compare_digest(code, str(state()["code"])):
        return None
    return str(state()["token"])


def lan_ip() -> str:
    """探测本机在局域网里的地址（UDP connect 不发包，只让系统选路由）。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


def urls(port: int) -> list[str]:
    return [f"http://{lan_ip()}:{port}/m"]


def page() -> str:
    """轻量移动端页面：配对 → 项目 → 录音 → 逐句编辑 / 指定发言人 / 合并。"""
    return _PAGE


_PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111827">
<title>听写 · 手机端</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e8ebef;--text:#1f2328;--muted:#8a94a6;--primary:#2563eb;--danger:#b00020}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding-bottom:env(safe-area-inset-bottom)}
header{position:sticky;top:0;z-index:5;background:rgba(246,247,249,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);padding:calc(10px + env(safe-area-inset-top)) 14px 10px;display:flex;align-items:center;gap:10px}
header h1{font-size:16px;margin:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button{font:inherit;border:0;border-radius:10px;padding:9px 14px;background:#eef1f5;color:var(--text)}
button.primary{background:var(--primary);color:#fff}
button.ghost{background:transparent;color:var(--muted)}
button:disabled{opacity:.45}
main{padding:12px 12px 30px;max-width:760px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;margin-bottom:10px}
.row{display:flex;align-items:flex-start;gap:10px}
.muted{color:var(--muted);font-size:12.5px}
.title{font-size:15px;font-weight:600}
.sentence{padding:11px 12px;border-bottom:1px solid #f2f4f7;display:flex;gap:10px;align-items:flex-start}
.sentence:last-child{border-bottom:0}
.speaker{flex:0 0 auto;font-size:11px;color:#5b6472;background:#f1f4f8;border-radius:7px;padding:2px 7px;margin-top:1px;max-width:92px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.text{flex:1;word-break:break-word}
.text.dirty{color:#b45309}
input,select,textarea{font:inherit;width:100%;border:1px solid var(--line);border-radius:10px;padding:9px 10px;background:#fff;color:var(--text)}
textarea{min-height:96px;resize:vertical}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.pill{font-size:12px;color:var(--muted);padding:8px 2px}
.empty{text-align:center;color:var(--muted);padding:36px 10px}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#111827;color:#fff;padding:9px 16px;border-radius:999px;font-size:13px;opacity:0;transition:.2s;pointer-events:none}
.toast.on{opacity:1}
</style>
</head>
<body>
<div id="app"></div>
<div id="toast" class="toast"></div>
<script>
const KEY='lw_leaf_token';
let token=localStorage.getItem(KEY)||'';
const app=document.getElementById('app');
const view={name:'boot'};
let pollTimer=null;

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('on');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('on'),1800)}
async function api(path,opt){
  opt=opt||{};
  const headers=Object.assign({'X-Leaf-Token':token},opt.headers||{});
  if(opt.body&&typeof opt.body!=='string'){headers['Content-Type']='application/json';opt.body=JSON.stringify(opt.body)}
  const res=await fetch(path,Object.assign({},opt,{headers}));
  const data=await res.json().catch(()=>({}));
  if(res.status===403){token='';localStorage.removeItem(KEY);renderPair('配对已失效，请重新输入电脑上的配对码');throw new Error(data.error||'需要配对')}
  if(!res.ok)throw new Error(data.error||('HTTP '+res.status));
  return data;
}
function stopPoll(){if(pollTimer){clearInterval(pollTimer);pollTimer=null}}

function renderPair(msg){
  stopPoll();view.name='pair';
  app.innerHTML=`<header><h1>配对这台电脑</h1></header><main>
    <div class="card">
      <div class="title" style="margin-bottom:6px">输入电脑上的 6 位配对码</div>
      <div class="muted" style="margin-bottom:10px">电脑端「设置」里能看到配对码。手机需要和电脑连同一个 Wi-Fi。</div>
      ${msg?`<div class="muted" style="color:#b00020;margin-bottom:8px">${esc(msg)}</div>`:''}
      <input id="code" inputmode="numeric" maxlength="6" placeholder="000000" style="font-size:24px;letter-spacing:8px;text-align:center">
      <button class="primary" id="pairBtn" style="width:100%;margin-top:10px">配对</button>
    </div></main>`;
  const btn=document.getElementById('pairBtn');
  btn.onclick=async()=>{
    const code=(document.getElementById('code').value||'').trim();
    if(!/^\\d{6}$/.test(code)){toast('请输入 6 位数字');return}
    btn.disabled=true;
    try{
      const r=await fetch('/api/leaf/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(d.error||'配对码不正确');
      token=d.token;localStorage.setItem(KEY,token);toast('配对成功');goProjects();
    }catch(e){toast(e.message||'配对失败')}finally{btn.disabled=false}
  };
}

async function goProjects(){
  stopPoll();view.name='projects';
  app.innerHTML=`<header><h1>我的项目</h1></header><main><div class="empty">加载中…</div></main>`;
  try{
    const d=await api('/api/projects');
    const list=d.projects||[];
    app.innerHTML=`<header><h1>我的项目</h1></header><main>
      ${list.length?list.map(p=>`<div class="card" data-pid="${esc(p.id)}"><div class="title">${esc(p.name)}</div><div class="muted">${esc(p.description||'')}</div></div>`).join(''):'<div class="empty">还没有项目，请先在电脑上创建</div>'}
      </main>`;
    app.querySelectorAll('[data-pid]').forEach(el=>el.onclick=()=>goRecordings(el.dataset.pid));
  }catch(e){if(view.name==='pair')return;app.innerHTML=`<header><h1>我的项目</h1></header><main><div class="empty">${esc(e.message)}</div><button class="primary" onclick="goProjects()">重试</button></main>`}
}

async function goRecordings(pid,pidName){
  stopPoll();view.name='recordings';view.pid=pid;
  app.innerHTML=`<header><button class="ghost" onclick="goProjects()">‹ 项目</button><h1>录音</h1></header><main><div class="empty">加载中…</div></main>`;
  try{
    const d=await api('/api/projects/'+encodeURIComponent(pid)+'/recordings');
    const list=d.recordings||[];
    app.innerHTML=`<header><button class="ghost" onclick="goProjects()">‹ 项目</button><h1>录音</h1></header><main>
      ${list.length?list.map(r=>{
        const st=(r.transcribe&&r.transcribe.status)||'pending';
        const label={pending:'待转写',transcribing:'转写中',done:'已完成',error:'转写失败'}[st]||st;
        return `<div class="card" data-rid="${esc(r.id)}"><div class="row"><div class="title" style="flex:1">${esc(r.name)}</div><span class="speaker">${esc(label)}</span></div><div class="muted">${Math.round((r.duration_sec||0))} 秒</div></div>`;
      }).join(''):'<div class="empty">这个项目还没有录音</div>'}
      </main>`;
    app.querySelectorAll('[data-rid]').forEach(el=>el.onclick=()=>goTranscript(pid,el.dataset.rid));
  }catch(e){if(view.name==='pair')return;app.innerHTML=`<header><button class="ghost" onclick="goProjects()">‹ 项目</button><h1>录音</h1></header><main><div class="empty">${esc(e.message)}</div></main>`}
}

async function loadDetail(pid,rid){
  const d=await api('/api/projects/'+encodeURIComponent(pid)+'/recordings/'+encodeURIComponent(rid));
  return d;
}

let editing=null;      // {id,text,speaker}
let mergeMode=false;
let selected=[];
let detail=null;

async function goTranscript(pid,rid,quiet){
  view.name='transcript';view.pid=pid;view.rid=rid;
  if(!quiet){app.innerHTML=`<header><button class="ghost" onclick="goRecordings('${esc(pid)}')">‹ 录音</button><h1>转写稿</h1></header><main><div class="empty">加载中…</div></main>`}
  try{
    detail=await loadDetail(pid,rid);
    if(editing){const s=(detail.sentences||[]).find(x=>x.id===editing.id);if(!s){editing=null}}
    drawTranscript();
    if(!pollTimer){pollTimer=setInterval(()=>{if(view.name==='transcript'&&!editing&&!mergeMode)goTranscript(view.pid,view.rid,true)},5000)}
  }catch(e){
    if(view.name==='pair')return;
    if(!quiet)app.innerHTML=`<header><button class="ghost" onclick="goProjects()">‹ 项目</button><h1>转写稿</h1></header><main><div class="empty">${esc(e.message)}</div></main>`;
  }
}

function speakersOf(){
  const set=new Set(detail.speakers||[]);
  (detail.sentences||[]).forEach(s=>{if(s.speaker)set.add(s.speaker)});
  return Array.from(set);
}

function drawTranscript(){
  const list=detail.sentences||[];
  const roster=speakersOf();
  const header=`<header><button class="ghost" onclick="goRecordings('${esc(view.pid)}')">‹ 录音</button><h1>${esc(detail.recording?detail.recording.name:'转写稿')}</h1></header>`;
  if(list.length===0){
    app.innerHTML=header+`<main><div class="empty">还没有转写内容</div></main>`;return;
  }
  const mergeBar=mergeMode?`<div class="bar"><span class="pill">已选 ${selected.length} 句</span>
      <button class="primary" id="doMerge" ${selected.length<2?'disabled':''}>合并所选</button>
      <button id="cancelMerge">退出合并</button></div>`:'';
  app.innerHTML=header+`<main>
    <div class="bar" style="justify-content:space-between">
      <span class="pill">${list.length} 句 · ${roster.length} 位发言人</span>
      <span style="display:flex;gap:6px">
        <button id="addSpeaker">＋发言人</button>
        <button id="toggleMerge">${mergeMode?'退出合并':'多句合并'}</button>
      </span>
    </div>
    ${mergeBar}
    <div class="card" style="padding:0;overflow:hidden">
      ${list.map(s=>{
        const checked=selected.includes(s.id);
        const isEdit=editing&&editing.id===s.id;
        return `<div class="sentence" data-sid="${esc(s.id)}">
          ${mergeMode?`<input type="checkbox" data-check="${esc(s.id)}" ${checked?'checked':''} style="width:18px;height:18px;margin-top:2px">`:''}
          <span class="speaker">${esc(s.speaker||'未标注')}</span>
          <div class="text" style="flex:1">
            ${isEdit?`
              <textarea id="editText">${esc(editing.text)}</textarea>
              <div class="bar" style="margin:8px 0 0">
                <select id="editSpeaker" style="flex:1">
                  <option value="">未标注</option>
                  ${roster.map(n=>`<option value="${esc(n)}" ${editing.speaker===n?'selected':''}>${esc(n)}</option>`).join('')}
                  ${editing.speaker&&!roster.includes(editing.speaker)?`<option value="${esc(editing.speaker)}" selected>${esc(editing.speaker)}</option>`:''}
                </select>
                <button class="primary" id="saveEdit">保存</button>
                <button id="cancelEdit">取消</button>
              </div>`:
              `<div>${esc(s.text)}</div>`}
          </div>
        </div>`;
      }).join('')}
    </div></main>`;
  bindTranscript(list,roster);
}

function bindTranscript(list,roster){
  app.querySelectorAll('[data-sid]').forEach(row=>{
    const sid=row.dataset.sid;
    row.onclick=(ev)=>{
      if(mergeMode){ev.stopPropagation();toggleSelect(sid);return}
      if(ev.target.closest('button,select,textarea,input'))return;
      const s=list.find(x=>x.id===sid);
      if(!s)return;
      if(!s.text.trim()){toast('这句话是空的，无法编辑');return}
      editing={id:s.id,text:s.text,speaker:s.speaker||''};drawTranscript();
    };
  });
  const add=document.getElementById('addSpeaker');
  if(add)add.onclick=async()=>{
    const name=(prompt('新发言人名字，例如「受访者B」')||'').trim();
    if(!name)return;
    try{await api('/api/projects/'+encodeURIComponent(view.pid)+'/recordings/'+encodeURIComponent(view.rid)+'/speakers',{method:'PATCH',body:{action:'create',name}});toast('已添加');await goTranscript(view.pid,view.rid,true)}catch(e){toast(e.message)}
  };
  const tm=document.getElementById('toggleMerge');
  if(tm)tm.onclick=()=>{mergeMode=!mergeMode;selected=[];editing=null;drawTranscript()};
  const cm=document.getElementById('cancelMerge');
  if(cm)cm.onclick=()=>{mergeMode=false;selected=[];drawTranscript()};
  const dm=document.getElementById('doMerge');
  if(dm)dm.onclick=async()=>{
    if(selected.length<2)return;
    try{await api('/api/projects/'+encodeURIComponent(view.pid)+'/recordings/'+encodeURIComponent(view.rid)+'/sentences/merge',{method:'POST',body:{sentence_ids:selected}});mergeMode=false;selected=[];toast('已合并');await goTranscript(view.pid,view.rid,true)}catch(e){toast(e.message)}
  };
  const se=document.getElementById('saveEdit');
  if(se)se.onclick=async()=>{
    const text=(document.getElementById('editText').value||'').trim();
    const speaker=document.getElementById('editSpeaker').value;
    if(!text){toast('内容不能为空');return}
    se.disabled=true;
    try{
      await api('/api/projects/'+encodeURIComponent(view.pid)+'/recordings/'+encodeURIComponent(view.rid)+'/sentences/'+encodeURIComponent(editing.id),{method:'PATCH',body:{text,speaker}});
      editing=null;toast('已保存（电脑端同步）');await goTranscript(view.pid,view.rid,true);
    }catch(e){toast(e.message)}finally{se.disabled=false}
  };
  const ce=document.getElementById('cancelEdit');
  if(ce)ce.onclick=()=>{editing=null;drawTranscript()};
  app.querySelectorAll('[data-check]').forEach(cb=>{
    cb.onclick=(ev)=>{ev.stopPropagation();toggleSelect(cb.dataset.check)};
  });
}

function toggleSelect(sid){
  const i=selected.indexOf(sid);
  if(i>=0)selected.splice(i,1);else selected.push(sid);
  drawTranscript();
}

function boot(){
  if(!token){renderPair('');return}
  goProjects();
}
window.goProjects=goProjects;window.goRecordings=goRecordings;
boot();
</script>
</body>
</html>
"""
