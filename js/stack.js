/* stack.js — 对话里的「餐卡左右叠放」
 *  · 当前套居中，卡组撑满屏宽（卡宽 = 屏宽 − 2×22），左右各露出约 16px 相邻套的边缘（略小、略低、略透明），
 *    边缘有很淡的小角标：左「爆款」右「新」；没有任何滑动提示文字。
 *  · 左右滑不是跳过/确认，而是浏览不同套餐：向左滑 → 新品序（rankNew）的下一套，向右滑 → 爆品序（rankHot）的下一套
 *    （与首页同一规则）。叠层跟手、松手超阈值翻页、不足回弹；翻过的套进历史栈，「↩」/Backspace 可反悔。
 *  · 卡底两个按钮：小的购物车加号图标（加购，无字）+ 大的黄色「去结算」（加购并只结算这一套）。 */
(function () {
  'use strict';
  var Mai = (window.Mai = window.Mai || {});
  var CFG = window.MAIMAI_CONFIG, SW = CFG.swipe;
  var $ = Mai.sets;
  var PEEK = 16, SIDE_S = 0.94, SIDE_Y = 12, CARD_W = 346;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function money(n) { return $.money(n); }
  var ICON_UNDO = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';
  var ICON_BULB = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#C98A00" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3Z" fill="#FFE08A"/></svg>';

  /* ── 餐卡 HTML（Figma 07 / 静态稿 07：每行 图+名+营养一行+价格；卡底 共X kcal/合计¥ + 原价划线/省¥X + 一行理由 + 唯一黄按钮）── */
  function rowHTML(r, i, set) {
    var sub = $.rowNutText(r);
    var priceCol = '<div class="ip">¥' + money(r.subtotal) + (r.was > r.subtotal + 0.001 ? '<s>¥' + money(r.was) + '</s>' : '') + '</div>';
    return '<div class="it" data-i="' + i + '" data-code="' + r.code + '">' +
      '<div class="th"><img src="' + esc(r.img) + '" alt="' + esc(r.name) + '" draggable="false" onerror="if(!this.dataset.r){this.dataset.r=1;this.src=\'' + esc(r.imgRemote) + '\'}"></div>' +
      '<div class="itx"><div class="inm"><span>' + esc(r.name) + '</span>' + (r.qty > 1 ? '<em class="qty">×' + r.qty + '</em>' : '') + (r.coupon ? '<em class="cpn">券</em>' : '') + '</div>' +
      '<div class="ism">' + esc(sub) + '</div></div>' + priceCol + '</div>';
  }
  function cardHTML(set) {
    var est = set.est ? '约' : '';
    var save = set.saved > 0.05;
    var ed = set.edited;
    var edLine = ed ? '<div class="edline"><b>' + $.CAT_CN[ed.cat] + '：' + esc(ed.from) + ' → ' + esc(ed.to) + '</b><span>' +
      (ed.delta > 0.001 ? '+¥' + money(ed.delta) : ed.delta < -0.001 ? '省¥' + money(-ed.delta) : '价格不变') +
      (ed.dKcal ? ' · ' + (ed.dKcal > 0 ? '+' : '−') + Math.abs(ed.dKcal) + 'kcal' : '') + '</span></div>' : '';
    return '<div class="mc-in' + (set.rows.length >= 5 ? ' dense' : '') + '">' +
      '<div class="mh"><b class="mt">' + esc(ed ? (/ · 1人$/.test(set.title) ? set.title.replace(/ · 1人$/, ' · 已改单') : set.title) : set.title) + '</b>' + (set.pill ? '<span class="pill ' + set.pill.cls + '">' + esc(set.pill.text) + '</span>' : '') + '</div>' +
      '<div class="its">' + set.rows.map(function (r, i) { return rowHTML(r, i, set); }).join('') + '</div>' +
      '<div class="sm"><div class="sml"><div class="kc">共 ' + est + set.kcal + ' kcal</div><div class="mut">' + (set.pill && set.pill.cls === 'p' ? esc(set.reasonLine) : (set.pill && /^脂肪/.test(set.pill.text) ? '' : '脂肪 ' + est + set.fat + 'g')) + '</div></div>' +
      '<div class="smr"><div class="tot">合计 <b>¥' + money(set.total) + '</b></div>' + (save ? '<div class="sv"><s>¥' + money(set.was) + '</s><i>省 ¥' + money(set.saved) + '</i></div>' : '') + '</div></div>' +
      edLine +
      (set.pill && set.pill.cls === 'p' ? '' : '<div class="rs">' + ICON_BULB + '<span>' + esc(set.reasonLine) + '</span></div>') +
      '<div class="acts"><button class="addbtn" type="button" aria-label="加入购物车"><svg class="ic-add" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h2.6l2 9.6a1.5 1.5 0 0 0 1.5 1.2h7.9a1.5 1.5 0 0 0 1.5-1.1L19.4 8"/><circle cx="9.3" cy="19" r="1.3" fill="currentColor" stroke="none"/><circle cx="16.2" cy="19" r="1.3" fill="currentColor" stroke="none"/><path d="M17 1.8v5M14.5 4.3h5"/></svg><svg class="ic-ok" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></button>' +
        '<button class="gobtn" type="button" aria-label="就这个吧！去结算"><span>就这个吧！</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></button></div>' +
      '</div>';
  }

  /* ── 叠层姿态 ── */
  var SX = PEEK + (CARD_W / 2) * (1 - SIDE_S);
  function pose(role) {
    switch (role) {
      case 'c': return { x: 0, y: 0, r: 0, s: 1, o: 1, z: 3 };
      case 'l': return { x: -SX, y: SIDE_Y, r: 0, s: SIDE_S, o: 0.85, z: 1 };
      case 'r': return { x: SX, y: SIDE_Y, r: 0, s: SIDE_S, o: 0.85, z: 1 };
      case 'hl': return { x: -SX + 8, y: SIDE_Y + 8, r: 0, s: SIDE_S - 0.04, o: 0, z: 0 };
      case 'hr': return { x: SX - 8, y: SIDE_Y + 8, r: 0, s: SIDE_S - 0.04, o: 0, z: 0 };
      case 'ol': return { x: -440, y: 10, r: -8, s: 1, o: 0, z: 4 };
      case 'or': return { x: 440, y: 10, r: 8, s: 1, o: 0, z: 4 };
    }
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mix(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), r: lerp(a.r, b.r, t), s: lerp(a.s, b.s, t), o: lerp(a.o, b.o, t), z: t > 0.5 ? b.z : a.z }; }
  function put(el, p, animate) {
    el.classList.toggle('anim', !!animate);
    el.style.transform = 'translate3d(' + p.x.toFixed(2) + 'px,' + p.y.toFixed(2) + 'px,0) rotate(' + p.r.toFixed(2) + 'deg) scale(' + p.s.toFixed(4) + ')';
    el.style.opacity = p.o; el.style.zIndex = p.z;
  }

  /* opts: {hot:[sets], new:[sets], center:set, onFlip(set), onAdd(set, btn)} —— hot/new 为各自序里“除 center 外”的后续套 */
  function Stack(host, opts) {
    var self = this;
    var lists = { hot: opts.hot.slice(), new: opts.new.slice() }, cur = { hot: 0, new: 0 };
    var history = [], busy = false, drag = null;
    var slots = { l: null, c: null, r: null };
    this.log = []; this.host = host; this.lists = lists;
    host.classList.add('stack');
    host.innerHTML = '<i class="etag l" aria-hidden="true">爆款</i><i class="etag r" aria-hidden="true">新</i><button class="sundo" type="button" aria-label="回到上一套" hidden>' + ICON_UNDO + '</button>';
    var tagL = host.querySelector('.etag.l'), tagR = host.querySelector('.etag.r'), undoBtn = host.querySelector('.sundo');

    function railOfSlot(k) { return k === 'l' ? 'hot' : 'new'; }
    function peek(rail) { return lists[rail][cur[rail]] || null; }
    function mount(set, role, startRole) {
      var el = document.createElement('article');
      el.className = 'mc'; el._set = set; el.innerHTML = cardHTML(set);
      host.appendChild(el);
      put(el, pose(startRole || role), false);
      return el;
    }
    function natural(el) { el.style.height = ''; return el.offsetHeight; }
    function fit(animate) {
      var h = natural(slots.c);
      host.style.height = h + 'px';
      ['l', 'r'].forEach(function (k) { if (slots[k]) slots[k].style.height = h + 'px'; });
      return h;
    }
    function chrome() {
      tagL.classList.toggle('on', !!slots.l); tagR.classList.toggle('on', !!slots.r);
      undoBtn.hidden = history.length === 0;
      host.classList.toggle('has-undo', history.length > 0);
    }
    function settle(animate) {
      put(slots.c, pose('c'), animate);
      if (slots.l) put(slots.l, pose('l'), animate);
      if (slots.r) put(slots.r, pose('r'), animate);
    }

    slots.c = mount(opts.center, 'c');
    slots.l = peek('hot') ? mount(peek('hot'), 'l') : null;
    slots.r = peek('new') ? mount(peek('new'), 'r') : null;
    fit(false); chrome();
    this.center = function () { return slots.c._set; };
    this.heads = function () { return { left: slots.l && slots.l._set, center: slots.c._set, right: slots.r && slots.r._set }; };
    this.path = function () { return history.map(function (h) { return h.from.id; }).concat(slots.c._set.id); };
    this.canUndo = function () { return history.length > 0; };

    /* 重新渲染某一套（改单后）。highlight：被替换行高亮 2s + 价差 */
    this.refresh = function (set, hl) {
      [slots.c, slots.l, slots.r].forEach(function (el) { if (el && el._set === set) el.innerHTML = cardHTML(set); });
      if (slots.c._set === set) {
        fit(true);
        if (hl) {
          var row = slots.c.querySelector('.it[data-i="' + hl.row + '"]');
          if (row) {
            row.classList.add('hl');
            var d = document.createElement('div'); d.className = 'dtag ' + (hl.delta > 0.001 ? 'up' : hl.delta < -0.001 ? 'down' : 'eq');
            d.textContent = hl.delta > 0.001 ? '+¥' + money(hl.delta) : hl.delta < -0.001 ? '省¥' + money(-hl.delta) : '价格不变';
            row.querySelector('.ip').appendChild(d);
            setTimeout(function () { row.classList.remove('hl'); if (d.parentNode) d.parentNode.removeChild(d); }, 2000);
          }
        }
      }
    };

    this.go = function (dir) {                // dir 'left' = 新品序，'right' = 爆品序
      if (busy) return false;
      var k = dir === 'left' ? 'r' : 'l', rail = railOfSlot(k), incoming = slots[k], out = slots.c;
      if (!incoming) { settle(true); var a = pose('c'); a.x = dir === 'left' ? -12 : 12; put(out, a, true); setTimeout(function () { put(out, pose('c'), true); }, 120); Mai.ui.toast(dir === 'left' ? '新品都逛完啦' : '爆品都逛完啦'); return false; }
      busy = true;
      history.push({ dir: dir, from: out._set });
      cur[rail]++;
      self.log.push({ dir: dir, id: incoming._set.id, rail: rail });
      put(out, pose(dir === 'left' ? 'ol' : 'or'), true);
      put(incoming, pose('c'), true);
      slots.c = incoming;
      var nxt = peek(rail);
      slots[k] = nxt ? mount(nxt, k, 'h' + k) : null;
      var h = natural(slots.c); host.style.height = h + 'px';
      if (slots[k]) { slots[k].style.height = h + 'px'; requestAnimationFrame(function () { requestAnimationFrame(function () { put(slots[k], pose(k), true); }); }); }
      var other = k === 'l' ? 'r' : 'l'; if (slots[other]) slots[other].style.height = h + 'px';
      setTimeout(function () { out.remove(); busy = false; }, 420);
      chrome();
      if (opts.onFlip) opts.onFlip(slots.c._set, dir);
      return true;
    };
    this.undo = function () {
      if (busy || !history.length) return false;
      busy = true;
      var h = history.pop(), dir = h.dir, k = dir === 'left' ? 'r' : 'l', rail = railOfSlot(k);
      cur[rail]--;
      var curEl = slots.c, gone = slots[k];
      self.log.push({ dir: 'undo', id: h.from.id, rail: rail });
      var back = mount(h.from, 'c', dir === 'left' ? 'ol' : 'or');
      var hh = natural(back);
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        put(back, pose('c'), true); put(curEl, pose(k), true);
        if (gone) put(gone, pose('h' + k), true);
        host.style.height = hh + 'px'; curEl.style.height = hh + 'px';
      }); });
      slots.c = back; slots[k] = curEl;
      setTimeout(function () { if (gone) gone.remove(); busy = false; }, 430);
      chrome();
      if (opts.onFlip) opts.onFlip(slots.c._set, 'undo');
      return true;
    };
    undoBtn.addEventListener('click', function (e) { e.stopPropagation(); self.undo(); });

    /* ── 手势：水平拖动翻页；竖向拖动让给对话区滚动 ── */
    host.addEventListener('pointerdown', function (e) {
      if (busy || e.button > 0) return;
      if (e.target.closest('.addbtn') || e.target.closest('.gobtn') || e.target.closest('.sundo')) return;
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, samples: [[performance.now(), e.clientX]], on: false, dx: 0 };
    });
    host.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var k = Mai.ui.scale(), dx = (e.clientX - drag.x0) / k, dy = (e.clientY - drag.y0) / k;
      if (!drag.on) {
        if (Math.abs(dy) > SW.dragStart && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }   // 竖向：交给滚动
        if (Math.abs(dx) < SW.dragStart) return;
        drag.on = true; try { host.setPointerCapture(e.pointerId); } catch (_) {}
        host.classList.add('dragging');
      }
      drag.samples.push([performance.now(), e.clientX]); if (drag.samples.length > 6) drag.samples.shift();
      drag.dx = dx;
      var dirK = dx < 0 ? 'r' : 'l', hasNext = !!slots[dirK];
      var ex = hasNext ? dx : dx * 0.35, rot = Math.max(-8, Math.min(8, ex / 24));
      put(slots.c, { x: ex, y: Math.abs(ex) * 0.02, r: rot, s: 1, o: 1, z: 3 }, false);
      var p = hasNext ? Math.min(1, Math.abs(dx) / 200) : 0;
      ['l', 'r'].forEach(function (kk) { if (slots[kk]) put(slots[kk], kk === dirK ? mix(pose(kk), pose('c'), p * 0.92) : pose(kk), false); });
      slots.c.style.setProperty('--lift', Math.min(1, Math.abs(ex) / 120));
    });
    function end(e, cancelled) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      var d = drag; drag = null; host.classList.remove('dragging');
      try { host.releasePointerCapture(d.id); } catch (_) {}
      slots.c.style.removeProperty('--lift');
      if (!d.on) return;
      var s = d.samples, vel = 0;
      if (s.length > 1) { var a = s[0], b = s[s.length - 1]; vel = (b[1] - a[1]) / Math.max(1, b[0] - a[0]) / Mai.ui.scale(); }
      var dx = d.dx, dir = dx < 0 ? 'left' : 'right';
      var commit = !cancelled && (Math.abs(dx) >= SW.commitDistance || (Math.abs(vel) >= SW.commitVelocity && Math.abs(dx) > 30 && (vel < 0) === (dx < 0)));
      if (commit) self.go(dir); else settle(true);
    }
    host.addEventListener('pointerup', function (e) { end(e, false); });
    host.addEventListener('pointercancel', function (e) { end(e, true); });
    host.addEventListener('lostpointercapture', function (e) { if (e.target === host && drag && drag.on) end(e, true); });

    host.addEventListener('click', function (e) {
      var go = e.target.closest('.gobtn'), btn = go || e.target.closest('.addbtn'); if (!btn) return;
      var el = btn.closest('.mc'); if (!el || el !== slots.c) return;
      if (go) { if (opts.onGo) opts.onGo(el._set, btn); }
      else if (opts.onAdd) opts.onAdd(el._set, btn);
    });
  }

  Mai.Stack = Stack;
  Mai.cardHTML = cardHTML;
})();
