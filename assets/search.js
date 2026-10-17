/* atlas-site search: hand-written, no dependencies.
   Tokenizer mirrors atlas_site/search.py: lowercase; ASCII words; CJK runs
   as overlapping bigrams (a lone CJK character stays a unigram). */
(function () {
  'use strict';
  var ROOT = document.body.getAttribute('data-root') || '';
  var CJK = '\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af';
  var TOKEN = new RegExp('[a-z0-9]+|[' + CJK + ']+', 'g');
  var IS_ASCII = /^[a-z0-9]/;
  var GROUPS = ['组成树', '思想线', '决策记录'];
  var SVG = function (p) { return '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>'; };
  var IC = {
    search: SVG('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>'),
    file: SVG('<path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z"/><path d="M14 3v4h4"/>'),
    idea: SVG('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>'),
    adr: SVG('<path d="M6 4h12v16l-6-3.5L6 20z"/>')
  };

  function tokenize(text) {
    var out = [], m, w, i;
    var s = String(text).toLowerCase();
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(s))) {
      w = m[0];
      if (IS_ASCII.test(w) || w.length === 1) out.push(w);
      else for (i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    }
    return out;
  }
  function uniq(a) { var seen = {}, o = []; a.forEach(function (x) { if (!seen[x]) { seen[x] = 1; o.push(x); } }); return o; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  var LIMIT = 50, TOP = 50;   // results shown; candidates re-ranked by phrase match

  /* ---------------- index ---------------- */
  // Small atlases: one search-index.js. Large ones (shards in the index) keep
  // only doc metadata there; postings and section text come in shards that
  // are injected as <script> on demand, so file:// still works.
  var IDX = null, VOCAB = null, FULL = null, SH = null, loading = null, KEYS = null;
  var pending = {};   // shard file -> [callbacks] while loading; true once loaded
  function script(src, ok, bad) {
    var s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = bad;
    document.head.appendChild(s);
  }
  function load(cb) {
    if (IDX) return cb();
    if (window.ATLAS_SEARCH) { prepare(); return cb(); }
    if (!loading) {
      loading = [];
      script(ROOT + 'search-index.js',
        function () { prepare(); var l = loading; loading = null; l.forEach(function (f) { f(); }); },
        function () { var l = loading; loading = null; l.forEach(function (f) { f(new Error('index')); }); });
    }
    loading.push(cb);
  }
  function fullText(d) { return (d.s.map(function (s) { return s[1] + ' ' + s[2]; }).join(' ')).toLowerCase(); }
  function prepare() {
    IDX = window.ATLAS_SEARCH;
    SH = IDX.shards || null;
    if (SH) { IDX.postings = {}; VOCAB = []; FULL = []; return; }
    VOCAB = Object.keys(IDX.postings).filter(function (k) { return IS_ASCII.test(k); });
    FULL = IDX.docs.map(fullText);
  }
  function fnv(s) {   // FNV-1a over code points; same as search.fnv1a in Python
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      var c = s.codePointAt(i);
      if (c > 0xffff) i++;
      h = Math.imul(h ^ c, 16777619) >>> 0;
    }
    return h;
  }
  function shardOf(tok) { return fnv(IS_ASCII.test(tok) ? tok.slice(0, 2) : tok) % SH.p; }
  function fetchShards(files, onEach, cb) {
    var left = 0, failed = false;
    function done(err) { if (err) failed = true; if (--left === 0) cb(failed ? new Error('shard') : null); }
    files.forEach(function (f) {
      if (pending[f] === true) return;
      left++;
      if (pending[f]) { pending[f].push(done); return; }
      pending[f] = [done];
      script(ROOT + f, function () {
        onEach(f);
        var l = pending[f]; pending[f] = true; l.forEach(function (g) { g(); });
      }, function () {
        var l = pending[f]; delete pending[f]; l.forEach(function (g) { g(true); });
      });
    });
    if (!left) cb(null);
  }
  // make sure postings for these query tokens are present
  function needTokens(toks, cb) {
    if (!SH) return cb(null);
    var ks = {};
    toks.forEach(function (t) {
      if (!IS_ASCII.test(t) && t.length === 1) { for (var k = 0; k < SH.p; k++) ks[k] = 1; }   // lone CJK char: every shard
      else ks[shardOf(t)] = 1;
    });
    fetchShards(Object.keys(ks).map(function (k) { return 'search/p' + k + '.js'; }), function (f) {
      var k = +f.match(/p(\d+)\.js$/)[1], part = window.ATLAS_SEARCH_P[k];
      Object.keys(part).forEach(function (t) { IDX.postings[t] = part[t]; if (IS_ASCII.test(t)) VOCAB.push(t); });
      delete window.ATLAS_SEARCH_P[k];
      KEYS = null;
    }, cb);
  }
  // make sure section text for these docs is present (snippets, phrase bonus, ask-AI fallback)
  function needDocs(ids, cb) {
    if (!SH) return cb(null);
    var ks = {};
    ids.forEach(function (i) { if (!IDX.docs[i].s) ks[Math.floor(i / SH.per)] = 1; });
    fetchShards(Object.keys(ks).map(function (k) { return 'search/d' + k + '.js'; }), function (f) {
      var k = +f.match(/d(\d+)\.js$/)[1], texts = window.ATLAS_SEARCH_D[k];
      texts.forEach(function (secs, j) { var i = k * SH.per + j; IDX.docs[i].s = secs; FULL[i] = fullText(IDX.docs[i]); });
      delete window.ATLAS_SEARCH_D[k];
    }, cb);
  }

  // doc -> weighted term frequency for one query token
  function postingsFor(tok, isLast) {
    var res = {}, p, i, k;
    function add(list, w) { for (i = 0; i < list.length; i += 2) res[list[i]] = (res[list[i]] || 0) + list[i + 1] * w; }
    if (!IS_ASCII.test(tok) && tok.length === 1 && SH) {   // lone CJK character, sharded: every token holding it
      KEYS = KEYS || Object.keys(IDX.postings);
      KEYS.forEach(function (k) { if (k.indexOf(tok) >= 0) add(IDX.postings[k], 1); });
      IDX.docs.forEach(function (d, j) { var n = d.t.toLowerCase().split(tok).length - 1; if (n) res[j] = (res[j] || 0) + n; });
      return res;
    }
    if (!IS_ASCII.test(tok) && tok.length === 1) {   // lone CJK character: scan
      IDX.docs.forEach(function (d, j) {
        var n = (FULL[j] + ' ' + d.t.toLowerCase()).split(tok).length - 1;
        if (n) res[j] = n;
      });
      return res;
    }
    if ((p = IDX.postings[tok])) add(p, 1);
    if (IS_ASCII.test(tok) && tok.length >= 2) {     // prefix: "trans" finds transcript
      for (k = 0; k < VOCAB.length; k++) {
        if (VOCAB[k] !== tok && VOCAB[k].indexOf(tok) === 0) add(IDX.postings[VOCAB[k]], isLast ? 0.6 : 0.3);
      }
    }
    return res;
  }

  function search(q) {
    var segs = uniq(q.toLowerCase().split(/\s+/).filter(Boolean));
    var toks = uniq(tokenize(q));
    if (!toks.length) return { items: [], segs: segs, toks: toks };
    var N = IDX.docs.length, per = toks.map(function (t, i) { return postingsFor(t, i === toks.length - 1); });
    var hits = {}, scores = {};
    per.forEach(function (m) {
      var df = Object.keys(m).length, idf = Math.log(1 + N / Math.max(df, 1));
      Object.keys(m).forEach(function (d) {
        hits[d] = (hits[d] || 0) + 1;
        scores[d] = (scores[d] || 0) + idf * (1 + Math.log(m[d]));
      });
    });
    var need = toks.length, docs = Object.keys(hits).filter(function (d) { return hits[d] === need; });
    var partial = false;
    if (!docs.length && toks.length > 2) {               // nothing has every token: allow most of them
      need = Math.ceil(toks.length * 0.6); partial = true;
      docs = Object.keys(hits).filter(function (d) { return hits[d] >= need; });
    }
    // Stage 1: token score + title bonus for every match.
    var items = docs.map(function (d) {
      var doc = IDX.docs[d], title = doc.t.toLowerCase(), sc = scores[d];
      segs.forEach(function (s) {
        var st = tokenize(s);
        if (!st.length) return;
        if (title.indexOf(s) >= 0) sc += 30;               // title hits rank above body hits
        else st.forEach(function (t) { if (title.indexOf(t) >= 0) sc += 6; });
      });
      if (partial) sc *= 0.5;
      return { i: +d, doc: doc, score: sc, phrase: false };
    });
    items.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    // Stage 2: the best TOP by stage-1 score are re-ranked by whole-phrase
    // matches in the body. Fixed candidate set, so a sharded index (which loads
    // body text for just these) ranks exactly like the single-file one.
    var top = items.slice(0, TOP);
    top.forEach(function (it) {
      var full = FULL[it.i];
      if (full === undefined) return;                      // text shard not loaded yet (run() loads it, then re-ranks)
      var add = 0, mul = 1;
      segs.forEach(function (s) {
        var st = tokenize(s);
        if (!st.length) return;
        var c = full.split(s).length - 1;
        if (c) { it.phrase = true; add += 4 * Math.min(c, 5); }
        else if (st.length > 1) mul *= 0.5;                // tokens present but not next to each other
      });
      it.score = (it.score + add * (partial ? 0.5 : 1)) * mul;
    });
    top.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    items = top.concat(items.slice(TOP));
    return { items: items, segs: segs, toks: toks };
  }

  // Loose search for a whole question: rank by matched tokens, no AND.
  // Used by the ask-AI drawer to pick context ("top hits for the question").
  function searchLoose(q, n) {
    var toks = uniq(tokenize(q));
    if (!toks.length) return [];
    var N = IDX.docs.length, hits = {}, scores = {};
    toks.forEach(function (t) {
      var m = postingsFor(t, false), ds = Object.keys(m), idf = Math.log(1 + N / Math.max(ds.length, 1));
      ds.forEach(function (d) { hits[d] = (hits[d] || 0) + 1; scores[d] = (scores[d] || 0) + idf * (1 + Math.log(m[d])); });
    });
    var need = Math.max(1, Math.ceil(toks.length * 0.3));
    return Object.keys(hits).filter(function (d) { return hits[d] >= need; })
      .map(function (d) {
        var sc = scores[d], title = IDX.docs[d].t.toLowerCase();
        toks.forEach(function (t) { if (title.indexOf(t) >= 0) sc += 3; });
        return { i: +d, score: sc };
      })
      .sort(function (a, b) { return b.score - a.score || a.i - b.i; })
      .slice(0, n).map(function (x) { return x.i; });
  }

  // Async entry points: fetch whatever shards the query needs, then answer.
  // Phrase bonus and snippets need section text, so text shards for the shown
  // results are loaded and ranking re-run until the shown set is all loaded.
  function run(q, cb) {
    needTokens(uniq(tokenize(q)), function (err) {
      if (err) return cb(err);
      var r = search(q);
      var miss = r.items.slice(0, TOP).filter(function (it) { return !it.doc.s; }).map(function (it) { return it.i; });
      if (!miss.length) return cb(null, r);
      needDocs(miss, function (e) { cb(e, e ? null : search(q)); });
    });
  }
  function looseAsync(q, n, cb) {
    needTokens(uniq(tokenize(q)), function (err) { cb(err, err ? [] : searchLoose(q, n)); });
  }

  /* ---------------- highlight and snippet ---------------- */
  function terms(segs, toks, text) {
    var low = text.toLowerCase(), out = [];
    segs.forEach(function (s) {
      if (low.indexOf(s) >= 0) out.push(s);
      else tokenize(s).forEach(function (t) { out.push(t); });
    });
    toks.forEach(function (t) { if (IS_ASCII.test(t)) out.push(t); });
    return uniq(out).filter(function (t) { return t.length; });
  }
  function ranges(text, ts) {
    var low = text.toLowerCase(), r = [];
    ts.forEach(function (t) { var i = 0; while ((i = low.indexOf(t, i)) >= 0) { r.push([i, i + t.length]); i += t.length; } });
    r.sort(function (a, b) { return a[0] - b[0]; });
    var m = [];
    r.forEach(function (x) { if (m.length && x[0] <= m[m.length - 1][1]) m[m.length - 1][1] = Math.max(m[m.length - 1][1], x[1]); else m.push(x); });
    return m;
  }
  function hl(text, ts) {
    var out = '', last = 0;
    ranges(text, ts).forEach(function (x) { out += esc(text.slice(last, x[0])) + '<mark>' + esc(text.slice(x[0], x[1])) + '</mark>'; last = x[1]; });
    return out + esc(text.slice(last));
  }
  function snippet(it, segs, toks) {
    var best = null;
    // prefer the section with a whole-phrase match, then any token
    var probes = segs.concat(toks);
    for (var p = 0; p < probes.length && !best; p++) {
      for (var k = 0; k < (it.doc.s || []).length; k++) {
        var sec = it.doc.s[k], low = sec[2].toLowerCase(), at = low.indexOf(probes[p]);
        if (at >= 0) { best = { sec: sec, at: at }; break; }
        if (sec[1].toLowerCase().indexOf(probes[p]) >= 0) { best = { sec: sec, at: 0 }; break; }
      }
    }
    if (!best) best = { sec: (it.doc.s && it.doc.s[0]) || ['', '', ''], at: 0 };
    var text = best.sec[2], a = Math.max(0, best.at - 24), e = Math.min(text.length, a + 110);
    var cut = (a ? '…' : '') + text.slice(a, e) + (e < text.length ? '…' : '');
    return { html: hl(cut, terms(segs, toks, cut)), id: best.sec[0], heading: best.sec[1] };
  }

  /* ---------------- panel ---------------- */
  var wrap, input, list, foot, items = [], sel = 0, lastFocus = null;
  function build() {
    wrap = document.createElement('div');
    wrap.className = 'pal-wrap'; wrap.hidden = true;
    wrap.innerHTML = '<div class="pal" role="dialog" aria-modal="true" aria-label="搜索文档">' +
      '<div class="pal-in">' + IC.search + '<input type="search" placeholder="搜索全部文档，如 权限表、transcript" autocomplete="off" spellcheck="false" aria-label="搜索" aria-controls="pal-res"><kbd>Esc</kbd></div>' +
      '<div class="pal-res" id="pal-res" role="listbox"></div>' +
      '<div class="pal-ft"><span><kbd>↑</kbd><kbd>↓</kbd>选择</span><span><kbd>↵</kbd>打开</span><span><kbd>Esc</kbd>关闭</span><span class="pal-n" aria-live="polite"></span></div></div>';
    document.body.appendChild(wrap);
    input = wrap.querySelector('input'); list = wrap.querySelector('.pal-res'); foot = wrap.querySelector('.pal-n');
    input.addEventListener('input', render);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { move(1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { move(-1); e.preventDefault(); }
      else if (e.key === 'Enter') { if (items[sel]) { e.preventDefault(); go(items[sel]); } }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    list.addEventListener('mousemove', function (e) {
      var a = e.target.closest('.pal-it');
      if (a && +a.getAttribute('data-i') !== sel) { sel = +a.getAttribute('data-i'); mark(false); }
    });
    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap) close(); });
  }
  function move(d) { if (!items.length) return; sel = (sel + d + items.length) % items.length; mark(true); }
  function mark(scroll) {
    var els = list.querySelectorAll('.pal-it');
    for (var i = 0; i < els.length; i++) {
      var on = i === sel;
      els[i].classList.toggle('on', on);
      els[i].setAttribute('aria-selected', on ? 'true' : 'false');
      if (on && scroll) els[i].scrollIntoView({ block: 'nearest' });
    }
  }
  function go(href) { close(); location.href = href; }
  function empty(title, sub) {
    list.innerHTML = '<div class="pal-empty">' + IC.search + '<b>' + title + '</b><span>' + sub + '</span></div>';
  }
  var gen = 0;
  function render() {
    var q = input.value.trim(), my = ++gen;
    if (!IDX) { items = []; sel = 0; empty('正在载入索引…', ''); return; }
    if (!q) { items = []; sel = 0; empty('输入关键词，搜索全部 ' + IDX.docs.length + ' 篇文档', '中文、英文、代码里的名字都能搜'); foot.textContent = ''; return; }
    run(q, function (err, r) {
      if (my !== gen) return;                              // a newer query is already running
      items = []; sel = 0;
      if (err) { empty('索引分片载入失败', '请确认 search/ 目录和页面一起部署'); foot.textContent = ''; return; }
      show(q, r);
    });
  }
  function show(q, r) {
    if (!r.items.length) { empty('没有找到「' + esc(q) + '」', '换个说法，或少输几个字'); foot.textContent = '0 条结果'; return; }
    var html = '', shown = r.items.slice(0, LIMIT);
    GROUPS.forEach(function (g) {
      var gs = shown.filter(function (it) { return it.doc.g === g; });
      if (!gs.length) return;
      html += '<div class="pal-g" role="presentation">' + g + '<span>' + gs.length + '</span></div>';
      gs.forEach(function (it) {
        var sn = snippet(it, r.segs, r.toks);
        var href = ROOT + it.doc.u + (sn.id ? '#' + encodeURIComponent(sn.id) : '');
        var crumb = it.doc.c + (sn.heading ? ' / ' + sn.heading : '');
        html += '<a class="pal-it" role="option" href="' + esc(href) + '" data-i="' + items.length + '">' +
          (g === '决策记录' ? IC.adr : g === '思想线' ? IC.idea : IC.file) +
          '<div><div class="pal-t"><span>' + hl(it.doc.t, terms(r.segs, r.toks, it.doc.t)) + '</span><span class="pal-c">' + esc(crumb) + '</span></div>' +
          '<div class="pal-s">' + sn.html + '</div></div></a>';
        items.push(href);
      });
    });
    list.innerHTML = html;
    foot.textContent = r.items.length + ' 条结果' + (r.items.length > LIMIT ? '，显示前 ' + LIMIT + ' 条' : '');
    mark(false);
  }
  function open() {
    if (!wrap) build();
    lastFocus = document.activeElement;
    wrap.hidden = false;
    document.documentElement.classList.add('pal-open');
    input.focus(); input.select();
    load(function (err) { if (err) { empty('索引载入失败', '请确认 search-index.js 和页面一起部署'); return; } if (!wrap.hidden) render(); });
    render();
  }
  function close() {
    if (!wrap || wrap.hidden) return;
    wrap.hidden = true;
    document.documentElement.classList.remove('pal-open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  document.querySelectorAll('[data-open-search]').forEach(function (b) { b.addEventListener('click', open); });
  document.addEventListener('keydown', function (e) {
    var t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if ((e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault(); open();
    }
  });
  // exposed for tests and debugging
  window.atlasSearch = {
    tokenize: tokenize, open: open, close: close, load: load,
    index: function () { return IDX; },
    sharded: function () { return !!SH; },
    loose: function (q, n) { return searchLoose(q, n); },          // single-file index only
    looseAsync: looseAsync,                                          // works in both modes
    docs: needDocs,                                                  // load section text for doc ids
    run: function (q, cb) { run(q, function (e, r) { cb(e, r ? r.items.map(function (x) { return x.doc.t; }) : []); }); },
    search: function (q) { return search(q).items.map(function (x) { return x.doc.t; }); }
  };
})();
