/* cart.js — 购物车共享 store（首页 / 对话页 / 步骤 3 购物车页共用）
 * 数据放 localStorage（key = maimai.cart.v1），读不了/写不了时退回内存。
 * 结构：{ v:1, entries:[ { id, ts, kind:'set'|'dish', title, rail, rows:[{code,name,img,qty,subtotal,was,coupon}], total, was } ] }
 *   —— 一次「加入购物车」= 一条 entry（整套 = 1 套，数量 +1 套；首页单品加购 = kind:'dish'）。
 * 步骤 3 增补：row.sel（勾选，缺省=勾选）、setSel/setGroupSel/setAll/setQty/removeRow/removeEntry/selectedRows/removeSelected。
 * 步骤 3 读取：Mai.cart.entries()、Mai.cart.lines()（按菜品合并）、Mai.cart.total()、Mai.cart.count()。
 * 角标数字 = 购物车里所有菜品的份数合计。 */
(function (root) {
  'use strict';
  var Mai = (root.Mai = root.Mai || {});
  var KEY = 'maimai.cart.v1';
  var mem = { v: 1, entries: [] }, subs = [];

  function load() {
    try { var s = root.localStorage.getItem(KEY); if (s) { var o = JSON.parse(s); if (o && o.entries) return o; } } catch (_) {}
    return null;
  }
  function save() { try { root.localStorage.setItem(KEY, JSON.stringify(mem)); } catch (_) {} }
  function r2(x) { return Math.round(x * 100) / 100; }
  function emit() { subs.forEach(function (f) { try { f(api); } catch (_) {} }); }

  /* 改数量/删行后重算这一条的本地价（用 Mai.pricing.localRows；没有就按比例）*/
  function reprice(e) {
    var loc = root.Mai.pricing ? root.Mai.pricing.localRows(e.rows) : null, t = 0, w = 0;
    e.rows.forEach(function (r, i) {
      if (loc) { r.subtotal = loc[i].sub; r.was = loc[i].orig; r.coupon = loc[i].coupon; }
      t += r.subtotal; w += r.was || r.subtotal;
    });
    e.total = r2(t); e.was = r2(w);
  }

  var api = {
    key: KEY,
    entries: function () { return mem.entries.slice(); },
    count: function () { var n = 0; mem.entries.forEach(function (e) { e.rows.forEach(function (r) { n += r.qty; }); }); return n; },
    sets: function () { return mem.entries.filter(function (e) { return e.kind === 'set'; }).length; },
    total: function () { var t = 0; mem.entries.forEach(function (e) { t += e.total; }); return r2(t); },
    lines: function () {              // 按菜品合并（步骤 3 展示购物车明细可用）
      var m = {}, out = [];
      mem.entries.forEach(function (e) { e.rows.forEach(function (r) {
        var l = m[r.code]; if (!l) { l = m[r.code] = { code: r.code, name: r.name, img: r.img, qty: 0, subtotal: 0, was: 0 }; out.push(l); }
        l.qty += r.qty; l.subtotal = r2(l.subtotal + r.subtotal); l.was = r2(l.was + (r.was || r.subtotal));
      }); });
      return out;
    },
    addSet: function (set) {
      var e = { id: 'e' + Date.now() + '-' + mem.entries.length, ts: Date.now(), kind: 'set', title: set.title, rail: set.rail || null, total: r2(set.total), was: r2(set.was || set.total),
        rows: set.rows.map(function (r) { return { code: r.code, name: r.name, img: r.img, qty: r.qty, subtotal: r2(r.subtotal), was: r2(r.was || r.subtotal), coupon: r.coupon || null }; }) };
      mem.entries.push(e); save(); emit(); return e;
    },
    addDish: function (card) {        // 首页单品卡「加购」
      var e = { id: 'e' + Date.now() + '-' + mem.entries.length, ts: Date.now(), kind: 'dish', title: card.name, rail: card.rail || null, total: r2(card.price), was: r2(card.was ? parseFloat(String(card.was).replace('¥', '')) : card.price),
        rows: [{ code: card.code, name: card.name, img: card.img, qty: 1, subtotal: r2(card.price), was: r2(card.was ? parseFloat(String(card.was).replace('¥', '')) : card.price), coupon: card.deal && card.deal.type === 'coupon' ? card.deal.text : null }] };
      mem.entries.push(e); save(); emit(); return e;
    },
    /* ── 步骤 3：勾选 / 改数量 / 删除（行 = entry.rows[i]；row.sel 缺省 = 勾选）── */
    isSel: function (r) { return r.sel !== false; },
    find: function (id) { for (var i = 0; i < mem.entries.length; i++) if (mem.entries[i].id === id) return mem.entries[i]; return null; },
    setSel: function (id, idx, on) { var e = api.find(id); if (e && e.rows[idx]) { e.rows[idx].sel = !!on; save(); emit(); } },
    setGroupSel: function (id, on) { var e = api.find(id); if (e) { e.rows.forEach(function (r) { r.sel = !!on; }); save(); emit(); } },
    setAll: function (on) { mem.entries.forEach(function (e) { e.rows.forEach(function (r) { r.sel = !!on; }); }); save(); emit(); },
    setQty: function (id, idx, q) {
      var e = api.find(id); if (!e || !e.rows[idx]) return;
      if (q < 1) return api.removeRow(id, idx);
      e.rows[idx].qty = Math.min(20, q); reprice(e); save(); emit();
    },
    removeRow: function (id, idx) {
      var e = api.find(id); if (!e) return;
      e.rows.splice(idx, 1);
      if (!e.rows.length) mem.entries = mem.entries.filter(function (x) { return x !== e; }); else reprice(e);
      save(); emit();
    },
    removeEntry: function (id) { mem.entries = mem.entries.filter(function (x) { return x.id !== id; }); save(); emit(); },
    selectedRows: function () {     // [{entry,row,idx}]（购物车顺序）
      var out = []; mem.entries.forEach(function (e) { e.rows.forEach(function (r, i) { if (r.sel !== false) out.push({ entry: e, row: r, idx: i }); }); }); return out;
    },
    removeSelected: function () {   // 支付成功：已结算的行清出，未勾选的留下
      mem.entries.forEach(function (e) { e.rows = e.rows.filter(function (r) { return r.sel === false; }); if (e.rows.length) reprice(e); });
      mem.entries = mem.entries.filter(function (e) { return e.rows.length; });
      save(); emit();
    },
    clear: function () { mem = { v: 1, entries: [] }; save(); emit(); },
    subscribe: function (f) { subs.push(f); f(api); }
  };
  var saved = load(); if (saved) mem = saved;
  Mai.cart = api;
})(typeof window !== 'undefined' ? window : globalThis);
