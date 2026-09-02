/* 스노우베어베이커리 상품 DB
   - 데이터: data/products.json (정적 파일)
   - 쓰기:   GitHub Git Data API 로 여러 파일을 1커밋으로 반영
   - 토큰:   localStorage 에만 보관 (github.com API 외에는 전송하지 않음) */
'use strict';

/* ------------------------------------------------------------------ 설정 */

const REPO = (() => {
  // couplogis.github.io/snowbear-bakery-db/ 에서 실행되면 경로에서 추론한다.
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (m) {
    const seg = location.pathname.split('/').filter(Boolean)[0];
    if (seg) return { owner: m[1], repo: seg, branch: 'main' };
  }
  return { owner: 'COUPLOGIS', repo: 'snowbear-bakery-db', branch: 'main' };
})();

const TOKEN_KEY = 'sb_gh_token';
const THUMB_MAX = 200;
const IMG_KEYS = ['images_before', 'images_after'];

/* ------------------------------------------------------------------ 상태 */

const S = {
  schema: null,
  products: [],
  meta: {},
  fieldOrder: [],      // 표/폼에 쓰는 필드 순서
  filterKeys: [],
  filters: {},
  q: '',
  showHidden: false,
  sort: { key: 'erp_name', dir: 1 },
  view: [],            // 현재 필터/정렬 결과
  selected: null,      // 선택된 상품 id
  editing: null,       // 편집 중 상품 (null = 신규)
  editImages: {},      // 편집 중 이미지 { images_before: [{name, url, blob?}], ... }
  pendingXlsx: null,   // 업로드 대기 파싱 결과
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.includes('-')) n.setAttribute(k, v);   // aria-*, data-* 등은 속성으로
    else n[k] = v;
  }
  for (const k of kids) n.append(k);
  return n;
};

/* ------------------------------------------------------------- 유틸 */

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isError);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3000);
}

function slugify(text, fallback) {
  if (!text) return fallback;
  let s = String(text).trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_');
  s = s.replace(/^_|_$/g, '');
  return s.slice(0, 40) || fallback;
}

function nextId(list) {
  let max = 0;
  for (const p of list) {
    const m = /^P(\d+)$/.exec(p.id || '');
    if (m) max = Math.max(max, +m[1]);
  }
  return 'P' + String(max + 1).padStart(3, '0');
}

function stamp() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T') + '+09:00';
}

function matchKey(p) {
  return p.sale_code || p.foodrain_code || p.erp_name || p.id;
}

/* 표시용 값. 여러 상품이 참조할 수 있으므로 원본은 건드리지 않는다. */
function val(p, key) {
  const v = p[key];
  return v === null || v === undefined || v === '' ? '' : String(v);
}

/* ------------------------------------------------------------- 데이터 로드 */

async function boot() {
  const bust = '?v=' + Date.now();
  const [schema, data] = await Promise.all([
    fetch('data/schema.json' + bust).then(r => r.json()),
    fetch('data/products.json' + bust).then(r => r.json()),
  ]);

  S.schema = schema;
  S.products = data.products || [];
  S.meta = { updated_at: data.updated_at, source: data.source };

  S.fieldOrder = schema.groups.flatMap(g => g.fields);
  S.filterKeys = S.fieldOrder.filter(k => schema.fields[k] && schema.fields[k].filter);
  for (const k of S.filterKeys) S.filters[k] = '';

  $('#dataStamp').textContent = S.meta.updated_at
    ? '갱신 ' + new Intl.DateTimeFormat('ko-KR', {
        dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Seoul',
      }).format(new Date(S.meta.updated_at))
    : '';

  buildFilterControls();
  buildGridHead();
  refreshTokenDot();
  apply();
  wire();
}

/* ------------------------------------------------------------- 필터 */

function uniqueValues(key) {
  const set = new Set();
  for (const p of S.products) {
    const v = val(p, key);
    if (v) set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ko'));
}

function buildFilterControls() {
  const wrap = $('#selects');
  wrap.textContent = '';
  for (const key of S.filterKeys) {
    const f = S.schema.fields[key];
    const sel = el('select', { id: 'f_' + key });
    sel.setAttribute('aria-label', f.label);
    sel.append(el('option', { value: '', textContent: f.label + ' 전체' }));
    for (const v of uniqueValues(key)) sel.append(el('option', { value: v, textContent: v }));
    sel.addEventListener('change', () => {
      S.filters[key] = sel.value;
      sel.dataset.active = sel.value ? '1' : '';
      apply();
    });
    wrap.append(sel);
  }
}

function apply() {
  const q = S.q.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];

  S.view = S.products.filter(p => {
    if (!S.showHidden && p.active === false) return false;
    for (const key of S.filterKeys) {
      if (S.filters[key] && val(p, key) !== S.filters[key]) return false;
    }
    if (terms.length) {
      const hay = S.fieldOrder.map(k => val(p, k)).join(' ').toLowerCase();
      if (!terms.every(t => hay.includes(t))) return false;
    }
    return true;
  });

  const { key, dir } = S.sort;
  S.view.sort((a, b) => {
    const x = val(a, key), y = val(b, key);
    if (x === y) return (a.id || '').localeCompare(b.id || '');
    if (!x) return 1;          // 빈 값은 항상 뒤로
    if (!y) return -1;
    return x.localeCompare(y, 'ko', { numeric: true }) * dir;
  });

  const hidden = S.products.filter(p => p.active === false).length;
  $('#countLabel').textContent =
    `${S.view.length} / ${S.products.length}건` + (hidden ? ` (숨김 ${hidden})` : '');

  renderGrid();
}

/* ------------------------------------------------------------- 리스트 */

function buildGridHead() {
  const tr = el('tr');
  tr.append(el('th', { className: 'col-no', textContent: '#', title: '조회 결과 순번' }));
  tr.append(el('th', { className: 'col-thumb', textContent: '이미지', title: '소분 전 이미지' }));

  // 본문(renderGrid)과 순서가 정확히 같아야 한다:
  // 썸네일 · 상품명(고정) · 보관방법(보조칸) · 나머지 필드
  const cols = [
    { key: 'erp_name', cls: 'col-name' },
    { key: 'storage', cls: 'col-sub' },
    ...S.fieldOrder
      .filter(k => k !== 'erp_name' && k !== 'storage')
      .map(k => ({ key: k, cls: '' })),
  ];

  const groupStart = new Set(S.schema.groups.map(g => g.fields[0]));

  for (const c of cols) {
    const f = S.schema.fields[c.key];
    const th = el('th', { className: c.cls, dataset: { key: c.key } });
    if (groupStart.has(c.key) && c.key !== 'erp_name' && c.key !== 'storage') {
      th.classList.add('group-start');
    }
    th.style.minWidth = (f.width || 100) + 'px';
    th.append(f.label);
    th.append(el('span', { className: 'sort' }));
    th.addEventListener('click', () => {
      S.sort = S.sort.key === c.key ? { key: c.key, dir: -S.sort.dir } : { key: c.key, dir: 1 };
      markSort();
      apply();
    });
    tr.append(th);
  }
  $('#gridHead').replaceChildren(tr);
  markSort();
}

function markSort() {
  for (const th of $('#gridHead').querySelectorAll('th[data-key]')) {
    const on = th.dataset.key === S.sort.key;
    th.querySelector('.sort').textContent = on ? (S.sort.dir > 0 ? '▲' : '▼') : '';
    th.setAttribute('aria-sort', on ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
  }
}

function thumbCell(p) {
  const td = el('td', { className: 'col-thumb' });
  const name = (p.images_before && p.images_before[0]) || (p.images_after && p.images_after[0]);
  if (name) {
    td.append(el('img', {
      className: 'thumb', loading: 'lazy', width: 34, height: 34, src: thumbSrc(name),
      alt: val(p, 'erp_name') + ' 썸네일',
    }));
  } else {
    td.append(el('div', { className: 'thumb-none', textContent: '없음' }));
  }
  return td;
}

const thumbSrc = name => 'images/thumb/' + encodeURIComponent(name.replace(/\.png$/i, '.webp'));
const fullSrc = name => 'images/full/' + encodeURIComponent(name);

function cellContent(p, key) {
  const v = val(p, key);
  if (key === 'storage' && v) return el('span', { className: 'tag storage-' + v, textContent: v });
  if (key === 'erp_name') {
    const frag = document.createDocumentFragment();
    frag.append(v || '(이름 없음)');
    if (p.active === false) frag.append(' ', el('span', { className: 'tag off', textContent: '숨김' }));
    return frag;
  }
  return document.createTextNode(v);
}

function renderGrid() {
  const body = $('#gridBody');
  const frag = document.createDocumentFragment();
  const groupStart = new Set(S.schema.groups.map(g => g.fields[0]));
  const rest = S.fieldOrder.filter(k => k !== 'erp_name' && k !== 'storage');

  S.view.forEach((p, i) => {
    const tr = el('tr', { tabIndex: 0, dataset: { id: p.id } });
    tr.setAttribute('aria-selected', String(S.selected === p.id));
    if (p.active === false) tr.classList.add('hidden-row');

    tr.append(el('td', { className: 'col-no', textContent: String(i + 1) }));
    tr.append(thumbCell(p));

    const nameTd = el('td', { className: 'col-name', title: val(p, 'erp_name') });
    nameTd.append(cellContent(p, 'erp_name'));
    tr.append(nameTd);

    // 상세 열림(좁은 리스트)에서 상품명 옆에 같이 보일 보조 정보
    const sub = el('td', { className: 'col-sub' });
    sub.append(cellContent(p, 'storage'));
    tr.append(sub);

    for (const key of rest) {
      const td = el('td', { title: val(p, key) });
      if (groupStart.has(key)) td.classList.add('group-start');
      td.append(cellContent(p, key));
      tr.append(td);
    }

    tr.addEventListener('click', () => select(p.id));
    tr.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(p.id); }
    });
    frag.append(tr);
  });

  body.replaceChildren(frag);
  $('#emptyMsg').hidden = S.view.length > 0;
}

/* ------------------------------------------------------------- 상세 */

function select(id) {
  S.selected = id;
  $('#layout').classList.add('split');
  $('#detail').hidden = false;
  renderDetail();
  for (const tr of $('#gridBody').children) {
    tr.setAttribute('aria-selected', String(tr.dataset.id === id));
  }
  const row = $(`#gridBody tr[data-id="${id}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function closeDetail() {
  S.selected = null;
  $('#layout').classList.remove('split');
  $('#detail').hidden = true;
  for (const tr of $('#gridBody').children) tr.setAttribute('aria-selected', 'false');
}

function current() {
  return S.products.find(p => p.id === S.selected) || null;
}

function renderDetail() {
  const p = current();
  if (!p) return closeDetail();

  $('#dTitle').textContent = val(p, 'erp_name') || '(이름 없음)';
  $('#dSub').textContent = [val(p, 'sale_code'), val(p, 'vendor'), val(p, 'spec')]
    .filter(Boolean).join('  ·  ');
  $('#btnHide').textContent = p.active === false ? '숨김 해제' : '숨김';

  const body = $('#detailBody');
  body.textContent = '';

  // 그룹별 상세를 먼저, 이미지는 아래에 크게
  const strip = el('div', { className: 'img-strip' });
  for (const key of IMG_KEYS) {
    const box = el('div', { className: 'img-box' });
    box.append(el('span', { textContent: S.schema.images[key].label }));
    const shots = el('div', { className: 'shots' });
    const names = p[key] || [];
    if (!names.length) {
      shots.append(el('div', { className: 'img-empty', textContent: '이미지 없음' }));
    }
    for (const name of names) {
      const img = el('img', {
        src: fullSrc(name), loading: 'lazy', tabIndex: 0,
        alt: `${val(p, 'erp_name')} ${S.schema.images[key].label} — 클릭하면 확대`,
        title: '클릭하면 확대',
      });
      const open = () => lightbox(name, `${val(p, 'erp_name')} — ${S.schema.images[key].label}`);
      img.addEventListener('click', open);
      img.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      shots.append(img);
    }
    box.append(shots);
    strip.append(box);
  }
  const groups = el('div', { className: 'groups' });
  for (const g of S.schema.groups) {
    const sec = el('section', { className: 'group' });
    sec.append(el('h3', { textContent: g.label }));
    const dl = el('dl');
    for (const key of g.fields) {
      const f = S.schema.fields[key];
      const v = val(p, key);
      dl.append(el('dt', { textContent: f.label }));
      const dd = el('dd', { textContent: v || '—' });
      if (!v) dd.classList.add('void');
      dl.append(dd);
    }
    sec.append(dl);
    groups.append(sec);
  }
  body.append(groups);
  body.append(el('h3', { className: 'img-strip-title', textContent: '제품 이미지' }));
  body.append(strip);
  body.scrollTop = 0;
}

/* ------------------------------------------------------------- 확대 */

const LB_MAX_UPSCALE = 3;   // 원본보다 3배 넘게 늘리면 뭉개져서 오히려 안 보인다

function lightbox(name, caption) {
  const img = $('#lbImg');
  img.style.maxWidth = '';
  img.style.maxHeight = '';
  img.addEventListener('load', fitLightbox, { once: true });
  img.src = fullSrc(name);
  img.alt = caption;
  $('#lbCap').textContent = caption;
  $('#lightbox').hidden = false;
  $('.lb-close').focus();
  if (img.complete && img.naturalWidth) fitLightbox();
}

/* 화면을 최대한 채우되 원본 해상도 대비 상한을 둔다. */
function fitLightbox() {
  const img = $('#lbImg');
  if (!img.naturalWidth) return;
  img.style.maxWidth = Math.min(window.innerWidth * 0.97,
                                img.naturalWidth * LB_MAX_UPSCALE) + 'px';
  img.style.maxHeight = Math.min(window.innerHeight * 0.92,
                                 img.naturalHeight * LB_MAX_UPSCALE) + 'px';
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lbImg').src = '';
}

/* ------------------------------------------------------------- 프레젠테이션 */

/* 필기는 슬라이드 크기 대비 0~1 좌표로 저장한다.
   그래야 확대하거나 창을 줄여도 그림이 제자리에 남는다. */
const PR = {
  on: false,
  idx: 0,
  zoom: 1,
  tool: 'none',
  color: '#e5231b',
  strokes: new Map(),   // 상품 id -> [stroke]
  drawing: null,
  laserFade: null,
  hideEmpty: false,
  manualZoom: false,   // 사용자가 직접 배율을 만졌으면 자동 맞춤을 하지 않는다
};

const PR_COLORS = ['#e5231b', '#1f5eff', '#111820', '#12a150', '#f5c518'];
const PR_WIDTH = { pen: 0.0035, marker: 0.022, eraser: 0.03 };
const PR_ZOOM = [0.5, 0.65, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];

function prList() {
  return S.view.length ? S.view : S.products;
}

function openPresent() {
  const list = prList();
  if (!list.length) return;
  const at = list.findIndex(p => p.id === S.selected);
  PR.idx = at >= 0 ? at : 0;
  PR.on = true;
  PR.zoom = 1;
  PR.manualZoom = false;
  setTool('none');
  $('#present').hidden = false;
  document.documentElement.requestFullscreen?.().catch(() => { /* 전체화면 거부돼도 계속 */ });
  renderSlide();
  $('#prExit').focus();
}

function closePresent() {
  PR.on = false;
  $('#present').hidden = true;
  $('#prLaser').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  const p = prList()[PR.idx];
  if (p) { S.selected = p.id; select(p.id); }
}

function prGo(delta) {
  const list = prList();
  const next = PR.idx + delta;
  if (next < 0 || next >= list.length) return;
  PR.idx = next;
  renderSlide();
}

function renderSlide() {
  const list = prList();
  const p = list[PR.idx];
  if (!p) return closePresent();

  $('#prPage').textContent = `${PR.idx + 1} / ${list.length}`;
  const atFirst = PR.idx === 0;
  const atLast = PR.idx === list.length - 1;
  for (const id of ['#prPrev', '#prPrevBig']) $(id).disabled = atFirst;
  for (const id of ['#prNext', '#prNextBig']) $(id).disabled = atLast;

  const slide = $('#prSlide');
  slide.textContent = '';
  slide.append(el('h2', { textContent: val(p, 'erp_name') || '(이름 없음)' }));
  slide.append(el('p', {
    className: 'pr-sub',
    textContent: [val(p, 'sale_code'), val(p, 'vendor'), val(p, 'storage')]
      .filter(Boolean).join('  ·  ') || ' ',
  }));

  const shots = el('div', { className: 'pr-shots' });
  for (const key of IMG_KEYS) {
    const box = el('div', { className: 'pr-shot' });
    box.append(el('span', { textContent: S.schema.images[key].label }));
    const names = p[key] || [];
    if (!names.length) {
      box.append(el('div', { className: 'img-empty', textContent: '이미지 없음' }));
    } else {
      // 발표에서는 원본을 쓴다 (확대해도 뭉개지지 않도록)
      box.append(el('img', {
        src: fullSrc(names[0]),
        alt: `${val(p, 'erp_name')} ${S.schema.images[key].label}`,
      }));
    }
    shots.append(box);
  }

  // 상세화면과 같은 그룹·항목을 전부 싣는다
  const groups = el('div', { className: 'pr-groups' });
  for (const g of S.schema.groups) {
    const fields = g.fields.filter(k => !PR.hideEmpty || val(p, k));
    if (!fields.length) continue;
    const sec = el('section', { className: 'pr-group' });
    sec.append(el('h3', { textContent: g.label }));
    const dl = el('dl');
    for (const key of fields) {
      const v = val(p, key);
      dl.append(el('dt', { textContent: S.schema.fields[key].label }));
      dl.append(el('dd', { textContent: v || '—', className: v ? '' : 'void' }));
    }
    sec.append(dl);
    groups.append(sec);
  }

  const body = el('div', { className: 'pr-body' });
  body.append(shots, groups);
  slide.append(body);

  if (PR.manualZoom) applyZoom(); else prFit();
  // 이미지가 늦게 뜨면 높이가 바뀌므로 그때 한 번 더 맞춘다
  for (const img of slide.querySelectorAll('img')) {
    img.addEventListener('load', () => {
      if (!PR.manualZoom) prFit(); else resizeInk();
    }, { once: true });
  }
  requestAnimationFrame(resizeInk);
}

/* 레이아웃 폭은 고정하고 transform 으로만 키우고 줄인다.
   폭을 줄이면 글이 접혀 오히려 길어지기 때문에 높이 맞춤이 안 된다. */
function applyZoom() {
  const wrap = $('#prWrap');
  const stage = $('#prStage');
  const base = Math.max(600, Math.min(1280, wrap.clientWidth - 48));

  stage.style.setProperty('--pr-w', base + 'px');
  stage.style.setProperty('--pr-s', PR.zoom);

  // 변형된 요소는 스크롤 영역을 넓히지 못하므로 바깥 상자로 자리를 잡아 준다
  const box = $('#prBox');
  box.style.width = Math.round(base * PR.zoom) + 'px';
  box.style.height = Math.round(stage.offsetHeight * PR.zoom) + 'px';

  $('#prZoomLabel').textContent = Math.round(PR.zoom * 100) + '%';
  requestAnimationFrame(resizeInk);
}

function prZoom(dir) {
  // 자동 맞춤 배율은 목록에 없으니 가장 가까운 단계를 기준으로 삼는다
  let at = PR_ZOOM.findIndex(z => z >= PR.zoom - 1e-6);
  if (at < 0) at = PR_ZOOM.length - 1;
  if (dir > 0 && Math.abs(PR_ZOOM[at] - PR.zoom) > 1e-6) dir = 0;
  const next = PR_ZOOM[Math.min(PR_ZOOM.length - 1, Math.max(0, at + dir))];
  if (Math.abs(next - PR.zoom) < 1e-6) return;
  PR.zoom = next;
  PR.manualZoom = true;
  applyZoom();
}

/* 슬라이드 전체가 한 화면에 들어오도록 배율을 맞춘다.
   변형만 쓰므로 글이 다시 접히지 않아 한 번에 정확히 떨어진다. */
function prFit() {
  const wrap = $('#prWrap');
  const avail = wrap.clientHeight - 48;
  if (avail <= 0) return;
  PR.manualZoom = false;
  PR.zoom = 1;
  applyZoom();
  const h = $('#prStage').offsetHeight;     // 변형 전 높이
  if (h > avail) PR.zoom = Math.max(0.3, avail / h);
  applyZoom();
}

function resizeInk() {
  const canvas = $('#prInk');
  const stage = $('#prStage');
  const cw = stage.offsetWidth, ch = stage.offsetHeight;
  if (!cw || !ch) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(cw * dpr);
  const h = Math.round(ch * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  redrawInk();
}

function currentStrokes() {
  const p = prList()[PR.idx];
  if (!p) return [];
  if (!PR.strokes.has(p.id)) PR.strokes.set(p.id, []);
  return PR.strokes.get(p.id);
}

function redrawInk() {
  const canvas = $('#prInk');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const s of currentStrokes()) drawStroke(ctx, s, canvas);
}

function drawStroke(ctx, s, canvas) {
  if (s.points.length < 2) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, s.width * canvas.width);

  if (s.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
  } else if (s.tool === 'marker') {
    ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = s.color;
    ctx.globalAlpha = 0.38;
  } else {
    ctx.strokeStyle = s.color;
  }

  ctx.beginPath();
  ctx.moveTo(s.points[0].x * canvas.width, s.points[0].y * canvas.height);
  for (let i = 1; i < s.points.length; i++) {
    ctx.lineTo(s.points[i].x * canvas.width, s.points[i].y * canvas.height);
  }
  ctx.stroke();
  ctx.restore();
}

function setTool(tool) {
  PR.tool = tool;
  const canvas = $('#prInk');
  canvas.classList.toggle('idle', tool === 'none' || tool === 'laser');
  canvas.classList.toggle('draw', tool === 'pen' || tool === 'marker');
  canvas.classList.toggle('erase', tool === 'eraser');
  for (const b of document.querySelectorAll('#prBar [data-tool]')) {
    b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  }
  if (tool !== 'laser') $('#prLaser').hidden = true;
}

/* 캔버스 내부 좌표(0~1)로 환산. 확대/스크롤 상태와 무관하게 맞는다. */
function inkPoint(e) {
  const rect = $('#prInk').getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width,
    y: (e.clientY - rect.top) / rect.height,
  };
}

function wirePresent() {
  const canvas = $('#prInk');

  canvas.addEventListener('pointerdown', e => {
    if (!['pen', 'marker', 'eraser'].includes(PR.tool)) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    PR.drawing = {
      tool: PR.tool,
      color: PR.color,
      width: PR_WIDTH[PR.tool],
      points: [inkPoint(e)],
    };
    currentStrokes().push(PR.drawing);
    $('#present').classList.add('inking');
  });

  canvas.addEventListener('pointermove', e => {
    if (!PR.drawing) return;
    PR.drawing.points.push(inkPoint(e));
    redrawInk();
  });

  const endStroke = () => {
    if (!PR.drawing) return;
    // 점 하나만 찍힌 경우도 보이도록 살짝 늘려 준다
    if (PR.drawing.points.length === 1) {
      const p = PR.drawing.points[0];
      PR.drawing.points.push({ x: p.x + 0.001, y: p.y + 0.001 });
    }
    PR.drawing = null;
    $('#present').classList.remove('inking');
    redrawInk();
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', endStroke);

  // 레이저 포인터
  $('#present').addEventListener('pointermove', e => {
    if (PR.tool !== 'laser') return;
    const dot = $('#prLaser');
    dot.hidden = false;
    dot.style.left = e.clientX + 'px';
    dot.style.top = e.clientY + 'px';
    clearTimeout(PR.laserFade);
    PR.laserFade = setTimeout(() => { dot.hidden = true; }, 2500);
  });

  for (const b of document.querySelectorAll('#prBar [data-tool]')) {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  }

  const colors = $('#prColors');
  for (const c of PR_COLORS) {
    const sw = el('button', {
      type: 'button', className: 'pr-swatch', title: '색상 ' + c,
      'aria-label': '색상 ' + c,
      'aria-pressed': String(c === PR.color),
    });
    sw.style.background = c;
    sw.addEventListener('click', () => {
      PR.color = c;
      for (const s of colors.children) s.setAttribute('aria-pressed', String(s === sw));
      if (!['pen', 'marker'].includes(PR.tool)) setTool('pen');
    });
    colors.append(sw);
  }

  for (const id of ['#prPrev', '#prPrevBig']) $(id).addEventListener('click', () => prGo(-1));
  for (const id of ['#prNext', '#prNextBig']) $(id).addEventListener('click', () => prGo(1));
  $('#prExit').addEventListener('click', closePresent);
  $('#prZoomIn').addEventListener('click', () => prZoom(1));
  $('#prZoomOut').addEventListener('click', () => prZoom(-1));
  $('#prZoomFit').addEventListener('click', prFit);

  $('#prEmpty').addEventListener('click', () => {
    PR.hideEmpty = !PR.hideEmpty;
    $('#prEmpty').setAttribute('aria-pressed', String(PR.hideEmpty));
    renderSlide();
  });

  $('#prUndo').addEventListener('click', () => { currentStrokes().pop(); redrawInk(); });
  $('#prClear').addEventListener('click', () => {
    const p = prList()[PR.idx];
    if (p) PR.strokes.set(p.id, []);
    redrawInk();
  });

  window.addEventListener('resize', () => {
    if (!PR.on) return;
    if (PR.manualZoom) applyZoom(); else prFit();
  });

  document.addEventListener('keydown', e => {
    if (!PR.on) return;
    if (e.ctrlKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      currentStrokes().pop();
      redrawInk();
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    const map = { v: 'none', p: 'pen', h: 'marker', l: 'laser', e: 'eraser' };
    if (map[k]) { setTool(map[k]); return; }
    if (k === 'b') { $('#prEmpty').click(); return; }
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); prGo(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prGo(-1); }
    else if (e.key === 'Escape') closePresent();
    else if (e.key === '+' || e.key === '=') prZoom(1);
    else if (e.key === '-') prZoom(-1);
    else if (e.key === '0') prFit();
  });
}

/* ------------------------------------------------------------- GitHub */

const token = () => localStorage.getItem(TOKEN_KEY) || '';

function refreshTokenDot() {
  $('#tokenDot').classList.toggle('on', !!token());
  $('#btnToken').title = token() ? 'GitHub 토큰 저장됨' : 'GitHub 토큰이 없어 저장할 수 없습니다';
}

async function gh(path, opts = {}) {
  const t = token();
  if (!t) throw new Error('GitHub 토큰이 없습니다. [저장설정]에서 먼저 등록하세요.');
  const res = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}${path}`, {
    ...opts,
    // 캐시된 ref/commit 응답을 쓰면 낡은 SHA 를 부모로 잡아
    // 두 번째 커밋부터 "not a fast forward" 로 실패한다.
    cache: 'no-store',
    headers: {
      Authorization: 'Bearer ' + t,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* 본문 없음 */ }
    if (res.status === 401) detail = '토큰이 유효하지 않습니다.';
    if (res.status === 403 && /rate limit/i.test(detail)) detail = 'API 호출 한도를 초과했습니다.';
    if (res.status === 404) detail += ' (저장소 접근 권한을 확인하세요)';
    if (res.status === 422 && /fast forward/i.test(detail)) {
      detail = '저장소가 그 사이 다른 곳에서 바뀌었습니다. 새로고침한 뒤 다시 저장하세요.';
    }
    throw new Error(`GitHub ${res.status} ${detail}`.trim());
  }
  return res.status === 204 ? null : res.json();
}

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;   // 인자 개수 제한 회피
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** git blob 해시 = sha1("blob <len>\0" + content). 트리와 비교해 중복 업로드를 막는다. */
async function gitBlobSha(bytes) {
  const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(head.length + bytes.length);
  buf.set(head, 0);
  buf.set(bytes, head.length);
  const digest = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 여러 파일을 한 커밋으로 반영한다.
 * files: [{ path, text }] 또는 [{ path, bytes }]
 */
async function commitFiles(files, message, onProgress) {
  const say = onProgress || (() => {});

  say('저장소 상태 확인 중…');
  const ref = await gh(`/git/ref/heads/${REPO.branch}`);
  const head = await gh(`/git/commits/${ref.object.sha}`);
  const tree = await gh(`/git/trees/${head.tree.sha}?recursive=1`);
  const existing = new Map(tree.tree.map(e => [e.path, e.sha]));

  // 내용이 같은 파일은 건너뛴다
  const todo = [];
  for (const f of files) {
    const bytes = f.bytes || new TextEncoder().encode(f.text);
    const sha = await gitBlobSha(bytes);
    if (existing.get(f.path) === sha) continue;
    todo.push({ ...f, bytes });
  }
  if (!todo.length) return { skipped: true };

  const entries = [];
  let done = 0;
  for (const f of todo) {
    say(`업로드 ${++done}/${todo.length} — ${f.path.split('/').pop()}`);
    const blob = await gh('/git/blobs', {
      method: 'POST',
      body: JSON.stringify(
        f.text !== undefined
          ? { content: f.text, encoding: 'utf-8' }
          : { content: bytesToBase64(f.bytes), encoding: 'base64' }
      ),
    });
    entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  say('커밋 생성 중…');
  const newTree = await gh('/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: head.tree.sha, tree: entries }),
  });
  const commit = await gh('/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [ref.object.sha] }),
  });
  await gh(`/git/refs/heads/${REPO.branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha }),
  });

  return { sha: commit.sha, count: todo.length };
}

function productsPayload() {
  return JSON.stringify({
    updated_at: stamp(),
    source: S.meta.source || '',
    count: S.products.length,
    products: S.products,
  }, null, 1);
}

/* ------------------------------------------------------------- 이미지 처리 */

async function makeThumb(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, THUMB_MAX / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await new Promise(res => canvas.toBlob(res, 'image/webp', 0.82));
  return new Uint8Array(await out.arrayBuffer());
}

const blobBytes = async blob => new Uint8Array(await blob.arrayBuffer());

/** 편집/업로드로 새로 들어온 이미지의 파일 두 벌(원본 + 썸네일)을 만든다. */
async function imageFiles(name, blob) {
  const base = name.replace(/\.[^.]+$/, '');
  return [
    { path: 'images/full/' + name, bytes: await blobBytes(blob) },
    { path: 'images/thumb/' + base + '.webp', bytes: await makeThumb(blob) },
  ];
}

/* ------------------------------------------------------------- 수정 / 추가 */

function openEdit(product) {
  S.editing = product;
  const isNew = !product;
  $('#editTitle').textContent = isNew ? '상품 추가' : '상품 수정';
  $('#editMsg').textContent = '';
  $('#editMsg').classList.remove('err');

  S.editImages = {};
  for (const key of IMG_KEYS) {
    S.editImages[key] = (product && product[key] || []).map(name => ({ name, url: thumbSrc(name) }));
  }

  const body = $('#editBody');
  body.textContent = '';

  for (const g of S.schema.groups) {
    const sec = el('section', { className: 'edit-group' });
    sec.append(el('h3', { textContent: g.label }));
    const grid = el('div', { className: 'edit-grid' });

    for (const key of g.fields) {
      const f = S.schema.fields[key];
      const lab = el('label', { className: 'fld' + (f.required ? ' req' : '') });
      lab.append(el('span', { textContent: f.label }));

      let input;
      if (f.type === 'textarea') {
        input = el('textarea', { name: key, value: product ? val(product, key) : '' });
      } else {
        input = el('input', { type: 'text', name: key, value: product ? val(product, key) : '' });
        if (f.type === 'select') {
          const listId = 'dl_' + key;
          input.setAttribute('list', listId);
          const dl = el('datalist', { id: listId });
          for (const v of uniqueValues(key)) dl.append(el('option', { value: v }));
          lab.append(dl);
        }
        if (f.required) input.required = true;
      }
      lab.append(input);
      grid.append(lab);
    }
    sec.append(grid);
    body.append(sec);
  }

  // 이미지 편집
  const imgSec = el('section', { className: 'edit-group' });
  imgSec.append(el('h3', { textContent: '이미지' }));
  const wrap = el('div', { className: 'img-edit' });
  for (const key of IMG_KEYS) {
    const box = el('div', { className: 'img-edit-box', dataset: { key } });
    box.append(el('span', { textContent: S.schema.images[key].label }));
    box.append(el('div', { className: 'img-edit-list' }));
    wrap.append(box);
  }
  imgSec.append(wrap);
  body.append(imgSec);
  renderEditImages();

  $('#editDlg').showModal();
}

function renderEditImages() {
  for (const key of IMG_KEYS) {
    const box = $(`.img-edit-box[data-key="${key}"]`);
    if (!box) continue;
    const list = box.querySelector('.img-edit-list');
    list.textContent = '';

    S.editImages[key].forEach((item, i) => {
      const cell = el('div', { className: 'img-edit-item' });
      cell.append(el('img', { src: item.url, alt: `${S.schema.images[key].label} ${i + 1}` }));
      const rm = el('button', {
        type: 'button', textContent: '×',
        title: '이 이미지 제외',
        'aria-label': `${S.schema.images[key].label} ${i + 1} 제외`,
      });
      rm.addEventListener('click', () => {
        S.editImages[key].splice(i, 1);
        renderEditImages();
      });
      cell.append(rm);
      list.append(cell);
    });

    const drop = el('div', {
      className: 'img-drop', tabIndex: 0, role: 'button',
      textContent: '+ 이미지 추가',
      title: '클릭하거나 파일을 끌어다 놓으세요',
    });
    const pick = () => {
      const inp = el('input', { type: 'file', accept: 'image/*', multiple: true });
      inp.addEventListener('change', () => addEditImages(key, inp.files));
      inp.click();
    };
    drop.addEventListener('click', pick);
    drop.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
    });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.classList.remove('over');
      addEditImages(key, e.dataTransfer.files);
    });
    list.append(drop);
  }
}

function addEditImages(key, fileList) {
  for (const file of fileList) {
    if (!file.type.startsWith('image/')) continue;
    S.editImages[key].push({ name: null, url: URL.createObjectURL(file), blob: file, ext: extOf(file) });
  }
  renderEditImages();
}

function extOf(file) {
  const m = /\.(png|jpe?g|webp|gif)$/i.exec(file.name || '');
  if (m) return m[0].toLowerCase();
  return file.type === 'image/jpeg' ? '.jpg' : file.type === 'image/webp' ? '.webp' : '.png';
}

async function saveEdit(e) {
  e.preventDefault();
  const msg = $('#editMsg');
  const btn = $('#btnSave');
  const form = $('#editForm');

  const rec = S.editing ? { ...S.editing } : { id: nextId(S.products), active: true };
  for (const key of S.fieldOrder) {
    const input = form.elements[key];
    if (!input) continue;
    const v = input.value.trim();
    if (v) rec[key] = v; else delete rec[key];
  }
  if (!rec.erp_name) {
    msg.textContent = 'ERP상품명은 필수입니다.';
    msg.classList.add('err');
    return;
  }

  btn.disabled = true;
  msg.classList.remove('err');
  const say = t => { msg.textContent = t; };

  try {
    // 새 이미지에 파일명을 붙이고 업로드 파일 목록을 만든다
    const files = [];
    const base = rec.id + '_' + slugify(rec.erp_name, rec.id);
    for (const key of IMG_KEYS) {
      const suffix = key === 'images_before' ? 'before' : 'after';
      const names = [];
      let n = 0;
      for (const item of S.editImages[key]) {
        n += 1;
        if (item.blob) {
          say('이미지 변환 중…');
          const name = `${base}_${suffix}${n}${item.ext}`;
          files.push(...await imageFiles(name, item.blob));
          names.push(name);
        } else {
          names.push(item.name);
        }
      }
      rec[key] = names;
    }
    rec.updated_at = stamp();

    // 메모리 반영 후 products.json 을 만든다
    const idx = S.products.findIndex(p => p.id === rec.id);
    const backup = idx >= 0 ? S.products[idx] : null;
    if (idx >= 0) S.products[idx] = rec; else S.products.push(rec);

    files.push({ path: 'data/products.json', text: productsPayload() });

    try {
      const res = await commitFiles(
        files,
        `${S.editing ? '수정' : '추가'}: ${rec.erp_name} (${rec.id})`,
        say
      );
      toast(res.skipped ? '변경된 내용이 없습니다.'
                        : `저장 완료 — ${res.count}개 파일 커밋`);
    } catch (err) {
      // 커밋 실패 시 화면 상태를 되돌린다
      if (idx >= 0) S.products[idx] = backup; else S.products.pop();
      throw err;
    }

    $('#editDlg').close();
    buildFilterControls();
    for (const key of S.filterKeys) {
      const sel = $('#f_' + key);
      if (sel) { sel.value = S.filters[key]; sel.dataset.active = S.filters[key] ? '1' : ''; }
    }
    S.selected = rec.id;
    apply();
    select(rec.id);

  } catch (err) {
    msg.textContent = err.message;
    msg.classList.add('err');
  } finally {
    btn.disabled = false;
  }
}

async function toggleHide() {
  const p = current();
  if (!p) return;
  const goingHidden = p.active !== false;
  if (goingHidden && !confirm(`"${val(p, 'erp_name')}" 을(를) 목록에서 숨길까요?\n데이터와 이미지는 지워지지 않습니다.`)) return;

  const prev = p.active;
  p.active = !goingHidden;
  p.updated_at = stamp();
  try {
    await commitFiles(
      [{ path: 'data/products.json', text: productsPayload() }],
      `${goingHidden ? '숨김' : '숨김 해제'}: ${val(p, 'erp_name')} (${p.id})`,
      t => toast(t)
    );
    toast(goingHidden ? '숨김 처리했습니다.' : '다시 표시합니다.');
    apply();
    renderDetail();
  } catch (err) {
    p.active = prev;
    toast(err.message, true);
  }
}

/* ------------------------------------------------------------- 엑셀 업로드 */

const NS = {
  xdr: 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  main: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
};

const parseXml = text => new DOMParser().parseFromString(text, 'application/xml');

/** 시트 이름 -> xl/worksheets/sheetN.xml 경로 (순서가 아니라 관계 파일로 찾는다) */
async function sheetPath(zip, sheetName) {
  const wbXml = parseXml(await zip.file('xl/workbook.xml').async('text'));
  const relXml = parseXml(await zip.file('xl/_rels/workbook.xml.rels').async('text'));

  const rels = {};
  for (const rel of relXml.getElementsByTagName('Relationship')) {
    rels[rel.getAttribute('Id')] = rel.getAttribute('Target');
  }
  for (const sh of wbXml.getElementsByTagNameNS(NS.main, 'sheet')) {
    if (sh.getAttribute('name') !== sheetName) continue;
    const rid = sh.getAttributeNS(NS.r, 'id') || sh.getAttribute('r:id');
    let target = rels[rid] || '';
    target = target.replace(/^\/?xl\//, '').replace(/^\.\//, '');
    return 'xl/' + target;
  }
  return null;
}

/** 시트에 박힌 이미지를 {"행,열": [Blob]} 으로 뽑는다 (행/열은 0-based). */
async function extractSheetImages(zip, sheetFile) {
  const relPath = sheetFile.replace(/([^/]+)$/, '_rels/$1.rels');
  const relFile = zip.file(relPath);
  if (!relFile) return {};

  const relXml = parseXml(await relFile.async('text'));
  let drawing = null;
  for (const rel of relXml.getElementsByTagName('Relationship')) {
    if ((rel.getAttribute('Type') || '').endsWith('/drawing')) {
      drawing = rel.getAttribute('Target').replace(/^\.\.\//, 'xl/').replace(/^\//, '');
    }
  }
  if (!drawing || !zip.file(drawing)) return {};

  const dRelPath = drawing.replace(/([^/]+)$/, '_rels/$1.rels');
  const dRelXml = parseXml(await zip.file(dRelPath).async('text'));
  const media = {};
  for (const rel of dRelXml.getElementsByTagName('Relationship')) {
    media[rel.getAttribute('Id')] =
      rel.getAttribute('Target').replace(/^\.\.\//, 'xl/').replace(/^\//, '');
  }

  const dXml = parseXml(await zip.file(drawing).async('text'));
  const out = {};
  const anchors = [
    ...dXml.getElementsByTagNameNS(NS.xdr, 'twoCellAnchor'),
    ...dXml.getElementsByTagNameNS(NS.xdr, 'oneCellAnchor'),
  ];
  for (const anchor of anchors) {
    const from = anchor.getElementsByTagNameNS(NS.xdr, 'from')[0];
    const blip = anchor.getElementsByTagNameNS(NS.a, 'blip')[0];
    if (!from || !blip) continue;
    const col = +from.getElementsByTagNameNS(NS.xdr, 'col')[0].textContent;
    const row = +from.getElementsByTagNameNS(NS.xdr, 'row')[0].textContent;
    const rid = blip.getAttributeNS(NS.r, 'embed') || blip.getAttribute('r:embed');
    const path = media[rid];
    if (!path || !zip.file(path)) continue;
    const blob = await zip.file(path).async('blob');
    blob._ext = (path.match(/\.[^.]+$/) || ['.png'])[0].toLowerCase();
    (out[`${row},${col}`] ||= []).push(blob);
  }
  return out;
}

const XL_SHEET = '상품리스트(이미지)';
const XL_HEADER_ROW = 1;   // 0-based (엑셀 2행)
const XL_DATA_ROW = 2;     // 0-based (엑셀 3행)

async function parseXlsx(file) {
  const buf = await file.arrayBuffer();

  const wb = XLSX.read(buf, { type: 'array' });
  if (!wb.SheetNames.includes(XL_SHEET)) {
    throw new Error(`시트 '${XL_SHEET}' 가 없습니다. (있는 시트: ${wb.SheetNames.join(', ')})`);
  }
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[XL_SHEET], {
    header: 1, raw: true, defval: null, blankrows: true,
  });

  // 엑셀 컬럼명 -> JSON 키
  const excelToKey = {};
  for (const [key, f] of Object.entries(S.schema.fields)) excelToKey[f.excel] = key;

  const header = rows[XL_HEADER_ROW] || [];
  const colToKey = {};
  const unknown = [];
  header.forEach((name, i) => {
    const n = (name || '').toString().trim();
    if (!n) return;
    if (excelToKey[n]) colToKey[i] = excelToKey[n];
    else if (!['이미지', '소분전', '소분후'].includes(n)) unknown.push(n);
  });
  if (!Object.keys(colToKey).length) {
    throw new Error('헤더(2행)에서 알아볼 수 있는 컬럼을 찾지 못했습니다. 원본과 같은 형식인지 확인하세요.');
  }

  const zip = await JSZip.loadAsync(buf);
  const sPath = await sheetPath(zip, XL_SHEET);
  const images = sPath ? await extractSheetImages(zip, sPath) : {};

  const parsed = [];
  for (let r = XL_DATA_ROW; r < rows.length; r++) {
    const row = rows[r] || [];
    const rec = {};
    for (const [i, key] of Object.entries(colToKey)) {
      let v = row[i];
      if (v === null || v === undefined) continue;
      if (typeof v === 'string') v = v.replace(/\r\n/g, '\n').trim();
      if (v === '') continue;
      rec[key] = v;
    }
    if (!Object.keys(rec).length) continue;
    rec._images = {
      images_before: images[`${r},0`] || [],
      images_after: images[`${r},1`] || [],
    };
    parsed.push(rec);
  }

  return { parsed, unknown, imageCount: Object.values(images).flat().length };
}

function previewXlsx(result) {
  const index = new Map(S.products.map(p => [matchKey(p), p]));
  let updated = 0, added = 0;
  const addedNames = [];
  for (const rec of result.parsed) {
    if (index.has(matchKey(rec))) updated++;
    else { added++; addedNames.push(rec.erp_name || '(이름 없음)'); }
  }

  const box = $('#upPreview');
  box.textContent = '';
  box.hidden = false;
  box.append(el('div', {},
    `읽은 상품 ${result.parsed.length}건 · 이미지 ${result.imageCount}장 → `));
  box.append(el('div', {},
    el('b', { textContent: String(updated) }), '건 갱신, ',
    el('b', { textContent: String(added) }), '건 추가, 기존 ',
    el('b', { textContent: String(S.products.length - updated) }), '건 유지'));

  if (addedNames.length) {
    const ul = el('ul');
    for (const n of addedNames.slice(0, 12)) ul.append(el('li', { textContent: '신규: ' + n }));
    if (addedNames.length > 12) ul.append(el('li', { textContent: `… 외 ${addedNames.length - 12}건` }));
    box.append(ul);
  }
  if (result.unknown.length) {
    box.append(el('div', {}, el('b', { textContent: '무시된 컬럼: ' }), result.unknown.join(', ')));
  }

  $('#btnUpCommit').disabled = result.parsed.length === 0;
}

async function commitXlsx() {
  const result = S.pendingXlsx;
  if (!result) return;
  const btn = $('#btnUpCommit');
  const msg = $('#upMsg');
  btn.disabled = true;
  msg.classList.remove('err');
  const say = t => { msg.textContent = t; };

  const snapshot = S.products.map(p => ({ ...p }));

  try {
    const index = new Map(S.products.map(p => [matchKey(p), p]));
    const files = [];
    let n = 0;

    for (const rec of result.parsed) {
      n += 1;
      say(`처리 중 ${n}/${result.parsed.length}…`);
      const imgs = rec._images;
      delete rec._images;

      const target = index.get(matchKey(rec));
      const merged = target ? { ...target, ...rec } : { ...rec, active: true };
      if (!target) {
        merged.id = nextId(S.products);
        S.products.push(merged);
        index.set(matchKey(merged), merged);
      }

      const base = merged.id + '_' + slugify(merged.erp_name, merged.id);
      for (const key of IMG_KEYS) {
        const suffix = key === 'images_before' ? 'before' : 'after';
        const blobs = imgs[key];
        if (!blobs.length) {
          merged[key] = merged[key] || [];   // 엑셀에 이미지가 없으면 기존 것을 유지
          continue;
        }
        const names = [];
        for (let i = 0; i < blobs.length; i++) {
          const name = `${base}_${suffix}${i + 1}${blobs[i]._ext || '.png'}`;
          files.push(...await imageFiles(name, blobs[i]));
          names.push(name);
        }
        merged[key] = names;
      }
      merged.updated_at = stamp();

      if (target) Object.assign(target, merged);
    }

    files.push({ path: 'data/products.json', text: productsPayload() });

    const res = await commitFiles(files, `엑셀 업로드 병합 (${result.parsed.length}건)`, say);
    toast(res.skipped ? '변경된 내용이 없습니다.' : `업로드 완료 — ${res.count}개 파일 커밋`);

    $('#upDlg').close();
    S.pendingXlsx = null;
    $('#xlsxFile').value = '';
    $('#upPreview').hidden = true;
    buildFilterControls();
    apply();
    if (S.selected) renderDetail();

  } catch (err) {
    S.products = snapshot;
    msg.textContent = err.message;
    msg.classList.add('err');
    apply();
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------- 엑셀 일괄수정 */

/* 내려받기 → 엑셀에서 수정 → 검사 → 변경분만 반영.
   스키마 필드 외에 ID(매칭 열쇠), 숨김, 이미지(참고용) 열이 붙는다. */
const BULK_ID = 'ID';
const BULK_ACTIVE = '숨김';
const BULK_IMG = { images_before: '이미지(소분전)', images_after: '이미지(소분후)' };
const BULK_SHEET = '상품';

function bulkHeader() {
  return [BULK_ID, ...S.fieldOrder.map(k => S.schema.fields[k].label),
          BULK_ACTIVE, BULK_IMG.images_before, BULK_IMG.images_after];
}

function bulkExport(list, label) {
  const rows = [bulkHeader()];
  for (const p of list) {
    rows.push([
      p.id,
      ...S.fieldOrder.map(k => (p[k] === undefined || p[k] === null) ? '' : p[k]),
      p.active === false ? 'Y' : 'N',
      (p.images_before || []).join(', '),
      (p.images_after || []).join(', '),
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = bulkHeader().map(h =>
    ({ wch: h === BULK_ID ? 8 : h.startsWith('이미지') ? 34 : Math.max(11, h.length + 6) }));
  ws['!freeze'] = { xSplit: 1, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, BULK_SHEET);

  const d = new Date();
  const day = [d.getFullYear(), d.getMonth() + 1, d.getDate()]
    .map(n => String(n).padStart(2, '0')).join('');
  XLSX.writeFile(wb, `스노우베어_상품_일괄수정_${label}_${day}.xlsx`);
}

/** 올린 파일을 읽어 "무엇이 바뀌는지" 계획을 만든다. 여기서는 데이터를 건드리지 않는다. */
function bulkParse(file) {
  return file.arrayBuffer().then(buf => {
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[BULK_SHEET] || wb.Sheets[wb.SheetNames[0]];
    if (!sheet) throw new Error('시트를 읽을 수 없습니다.');

    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1, raw: true, defval: null, blankrows: false,
    });
    if (rows.length < 2) throw new Error('데이터 행이 없습니다. 1행은 제목 줄이어야 합니다.');

    const labelToKey = {};
    for (const [key, f] of Object.entries(S.schema.fields)) labelToKey[f.label] = key;

    const colKey = {};
    const ignored = [];
    let hasId = false;
    (rows[0] || []).forEach((raw, i) => {
      const h = (raw === null || raw === undefined ? '' : String(raw)).trim();
      if (!h) return;
      if (h === BULK_ID) { colKey[i] = '__id'; hasId = true; }
      else if (h === BULK_ACTIVE) colKey[i] = '__active';
      else if (labelToKey[h]) colKey[i] = labelToKey[h];
      else ignored.push(h);   // 이미지 열 등은 참고용
    });
    if (!hasId) {
      throw new Error(`제목 줄에 '${BULK_ID}' 열이 없습니다. 내려받은 파일의 1행을 지우지 마세요.`);
    }

    const byId = new Map(S.products.map(p => [p.id, p]));
    const plan = { updates: [], creates: [], errors: [], unchanged: 0, ignored, rowCount: 0 };
    const seen = new Set();

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const excelRow = r + 1;

      const cell = {};
      for (const [i, key] of Object.entries(colKey)) {
        let v = row[i];
        if (v === null || v === undefined) { cell[key] = ''; continue; }
        if (typeof v === 'string') v = v.replace(/\r\n/g, '\n').trim();
        cell[key] = v;
      }

      const id = String(cell.__id ?? '').trim();
      const isBlank = Object.entries(cell)
        .every(([k, v]) => k === '__active' || v === '' || v === null);
      if (isBlank) continue;
      plan.rowCount++;

      const name = String(cell.erp_name ?? '').trim();

      if (!id) {
        if (!name) {
          plan.errors.push(`${excelRow}행: ID 도 ERP상품명도 비어 있습니다.`);
          continue;
        }
        plan.creates.push({ excelRow, cell, name });
        continue;
      }

      if (seen.has(id)) {
        plan.errors.push(`${excelRow}행: ID ${id} 가 앞 행과 중복입니다.`);
        continue;
      }
      seen.add(id);

      const target = byId.get(id);
      if (!target) {
        plan.errors.push(`${excelRow}행: ID ${id} 를 찾을 수 없습니다. ID 열을 고치지 마세요.`);
        continue;
      }
      if (!name) {
        plan.errors.push(`${excelRow}행 (${val(target, 'erp_name')}): ERP상품명은 비울 수 없습니다.`);
        continue;
      }

      const changes = [];
      for (const key of S.fieldOrder) {
        if (!(key in cell)) continue;          // 엑셀에서 열을 지웠으면 건드리지 않는다
        const to = cell[key];
        const before = val(target, key);
        const after = to === '' ? '' : String(to);
        if (before !== after) changes.push({ key, before, after, value: to });
      }

      let activeTo = null;
      if ('__active' in cell) {
        const hide = String(cell.__active ?? '').trim().toUpperCase();
        if (hide && !['Y', 'N', 'YES', 'NO'].includes(hide)) {
          plan.errors.push(`${excelRow}행: ${BULK_ACTIVE} 은 Y 또는 N 이어야 합니다 (입력값 "${cell.__active}")`);
          continue;
        }
        const wantActive = !(hide === 'Y' || hide === 'YES');
        if (wantActive !== (target.active !== false)) activeTo = wantActive;
      }

      if (!changes.length && activeTo === null) { plan.unchanged++; continue; }
      plan.updates.push({ excelRow, target, changes, activeTo });
    }

    return plan;
  });
}

function bulkRender(plan) {
  const box = $('#bulkReport');
  box.textContent = '';
  box.hidden = false;

  const line = (...kids) => box.append(el('div', {}, ...kids));
  const num = n => el('b', { textContent: String(n) });

  line(`읽은 행 `, num(plan.rowCount), `건 → `,
       num(plan.updates.length), `건 수정, `,
       num(plan.creates.length), `건 추가, `,
       num(plan.unchanged), `건 변경 없음`);

  if (plan.errors.length) {
    const sec = el('div', { className: 'bulk-errors' });
    sec.append(el('div', {}, el('b', { textContent: `문제 ${plan.errors.length}건 — 고친 뒤 다시 올려 주세요` })));
    const ul = el('ul');
    for (const e of plan.errors.slice(0, 20)) ul.append(el('li', { textContent: e }));
    if (plan.errors.length > 20) ul.append(el('li', { textContent: `… 외 ${plan.errors.length - 20}건` }));
    sec.append(ul);
    box.append(sec);
  }

  if (plan.updates.length) {
    const ul = el('ul', { className: 'bulk-diff' });
    for (const u of plan.updates.slice(0, 40)) {
      const li = el('li');
      li.append(el('b', { textContent: val(u.target, 'erp_name') || u.target.id }));
      const parts = u.changes.map(c =>
        `${S.schema.fields[c.key].label}: ${c.before || '(빈칸)'} → ${c.after || '(빈칸)'}`);
      if (u.activeTo !== null) parts.push(u.activeTo ? '숨김 해제' : '숨김');
      li.append(el('div', { className: 'bulk-change', textContent: parts.join('  ·  ') }));
      ul.append(li);
    }
    if (plan.updates.length > 40) {
      ul.append(el('li', { textContent: `… 외 ${plan.updates.length - 40}건` }));
    }
    box.append(ul);
  }

  if (plan.creates.length) {
    const ul = el('ul');
    for (const c of plan.creates.slice(0, 20)) ul.append(el('li', { textContent: '신규: ' + c.name }));
    if (plan.creates.length > 20) ul.append(el('li', { textContent: `… 외 ${plan.creates.length - 20}건` }));
    box.append(ul);
  }

  if (plan.ignored.length) {
    line(el('b', { textContent: '반영하지 않는 열: ' }), plan.ignored.join(', '));
  }

  const ok = !plan.errors.length && (plan.updates.length || plan.creates.length);
  $('#bulkCommit').disabled = !ok;
  return ok;
}

async function bulkApply() {
  const plan = S.pendingBulk;
  if (!plan) return;
  const btn = $('#bulkCommit');
  const msg = $('#bulkMsg');
  btn.disabled = true;
  msg.classList.remove('err');

  const snapshot = S.products.map(p => ({ ...p }));

  try {
    const now = stamp();

    for (const u of plan.updates) {
      for (const c of u.changes) {
        if (c.after === '') delete u.target[c.key];
        else u.target[c.key] = c.value;
      }
      if (u.activeTo !== null) u.target.active = u.activeTo;
      u.target.updated_at = now;
    }

    for (const c of plan.creates) {
      const rec = { id: nextId(S.products), active: true };
      for (const key of S.fieldOrder) {
        const v = c.cell[key];
        if (v !== undefined && v !== '') rec[key] = v;
      }
      rec.images_before = [];
      rec.images_after = [];
      rec.updated_at = now;
      S.products.push(rec);
    }

    const parts = [];
    if (plan.updates.length) parts.push(`${plan.updates.length}건 수정`);
    if (plan.creates.length) parts.push(`${plan.creates.length}건 추가`);

    const res = await commitFiles(
      [{ path: 'data/products.json', text: productsPayload() }],
      `엑셀 일괄수정 (${parts.join(', ')})`,
      t => { msg.textContent = t; }
    );
    toast(res.skipped ? '변경된 내용이 없습니다.' : `반영 완료 — ${parts.join(', ')}`);

    $('#bulkDlg').close();
    bulkReset();
    buildFilterControls();
    apply();
    if (S.selected) renderDetail();

  } catch (err) {
    S.products = snapshot;
    apply();
    msg.textContent = err.message;
    msg.classList.add('err');
    btn.disabled = false;
  }
}

function bulkReset() {
  S.pendingBulk = null;
  $('#bulkFile').value = '';
  $('#bulkReport').hidden = true;
  $('#bulkReport').textContent = '';
  $('#bulkMsg').textContent = '';
  $('#bulkMsg').classList.remove('err');
  $('#bulkCommit').disabled = true;
}

function wireBulk() {
  $('#btnBulk').addEventListener('click', () => {
    bulkReset();
    $('#bulkDlView').textContent = `조회 결과 내려받기 (${S.view.length}건)`;
    $('#bulkDlAll').textContent = `전체 내려받기 (${S.products.length}건)`;
    $('#bulkDlAll').hidden = S.view.length === S.products.length;
    $('#bulkDlg').showModal();
  });

  $('#bulkDlView').addEventListener('click', () => {
    bulkExport(S.view, '조회분');
    toast(`${S.view.length}건을 내려받았습니다.`);
  });
  $('#bulkDlAll').addEventListener('click', () => {
    bulkExport(S.products, '전체');
    toast(`${S.products.length}건을 내려받았습니다.`);
  });

  $('#bulkFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const msg = $('#bulkMsg');
    msg.classList.remove('err');
    msg.textContent = '검사 중…';
    $('#bulkCommit').disabled = true;
    try {
      S.pendingBulk = await bulkParse(file);
      const ok = bulkRender(S.pendingBulk);
      msg.textContent = ok ? '검사 통과 — 반영할 수 있습니다.'
        : (S.pendingBulk.errors.length ? '문제를 고친 뒤 다시 올려 주세요.' : '반영할 변경이 없습니다.');
      if (!ok && S.pendingBulk.errors.length) msg.classList.add('err');
    } catch (err) {
      S.pendingBulk = null;
      $('#bulkReport').hidden = true;
      msg.textContent = err.message;
      msg.classList.add('err');
    }
  });

  $('#bulkCommit').addEventListener('click', bulkApply);
}

/* ------------------------------------------------------------- 이벤트 */

function wire() {
  let qTimer;
  $('#q').addEventListener('input', e => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { S.q = e.target.value; apply(); }, 150);
  });

  $('#showHidden').addEventListener('change', e => { S.showHidden = e.target.checked; apply(); });

  $('#btnReset').addEventListener('click', () => {
    S.q = '';
    $('#q').value = '';
    S.showHidden = false;
    $('#showHidden').checked = false;
    for (const key of S.filterKeys) {
      S.filters[key] = '';
      const sel = $('#f_' + key);
      if (sel) { sel.value = ''; sel.dataset.active = ''; }
    }
    apply();
  });

  $('#btnClose').addEventListener('click', closeDetail);
  $('#btnPresent').addEventListener('click', openPresent);
  $('#btnEdit').addEventListener('click', () => openEdit(current()));
  $('#btnHide').addEventListener('click', toggleHide);
  $('#btnAdd').addEventListener('click', () => openEdit(null));

  $('#editForm').addEventListener('submit', saveEdit);

  $('#btnUpload').addEventListener('click', () => {
    $('#upMsg').textContent = '';
    $('#upDlg').showModal();
  });

  $('#xlsxFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const msg = $('#upMsg');
    msg.classList.remove('err');
    msg.textContent = '엑셀 분석 중…';
    $('#btnUpCommit').disabled = true;
    try {
      S.pendingXlsx = await parseXlsx(file);
      previewXlsx(S.pendingXlsx);
      msg.textContent = '';
    } catch (err) {
      S.pendingXlsx = null;
      $('#upPreview').hidden = true;
      msg.textContent = err.message;
      msg.classList.add('err');
    }
  });

  $('#btnUpCommit').addEventListener('click', commitXlsx);

  // 저장 설정
  $('#btnToken').addEventListener('click', () => {
    $('#tokenInput').value = token();
    $('#tokenMsg').textContent = `${REPO.owner}/${REPO.repo} · ${REPO.branch}`;
    $('#tokenDlg').showModal();
  });
  $('#btnTokenSave').addEventListener('click', () => {
    const v = $('#tokenInput').value.trim();
    if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY);
    refreshTokenDot();
    $('#tokenDlg').close();
    toast(v ? '토큰을 저장했습니다.' : '토큰을 삭제했습니다.');
  });
  $('#btnTokenClear').addEventListener('click', () => {
    localStorage.removeItem(TOKEN_KEY);
    $('#tokenInput').value = '';
    refreshTokenDot();
    toast('토큰을 삭제했습니다.');
  });

  for (const b of document.querySelectorAll('[data-close]')) {
    b.addEventListener('click', () => b.closest('dialog').close());
  }

  // 확대
  $('.lb-close').addEventListener('click', closeLightbox);
  $('#lightbox').addEventListener('click', e => {
    if (e.target.id === 'lightbox') closeLightbox();
  });
  window.addEventListener('resize', () => { if (!$('#lightbox').hidden) fitLightbox(); });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || PR.on) return;   // 발표 중 Esc 는 발표 종료가 맡는다
    if (!$('#lightbox').hidden) { closeLightbox(); return; }
    if (!document.querySelector('dialog[open]') && S.selected) closeDetail();
  });

  wirePresent();
  wireBulk();
}

boot().catch(err => {
  document.body.append(el('p', {
    style: 'padding:24px;color:#c0341d',
    textContent: '데이터를 불러오지 못했습니다: ' + err.message,
  }));
});
