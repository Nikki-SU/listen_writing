const STORAGE_KEY = 'lw_coding_prototype_v2';
const SCHEMA = 2;
const ME = 'me';
const P2 = 'p02';

const app = document.getElementById('app');
let toastTimer = null;
let rafId = null;

const ui = {
  mode: 'reading',
  activeDocId: 'P03',
  activeSentenceId: null,
  activeCodingId: null,
  activeCodeId: 'form',
  selection: null,
  helpOpen: true,
  onlyConflicts: false,
  analysisSelection: null,
  mergeConfirm: false,
  play: null,
};

let data = loadData();

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function spanOf(text, quote) {
  const start = text.indexOf(quote);
  return start < 0 ? [0, 0] : [start, start + quote.length];
}

function buildSample() {
  const codes = [
    { id: 'form', parent: null, color: 0, name: '形式化治理', definition: '以可见的流程、材料与留痕替代实际效果。', inclusion: '拍照、填表、迎检、留痕、走流程。', exclusion: '真正解决问题、居民实际受益。' },
    { id: 'photo', parent: 'form', color: 0, name: '拍照留痕', definition: '用照片证明活动发生过。', inclusion: '拍照、合影、留痕。', exclusion: '仅口头汇报。' },
    { id: 'table', parent: 'form', color: 0, name: '表格迎检', definition: '以表格和记录应付检查。', inclusion: '填表、记录、台账、考核。', exclusion: '实际走访但无表格。' },
    { id: 'perf', parent: 'form', color: 0, name: '应付策略', definition: '以最低成本完成参与，避免公开冲突。', inclusion: '走流程、应付一下、做完就行。', exclusion: '真正认同并主动参与。' },
    { id: 'access', parent: null, color: 2, name: '参与资格', definition: '谁有资格参与、以什么代价参与。', inclusion: '不得不去、没时间、无力感。', exclusion: '自愿且有余力的参与。' },
    { id: 'must', parent: 'access', color: 2, name: '不得不参与', definition: '因为制度或关系压力而参与。', inclusion: '不去不行、别人都去、考核要求。', exclusion: '完全自愿。' },
    { id: 'powerless', parent: 'access', color: 2, name: '无力感', definition: '想做但觉得改变不了。', inclusion: '时间不够、做了也没用、奇怪。', exclusion: '有效改变或积极行动。' },
    { id: 'boundary', parent: null, color: 3, name: '边界工作', definition: '把某些话题处理成“非政治”的日常表达。', inclusion: '用梗、玩笑、不说破、都明白。', exclusion: '直接、公开的政治表达。' },
    { id: 'depol', parent: 'boundary', color: 3, name: '去政治化表达', definition: '用日常语言包装敏感话题。', inclusion: '梗、玩笑、暗示。', exclusion: '直接点名政治。' },
    { id: 'selfc', parent: 'boundary', color: 3, name: '自我审查', definition: '主动收回或避免表达敏感内容。', inclusion: '不说、不回复、不说了。', exclusion: '照常表达。' },
    { id: 'probe', parent: null, color: 1, name: '追问', definition: '访谈者追问、澄清或挑战受访者说法。', inclusion: '具体是指什么、这是不是……。', exclusion: '受访者自述。' },
  ];

  const documents = [
    {
      id: 'P03', title: '社区工作者 · 第三次访谈', speakerA: 'Speaker A', speakerB: 'Speaker B',
      sentences: [
        ['我们其实也知道，很多活动就是为了拍照，', 'Speaker A'],
        ['嗯，但是你不去又不行，', 'Speaker A'],
        ['所以大家就……就应付一下。', 'Speaker A'],
        ['你说的“应付”具体是指什么？', 'Speaker B'],
        ['就是……走个流程吧，不然考核过不了。', 'Speaker A'],
        ['而且上面要的是照片、表格，不是你实际做了什么。', 'Speaker A'],
        ['有时候我也想认真做，但是时间根本不够。', 'Speaker A'],
        ['你认真做，别人还觉得你奇怪。', 'Speaker A'],
        ['所以后来就……不说了，做完就行。', 'Speaker A'],
        ['嗯，反正大家都明白，不用说得太清楚。', 'Speaker B'],
      ],
    },
    {
      id: 'P01', title: '社区工作者 · 第一次访谈', speakerA: 'Speaker A', speakerB: 'Speaker B',
      sentences: [
        ['我一开始以为，居民会主动来反映问题。', 'Speaker A'],
        ['后来发现，大家更愿意在群里说，不愿意面对面。', 'Speaker A'],
        ['我们去入户的时候，他们会说“都挺好”，其实问题还在。', 'Speaker A'],
        ['上面考核看的是走访记录，不是问题有没有解决。', 'Speaker A'],
        ['所以我们就……把记录做漂亮一点。', 'Speaker A'],
        ['你说这是形式主义吗？我也不好说。', 'Speaker B'],
        ['但是不做记录，检查就过不了。', 'Speaker A'],
        ['嗯，大家都懂，不用明说。', 'Speaker A'],
      ],
    },
    {
      id: 'P02', title: '青年受访者 · 第二次访谈', speakerA: 'Speaker A', speakerB: 'Speaker B',
      sentences: [
        ['我不太想在公司里谈政治，太敏感了。', 'Speaker A'],
        ['群里有人发，我一般就看看，不回复。', 'Speaker A'],
        ['有时候会用一个梗，大家都懂，但不会说破。', 'Speaker A'],
        ['你说这是自我审查吗？可能是吧。', 'Speaker B'],
        ['但是说破了，关系就不好处了。', 'Speaker A'],
        ['所以就用玩笑的方式讲。', 'Speaker A'],
        ['嗯，反正圈子里的都明白。', 'Speaker A'],
      ],
    },
    {
      id: 'P04', title: '基层干部 · 第四次访谈', speakerA: 'Speaker A', speakerB: 'Speaker B',
      sentences: [
        ['我们的工作就是落实上面的要求。', 'Speaker A'],
        ['很多指标是硬的，必须完成。', 'Speaker A'],
        ['居民的需求和指标不一定对得上。', 'Speaker A'],
        ['那就先完成指标，再想办法。', 'Speaker A'],
        ['有时候也要拍照、留痕，证明做了。', 'Speaker A'],
        ['不然检查的时候说不清。', 'Speaker A'],
      ],
    },
  ];

  const docs = documents.map((d) => ({
    ...d,
    sentences: d.sentences.map(([text, speaker], i) => ({
      id: d.id + '-s' + (i + 1),
      index: i,
      text,
      speaker,
      start: i * 3000,
      end: i * 3000 + 2600,
    })),
  }));

  const codings = [];
  function add(docId, idx, quote, codeId, coderId) {
    const d = docs.find((x) => x.id === docId);
    const s = d && d.sentences[idx];
    if (!s) return;
    const [start, end] = spanOf(s.text, quote);
    if (end <= start) return;
    codings.push({ id: uid(), docId, sentenceId: s.id, start, end, codeId, coderId: coderId || ME });
  }

  add('P03', 0, '很多活动就是为了拍照', 'photo');
  add('P03', 1, '不去又不行', 'must');
  add('P03', 2, '就应付一下', 'perf');
  add('P03', 2, '所以大家就……', 'powerless');
  add('P03', 3, '“应付”具体是指什么', 'probe');
  add('P03', 4, '走个流程', 'perf');
  add('P03', 4, '考核过不了', 'form');
  add('P03', 5, '照片、表格', 'photo');
  add('P03', 5, '不是你实际做了什么', 'form');
  add('P03', 6, '时间根本不够', 'powerless');
  add('P03', 7, '别人还觉得你奇怪', 'must');
  add('P03', 8, '不说了，做完就行', 'selfc');
  add('P03', 9, '不用说得太清楚', 'selfc');

  add('P03', 0, '很多活动就是为了拍照', 'photo', P2);
  add('P03', 1, '不去又不行', 'must', P2);
  add('P03', 2, '大家就……就应付', 'perf', P2);
  add('P03', 4, '不然考核过不了', 'table', P2);
  add('P03', 6, '时间根本不够', 'powerless', P2);
  add('P03', 8, '做完就行', 'perf', P2);
  add('P03', 9, '不用说得太清楚', 'selfc', P2);

  add('P01', 2, '“都挺好”', 'depol');
  add('P01', 3, '走访记录', 'table');
  add('P01', 4, '记录做漂亮一点', 'perf');
  add('P01', 5, '形式主义吗', 'probe');
  add('P01', 6, '检查就过不了', 'table');
  add('P01', 7, '不用明说', 'depol');

  add('P01', 2, '“都挺好”', 'selfc', P2);
  add('P01', 3, '走访记录', 'table', P2);
  add('P01', 4, '记录做漂亮一点', 'perf', P2);
  add('P01', 6, '检查就过不了', 'table', P2);
  add('P01', 7, '不用明说', 'depol', P2);

  add('P02', 0, '太敏感了', 'selfc');
  add('P02', 1, '不回复', 'selfc');
  add('P02', 2, '用一个梗', 'depol');
  add('P02', 3, '自我审查吗', 'probe');
  add('P02', 4, '关系就不好处了', 'selfc');
  add('P02', 5, '用玩笑的方式讲', 'depol');
  add('P02', 6, '都明白', 'depol');

  add('P02', 0, '太敏感了', 'selfc', P2);
  add('P02', 1, '看看，不回复', 'selfc', P2);
  add('P02', 2, '用一个梗', 'depol', P2);
  add('P02', 4, '关系就不好处了', 'selfc', P2);
  add('P02', 5, '用玩笑的方式讲', 'depol', P2);

  const memos = [
    { id: uid(), targetType: 'sentence', targetId: 'P03-s3', author: '我', text: '为什么用“应付”而不是“抵抗”？要和 P01、P04 比较后再定。', ts: '刚刚' },
    { id: uid(), targetType: 'code', targetId: 'perf', author: '我', text: '注意区分“应付检查”与“真正认同但没时间”。', ts: '5 分钟前' },
    { id: uid(), targetType: 'sentence', targetId: 'P02-s1', author: '我', text: '这里可能是自我审查，也可能只是不想吵架；下次追问。', ts: '12 分钟前' },
  ];

  const themes = [
    { id: 't1', name: '在形式化治理中维持最低限度的参与', definition: '参与不是为了改变，而是为了不被指出问题。', codeIds: ['form', 'perf', 'must', 'powerless'] },
    { id: 't2', name: '把政治说成日常：边界工作的两种说法', definition: '用玩笑、梗与“都明白”把敏感话题留在可说的边界内。', codeIds: ['boundary', 'depol', 'selfc'] },
    { id: 't3', name: '照片与表格构成的可见性', definition: '只有被拍下、被填进表格的行动才算“做了”。', codeIds: ['photo', 'table'] },
  ];

  return { project: '泛政治议题研究', coders: [{ id: ME, name: '我' }, { id: P2, name: 'P02' }], docs, codes, codings, memos, themes, resolutions: {} };
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.schema === SCHEMA && parsed.data) return parsed.data;
    }
  } catch (e) {
    console.warn('load prototype data failed', e);
  }
  return buildSample();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ schema: SCHEMA, data }));
  } catch (e) {
    console.warn('persist prototype data failed', e);
  }
}

function getDoc(id) {
  return data.docs.find((d) => d.id === id) || null;
}

function getSentence(docId, sentenceId) {
  const d = getDoc(docId);
  return d ? d.sentences.find((s) => s.id === sentenceId) || null : null;
}

function getCode(id) {
  return data.codes.find((c) => c.id === id) || null;
}

function getCoding(id) {
  return data.codings.find((c) => c.id === id) || null;
}

function rootCode(codeId) {
  let c = getCode(codeId);
  let guard = 0;
  while (c && c.parent && guard < 20) {
    c = getCode(c.parent);
    guard += 1;
  }
  return c;
}

function colorIndex(codeId) {
  const root = rootCode(codeId);
  return root && typeof root.color === 'number' ? root.color : 0;
}

function subtreeIds(codeId) {
  const ids = new Set([codeId]);
  let changed = true;
  while (changed) {
    changed = false;
    data.codes.forEach((c) => {
      if (c.parent && ids.has(c.parent) && !ids.has(c.id)) {
        ids.add(c.id);
        changed = true;
      }
    });
  }
  return ids;
}

function codingsFor(docId, sentenceId, coderId) {
  const who = coderId || ME;
  return data.codings
    .filter((c) => c.docId === docId && c.sentenceId === sentenceId && c.coderId === who)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function docCodings(docId, coderId) {
  const who = coderId || ME;
  return data.codings.filter((c) => c.docId === docId && c.coderId === who);
}

function countCode(codeId, docId, coderId) {
  const ids = subtreeIds(codeId);
  const who = coderId || ME;
  return data.codings.filter((c) => c.coderId === who && ids.has(c.codeId) && (!docId || c.docId === docId)).length;
}

function memoFor(targetType, targetId) {
  return data.memos.find((m) => m.targetType === targetType && m.targetId === targetId) || null;
}

function setMemo(targetType, targetId, text) {
  let memo = memoFor(targetType, targetId);
  if (!memo) {
    memo = { id: uid(), targetType, targetId, author: '我', text: '', ts: '刚刚' };
    data.memos.push(memo);
  }
  memo.text = text;
  persist();
}

function nextColor() {
  const tops = data.codes.filter((c) => !c.parent);
  return tops.length % 4;
}

function newCode(name, parentId) {
  const code = {
    id: 'c_' + uid(),
    parent: parentId || null,
    color: parentId ? colorIndex(parentId) : nextColor(),
    name: name || '未命名码',
    definition: '',
    inclusion: '',
    exclusion: '',
  };
  data.codes.push(code);
  return code;
}

function codeName(codeId) {
  const c = getCode(codeId);
  return c ? c.name : '未知码';
}

function chipHTML(codeId, extra) {
  return '<span class="chip c' + colorIndex(codeId) + '"><span class="dot"></span>' + escapeHtml(codeName(codeId)) + (extra || '') + '</span>';
}

function docTitle(docId) {
  const d = getDoc(docId);
  return d ? d.id + ' · ' + d.title : docId;
}

function canonical(codings) {
  return codings
    .map((c) => c.codeId + ':' + c.start + ':' + c.end)
    .sort()
    .join('|');
}

function sentenceConflict(docId, sentenceId) {
  const mine = codingsFor(docId, sentenceId, ME);
  const other = codingsFor(docId, sentenceId, P2);
  return { mine, other, conflict: canonical(mine) !== canonical(other) };
}

function resolutionKey(docId, sentenceId) {
  return docId + ':' + sentenceId;
}

function showToast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}

function render() {
  app.innerHTML = headerHTML() + (ui.helpOpen ? helpbarHTML() : '') + workspaceHTML();
  if (ui.mode === 'reading' && ui.selection) positionPopover();
  if (ui.play) startTicker();
}

function headerHTML() {
  const tabs = [
    ['reading', '阅读编码'],
    ['codebook', '码本'],
    ['analysis', '分析'],
    ['compare', '对比'],
  ];
  return '<header class="top">' +
    '<div class="brand"><span class="brand-dot"></span><div><div class="brand-title">访谈工作台 · 编码原型</div><div class="brand-sub">' + escapeHtml(data.project) + ' · 固定示例数据</div></div></div>' +
    '<nav class="tabs">' + tabs.map(([id, label]) => '<button class="tab ' + (ui.mode === id ? 'active' : '') + '" data-action="mode" data-mode="' + id + '">' + label + '</button>').join('') + '</nav>' +
    '<div class="top-actions"><span class="tag">示例数据</span>' +
    '<button class="btn" data-action="export">导出 JSON</button>' +
    '<button class="btn" data-action="reset">重置示例</button>' +
    '<button class="btn" data-action="help">' + (ui.helpOpen ? '收起说明' : '说明') + '</button></div>' +
    '</header>';
}

function helpbarHTML() {
  return '<div class="helpbar">' +
    '<span>① 选中文字 → 贴码</span>' +
    '<span>② 点页边彩条 → 播放片段</span>' +
    '<span>③ 点句子 → 看片段与 memo</span>' +
    '<span>④ 码本 / 分析 / 对比是独立工作模式</span>' +
    '<button class="close" data-action="help">×</button>' +
    '</div>';
}

function workspaceHTML() {
  if (ui.mode === 'codebook') return codebookHTML();
  if (ui.mode === 'analysis') return analysisHTML();
  if (ui.mode === 'compare') return compareHTML();
  return readingHTML();
}

function docsPanelHTML() {
  const docs = data.docs.map((d) => {
    const count = docCodings(d.id, ME).length;
    return '<button class="doc ' + (ui.activeDocId === d.id ? 'active' : '') + '" data-action="select-doc" data-doc-id="' + d.id + '">' +
      '<span class="doc-id">' + d.id + '</span>' +
      '<span class="doc-name">' + escapeHtml(d.title) + '</span>' +
      '<span class="doc-meta">' + (count ? count + ' 条' : '未编码') + '</span>' +
      '</button>';
  }).join('');
  const topCodes = data.codes
    .filter((c) => !c.parent)
    .map((c) => ({ c, n: countCode(c.id) }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 6)
    .map(({ c, n }) => '<button class="chip c' + colorIndex(c.id) + '" data-action="open-code" data-code-id="' + c.id + '"><span class="dot"></span>' + escapeHtml(c.name) + '<span class="pop-count">' + n + '</span></button>')
    .join('');
  return '<aside class="panel left">' +
    '<div class="panel-title">文档 <span class="count">' + data.docs.length + '</span></div>' +
    docs +
    '<div class="section-title">最近使用码</div>' +
    '<div class="chips">' + topCodes + '</div>' +
    '<div class="section-title">提示</div>' +
    '<div class="insp-empty">选中一句话里的任意片段，就可以给它贴多个码。页边彩条代表这一句上的编码。</div>' +
    '</aside>';
}

function readingHTML() {
  const d = getDoc(ui.activeDocId);
  if (!d) return '<div class="workspace reading"></div>';
  return '<div class="workspace reading">' +
    docsPanelHTML() +
    '<section class="panel reader">' +
    playerHTML(d) +
    '<div class="transcript">' + d.sentences.map((s) => sentenceHTML(d, s)).join('') + '</div>' +
    popoverHTML() +
    '</section>' +
    inspectorHTML() +
    '</div>';
}

function playerHTML(d) {
  const total = d.sentences.length ? d.sentences[d.sentences.length - 1].end : 0;
  const current = ui.play && ui.play.docId === d.id ? ui.play.current : 0;
  const pct = total ? Math.min(100, (current / total) * 100) : 0;
  return '<div class="player">' +
    '<button class="play-main" data-action="toggle-play">' + (ui.play && ui.play.docId === d.id ? '■' : '▶') + '</button>' +
    '<span class="play-time" id="playTime">' + fmt(current) + ' / ' + fmt(total) + '</span>' +
    '<span class="progress"><i id="playFill" style="width:' + pct + '%"></i></span>' +
    '<span class="pill brand">模拟播放</span>' +
    '<span class="pill">1.0x</span>' +
    '</div>';
}

function sentenceHTML(d, s) {
  const codings = codingsFor(d.id, s.id, ME);
  const activeCoding = codings.find((c) => c.id === ui.activeCodingId);
  const memo = memoFor('sentence', s.id);
  const active = ui.activeSentenceId === s.id;
  const playing = ui.play && ui.play.sentenceId === s.id;
  const lane = codings.map((c) => '<button class="bar c' + colorIndex(c.codeId) + ' ' + (ui.activeCodingId === c.id ? 'active' : '') + '" data-action="select-coding" data-coding-id="' + c.id + '" title="' + escapeHtml(codeName(c.codeId)) + '">' + '</button>').join('');
  return '<div class="sentence ' + (active ? 'active' : '') + ' ' + (playing ? 'playing' : '') + '" data-action="select-sentence" data-sentence-id="' + s.id + '" data-doc-id="' + d.id + '">' +
    '<button class="mini-play" data-action="play-sentence" data-sentence-id="' + s.id + '">▶</button>' +
    '<span class="time">' + fmt(s.start) + '</span>' +
    '<div class="sbody">' +
    '<div class="smeta"><span class="spk">' + escapeHtml(s.speaker) + '</span>' + (memo ? '<span class="memo-mark">memo</span>' : '') + '</div>' +
    '<div class="stext" data-sentence-text data-sentence-id="' + s.id + '">' + renderSentenceText(s, codings, activeCoding) + '</div>' +
    '</div>' +
    '<div class="lane">' + lane + '</div>' +
    '</div>';
}

function renderSentenceText(sentence, codings, activeCoding) {
  const text = sentence.text;
  const points = new Set([0, text.length]);
  codings.forEach((c) => {
    points.add(Math.max(0, Math.min(text.length, c.start)));
    points.add(Math.max(0, Math.min(text.length, c.end)));
  });
  const sorted = Array.from(points).sort((a, b) => a - b);
  let html = '';
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b <= a) continue;
    const segment = text.slice(a, b);
    const covering = codings.filter((c) => c.start <= a && c.end >= b);
    const active = activeCoding && covering.some((c) => c.id === activeCoding.id);
    let cls = '';
    if (covering.length) cls += ' coded u' + colorIndex(covering[0].codeId);
    if (active) cls += ' active';
    html += '<span class="seg' + cls + '">' + escapeHtml(segment) + '</span>';
  }
  return html;
}

function popoverHTML() {
  if (!ui.selection) return '';
  const sel = ui.selection;
  const s = getSentence(sel.docId, sel.sentenceId);
  if (!s) return '';
  const quote = s.text.slice(sel.start, sel.end);
  const rows = data.codes.map((c) => {
    const checked = data.codings.some((x) => x.docId === sel.docId && x.sentenceId === sel.sentenceId && x.start === sel.start && x.end === sel.end && x.codeId === c.id && x.coderId === ME);
    return '<div class="pop-row" data-action="toggle-code" data-code-id="' + c.id + '">' +
      '<span class="pop-box ' + (checked ? 'checked' : '') + '">' + (checked ? '✓' : '') + '</span>' +
      '<span class="dot c' + colorIndex(c.id) + '"></span>' +
      '<span class="pop-name">' + escapeHtml(c.name) + '</span>' +
      '<span class="pop-count">' + countCode(c.id) + '</span>' +
      '</div>';
  }).join('');
  return '<div class="popover" id="popover">' +
    '<div class="pop-head"><span class="pop-title">给选中片段贴码</span><button class="pop-close" data-action="close-popover">×</button></div>' +
    '<div class="pop-quote">“' + escapeHtml(quote) + '”</div>' +
    '<input class="pop-search" id="popSearch" placeholder="搜索编码…" data-code-search>' +
    '<div class="pop-list" id="popList">' + rows + '</div>' +
    '<div class="pop-new"><input id="newCodeInput" placeholder="用选中文字新建码，回车确认" data-new-code></div>' +
    '<div class="pop-foot"><span>可多选，点击完成</span><button class="btn primary" data-action="close-popover">完成</button></div>' +
    '</div>';
}

function inspectorHTML() {
  const d = getDoc(ui.activeDocId);
  const coding = ui.activeCodingId ? getCoding(ui.activeCodingId) : null;
  if (coding) {
    const s = getSentence(coding.docId, coding.sentenceId);
    const c = getCode(coding.codeId);
    const memo = memoFor('sentence', s.id);
    const quote = s.text.slice(coding.start, coding.end);
    return '<aside class="panel inspector">' +
      '<div class="panel-title">选中编码 <span class="count">' + escapeHtml(codeName(coding.codeId)) + '</span></div>' +
      '<div class="quote-box">“' + escapeHtml(quote) + '”<span class="quote-meta">' + fmt(s.start) + '–' + fmt(s.end) + ' · ' + coding.docId + ' · ' + (coding.coderId === ME ? '我' : 'P02') + '</span></div>' +
      '<div class="label">码</div><div class="chips">' + chipHTML(coding.codeId) + '</div>' +
      '<div class="label">定义</div><div class="insp-empty">' + escapeHtml(c ? c.definition || '（未填写）' : '') + '</div>' +
      '<div class="label">Memo</div><textarea class="memo-input" data-memo-target="sentence" data-target-id="' + s.id + '" placeholder="记录你的分析…">' + escapeHtml(memo ? memo.text : '') + '</textarea>' +
      '<div class="insp-actions"><button class="btn" data-action="play-coding" data-coding-id="' + coding.id + '">▶ 播放片段</button><button class="btn danger" data-action="remove-coding" data-coding-id="' + coding.id + '">删除这条编码</button></div>' +
      '<div class="status">编码与 memo 自动保存在本浏览器</div>' +
      '</aside>';
  }
  const s = ui.activeSentenceId ? getSentence(ui.activeDocId, ui.activeSentenceId) : null;
  if (s) {
    const codings = codingsFor(ui.activeDocId, s.id, ME);
    const memo = memoFor('sentence', s.id);
    return '<aside class="panel inspector">' +
      '<div class="panel-title">选中片段 <span class="count">' + s.id + '</span></div>' +
      '<div class="quote-box">' + escapeHtml(s.text) + '<span class="quote-meta">' + fmt(s.start) + '–' + fmt(s.end) + ' · ' + escapeHtml(s.speaker) + '</span></div>' +
      '<div class="label">已挂编码（' + codings.length + '）</div>' +
      '<div class="chips">' + (codings.length ? codings.map((c) => '<span class="chip c' + colorIndex(c.codeId) + '"><span class="dot"></span>' + escapeHtml(codeName(c.codeId)) + '<button data-action="remove-coding" data-coding-id="' + c.id + '">×</button></span>').join('') : '<span class="insp-empty">还没有编码。选中文字后贴码。</span>') + '</div>' +
      '<div class="label">Memo</div><textarea class="memo-input" data-memo-target="sentence" data-target-id="' + s.id + '" placeholder="记录你的分析…">' + escapeHtml(memo ? memo.text : '') + '</textarea>' +
      '<div class="insp-actions"><button class="btn" data-action="play-sentence" data-sentence-id="' + s.id + '">▶ 播放这一句</button></div>' +
      '<div class="status">编码与 memo 自动保存在本浏览器</div>' +
      '</aside>';
  }
  if (!d) return '<aside class="panel inspector"></aside>';
  const count = docCodings(d.id, ME).length;
  return '<aside class="panel inspector">' +
    '<div class="panel-title">文档概览 <span class="count">' + d.id + '</span></div>' +
    '<div class="quote-box">' + escapeHtml(d.title) + '<span class="quote-meta">' + d.sentences.length + ' 句 · ' + count + ' 条编码</span></div>' +
    '<div class="section-title">怎么开始</div>' +
    '<div class="insp-empty">① 在正文里拖选一段文字；<br>② 在弹出的码选择器里勾选码；<br>③ 页边会出现彩条，点击彩条可回放这一段（模拟）。</div>' +
    '<div class="section-title">提示</div>' +
    '<div class="insp-empty">一句话可以挂多个码，码可以重叠。码本、分析、对比在左上角切换。</div>' +
    '</aside>';
}

function codeTreeHTML() {
  const rows = [];
  function walk(parentId, depth) {
    data.codes.filter((c) => c.parent === parentId).forEach((c) => {
      rows.push('<div class="tree-row ' + (ui.activeCodeId === c.id ? 'active' : '') + '" data-action="select-code" data-code-id="' + c.id + '" style="padding-left:' + (6 + depth * 16) + 'px">' +
        '<span class="dot c' + colorIndex(c.id) + '"></span>' +
        '<span class="tree-name">' + escapeHtml(c.name) + '</span>' +
        '<span class="tree-count">' + countCode(c.id) + '</span>' +
        '</div>');
      walk(c.id, depth + 1);
    });
  }
  walk(null, 0);
  return rows.join('');
}

function codebookHTML() {
  return '<div class="workspace codebook">' +
    '<aside class="panel left">' +
    '<div class="panel-title">码本 <span class="count">' + data.codes.length + '</span></div>' +
    codeTreeHTML() +
    '<div class="new-code"><input id="newTopCode" placeholder="新建顶层码…"><button class="btn primary" data-action="add-top-code">添加</button></div>' +
    '<div class="section-title">说明</div>' +
    '<div class="insp-empty">码树支持父子层级；点码查看定义、示例与合并。所有改动即时生效。</div>' +
    '</aside>' +
    '<section class="panel">' + codeDetailHTML() + '</section>' +
    '</div>';
}

function codeDetailHTML() {
  const c = getCode(ui.activeCodeId) || data.codes[0];
  if (!c) return '<div class="empty">还没有码。</div>';
  const parent = c.parent ? getCode(c.parent) : null;
  const count = countCode(c.id);
  const examples = data.codings
    .filter((x) => subtreeIds(c.id).has(x.codeId) && x.coderId === ME)
    .slice(0, 8)
    .map((x) => {
      const s = getSentence(x.docId, x.sentenceId);
      const quote = s.text.slice(x.start, x.end);
      return '<button class="example" data-action="jump-coding" data-coding-id="' + x.id + '">“' + escapeHtml(quote) + '”<span class="ex-meta">' + x.docId + ' · ' + fmt(s.start) + '</span></button>';
    }).join('');
  const memo = memoFor('code', c.id);
  const mergeOptions = data.codes
    .filter((x) => !subtreeIds(c.id).has(x.id))
    .map((x) => '<option value="' + x.id + '">' + escapeHtml(x.name) + '</option>')
    .join('');
  return '<div class="detail-title"><span class="dot c' + colorIndex(c.id) + '"></span><h2>' + escapeHtml(c.name) + '</h2><span class="badge">' + count + ' 条编码</span></div>' +
    '<div class="field"><label>名称</label><input data-code-field="name" data-code-id="' + c.id + '" value="' + escapeHtml(c.name) + '"></div>' +
    '<div class="field"><label>定义</label><textarea data-code-field="definition" data-code-id="' + c.id + '">' + escapeHtml(c.definition) + '</textarea></div>' +
    '<div class="field"><label>纳入标准</label><textarea data-code-field="inclusion" data-code-id="' + c.id + '">' + escapeHtml(c.inclusion) + '</textarea></div>' +
    '<div class="field"><label>排除标准</label><textarea data-code-field="exclusion" data-code-id="' + c.id + '">' + escapeHtml(c.exclusion) + '</textarea></div>' +
    '<div class="field"><label>层级</label><div class="insp-empty">' + (parent ? '父码：' + escapeHtml(parent.name) + ' · ' + escapeHtml(parent.id) : '顶层码') + '</div></div>' +
    '<div class="field"><label>码 memo</label><textarea class="memo-input" data-code-memo="' + c.id + '" placeholder="这个码的使用边界、疑问…">' + escapeHtml(memo ? memo.text : '') + '</textarea></div>' +
    '<div class="field"><label>合并到</label>' +
    '<div class="merge-row"><select id="mergeTarget">' + mergeOptions + '</select><button class="btn" data-action="merge-code" data-code-id="' + c.id + '">合并</button></div>' +
    (ui.mergeConfirm ? '<div class="merge-confirm">合并会把这个码（含子码）的所有编码转移到目标码。 <button class="btn danger" data-action="confirm-merge" data-code-id="' + c.id + '">确认合并</button><button class="btn" data-action="cancel-merge">取消</button></div>' : '') +
    '</div>' +
    '<div class="field"><label>新增子码</label><div class="new-code"><input id="newChildCode" placeholder="子码名称…"><button class="btn primary" data-action="add-child-code" data-parent-id="' + c.id + '">添加</button></div></div>' +
    '<div class="section-title">示例片段</div>' +
    '<div class="example-list">' + (examples || '<div class="empty">这个码还没有编码片段。</div>') + '</div>';
}

function analysisHTML() {
  return '<div class="workspace analysis">' +
    '<section class="panel">' +
    '<div class="panel-title">码 × 案例矩阵 <span class="count">' + data.codings.length + ' 条编码</span></div>' +
    matrixHTML() +
    '<div class="section-title">说明</div>' +
    '<div class="insp-empty">单元格里的数字是该码（含子码）在该案例中的编码条数。点单元格看证据。</div>' +
    '</section>' +
    '<section class="panel right">' +
    '<div class="panel-title">主题与证据</div>' +
    themesHTML() +
    '<div class="section-title">证据</div>' +
    evidenceHTML() +
    '</section>' +
    '</div>';
}

function matrixHTML() {
  const docs = data.docs;
  const rows = [];
  function walk(parentId, depth) {
    data.codes.filter((c) => c.parent === parentId).forEach((c) => {
      rows.push('<tr><td class="name" style="padding-left:' + (6 + depth * 14) + 'px"><span class="dot c' + colorIndex(c.id) + '"></span>' + escapeHtml(c.name) + '</td>' +
        docs.map((d) => {
          const n = countCode(c.id, d.id);
          const active = ui.analysisSelection && ui.analysisSelection.type === 'cell' && ui.analysisSelection.codeId === c.id && ui.analysisSelection.docId === d.id;
          return '<td><button class="cell ' + (n ? '' : 'zero ') + (active ? 'active' : '') + '" data-action="matrix-cell" data-code-id="' + c.id + '" data-doc-id="' + d.id + '">' + n + '</button></td>';
        }).join('') + '</tr>');
      walk(c.id, depth + 1);
    });
  }
  walk(null, 0);
  return '<table class="matrix"><thead><tr><th>码</th>' + docs.map((d) => '<th>' + d.id + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
}

function themesHTML() {
  return data.themes.map((t) => {
    const ids = new Set();
    t.codeIds.forEach((id) => subtreeIds(id).forEach((x) => ids.add(x)));
    const n = data.codings.filter((c) => c.coderId === ME && ids.has(c.codeId)).length;
    const active = ui.analysisSelection && ui.analysisSelection.type === 'theme' && ui.analysisSelection.themeId === t.id;
    return '<div class="theme-card ' + (active ? 'active' : '') + '" data-action="select-theme" data-theme-id="' + t.id + '">' +
      '<div class="theme-name">' + escapeHtml(t.name) + '</div>' +
      '<div class="theme-def">' + escapeHtml(t.definition) + '</div>' +
      '<div class="theme-meta">证据 ' + n + ' 条</div>' +
      '</div>';
  }).join('');
}

function evidenceHTML() {
  const sel = ui.analysisSelection;
  if (!sel) return '<div class="empty">点矩阵单元格或主题卡片，这里会列出对应片段。</div>';
  let codings = [];
  if (sel.type === 'cell') {
    const ids = subtreeIds(sel.codeId);
    codings = data.codings.filter((c) => c.coderId === ME && c.docId === sel.docId && ids.has(c.codeId));
  } else if (sel.type === 'theme') {
    const theme = data.themes.find((t) => t.id === sel.themeId);
    if (theme) {
      const ids = new Set();
      theme.codeIds.forEach((id) => subtreeIds(id).forEach((x) => ids.add(x)));
      codings = data.codings.filter((c) => c.coderId === ME && ids.has(c.codeId));
    }
  }
  if (!codings.length) return '<div class="empty">没有匹配的片段。</div>';
  return '<div class="evidence-list">' + codings.slice(0, 12).map((x) => {
    const s = getSentence(x.docId, x.sentenceId);
    const quote = s.text.slice(x.start, x.end);
    return '<button class="evidence" data-action="jump-coding" data-coding-id="' + x.id + '">“' + escapeHtml(quote) + '”<div class="ev-meta">' + x.docId + ' · ' + fmt(s.start) + ' · ' + escapeHtml(codeName(x.codeId)) + '</div></button>';
  }).join('') + '</div>';
}

function compareHTML() {
  const d = getDoc(ui.activeDocId);
  if (!d) return '<div class="workspace compare"></div>';
  const cards = d.sentences.map((s) => compareSentenceHTML(d, s)).filter((x) => !ui.onlyConflicts || x.onlyConflicts);
  return '<div class="workspace compare">' +
    docsPanelHTML() +
    '<section class="panel">' +
    '<div class="panel-title">我 vs P02 <span class="count">' + d.id + '</span></div>' +
    '<div class="chips"><button class="chip ' + (ui.onlyConflicts ? 'c0' : '') + '" data-action="toggle-conflicts">' + (ui.onlyConflicts ? '只看分歧' : '显示全部') + '</button></div>' +
    '<div class="section-title"></div>' +
    (cards.length ? cards.map((x) => x.html).join('') : '<div class="empty">没有未解决的分歧。</div>') +
    '</section>' +
    compareSummaryHTML(d) +
    '</div>';
}

function compareSentenceHTML(d, s) {
  const { mine, other, conflict } = sentenceConflict(d.id, s.id);
  const resolved = data.resolutions[resolutionKey(d.id, s.id)];
  const chips = (list) => list.length ? list.map((c) => '<span class="chip c' + colorIndex(c.codeId) + '" title="' + escapeHtml(s.text.slice(c.start, c.end)) + '"><span class="dot"></span>' + escapeHtml(codeName(c.codeId)) + '</span>').join('') : '<span class="insp-empty">—</span>';
  const onlyConflicts = conflict && !resolved;
  const html = '<div class="compare-card ' + (conflict ? 'conflict' : '') + '">' +
    '<div class="compare-quote">' + escapeHtml(s.text) + '<span class="quote-meta">' + s.id + ' · ' + fmt(s.start) + '</span></div>' +
    '<div class="compare-grid"><div class="compare-col"><div class="compare-col-title">我</div><div class="chips">' + chips(mine) + '</div></div>' +
    '<div class="compare-col"><div class="compare-col-title">P02</div><div class="chips">' + chips(other) + '</div></div></div>' +
    '<div class="compare-actions">' + (conflict ? (resolved ? '<span class="badge resolved">已裁决：' + (resolved === 'mine' ? '以我为准' : '以 P02 为准') + '</span>' : '<span class="badge conflict">分歧</span><button class="btn" data-action="adopt" data-side="mine" data-doc-id="' + d.id + '" data-sentence-id="' + s.id + '">以我为准</button><button class="btn" data-action="adopt" data-side="p02" data-doc-id="' + d.id + '" data-sentence-id="' + s.id + '">以 P02 为准</button>') : '<span class="badge">一致</span>') + '</div>' +
    '</div>';
  return { html, onlyConflicts };
}

function compareSummaryHTML(d) {
  let total = 0;
  let conflicts = 0;
  let unresolved = 0;
  let resolved = 0;
  d.sentences.forEach((s) => {
    total += 1;
    const { conflict } = sentenceConflict(d.id, s.id);
    if (conflict) {
      conflicts += 1;
      const r = data.resolutions[resolutionKey(d.id, s.id)];
      if (r) resolved += 1;
      else unresolved += 1;
    }
  });
  return '<aside class="panel inspector">' +
    '<div class="panel-title">对比概览 <span class="count">' + d.id + '</span></div>' +
    '<div class="summary-row">句子 <span>' + total + '</span></div>' +
    '<div class="summary-row">分歧 <span>' + conflicts + '</span></div>' +
    '<div class="summary-row">待裁决 <span>' + unresolved + '</span></div>' +
    '<div class="summary-row">已裁决 <span>' + resolved + '</span></div>' +
    '<div class="section-title">怎么用</div>' +
    '<div class="insp-empty">两个人独立编码后，来这里逐句比较。边界不同也算分歧；裁决会写回“我”的编码。</div>' +
    '<div class="status">示例里预置了 P02 的另一套编码，方便你试。</div>' +
    '</aside>';
}

function positionPopover() {
  const el = document.getElementById('popover');
  if (!el || !ui.selection) return;
  const reader = document.querySelector('.reader');
  const stext = document.querySelector('[data-sentence-text][data-sentence-id="' + ui.selection.sentenceId + '"]');
  if (!reader || !stext) return;
  const range = rangeFromOffsets(stext, ui.selection.start, ui.selection.end);
  if (!range) return;
  const rect = range.getBoundingClientRect();
  const rrect = reader.getBoundingClientRect();
  let left = rect.left - rrect.left;
  let top = rect.bottom - rrect.top + 8;
  const pw = el.offsetWidth || 264;
  left = Math.max(8, Math.min(left, reader.clientWidth - pw - 8));
  top = Math.max(8, Math.min(top, reader.clientHeight - el.offsetHeight - 8));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

function textNodes(root) {
  const nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }
  return nodes;
}

function locateOffset(root, offset) {
  const nodes = textNodes(root);
  let acc = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    const len = nodes[i].textContent.length;
    if (offset <= acc + len) return [nodes[i], offset - acc];
    acc += len;
  }
  return nodes.length ? [nodes[nodes.length - 1], nodes[nodes.length - 1].textContent.length] : [root, 0];
}

function rangeFromOffsets(root, start, end) {
  try {
    const a = locateOffset(root, start);
    const b = locateOffset(root, end);
    const range = document.createRange();
    range.setStart(a[0], a[1]);
    range.setEnd(b[0], b[1]);
    return range;
  } catch (e) {
    return null;
  }
}

function toggleCoding(codeId) {
  const sel = ui.selection;
  if (!sel) return;
  const index = data.codings.findIndex((c) => c.docId === sel.docId && c.sentenceId === sel.sentenceId && c.start === sel.start && c.end === sel.end && c.codeId === codeId && c.coderId === ME);
  if (index >= 0) {
    data.codings.splice(index, 1);
    showToast('已移除编码');
  } else {
    data.codings.push({ id: uid(), docId: sel.docId, sentenceId: sel.sentenceId, start: sel.start, end: sel.end, codeId, coderId: ME });
    showToast('已贴码：' + codeName(codeId));
  }
  ui.activeCodingId = null;
  persist();
  render();
}

function removeCoding(codingId) {
  const index = data.codings.findIndex((c) => c.id === codingId);
  if (index >= 0) {
    data.codings.splice(index, 1);
    if (ui.activeCodingId === codingId) ui.activeCodingId = null;
    persist();
    render();
    showToast('已删除这条编码');
  }
}

function playRange(docId, start, end, sentenceId, codingId) {
  stopTicker();
  const d = getDoc(docId);
  if (!d) return;
  ui.play = { docId, start, end, sentenceId: sentenceId || null, codingId: codingId || null, startedAt: performance.now(), base: start, current: start };
  if (sentenceId) ui.activeSentenceId = sentenceId;
  if (codingId) ui.activeCodingId = codingId;
  render();
}

function stopPlay() {
  stopTicker();
  ui.play = null;
  render();
}

function stopTicker() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function startTicker() {
  stopTicker();
  if (!ui.play) return;
  const tick = () => {
    if (!ui.play) return;
    const elapsed = performance.now() - ui.play.startedAt;
    const current = Math.min(ui.play.end, ui.play.base + elapsed);
    ui.play.current = current;
    const d = getDoc(ui.play.docId);
    const total = d && d.sentences.length ? d.sentences[d.sentences.length - 1].end : 0;
    const timeEl = document.getElementById('playTime');
    const fillEl = document.getElementById('playFill');
    if (timeEl) timeEl.textContent = fmt(current) + ' / ' + fmt(total);
    if (fillEl) fillEl.style.width = (total ? Math.min(100, (current / total) * 100) : 0) + '%';
    if (current >= ui.play.end) {
      ui.play = null;
      stopTicker();
      render();
      return;
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function codingTimes(coding) {
  const s = getSentence(coding.docId, coding.sentenceId);
  if (!s) return [0, 0];
  const length = Math.max(1, s.text.length);
  const start = s.start + (coding.start / length) * (s.end - s.start);
  const end = s.start + (coding.end / length) * (s.end - s.start);
  return [start, end];
}

function playCoding(codingId) {
  const c = getCoding(codingId);
  if (!c) return;
  const [start, end] = codingTimes(c);
  playRange(c.docId, start, end, c.sentenceId, c.id);
}

function jumpToCoding(codingId) {
  const c = getCoding(codingId);
  if (!c) return;
  stopPlaybackIfAny();
  ui.mode = 'reading';
  ui.activeDocId = c.docId;
  ui.activeSentenceId = c.sentenceId;
  ui.activeCodingId = c.id;
  ui.selection = null;
  ui.analysisSelection = null;
  render();
}

function adopt(docId, sentenceId, side) {
  const mine = codingsFor(docId, sentenceId, ME);
  const other = codingsFor(docId, sentenceId, P2);
  if (side === 'p02') {
    data.codings = data.codings.filter((c) => !(c.docId === docId && c.sentenceId === sentenceId && c.coderId === ME));
    other.forEach((c) => {
      data.codings.push({ id: uid(), docId: c.docId, sentenceId: c.sentenceId, start: c.start, end: c.end, codeId: c.codeId, coderId: ME });
    });
  } else {
    data.codings = data.codings.filter((c) => !(c.docId === docId && c.sentenceId === sentenceId && c.coderId === P2));
  }
  data.resolutions[resolutionKey(docId, sentenceId)] = side;
  persist();
  render();
  showToast(side === 'mine' ? '已采用我的编码' : '已采用 P02 的编码');
}

function exportJSON() {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'coding-prototype-export.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('已导出 JSON');
}

function resetSample() {
  if (!confirm('重置为固定示例数据？你在原型里的编码、memo 会丢失。')) return;
  stopPlaybackIfAny();
  data = buildSample();
  ui.selection = null;
  ui.activeCodingId = null;
  ui.activeSentenceId = null;
  ui.analysisSelection = null;
  persist();
  render();
  showToast('已重置示例数据');
}

function stopPlaybackIfAny() {
  if (ui.play) {
    stopTicker();
    ui.play = null;
  }
}

function handleAction(action, el) {
  if (action === 'mode') {
    stopPlaybackIfAny();
    ui.mode = el.dataset.mode;
    ui.selection = null;
  } else if (action === 'help') {
    ui.helpOpen = !ui.helpOpen;
  } else if (action === 'export') {
    exportJSON();
    return;
  } else if (action === 'reset') {
    resetSample();
    return;
  } else if (action === 'select-doc') {
    if (ui.activeDocId !== el.dataset.docId) stopPlaybackIfAny();
    ui.activeDocId = el.dataset.docId;
    ui.activeSentenceId = null;
    ui.activeCodingId = null;
    ui.selection = null;
  } else if (action === 'select-sentence') {
    ui.activeSentenceId = el.dataset.sentenceId;
    ui.activeCodingId = null;
    if (!ui.selection || ui.selection.sentenceId !== el.dataset.sentenceId) ui.selection = null;
  } else if (action === 'select-coding') {
    const c = getCoding(el.dataset.codingId);
    if (c) {
      ui.activeCodingId = c.id;
      ui.activeSentenceId = c.sentenceId;
      ui.activeDocId = c.docId;
      ui.selection = null;
    }
  } else if (action === 'play-sentence') {
    const s = getSentence(ui.activeDocId, el.dataset.sentenceId);
    if (s) playRange(ui.activeDocId, s.start, s.end, s.id, null);
    return;
  } else if (action === 'toggle-play') {
    if (ui.play) {
      stopPlay();
      return;
    }
    const d = getDoc(ui.activeDocId);
    if (!d) return;
    const s = ui.activeSentenceId ? getSentence(ui.activeDocId, ui.activeSentenceId) : null;
    if (s) playRange(ui.activeDocId, s.start, s.end, s.id, null);
    else playRange(ui.activeDocId, 0, d.sentences.length ? d.sentences[d.sentences.length - 1].end : 0, null, null);
    return;
  } else if (action === 'play-coding') {
    playCoding(el.dataset.codingId);
    return;
  } else if (action === 'remove-coding') {
    removeCoding(el.dataset.codingId);
    return;
  } else if (action === 'toggle-code') {
    toggleCoding(el.dataset.codeId);
    return;
  } else if (action === 'close-popover') {
    ui.selection = null;
  } else if (action === 'open-code') {
    stopPlaybackIfAny();
    ui.mode = 'codebook';
    ui.activeCodeId = el.dataset.codeId;
    ui.selection = null;
  } else if (action === 'select-code') {
    ui.activeCodeId = el.dataset.codeId;
    ui.mergeConfirm = false;
  } else if (action === 'add-top-code') {
    const input = document.getElementById('newTopCode');
    const name = input && input.value.trim();
    if (!name) {
      showToast('先输入码名');
      return;
    }
    const c = newCode(name, null);
    ui.activeCodeId = c.id;
    persist();
    render();
    showToast('已新建码：' + name);
    return;
  } else if (action === 'add-child-code') {
    const input = document.getElementById('newChildCode');
    const name = input && input.value.trim();
    if (!name) {
      showToast('先输入子码名');
      return;
    }
    const c = newCode(name, el.dataset.parentId);
    ui.activeCodeId = c.id;
    persist();
    render();
    showToast('已新建子码：' + name);
    return;
  } else if (action === 'merge-code') {
    ui.mergeConfirm = true;
  } else if (action === 'cancel-merge') {
    ui.mergeConfirm = false;
  } else if (action === 'confirm-merge') {
    const select = document.getElementById('mergeTarget');
    const targetId = select && select.value;
    const sourceId = el.dataset.codeId;
    if (!targetId || targetId === sourceId) {
      ui.mergeConfirm = false;
      render();
      return;
    }
    const sourceIds = subtreeIds(sourceId);
    data.codings.forEach((c) => {
      if (sourceIds.has(c.codeId)) c.codeId = targetId;
    });
    data.codes = data.codes.filter((c) => !sourceIds.has(c.id));
    ui.activeCodeId = targetId;
    ui.mergeConfirm = false;
    persist();
    render();
    showToast('已合并到：' + codeName(targetId));
    return;
  } else if (action === 'matrix-cell') {
    ui.analysisSelection = { type: 'cell', codeId: el.dataset.codeId, docId: el.dataset.docId };
  } else if (action === 'select-theme') {
    ui.analysisSelection = { type: 'theme', themeId: el.dataset.themeId };
  } else if (action === 'jump-coding') {
    jumpToCoding(el.dataset.codingId);
    return;
  } else if (action === 'toggle-conflicts') {
    ui.onlyConflicts = !ui.onlyConflicts;
  } else if (action === 'adopt') {
    adopt(el.dataset.docId, el.dataset.sentenceId, el.dataset.side);
    return;
  }
  render();
}

app.addEventListener('click', (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (actionEl) {
    e.preventDefault();
    e.stopPropagation();
    handleAction(actionEl.dataset.action, actionEl);
    return;
  }
  const sentenceEl = e.target.closest('.sentence');
  if (sentenceEl && !e.target.closest('.mini-play') && !e.target.closest('.bar')) {
    ui.activeSentenceId = sentenceEl.dataset.sentenceId;
    ui.activeCodingId = null;
    if (!ui.selection || ui.selection.sentenceId !== sentenceEl.dataset.sentenceId) ui.selection = null;
    render();
  }
});

app.addEventListener('mouseup', (e) => {
  if (ui.mode !== 'reading') return;
  if (e.target.closest('.popover')) return;
  const stext = e.target.closest('[data-sentence-text]');
  if (!stext) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (!stext.contains(range.startContainer) || !stext.contains(range.endContainer)) return;
  const pre = document.createRange();
  pre.selectNodeContents(stext);
  pre.setEnd(range.startContainer, range.startOffset);
  let start = pre.toString().length;
  let end = start + range.toString().length;
  const full = stext.textContent || '';
  while (start < end && /\s/.test(full[start])) start += 1;
  while (end > start && /\s/.test(full[end - 1])) end -= 1;
  if (end <= start) return;
  ui.selection = { docId: ui.activeDocId, sentenceId: stext.dataset.sentenceId, start, end };
  ui.activeSentenceId = stext.dataset.sentenceId;
  ui.activeCodingId = null;
  sel.removeAllRanges();
  render();
});

app.addEventListener('input', (e) => {
  const target = e.target;
  if (target.matches('[data-memo-target]')) {
    setMemo(target.dataset.memoTarget, target.dataset.targetId, target.value);
    return;
  }
  if (target.matches('[data-code-memo]')) {
    setMemo('code', target.dataset.codeMemo, target.value);
    return;
  }
  if (target.matches('[data-code-field]')) {
    const c = getCode(target.dataset.codeId);
    if (c) {
      c[target.dataset.codeField] = target.value;
      persist();
    }
    return;
  }
  if (target.matches('[data-code-search]')) {
    const q = target.value.trim().toLowerCase();
    document.querySelectorAll('#popList .pop-row').forEach((row) => {
      const name = row.querySelector('.pop-name').textContent.toLowerCase();
      row.style.display = !q || name.indexOf(q) >= 0 ? '' : 'none';
    });
  }
});

app.addEventListener('change', (e) => {
  const target = e.target;
  if (target.matches('[data-code-field]') && target.dataset.codeField === 'name') {
    render();
  }
});

app.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (ui.selection) {
      ui.selection = null;
      render();
    }
    return;
  }
  if (e.key === 'Enter' && e.target.matches('[data-new-code]')) {
    e.preventDefault();
    const name = e.target.value.trim();
    if (!name || !ui.selection) return;
    const c = newCode(name, null);
    toggleCoding(c.id);
    return;
  }
  if (e.key === 'Enter' && e.target.matches('#newTopCode')) {
    e.preventDefault();
    const name = e.target.value.trim();
    if (!name) return;
    const c = newCode(name, null);
    ui.activeCodeId = c.id;
    persist();
    render();
    showToast('已新建码：' + name);
  }
  if (e.key === 'Enter' && e.target.matches('#newChildCode')) {
    e.preventDefault();
    const name = e.target.value.trim();
    if (!name) return;
    const c = newCode(name, ui.activeCodeId);
    ui.activeCodeId = c.id;
    persist();
    render();
    showToast('已新建子码：' + name);
  }
});

render();
