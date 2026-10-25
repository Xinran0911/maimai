/* pricing.js — 购物车 / 结算的算价（步骤 3）
 *  · 实算：data/prices.js（window.MAI_PRICES）是 tools/precompute_prices.py 用麦当劳 MCP calculate-price（只读）预先算好的静态表，
 *    key = 按菜品 code 排序的 "code:qty|code:qty"。浏览器端不带 token，也不联网算价。
 *  · 预估：表里没有的组合，用本地 sets.js / recommend.js 的价格与券逻辑算（菜单 currentPrice + 券），界面标「预估」。
 *  · 券：calculate-price 的券要求券在有效期内，而演示固定在 DEMO_NOW（2026-10-22），真实今天券已过期，所以券抵扣永远是本地估算：
 *    status = 'real'（商品价实算、无券）| 'mixed'（商品价实算 + 券预估）| 'est'（整单本地预估）。
 *  依赖：Mai.sets（info）、window.MAI_PRICES（可缺省 → 全部预估） */
(function (root) {
  'use strict';
  var Mai = (root.Mai = root.Mai || {});
  function r2(x) { return Math.round(x * 100) / 100; }
  function P() { return root.MAI_PRICES || { combos: {}, unavailable: [], meta: {} }; }
  function keyOf(map) { return Object.keys(map).sort().map(function (c) { return c + ':' + map[c]; }).join('|'); }
  function mergeRows(rows) {
    var m = {}, order = [];
    rows.forEach(function (r) { if (!m[r.code]) { m[r.code] = 0; order.push(r.code); } m[r.code] += r.qty; });
    return { map: m, order: order };
  }
  function lookup(map) { var e = P().combos[keyOf(map)]; return e && e.price != null ? e : null; }
  function unavailable(codes) {
    var P0 = P(), out = [];
    codes.forEach(function (c) {
      var one = P0.combos[c + ':1'];
      if (P0.unavailable.indexOf(c) >= 0 || (one && one.err)) out.push(c);
    });
    return out;
  }

  /* 本地：逐行算（券按「一张券可用 units 次」在这些行里先到先得），同时回填 row.subtotal/was/coupon */
  function localRows(rows) {
    var I = Mai.sets.info(), used = {};
    return rows.map(function (r) {
      var inf = I[r.code], sub = 0, cp = null, q = r.qty;
      for (var k = 0; k < q; k++) {
        var c = inf.coupon;
        if (c && inf.unitCoupon < inf.list && (used[c.id] || 0) < c.units) { sub += inf.unitCoupon; used[c.id] = (used[c.id] || 0) + 1; cp = c.title; }
        else sub += inf.list;
      }
      return { sub: r2(sub), list: r2(inf.list * q), orig: r2(Math.max(inf.orig, inf.list) * q), coupon: cp, saved: r2(inf.list * q - sub) };
    });
  }

  /* quote(rows, groups?) → { lines, perRow, status, base, couponSaved, specialSaved, origTotal, discount, payable, coupons, unavailable, changed }
   *  rows：[{code, qty}]（勾选的行，购物车顺序）；groups：[[rows…], …]（按套分组，整单没有现成实算时，逐套实算后相加） */
  function quote(rows, groups) {
    var I = Mai.sets.info();
    var perRow = localRows(rows);
    var mg = mergeRows(rows), lines = [], byCode = {};
    rows.forEach(function (r, i) {
      var inf = I[r.code], L = byCode[r.code];
      if (!L) { L = byCode[r.code] = { code: r.code, name: inf.name, short: inf.short, img: 'assets/img/' + inf.item.image.split('/').pop(), kind: inf.kind, qty: 0, list: 0, orig: 0, localSub: 0, coupon: null, couponSaved: 0 }; lines.push(L); }
      var p = perRow[i];
      L.qty += r.qty; L.list = r2(L.list + p.list); L.orig = r2(L.orig + p.orig); L.localSub = r2(L.localSub + p.sub);
      if (p.coupon) { L.coupon = p.coupon; L.couponSaved = r2(L.couponSaved + p.saved); }
    });
    var real = null, realLines = null, how = null;
    if (rows.length) {
      var e = lookup(mg.map);
      if (e) { real = e.price; realLines = e.lines; how = 'whole'; }
      else if (groups && groups.length > 1) {
        var tot = 0, ls = {}, okAll = true;
        groups.forEach(function (g) {
          if (!okAll || !g.length) return;
          var ge = lookup(mergeRows(g).map);
          if (!ge) { okAll = false; return; }
          tot += ge.price;
          Object.keys(ge.lines).forEach(function (c) { var o = ls[c] || [0, 0]; ls[c] = [r2(o[0] + ge.lines[c][0]), r2(o[1] + ge.lines[c][1])]; });
        });
        if (okAll) { real = r2(tot); realLines = ls; how = 'groups'; }
      }
      if (real == null) {            // 第三档：逐菜品（该菜品 + 该数量）实算后相加；已核对：表里 575 个多品组合与此相加结果完全一致
        var tot2 = 0, ls2 = {}, ok2 = true;
        mg.order.forEach(function (c) {
          if (!ok2) return;
          var one = {}; one[c] = mg.map[c]; var se = lookup(one);
          if (!se) { ok2 = false; return; }
          tot2 += se.price; ls2[c] = se.lines[c];
        });
        if (ok2) { real = r2(tot2); realLines = ls2; how = 'items'; }
      }
    }
    var listTotal = r2(lines.reduce(function (s, l) { return s + l.list; }, 0));
    var couponSaved = r2(lines.reduce(function (s, l) { return s + l.couponSaved; }, 0));
    var origLocal = r2(lines.reduce(function (s, l) { return s + l.orig; }, 0));
    var base = real != null ? real : listTotal;
    var changed = [];
    lines.forEach(function (l) {
      var rl = realLines && realLines[l.code];
      l.real = !!rl;
      var baseLine = rl ? rl[0] : l.list;
      if (rl && Math.abs(rl[0] - l.list) > 0.004) changed.push({ code: l.code, name: l.short, was: l.list, now: rl[0] });
      l.price = r2(baseLine - l.couponSaved);                 // 该行实付（真实商品价 − 本地估算的券）
      l.origLine = Math.max(l.orig, rl ? rl[1] : 0, baseLine);
    });
    var origTotal = r2(Math.max(lines.reduce(function (s, l) { return s + l.origLine; }, 0), base));
    var payable = r2(base - couponSaved);
    var coupons = [];
    lines.forEach(function (l) { if (l.coupon && l.couponSaved > 0.004) coupons.push({ title: l.coupon, name: l.short, saved: l.couponSaved }); });
    return {
      lines: lines, perRow: perRow, status: real == null ? 'est' : (couponSaved > 0.004 ? 'mixed' : 'real'), how: how,
      base: base, couponSaved: couponSaved, origTotal: origTotal, payable: payable,
      discount: r2(origTotal - payable), specialSaved: r2(origTotal - base), coupons: coupons,
      unavailable: unavailable(mg.order), changed: changed, count: rows.reduce(function (n, r) { return n + r.qty; }, 0)
    };
  }

  Mai.pricing = { quote: quote, localRows: localRows, keyOf: keyOf, meta: function () { return P().meta || {}; }, hasReal: function () { return !!root.MAI_PRICES; } };
})(typeof window !== 'undefined' ? window : globalThis);
