/* atlas-site ask-AI drawer: no API key. The question and the checked
   documents (.md copies of the pages) are joined into one prompt and handed
   to an outside AI through a prefilled link, or the clipboard when the link
   would be too long. Needs search.js (index + loose search). Vanilla JS. */
(function () {
  'use strict';
  var body = document.body;
  var ROOT = body.getAttribute('data-root') || '';
  var PAGE = body.getAttribute('data-page') || '';
  var SITE_URL = body.getAttribute('data-site-url') || '';
  var MAX_URL = 7000;
  var TARGETS = {
    chatgpt: { name: 'ChatGPT', prefill: 'https://chatgpt.com/?q=', home: 'https://chatgpt.com/' },
    claude: { name: 'Claude', prefill: 'https://claude.ai/new?q=', home: 'https://claude.ai/new' },
    deepseek: { name: 'DeepSeek', prefill: null, home: 'https://chat.deepseek.com/' }
  };
  var SVG = function (p) { return '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>'; };
  var IC = {
    spark: SVG('<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>'),
    x: SVG('<path d="M6 6l12 12M18 6 6 18"/>'),
    copy: SVG('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
    ext: SVG('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
    check: SVG('<path d="M5 12.5 10 17 19 7"/>')
  };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // Where links in the prompt point: --site-url, else this site's own URL
  // when served over http(s), else paths relative to the site root.
  function base() {
    if (SITE_URL) return SITE_URL;
    if (/^https?:$/.test(location.protocol)) return new URL(ROOT || './', location.href).href;
    return '';
  }

  /* ---------------- state ---------------- */
  var IDX = null, cur = -1, hits = [], override = {}, texts = {}, question = '';
  var wrap, ta, list, sizeEl, fitEl, toast, timer;

  function items() {
    // [doc index, reason, checked by default]
    var L = [], seen = {};
    function add(i, why, on) { if (i >= 0 && !seen[i]) { seen[i] = 1; L.push([i, why, on]); } }
    add(cur, '本页', true);
    hits.filter(function (i) { return i !== cur; }).slice(0, 3).forEach(function (i) { add(i, '搜索命中', true); });
    if (cur >= 0) {
      var d = IDX.docs[cur];
      add(d.p, '上一层', false);
      d.k.forEach(function (i) { add(i, '下一层', false); });
    }
    return L;
  }
  function checked() {
    return items().filter(function (x) { return x[0] in override ? override[x[0]] : x[2]; }).map(function (x) { return x[0]; });
  }

  /* ---------------- documents ---------------- */
  function stripFront(t) { return t.replace(/^---\n[\s\S]*?\n---\n/, ''); }
  function fallbackText(d) {   // file:// cannot fetch: rebuild from the search index text
    return '# ' + d.t + '\n\n' + d.s.map(function (s) { return (s[1] ? '## ' + s[1] + '\n' : '') + s[2]; }).join('\n\n');
  }
  function fetchDoc(i) {
    if (i in texts) return Promise.resolve(texts[i]);
    var d = IDX.docs[i];
    if (location.protocol === 'file:' || !window.fetch) { texts[i] = fallbackText(d); return Promise.resolve(texts[i]); }
    return fetch(ROOT + d.m).then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function (t) { texts[i] = stripFront(t).trim(); }, function () { texts[i] = fallbackText(d); })
      .then(function () { return texts[i]; });
  }
  function prefetch() { return Promise.all(items().map(function (x) { return fetchDoc(x[0]); })); }

  /* ---------------- prompt ---------------- */
  function prompt() {
    var b = base(), name = IDX.name || 'atlas';
    var q = question.trim() || '（在这里写你的问题）';
    var head = q + '\n\n请只根据下面这些 ' + name + ' 文档回答；不确定时说明还需要读哪一篇。全部文档的分层索引：' + b + 'llms.txt\n';
    return head + checked().map(function (i) {
      var d = IDX.docs[i];
      var t = i in texts ? texts[i] : fallbackText(d);
      return '\n---\n来源：' + b + d.m + '\n\n' + t + '\n';
    }).join('');
  }
  function tokens(s) {   // rough: one token per CJK character, four characters otherwise
    var cjk = (s.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/g) || []).length;
    return Math.round(cjk + (s.length - cjk) / 4);
  }
  function linkFor(k, p) { var t = TARGETS[k]; return t.prefill ? t.prefill + encodeURIComponent(p) : null; }

  /* ---------------- drawer ---------------- */
  function build() {
    wrap = document.createElement('div');
    wrap.className = 'ask-wrap'; wrap.hidden = true;
    wrap.innerHTML = '<aside class="ask-dr" role="dialog" aria-modal="true" aria-label="问 AI">' +
      '<div class="ask-hd">' + IC.spark + '<b>问 AI</b><span class="sp"></span><button class="tb" type="button" data-x aria-label="关闭">' + IC.x + '</button></div>' +
      '<div class="ask-bd"><textarea rows="4" placeholder="想问这些文档什么？例如：后台任务和前台写操作冲突时怎么办" aria-label="你的问题"></textarea>' +
      '<div class="ask-sec">上下文<span class="ask-sz"></span></div><div class="ask-ctx"></div>' +
      '<p class="ask-fit"></p>' +
      '<p class="ask-tip">不需要 API key：问题和勾选的文档会拼成一段提示词，带到你选的 AI 里。默认只勾本页和搜索命中，上一层、下一层按需勾选。</p></div>' +
      '<div class="ask-ft"><div class="ask-go">' +
      '<button class="tbtn pri" type="button" data-go="chatgpt">' + IC.ext + '在 ChatGPT 打开</button>' +
      '<button class="tbtn" type="button" data-go="claude">' + IC.ext + '在 Claude 打开</button>' +
      '<button class="tbtn" type="button" data-go="deepseek">' + IC.ext + '在 DeepSeek 打开</button></div>' +
      '<button class="tbtn ghost" type="button" data-go="copy">' + IC.copy + '复制提示词</button></div></aside>';
    body.appendChild(wrap);
    toast = document.createElement('div');
    toast.className = 'toast'; toast.setAttribute('role', 'status');
    body.appendChild(toast);
    ta = wrap.querySelector('textarea'); list = wrap.querySelector('.ask-ctx');
    sizeEl = wrap.querySelector('.ask-sz'); fitEl = wrap.querySelector('.ask-fit');
    ta.addEventListener('input', function () {
      question = ta.value;
      clearTimeout(timer);
      timer = setTimeout(function () {
        hits = IDX ? window.atlasSearch.loose(question, 4) : [];
        draw(); prefetch().then(totals);
      }, 150);
      totals();
    });
    list.addEventListener('change', function (e) {
      var i = +e.target.getAttribute('data-i');
      override[i] = e.target.checked;
      totals();
    });
    wrap.querySelector('[data-x]').addEventListener('click', close);
    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) close(); });
    wrap.querySelector('.ask-ft').addEventListener('click', function (e) {
      var b = e.target.closest('[data-go]');
      if (b) go(b.getAttribute('data-go'));
    });
  }
  function draw() {
    if (!IDX) { list.innerHTML = '<p class="ask-tip">正在载入索引…</p>'; return; }
    var L = items();
    list.innerHTML = L.length ? L.map(function (x) {
      var d = IDX.docs[x[0]], on = x[0] in override ? override[x[0]] : x[2];
      return '<label class="ask-it"><input type="checkbox" data-i="' + x[0] + '"' + (on ? ' checked' : '') + '><span class="cb">' + IC.check + '</span>' +
        '<div><b>' + esc(d.t) + '</b><span>' + x[1] + ' · ' + (d.n / 1000).toFixed(1) + 'k 字</span></div></label>';
    }).join('') : '<p class="ask-tip">写下问题后，这里会列出最相关的几篇。</p>';
    totals();
  }
  function totals() {
    if (!IDX || !sizeEl) return;
    var p = prompt(), url = linkFor('chatgpt', p);
    sizeEl.textContent = p.length.toLocaleString() + ' 字 · 约 ' + tokens(p).toLocaleString() + ' tokens';
    fitEl.textContent = url.length <= MAX_URL
      ? '预填链接 ' + url.length.toLocaleString() + ' 字符，可以直接带进 ChatGPT / Claude。'
      : '预填链接 ' + url.length.toLocaleString() + ' 字符，超过 ' + MAX_URL.toLocaleString() + '：会先复制到剪贴板，再打开网站，粘贴即可。';
    fitEl.classList.toggle('over', url.length > MAX_URL);
  }
  function say(t) {
    toast.innerHTML = IC.check + '<span>' + esc(t) + '</span>';
    toast.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toast.classList.remove('on'); }, 2600);
  }
  function copy(t) {
    function legacy() {
      var x = document.createElement('textarea');
      x.value = t; x.setAttribute('readonly', ''); x.style.position = 'fixed'; x.style.opacity = '0';
      body.appendChild(x); x.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      x.remove(); return ok;
    }
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(t).then(function () { return true; }, legacy);
    }
    return Promise.resolve(legacy());
  }
  function go(kind) {
    // Documents are prefetched when the list changes, so this normally resolves
    // at once and window.open still runs within the click's user activation.
    prefetch().then(function () {
      var p = prompt();
      if (kind === 'copy') { copy(p).then(function (ok) { say(ok ? '已复制提示词' : '复制失败，请手动选择'); }); return; }
      var t = TARGETS[kind], url = linkFor(kind, p);
      if (url && url.length <= MAX_URL) { window.open(url, '_blank', 'noopener'); return; }
      copy(p).then(function (ok) { say(ok ? '已复制，粘贴即可' : '复制失败，请用「复制提示词」'); });
      window.open(t.home, '_blank', 'noopener');
    });
  }
  function open() {
    if (!wrap) build();
    wrap.hidden = false;
    document.documentElement.classList.add('pal-open');
    ta.focus();
    draw();
    window.atlasSearch.load(function (err) {
      if (err) { list.innerHTML = '<p class="ask-tip">索引载入失败：请确认 search-index.js 和页面一起部署。</p>'; return; }
      IDX = window.atlasSearch.index();
      cur = -1;
      IDX.docs.forEach(function (d, i) { if (d.u === PAGE) cur = i; });
      if (question) hits = window.atlasSearch.loose(question, 4);
      draw(); prefetch().then(totals);
    });
  }
  function close() {
    if (!wrap || wrap.hidden) return;
    wrap.hidden = true;
    document.documentElement.classList.remove('pal-open');
  }

  document.querySelectorAll('[data-ask]').forEach(function (b) { b.addEventListener('click', open); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && wrap && !wrap.hidden) close(); });
  window.atlasAsk = {
    open: open, close: close,
    prompt: function () { return prompt(); },
    link: function (k) { return linkFor(k, prompt()); },
    ready: function () { return prefetch(); }
  };
})();
