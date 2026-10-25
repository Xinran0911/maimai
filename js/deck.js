/* deck.js — 三张重叠「抽卡」：拖动跟手、过阈值翻页、不到阈值回弹，支持鼠标 + 触摸（Pointer Events）
 *
 * 语义（不是“跳过/要”）：左滑 = 新品序（rankNew），右滑 = 爆品序（rankHot）。
 *   两侧露出的卡 = 向该方向滑一下会翻出来的下一张；同一道菜不重复（createDeck 已去重、左右序互斥）。
 *   翻过的卡进“历史栈”，可以用「回到上一张」反悔（不会丢，也不会因此重复出现）。
 * 起手居中卡 = 爆品序第 1 张（与 Figma 01 中间卡一致：龙焰鸡腿堡三件套），两侧分别是新品序第 1 张 / 爆品序第 2 张。 */
(function () {
  'use strict';
  var Mai = (window.Mai = window.Mai || {});
  var CFG = window.MAIMAI_CONFIG, L = CFG.deckLayout, SW = CFG.swipe;

  var ICON_TICKET = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M3 8a2 2 0 0 0 0 4v0a2 2 0 0 0 0 4v1a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-1a2 2 0 0 1 0-4 2 2 0 0 1 0-4V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1Z"/><path d="M14 6v12" stroke-dasharray="2 2.4"/></svg>';
  var ICON_TAG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M3 12V4h8l10 10-8 8L3 12Z"/><circle cx="7.5" cy="8.5" r="1.4" fill="currentColor" stroke="none"/></svg>';

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ── 叠层姿态（role → transform）──────────────────────────── */
  var HALF = 131; // 卡宽 262 的一半
  function pose(role) {
    var sx = HALF * (1 - L.sideScale) + L.peek; // 侧卡中心相对居中卡的水平位移
    switch (role) {
      case 'c': return { x: 0, y: 0, r: 0, s: 1, o: 1, z: 3 };
      case 'l': return { x: -sx, y: L.sideDrop, r: -L.sideRotate, s: L.sideScale, o: 1, z: 1 };
      case 'r': return { x: sx, y: L.sideDrop, r: L.sideRotate, s: L.sideScale, o: 1, z: 1 };
      case 'hl': return { x: -sx + 10, y: L.sideDrop + 12, r: -L.sideRotate, s: L.sideScale - 0.06, o: 0, z: 0 }; // 侧卡后面待出场
      case 'hr': return { x: sx - 10, y: L.sideDrop + 12, r: L.sideRotate, s: L.sideScale - 0.06, o: 0, z: 0 };
      case 'ol': return { x: -460, y: 24, r: -16, s: 1, o: 0, z: 4 };   // 向左飞出
      case 'or': return { x: 460, y: 24, r: 16, s: 1, o: 0, z: 4 };
    }
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function mix(a, b, t) { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), r: lerp(a.r, b.r, t), s: lerp(a.s, b.s, t), o: lerp(a.o, b.o, t), z: t > 0.5 ? b.z : a.z }; }
  function put(el, p, animate) {
    el.classList.toggle('anim', !!animate);
    el.style.transform = 'translate3d(' + p.x.toFixed(2) + 'px,' + p.y.toFixed(2) + 'px,0) rotate(' + p.r.toFixed(2) + 'deg) scale(' + p.s.toFixed(4) + ')';
    el.style.opacity = p.o;
    el.style.zIndex = p.z;
  }

  /* ── 卡片 DOM ───────────────────────────────────────────── */
  function cardEl(c) {
    var el = document.createElement('article');
    el.className = 'card';
    el.dataset.code = c.code;
    el._card = c;
    var tail = c.deal
      ? '<div class="cpl ' + c.deal.type + '">' + (c.deal.type === 'coupon' ? ICON_TICKET : ICON_TAG) + '<span>' + esc(c.deal.text) + '</span></div>'
      : '<div class="chips">' + c.taste.map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('') + '</div>';
    el.innerHTML =
      '<div class="ph">' +
        '<img src="' + esc(c.img) + '" alt="' + esc(c.name) + '" draggable="false" onerror="if(!this.dataset.r){this.dataset.r=1;this.src=\'' + esc(c.imgRemote) + '\'}">' +
        '<div class="rail ' + c.rail + '" title="' + (c.rail === 'new' ? '新品' : '爆品') + '">' + (c.rail === 'new' ? '新' : '爆款') + '</div>' +
        (c.chip ? '<div class="cp">' + esc(c.chip) + '</div>' : '') +
      '</div>' +
      '<div class="bd"><div class="nm">' + esc(c.name) + '</div><div class="sub">' + esc(c.sub) + '</div>' + tail + '</div>' +
      '<div class="pr"><div class="pp"><span class="now">' + esc(c.priceLabel) + '<b>' + esc(c.priceText) + '</b></span>' + (c.was ? '<span class="was">' + esc(c.was) + '</span>' : '') + '</div>' +
      '<button class="add" type="button" aria-label="加入购物车：' + esc(c.name) + '"><svg class="ic-add" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h2.6l2 9.6a1.5 1.5 0 0 0 1.5 1.2h7.9a1.5 1.5 0 0 0 1.5-1.1L19.4 8"/><circle cx="9.3" cy="19" r="1.3" fill="currentColor" stroke="none"/><circle cx="16.2" cy="19" r="1.3" fill="currentColor" stroke="none"/><path d="M17 1.8v5M14.5 4.3h5"/></svg><svg class="ic-ok" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></button></div>';
    return el;
  }

  /* ── 控制器 ─────────────────────────────────────────────── */
  function Deck(root, built) {
    var self = this, ui = Mai.ui;
    var seq = { left: built.seq.left.slice(), right: built.seq.right.slice() }, cur = { left: 0, right: 0 };
    var history = [];           // [{dir, from: card}]
    var slots = { l: null, c: null, r: null };
    var busy = false;
    var dotsEl = document.getElementById('dots'), undoBtn = document.getElementById('undoBtn');
    var seenCodes = {};         // 仅用于自检：整个会话里每道菜只会出现一次（撤销不算）
    this.log = [];              // 翻页日志，测试用：[{dir, code, name, rail}]

    function peek(dir) { return seq[dir][cur[dir]] || null; }
    function roleKey(dir) { return dir === 'left' ? 'l' : 'r'; }

    function mount(c, role, hidden) {
      var el = cardEl(c);
      root.appendChild(el);
      put(el, pose(hidden || role), false);
      return el;
    }

    /* 初始化：居中 = 爆品序第 1 张；左侧 = 新品序第 1 张；右侧 = 爆品序第 2 张 */
    // 起手居中卡：'first' = 爆品序第 1 张；'firstDeal'（默认）= 爆品序里第一张带券/特价的（首屏就能看到优惠信息，和 Figma 01 中间卡有券一致）。
    // 选出的卡从爆品序里摘出，其余保持原序、不重复。
    var pickAt = 0;
    if (CFG.deckLayout.startCenter !== 'first') {
      for (var i = 0; i < seq.right.length && i < 4; i++) if (seq.right[i].deal) { pickAt = i; break; }
    }
    var first = seq.right.splice(pickAt, 1)[0];
    slots.c = mount(first, 'c');
    slots.l = peek('left') ? mount(peek('left'), 'l') : null;
    slots.r = peek('right') ? mount(peek('right'), 'r') : null;
    this.center = function () { return slots.c._card; };
    seenCodes[first.code] = 1;
    updateChrome();

    function updateChrome() {
      var n = history.length;
      Array.prototype.forEach.call(dotsEl.children, function (d, i) { d.classList.toggle('on', i === n % dotsEl.children.length); });
      undoBtn.disabled = n === 0;
      undoBtn.classList.toggle('show', n > 0);
    }
    function settle(animate) {
      put(slots.c, pose('c'), animate);
      if (slots.l) put(slots.l, pose('l'), animate);
      if (slots.r) put(slots.r, pose('r'), animate);
    }
    function finish(el, ms) { setTimeout(function () { el.remove(); busy = false; }, ms || 420); }

    /* 翻页：dir = 'left' | 'right'。fromDrag：已经被手指带到某个位置，只需继续飞出 */
    this.go = function (dir) {
      if (busy) return false;
      var k = roleKey(dir), incoming = slots[k], out = slots.c;
      if (!incoming) { settle(true); bounce(out, dir); ui.toast(dir === 'left' ? '新品都逛完啦' : '爆品都逛完啦'); return false; }
      busy = true;
      var card = incoming._card;
      history.push({ dir: dir, from: out._card });
      cur[dir]++;
      seenCodes[card.code] = (seenCodes[card.code] || 0) + 1;
      self.log.push({ dir: dir, code: card.code, name: card.name, rail: card.rail });
      put(out, pose(dir === 'left' ? 'ol' : 'or'), true);
      put(incoming, pose('c'), true);
      slots.c = incoming;
      // 补上这一侧新的露头卡（从侧卡后面淡入）
      var nxt = peek(dir);
      slots[k] = nxt ? mount(nxt, k, 'h' + k) : null;
      if (slots[k]) requestAnimationFrame(function () { requestAnimationFrame(function () { put(slots[k], pose(k), true); }); });
      finish(out);
      updateChrome();
      return true;
    };

    /* 反悔：回到上一张（把当前卡放回它来时那一侧的“下一张”位置） */
    this.undo = function () {
      if (busy || !history.length) return false;
      busy = true;
      var h = history.pop(), dir = h.dir, k = roleKey(dir);
      cur[dir]--;
      var curEl = slots.c, gone = slots[k];
      self.log.push({ dir: 'undo', code: h.from.code, name: h.from.name, rail: h.from.rail });
      var back = mount(h.from, 'c', dir === 'left' ? 'ol' : 'or');
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        put(back, pose('c'), true);
        put(curEl, pose(k), true);
        if (gone) put(gone, pose('h' + k), true);
      }); });
      slots.c = back; slots[k] = curEl;
      if (gone) finish(gone); else setTimeout(function () { busy = false; }, 420);
      updateChrome();
      return true;
    };

    function bounce(el, dir) {
      var a = pose('c'); a.x = dir === 'left' ? -14 : 14;
      put(el, a, true);
      setTimeout(function () { put(el, pose('c'), true); }, 120);
    }

    /* ── 手势 ── */
    var drag = null;
    root.addEventListener('pointerdown', function (e) {
      if (busy || e.button > 0) return;
      if (e.target.closest('.add')) return;                 // 加购按钮：不触发拖动
      if (!e.target.closest('.card') && !e.target.closest('.deck')) return;
      drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t: performance.now(), samples: [[performance.now(), e.clientX]], on: false, dx: 0 };
    });
    root.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var k = ui.scale();
      var dx = (e.clientX - drag.x0) / k, dy = (e.clientY - drag.y0) / k;
      if (!drag.on) {
        if (Math.abs(dx) < SW.dragStart && Math.abs(dy) < SW.dragStart) return;
        drag.on = true;
        try { root.setPointerCapture(e.pointerId); } catch (_) {}
        root.classList.add('dragging');
      }
      var now = performance.now();
      drag.samples.push([now, e.clientX]); if (drag.samples.length > 6) drag.samples.shift();
      drag.dx = dx;
      var dirKey = dx < 0 ? 'l' : 'r';
      var hasNext = !!slots[dirKey];
      var ex = hasNext ? dx : dx * 0.35;                    // 没有下一张时加阻尼
      var rot = Math.max(-14, Math.min(14, ex / 14));
      var c = { x: ex, y: Math.max(-30, Math.min(30, dy * 0.3)) + Math.abs(ex) * 0.02, r: rot, s: 1, o: 1, z: 3 };
      put(slots.c, c, false);
      var p = hasNext ? Math.min(1, Math.abs(dx) / 200) : 0;
      ['l', 'r'].forEach(function (kk) {
        if (!slots[kk]) return;
        put(slots[kk], kk === dirKey ? mix(pose(kk), pose('c'), p * 0.92) : pose(kk), false);
      });
      // 侧卡渐渐前移时，居中卡阴影随位移变深
      slots.c.style.setProperty('--lift', Math.min(1, Math.abs(ex) / 120));
    });
    function end(e, cancelled) {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      var d = drag; drag = null;
      root.classList.remove('dragging');
      try { root.releasePointerCapture(d.id); } catch (_) {}
      slots.c && slots.c.style.removeProperty('--lift');
      if (!d.on) return;                                    // 只是点击
      var s = d.samples, vel = 0;
      if (s.length > 1) { var a = s[0], b = s[s.length - 1]; vel = (b[1] - a[1]) / Math.max(1, b[0] - a[0]) / ui.scale(); }
      var dx = d.dx, dir = dx < 0 ? 'left' : 'right';
      var commit = !cancelled && (Math.abs(dx) >= SW.commitDistance || (Math.abs(vel) >= SW.commitVelocity && Math.abs(dx) > 30 && (vel < 0) === (dx < 0)));
      if (commit) { if (!self.go(dir)) { /* 没有下一张：已回弹 */ } }
      else settle(true);                                    // 不到阈值：回弹
    }
    root.addEventListener('pointerup', function (e) { end(e, false); });
    root.addEventListener('pointercancel', function (e) { end(e, true); });
    root.addEventListener('lostpointercapture', function (e) { if (e.target === root && drag && drag.on) end(e, true); }); // 触摸有隐式捕获，只处理 root 自己丢失捕获

    /* 加购（事件委托，只对当前居中卡生效） */
    root.addEventListener('click', function (e) {
      var btn = e.target.closest('.add'); if (!btn) return;
      var el = btn.closest('.card'); if (!el || el !== slots.c) return;
      var c = el._card;
      var n = ui.addToCart(c);
      ui.flyToCart(btn);
      btn.classList.add('done');
      setTimeout(function () { btn.classList.remove('done'); }, 1100);
      ui.toast('已加入购物车 · <b>' + esc(c.name) + '</b>', 1400);
    });
    undoBtn.addEventListener('click', function () { self.undo(); });
    document.addEventListener('keydown', function (e) {   // 桌面预览
      if (document.body.classList.contains('in-chat') || document.body.classList.contains('in-page')) return;   // 对话页有自己的键盘处理：← → 方向键、Backspace 反悔
      if (e.key === 'ArrowLeft') self.go('left');
      else if (e.key === 'ArrowRight') self.go('right');
      else if (e.key === 'Backspace') self.undo();
    });

    this.path = function () { return history.map(function (h) { return h.from.code; }).concat(slots.c._card.code); }; // 当前浏览路径（历史+居中卡），测试用
    this.seen = seenCodes;
    this.heads = function () { return { left: slots.l && slots.l._card, center: slots.c._card, right: slots.r && slots.r._card }; };
  }

  Mai.Deck = Deck;
})();
