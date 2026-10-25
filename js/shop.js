/* shop.js — 步骤 3：购物车页 → 结算页 → 假支付 → 支付成功页
 *  入口：Mai.shop.openCart()（首页 / 对话页右上购物车）。页面在 #phone 里叠在首页/对话页之上，返回 = 出栈。
 *  购物车：按「套 / 单品」分组，每行：勾选 · 数量加减 · 删除；底部汇总勾选项 原价 / 优惠 / 应付 + 「去结算」。
 *  结算：门店 · 到店取餐（麦乐送演示版未开放）· 堂食/外带 · 菜品明细 · 券和优惠 · 价格明细；价格 = Mai.pricing.quote（实算 / 预估，见 pricing.js）。
 *  假支付：确认支付 → 「支付中」1.4s → 支付成功页（取餐码）；只结算勾选项，未勾选的留在购物车。全程不联网、不调用任何下单接口。
 *  依赖：Mai.cart、Mai.pricing、Mai.ui、Mai.chat、MAIMAI_CONFIG */
(function () {
  'use strict';
  var Mai = (window.Mai = window.Mai || {});
  var CFG = window.MAIMAI_CONFIG, $ = function (id) { return document.getElementById(id); };
  var money = function (n) { return String(Math.round(n * 100) / 100); };
  var STORE = { code: CFG.store.code, name: '麦当劳上海陆家嘴明珠环餐厅', addr: '世纪大道55号2F-1室', hours: '07:00-23:00' };
  var PAGES = { cart: 'cartPage', co: 'coPage', ok: 'okPage' };
  var stack = [], S = { take: 'eat-in', paying: false, order: null };
  var TAKE = { 'eat-in': '堂食', 'locker-in': '外带' };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ── 页面栈 ── */
  function show(name) {
    var el = $(PAGES[name]); if (!el) return;
    stack = stack.filter(function (n) { return n !== name; }); stack.push(name);
    el.classList.add('on'); el.setAttribute('aria-hidden', 'false');
    document.body.classList.add('in-page');
    var sc = el.querySelector('.pg-scroll'); if (sc) sc.scrollTop = 0;
  }
  function hide(name) {
    var el = $(PAGES[name]); if (!el) return;
    el.classList.remove('on'); el.setAttribute('aria-hidden', 'true');
    stack = stack.filter(function (n) { return n !== name; });
    if (!stack.length) document.body.classList.remove('in-page');
  }
  function back() {
    var top = stack[stack.length - 1]; if (!top || S.paying) return;
    if (top === 'ok') return home();
    hide(top);
  }
  function home() {
    stack.slice().forEach(hide);
    if (Mai.chat && Mai.chat.state.open) Mai.chat.close();
  }

  /* ── 公共片段 ── */
  var ICON = {
    trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
    chk: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7"/></svg>',
    pin: '<svg width="12" height="14" viewBox="0 0 12 14"><path d="M6 0C2.9 0 .5 2.3.5 5.3c0 3.7 4.4 8 5.1 8.6.2.2.6.2.8 0 .7-.6 5.1-4.9 5.1-8.6C11.5 2.3 9.1 0 6 0Z" fill="#DA291C"/><circle cx="6" cy="5.2" r="2" fill="#fff"/></svg>',
    cart: '<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="#C9B79A" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h2.5l2.2 10.2a1.5 1.5 0 0 0 1.5 1.2h8.1a1.5 1.5 0 0 0 1.5-1.1L20.5 8H6.2"/><circle cx="9.5" cy="19.5" r="1.4"/><circle cx="17" cy="19.5" r="1.4"/></svg>'
  };
  function cb(state, attrs) { return '<button type="button" class="ck ' + state + '" ' + attrs + ' role="checkbox" aria-checked="' + (state === 'on' ? 'true' : state === 'part' ? 'mixed' : 'false') + '">' + (state === 'on' ? ICON.chk : state === 'part' ? '<i class="dash"></i>' : '') + '</button>'; }
  function badge(q, short) {
    if (short && q.status === 'mixed') return '<span class="pbadge mix" title="商品价实算，券抵扣为估算">券预估</span>';
    if (q.status === 'real') return '<span class="pbadge real" title="商品价由麦当劳 calculate-price 实算">✓ 实算</span>';
    if (q.status === 'mixed') return '<span class="pbadge mix" title="商品价实算，券抵扣为估算">商品价实算 · 券预估</span>';
    return '<span class="pbadge est" title="本地估算，未经 calculate-price 核价">预估</span>';
  }

  /* ── 购物车页 ── */
  function selRows() { return Mai.cart.selectedRows().map(function (x) { return x.row; }); }
  function selGroups() {
    return Mai.cart.entries().map(function (e) { return e.rows.filter(Mai.cart.isSel); }).filter(function (g) { return g.length; });
  }
  function selQuote() { return Mai.pricing.quote(selRows(), selGroups()); }
  function renderCart() {
    var entries = Mai.cart.entries(), body = $('cartBody'), n = Mai.cart.count();
    $('cartTitle').textContent = n ? '购物车 (' + n + ')' : '购物车';
    if (!entries.length) {
      body.innerHTML = '<div class="empty">' + ICON.cart + '<b>购物车还是空的</b><small>让麦麦帮你配一套，或者首页挑一份</small><button type="button" class="gbtn" data-act="goorder">去点餐</button></div>';
      $('cartBar').innerHTML = ''; $('cartBar').classList.add('none'); return;
    }
    $('cartBar').classList.remove('none');
    // 每行的价格：勾选行 = 本地逐行价（券先到先得）；未勾选行 = 单独标价
    var sel = Mai.cart.selectedRows(), selQ = Mai.pricing.localRows(sel.map(function (x) { return x.row; })), pr = {};
    sel.forEach(function (x, i) { pr[x.entry.id + '#' + x.idx] = selQ[i]; });
    var html = '<div class="storebar">' + ICON.pin + '<span>' + STORE.name + '</span><i>·</i><span>到店取餐</span></div>';
    entries.forEach(function (e) {
      var allOn = e.rows.every(Mai.cart.isSel), anyOn = e.rows.some(Mai.cart.isSel);
      html += '<section class="grp" data-eid="' + e.id + '"><header class="gh">' + cb(allOn ? 'on' : anyOn ? 'part' : '', 'data-act="gsel" data-eid="' + e.id + '"') +
        '<span class="gt ' + (e.kind === 'set' ? 'set' : 'one') + '">' + (e.kind === 'set' ? '套餐' : '单品') + '</span><b class="gn">' + esc(e.kind === 'set' ? e.title : e.rows[0].name.replace(/[“”]/g, '')) + '</b>' +
        '<button type="button" class="gdel" data-act="gdel" data-eid="' + e.id + '" aria-label="删除整组">' + ICON.trash + '</button></header>';
      e.rows.forEach(function (r, i) {
        var on = Mai.cart.isSel(r), p = pr[e.id + '#' + i] || Mai.pricing.localRows([r])[0];
        html += '<div class="crow' + (on ? '' : ' off') + '" data-eid="' + e.id + '" data-i="' + i + '" data-code="' + r.code + '">' +
          cb(on ? 'on' : '', 'data-act="rsel" data-eid="' + e.id + '" data-i="' + i + '" aria-label="勾选 ' + esc(r.name) + '"') +
          '<div class="th"><img src="' + esc(r.img) + '" alt="" draggable="false"></div>' +
          '<div class="cx"><div class="cn">' + esc(r.name.replace(/[“”]/g, '')) + '</div>' +
          '<div class="cs">' + (p.coupon && on ? '<em class="cpn">券</em>' : '') + '<span class="cp-price">¥' + money(on ? p.sub : p.list) + '</span>' + (p.orig > (on ? p.sub : p.list) + 0.004 ? '<s>¥' + money(p.orig) + '</s>' : '') + '</div>' +
          '<button type="button" class="rdel" data-act="rdel" data-eid="' + e.id + '" data-i="' + i + '">' + ICON.trash + '删除</button></div>' +
          '<div class="stp"><button type="button" class="m" data-act="dec" data-eid="' + e.id + '" data-i="' + i + '" aria-label="减少">−</button><span class="qn">' + r.qty + '</span><button type="button" class="p" data-act="inc" data-eid="' + e.id + '" data-i="' + i + '" aria-label="增加">+</button></div></div>';
      });
      html += '</section>';
    });
    body.innerHTML = html;
    // 底部汇总
    var q = selQuote(), total = Mai.cart.count(), allSel = Mai.cart.entries().every(function (e) { return e.rows.every(Mai.cart.isSel); });
    var has = q.count > 0;
    $('cartBar').innerHTML = '<div class="cb-all">' + cb(allSel ? 'on' : '', 'data-act="all" aria-label="全选"') + '<span>全选</span></div>' +
      '<div class="cb-sum"><div class="cb-l1">' + (has ? '原价 <s>¥' + money(q.origTotal) + '</s> <i>优惠 −¥' + money(q.discount) + '</i>' : '请勾选要点的菜品') + '</div>' +
      '<div class="cb-l2"><span>应付</span><b id="cartPayable">¥' + money(has ? q.payable : 0) + '</b>' + (has ? badge(q, true) : '') + '</div></div>' +
      '<button type="button" class="gbtn go" data-act="checkout"' + (has ? '' : ' disabled') + '>去结算' + (has ? '(' + q.count + ')' : '') + '</button>';
  }
  function cartClick(e) {
    var t = e.target.closest('[data-act]'); if (!t) return;
    var act = t.dataset.act, id = t.dataset.eid, i = +t.dataset.i, C = Mai.cart;
    if (act === 'back') return back();
    if (act === 'goorder') return home();
    if (act === 'rsel') { var en = C.find(id); C.setSel(id, i, !C.isSel(en.rows[i])); }
    else if (act === 'gsel') { var g = C.find(id); C.setGroupSel(id, !g.rows.every(C.isSel)); }
    else if (act === 'all') C.setAll(!C.entries().every(function (x) { return x.rows.every(C.isSel); }));
    else if (act === 'inc') { var a = C.find(id); C.setQty(id, i, a.rows[i].qty + 1); }
    else if (act === 'dec') { var b = C.find(id); if (b.rows[i].qty <= 1) { C.removeRow(id, i); Mai.ui.toast('已删除', 1100); } else C.setQty(id, i, b.rows[i].qty - 1); }
    else if (act === 'rdel') { C.removeRow(id, i); Mai.ui.toast('已删除', 1100); }
    else if (act === 'gdel') { C.removeEntry(id); Mai.ui.toast('已删除这一组', 1200); }
    else if (act === 'checkout') { if (!t.disabled) openCheckout(); }
  }

  /* ── 结算页 ── */
  function renderCheckout() {
    var q = selQuote(), body = $('coBody'), bar = $('coBar');
    if (!q.count) { body.innerHTML = '<div class="empty"><b>没有勾选的菜品</b><small>回购物车勾选要点的菜吧</small><button type="button" class="gbtn" data-act="back">回购物车</button></div>'; bar.innerHTML = ''; return; }
    var h = '<section class="card c-store"><div class="seg" role="tablist"><button type="button" class="on" data-act="mode-store" role="tab" aria-selected="true">到店取餐</button><button type="button" data-act="mode-delivery" role="tab" aria-selected="false">麦乐送</button></div>' +
      '<div class="sn">' + STORE.name + '</div><div class="sd">门店编码 ' + STORE.code + ' · ' + STORE.addr + ' · 营业 ' + STORE.hours + '</div>' +
      '<div class="takes">' + Object.keys(TAKE).map(function (k) { return '<button type="button" class="tk' + (S.take === k ? ' on' : '') + '" data-act="take" data-k="' + k + '">' + TAKE[k] + '</button>'; }).join('') + '</div></section>';
    if (q.unavailable.length) {
      var names = q.lines.filter(function (l) { return q.unavailable.indexOf(l.code) >= 0; }).map(function (l) { return l.short; });
      h += '<div class="warn">⚠ 核价提示：' + esc(names.join('、')) + ' 今天暂时不可售（门店实时核价返回售罄）。演示支付仍可继续，真实下单需先换掉。</div>';
    }
    h += '<section class="card c-items">';
    q.lines.forEach(function (l) {
      var na = q.unavailable.indexOf(l.code) >= 0;
      h += '<div class="irow' + (na ? ' na' : '') + '" data-code="' + l.code + '"><div class="th"><img src="' + esc(l.img) + '" alt="" draggable="false"></div><div class="ix"><div class="in">' + esc(l.name.replace(/[“”]/g, '')) + '</div>' +
        '<div class="is">×' + l.qty + (l.coupon && l.couponSaved > 0.004 ? ' <em class="cpn">券</em> ' + esc(l.coupon) : '') + (na ? ' <em class="nas">暂不可售</em>' : '') + '</div></div>' +
        '<div class="ip">¥' + money(l.price) + (l.origLine > l.price + 0.004 ? '<s>¥' + money(l.origLine) + '</s>' : '') + '</div></div>';
    });
    h += '</section>';
    h += '<section class="card c-cp"><div class="cprow"><span class="k">优惠券</span>' + (q.coupons.length ? '<span class="v used">' + q.coupons.map(function (c) { return esc(c.title); }).join('、') + ' <b>−¥' + money(q.couponSaved) + '</b></span>' : '<span class="v">已选商品暂无可用券</span>') + '</div>' +
      (q.coupons.length ? '<div class="cpn-note">券已自动使用 · 抵扣金额为本地估算（演示时间按 ' + esc(CFG.DEMO_NOW.slice(0, 10)) + ' 计，券有效期内）</div>' : '') + '</section>';
    h += '<section class="card c-sum"><div class="srow"><span>商品原价</span><b>¥' + money(q.origTotal) + '</b></div>' +
      (q.specialSaved > 0.004 ? '<div class="srow"><span>活动特价</span><b class="neg">−¥' + money(q.specialSaved) + '</b></div>' : '') +
      '<div class="srow"><span>优惠券</span>' + (q.couponSaved > 0.004 ? '<b class="neg">−¥' + money(q.couponSaved) + '</b>' : '<b class="mut">暂无可用</b>') + '</div>' +
      '<div class="srow total"><span>应付</span><b id="coPayable">¥' + money(q.payable) + '</b></div>' +
      '<div class="pnote ' + q.status + '">' + (q.status === 'real' ? '✓ 商品价由麦当劳 calculate-price 实算' + (q.how === 'groups' ? '（按套逐套核价后合计）' : q.how === 'items' ? '（逐菜品核价后合计）' : '') : q.status === 'mixed' ? '✓ 商品价由 calculate-price 实算 · 券抵扣为预估' + (q.how === 'groups' ? '（按套逐套核价后合计）' : q.how === 'items' ? '（逐菜品核价后合计）' : '') : '预估价：这个组合没有预先核价，按菜单价与券本地估算') + '</div>' +
      (q.changed.length ? '<div class="pnote chg">核价后价格有变：' + q.changed.map(function (c) { return esc(c.name) + ' ¥' + money(c.was) + ' → ¥' + money(c.now); }).join('；') + '（以核价为准）</div>' : '') + '</section>' +
      '<div class="demo-note">演示支付：不会真实下单，也不会扣款</div>';
    body.innerHTML = h;
    bar.innerHTML = '<div class="co-sum"><span>合计</span><b>¥' + money(q.payable) + '</b>' + badge(q) + '</div><button type="button" class="gbtn go" data-act="pay">确认支付</button>';
  }
  function coClick(e) {
    var t = e.target.closest('[data-act]'); if (!t) return;
    var act = t.dataset.act;
    if (act === 'back') return back();
    if (act === 'mode-delivery') { Mai.ui.toast('麦乐送演示版暂未开放，先选到店取餐', 1800); return; }
    if (act === 'take') { S.take = t.dataset.k; renderCheckout(); return; }
    if (act === 'pay') return pay();
  }

  /* ── 假支付 ── */
  function pickupCode() {
    var seq = 0; try { seq = +localStorage.getItem('maimai.orderseq') || 0; localStorage.setItem('maimai.orderseq', String(seq + 1)); } catch (_) {}
    var d = new Date(), n = (d.getMinutes() * 60 + d.getSeconds() + seq * 37) % 900 + 100;
    return String.fromCharCode(65 + (seq + d.getHours()) % 26) + ' ' + n;
  }
  function pay() {
    if (S.paying) return;
    var q = selQuote(); if (!q.count) return;
    S.paying = true;
    var ov = $('payOv'); ov.classList.add('on'); ov.setAttribute('aria-hidden', 'false');
    setTimeout(function () {
      S.order = { code: pickupCode(), take: S.take, store: STORE.name, storeCode: STORE.code, ts: Date.now(), total: q.payable, status: q.status, count: q.count,
        lines: q.lines.map(function (l) { return { code: l.code, name: l.name, img: l.img, qty: l.qty, price: l.price }; }), demo: true };
      try { var all = JSON.parse(localStorage.getItem('maimai.orders.v1') || '[]'); all.unshift(S.order); localStorage.setItem('maimai.orders.v1', JSON.stringify(all.slice(0, 20))); } catch (_) {}
      Mai.cart.removeSelected();                       // 已结算的清出，未勾选的留在购物车
      renderOk(); hide('co'); hide('cart'); show('ok');
      ov.classList.remove('on'); ov.setAttribute('aria-hidden', 'true'); S.paying = false;
    }, 1400);
  }
  function renderOk() {
    var o = S.order; if (!o) return;
    var left = Mai.cart.count();
    var h = '<section class="okhero"><div class="o1">支付成功 · 到店取餐</div><div class="o2">取餐码</div><div class="o3" id="pickCode">' + esc(o.code) + '</div><div class="o4">' + esc(o.store.replace('麦当劳', '')) + ' · ' + TAKE[o.take] + '</div></section>' +
      '<section class="card steps"><div class="stp4"><div class="s done"><i>' + ICON.chk + '</i><span>已支付</span></div><div class="s cur"><i>' + ICON.chk + '</i><span>制作中</span></div><div class="s"><i></i><span>待取餐</span></div><div class="s"><i></i><span>已完成</span></div></div><div class="hint">到店出示取餐码即可（演示订单，未真实下单）</div></section>' +
      '<section class="card c-items ok-items"><div class="oh">已点菜品 · ' + esc(STORE.name.replace('麦当劳', '')) + '</div>';
    o.lines.forEach(function (l) {
      h += '<div class="irow"><div class="th"><img src="' + esc(l.img) + '" alt="" draggable="false"></div><div class="ix"><div class="in">' + esc(l.name.replace(/[“”]/g, '')) + '</div><div class="is">×' + l.qty + '</div></div><div class="ip">¥' + money(l.price) + '</div></div>';
    });
    h += '<div class="paid"><span>实付</span><b id="paidTotal">¥' + money(o.total) + '</b></div></section>' +
      '<div class="msayrow"><img class="av" alt="麦麦" src="' + esc(CFG.avatar.src || '') + '" draggable="false"><div class="msay">' + (left ? '购物车里还留着 ' + left + ' 件没结算的，想好了随时回来点～' : '餐好了我会叫你，记得到店出示取餐码～') + '</div></div>';
    $('okBody').innerHTML = h;
    $('okBar').innerHTML = '<button type="button" class="gbtn go full" data-act="home">返回首页</button>';
  }
  function okClick(e) { var t = e.target.closest('[data-act]'); if (!t) return; if (t.dataset.act === 'home') home(); else if (t.dataset.act === 'back') back(); }

  /* ── 对外 ── */
  function openCart() { renderCart(); show('cart'); }
  function openCheckout() { if (!Mai.cart.selectedRows().length) { Mai.ui.toast('先勾选要点的菜品', 1400); return; } renderCheckout(); show('co'); }

  function init() {
    $('cartPage').addEventListener('click', cartClick);
    $('coPage').addEventListener('click', coClick);
    $('okPage').addEventListener('click', okClick);
    Mai.cart.subscribe(function () { if ($('cartPage').classList.contains('on')) renderCart(); });
  }
  Mai.shop = { init: init, openCart: openCart, openCheckout: openCheckout, back: back, home: home, state: S, quote: selQuote, STORE: STORE };
})();
