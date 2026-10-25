/* sets.js — 「套餐组合」：把推荐算法的单品结果（recommend.js）变成“一套”= 主食/套餐 + 配餐（对话餐卡用）
 *  · 价格真算：菜单 currentPrice；有效券（recommend.js 的 coupon 逻辑，DEMO_NOW 下判断有效期）按券后价；汇总 = 各行之和；原价 = 菜单 originalPrice（特价）/ 现价（券）
 *  · 营养：recommend.js 的 NUTRITION（est=1 的估算项在卡上标「约」）
 *  · 解析出的意图（高蛋白 / 清淡 / 几人+预算 / 便宜 / 不要辣 / 想吃鸡…）约束每一套
 *  · 左右两条序沿用 MaiRec.createDeck（热=爆品序 rankHot，新=新品序 rankNew，两序互斥、不重复）
 *  · applyEdit：语音改单，只替换当前套里对应品类（饮料/小食/主食）的那一行
 * 依赖：window.MEALS、window.MaiRec、window.MAIMAI_CONFIG */
(function (root) {
  'use strict';
  var Mai = (root.Mai = root.Mai || {});
  var MR = root.MaiRec, CFG = root.MAIMAI_CONFIG;
  var CAT = { combo: 'main', main: 'main', share: 'side', side: 'side', dessert: 'side', drink: 'drink' };
  var CAT_CN = { main: '主食', side: '小食', drink: '饮料' };
  var SPICY_RE = /麦辣|龙焰|辣/;
  var LIKE_RE = { chicken: /鸡|翅/, beef: /牛|巨无霸|安格斯/, fish: /鱼|虾/ };
  var FRIEDISH_RE = /炸|薯|麦辣|龙焰|派|翅|芝士条|麦乐|脆/;

  function r2(x) { return Math.round(x * 100) / 100; }
  function money(n) { return String(r2(n)); }
  function nowCtx() { return CFG.USE_REAL_NOW ? new Date() : CFG.DEMO_NOW; }
  function imgLocal(url) { return 'assets/img/' + url.split('/').pop(); }

  /* ── 每个商品的真实价格/券/营养（来自 MaiRec 的同一套 prep）── */
  var INFO = null;
  function info() {
    if (INFO) return INFO;
    INFO = {};
    MR.rankHot(root.MEALS.items, { now: nowCtx() }).forEach(function (r) {
      var e = r._e;
      INFO[r.code] = { code: r.code, item: r.item, name: r.item.name, kind: r.item.kind, cat: CAT[r.item.kind], list: e.listPrice, orig: e.origPrice,
        coupon: e.coupon, unitCoupon: e.unitCoupon, nut: e.nut, greasy: e.greasy, taste: e.taste || [], tags: e.tags || [], hot: !!r.item.hot, isNew: !!r.item.new,
        short: shortName(r.item.name) };
    });
    return INFO;
  }
  function shortName(n) {
    return n.replace(/[“”"【】]/g, '').replace(/美汁源|麦咖啡™|麦当劳|（冰\/热）|\(冰\/热\)|单品精选/g, '').replace(/^[“”]+|[“”]+$/g, '') || n;
  }

  /* ── 行 / 套的价格与营养 ── */
  function mkRow(inf, qty) {
    return { code: inf.code, name: inf.name, short: inf.short, kind: inf.kind, cat: inf.cat, qty: qty || 1, img: imgLocal(inf.item.image), imgRemote: inf.item.image,
      subtotal: 0, was: 0, coupon: null, nut: inf.nut, taste: inf.taste };
  }
  function reprice(set) {
    var I = info(), used = {}, total = 0, was = 0, kcal = 0, pro = 0, fat = 0, carb = 0, est = false;
    set.rows.forEach(function (r) {
      var inf = I[r.code], sub = 0, cp = null;
      for (var k = 0; k < r.qty; k++) {
        var c = inf.coupon;
        if (c && inf.unitCoupon < inf.list && (used[c.id] || 0) < c.units) { sub += inf.unitCoupon; used[c.id] = (used[c.id] || 0) + 1; cp = c.title; }
        else sub += inf.list;
      }
      r.subtotal = r2(sub); r.coupon = cp; r.was = r2(Math.max(inf.orig, inf.list) * r.qty);
      total += r.subtotal; was += r.was;
      kcal += inf.nut.kcal * r.qty; pro += inf.nut.protein * r.qty; fat += inf.nut.fat * r.qty; carb += (inf.nut.carb || 0) * r.qty; if (inf.nut.est) est = true;
    });
    set.total = r2(total); set.was = r2(was); set.saved = r2(was - total);
    set.kcal = Math.round(kcal); set.protein = Math.round(pro); set.fat = Math.round(fat); set.carb = Math.round(carb); set.est = est;
    set.left = set.budget ? r2(set.budget - set.total) : null;
    set.within = set.budget ? set.total <= set.budget + 1e-9 : true;
    return set;
  }
  function rowNutText(r) {
    var n = r.nut, q = r.qty, a = n.est ? '约' : '';
    if (!n.known && n.est) return '营养估算约' + Math.round(n.kcal * q) + 'kcal';
    return a + Math.round(n.kcal * q) + 'kcal';
  }

  /* ── 意图 → 过滤 / 打分 ── */
  function has(I, t) { return I.tags.indexOf(t) >= 0; }
  function allowed(inf, flags, I, role) {
    if (flags.noSpicy && SPICY_RE.test(inf.name)) return false;
    if (role === 'anchor' && flags.like) { var re = LIKE_RE[flags.like]; if (re && !re.test(inf.name)) return false; }
    if (has(I, '清淡')) {
      if (role === 'anchor' && (inf.kind !== 'main' || inf.greasy >= 0.6 || FRIEDISH_RE.test(inf.name) || !(inf.taste.indexOf('清淡') >= 0 || inf.nut.fat <= 12))) return false;
      if (role === 'side' && (inf.greasy >= 0.3 || inf.nut.fat > 8 || FRIEDISH_RE.test(inf.name) || inf.kind !== 'side')) return false;
      if (role === 'drink' && inf.nut.kcal > 150) return false;
    }
    return true;
  }
  function compScore(inf, role, I, flags, used) {
    var n = inf.nut, s = 0;
    if (has(I, '高蛋白')) s += role === 'drink' ? n.protein * 3 : n.protein * 2.2 - (n.fat > 20 ? 4 : 0);
    if (has(I, '清淡')) s += -n.kcal / (role === 'drink' ? 18 : 12) + (inf.taste.indexOf('清淡') >= 0 ? 4 : 0) - n.fat / 3;
    if (has(I, '顶饱')) s += n.kcal / 40;
    if (has(I, '省钱') || flags.cheaper) s += -inf.list * 0.9;
    if (has(I, '提神') && inf.taste.indexOf('提神') >= 0) s += 6;
    if (flags.like && LIKE_RE[flags.like] && LIKE_RE[flags.like].test(inf.name) && role === 'side') s += 8;
    s += -inf.list * 0.18 + (inf.orig > inf.list ? 2.5 : 0) + (inf.coupon ? 2 : 0) + (inf.hot ? 1.2 : 0) + (inf.isNew ? 0.8 : 0);
    s -= 40 * (used[inf.code] || 0);
    return s;
  }
  function pick(role, I, flags, used, exclude, anchorCodes, loose) {
    var best = null, bs = -1e9;
    var kinds = role === 'drink' ? ['drink'] : ['side'];            // 小食：只选 side（炸物/玉米杯/苹果片），不拿甜品抢位
    var inf = info();
    Object.keys(inf).forEach(function (c) {
      var x = inf[c];
      if (kinds.indexOf(x.kind) < 0 || (exclude && exclude(x)) || anchorCodes[c]) return;
      if (!allowed(x, flags, I, role)) return;
      if (!loose && has(I, '高蛋白') && x.nut.protein < (role === 'drink' ? 4 : 8)) return;   // 高蛋白：配餐也得有蛋白（找不到再放宽）
      var s = compScore(x, role, I, flags, used);
      if (s > bs) { bs = s; best = x; }
    });
    return best;
  }

  /* ── 套的元信息 ── */
  var TAG_SHOW = ['高蛋白', '清淡', '顶饱', '省钱', '提神'];
  function labelOf(I, flags) {
    var t = (I.tags || []).filter(function (x) { return TAG_SHOW.indexOf(x) >= 0; });
    if (flags.like) t.push({ chicken: '鸡肉', beef: '牛肉', fish: '鱼虾' }[flags.like]);
    if (flags.meal === 'breakfast') t.push('早餐');
    if (flags.noSpicy) t.push('不辣');
    return t.slice(0, 2).join('·') || '今日推荐';
  }
  function finalize(set, I, flags) {
    reprice(set);
    var n = I.people || 1;
    set.people = n; set.budget = I.budget || null;
    reprice(set);
    if (set.budget || n > 1) set.title = n + '人 · ¥' + money(set.total) + (set.budget ? '（预算' + set.budget + '内）' : '');
    else set.title = labelOf(I, flags) + ' · 1人';
    var pill = null;
    if (has(I, '高蛋白')) pill = { cls: 'p', text: '蛋白质 ' + (set.est ? '约' : '') + set.protein + 'g' };
    else if (has(I, '清淡')) pill = { cls: 'l', text: '脂肪 ' + (set.est ? '约' : '') + set.fat + 'g' };
    else if (set.rows.some(function (r) { return r.coupon; })) pill = { cls: 'c', text: '已用券' };
    else if (set.saved > 0.05) pill = { cls: 'c', text: '省¥' + money(set.saved) };
    set.pill = pill;
    set.reasonLine = describe(set, I);
    return set;
  }
  function mainRow(set) { return set.rows.filter(function (r) { return r.cat === 'main'; })[0] || set.rows[0]; }
  function describe(set, I) {
    var est = set.est ? '约' : '';
    if (set.people > 1 || set.budget) {
      var pp = r2(set.total / set.people);
      return set.people + '人共¥' + money(set.total) + '，人均¥' + (Math.round(pp * 10) / 10) + (set.saved > 0.05 ? '，用券/特价省¥' + money(set.saved) : '') + (set.budget ? '，预算还剩¥' + money(set.budget - set.total) : '');
    }
    if (has(I, '高蛋白')) {
      return I.state && I.state.workout ? '练后一餐刚好' : '吃得扎实';
    }
    if (has(I, '清淡')) return '脂肪才 ' + est + set.fat + 'g、' + est + set.kcal + 'kcal，清清爽爽不腻' + (set.saved > 0.05 ? '，还省了¥' + money(set.saved) : '');
    if (has(I, '省钱')) return '一套只要 ¥' + money(set.total) + (set.saved > 0.05 ? '，已省 ¥' + money(set.saved) : '') + '，' + est + set.kcal + 'kcal 吃得饱';
    return est + set.kcal + 'kcal，蛋白质 ' + est + set.protein + 'g' + (set.saved > 0.05 ? '，已省 ¥' + money(set.saved) : '');
  }

  /* ── 构建：返回 {hot:[sets], new:[sets], I, flags}；center = hot[0] ── */
  function build(parsed) {
    var I = MR.normIntent(parsed.mi), flags = parsed.flags || {};
    var all = root.MEALS.items, INF = info();
    var pool = all.filter(function (it) {
      if (flags.noSpicy && SPICY_RE.test(it.name)) return false;
      if (has(I, '清淡') && it.kind === 'combo') return false;          // 三件套自带薯条，清淡场景不用（也避免“单品被套餐去重吃掉”）
      return true;
    });
    var ctx = { now: nowCtx(), intent: parsed.mi && !I.empty ? parsed.mi : undefined };
    var deck = MR.createDeck(pool, ctx);
    var railLists = { new: deck.lists.new, hot: deck.lists.hot };
    var useBundle = I.people > 1 || !!I.budget;
    var used = {}, seenSig = {}, out = { hot: [], new: [], I: I, flags: flags };
    var cap = 9;
    function anchorOk(r) {
      var x = INF[r.code]; if (!x) return false;
      if (useBundle ? (x.cat === 'drink' || x.kind === 'dessert') : (x.kind !== 'main' && x.kind !== 'combo')) return false;
      return allowed(x, flags, I, 'anchor');
    }
    // 交错生成：center → 新0 → 热1 → 新1 …，这样同类配餐优先分给前几套，彼此不重复
    var cand = { hot: railLists.hot.filter(anchorOk), new: railLists.new.filter(anchorOk) };
    var idx = { hot: 0, new: 0 }, turn = ['hot', 'new'], t = 0, guard = 0;
    while ((out.hot.length < cap || out.new.length < cap) && guard++ < 80) {
      var rail = turn[t++ % 2];
      if (out[rail].length >= cap || idx[rail] >= cand[rail].length) { if (idx.hot >= cand.hot.length && idx.new >= cand.new.length) break; if (out.hot.length >= cap && out.new.length >= cap) break; continue; }
      var r = cand[rail][idx[rail]++], set = null;
      if (useBundle) set = bundleSet(r, pool, I, flags, ctx);
      else set = soloSet(r, I, flags, used);
      if (!set) continue;
      var sig = set.rows.map(function (x) { return x.code + 'x' + x.qty; }).sort().join('|');
      if (seenSig[sig]) continue; seenSig[sig] = 1;
      set.rail = rail; set.anchor = r.code; set.alg = r.reason || ''; set.id = rail + '-' + r.code;
      out[rail].push(set);
    }
    // 某条序为空时，把另一条序的一部分分过来（保证左右都有可翻的套）
    if (!out.hot.length && out.new.length > 1) { out.hot = out.new.splice(0, Math.ceil(out.new.length / 2)); out.hot.forEach(function (s) { s.rail = 'hot'; }); }
    if (!out.new.length && out.hot.length > 1) { out.new = out.hot.splice(Math.ceil(out.hot.length / 2)); out.new.forEach(function (s) { s.rail = 'new'; }); }
    return out;
  }

  function soloSet(r, I, flags, used) {
    var inf = info()[r.code], anchorCodes = {}; anchorCodes[r.code] = 1;
    var rows = [mkRow(inf, 1)];
    var drink = null, side = null;
    if (inf.kind !== 'combo') { drink = pick('drink', I, flags, used, null, anchorCodes); if (drink) { rows.push(mkRow(drink, 1)); used[drink.code] = (used[drink.code] || 0) + 1; } }
    var early = (used._n || 0) < 3;                                 // 前三套（首屏中间+左右）配餐不重复；之后允许复用
    side = pick('side', I, flags, used, function (x) { return early && (used[x.code] || 0) > 0 && has(I, '清淡'); }, anchorCodes);
    if (!side && rows.length < 2) side = pick('side', I, flags, used, null, anchorCodes, true);
    used._n = (used._n || 0) + 1;
    if (side) { rows.splice(1, 0, mkRow(side, 1)); used[side.code] = (used[side.code] || 0) + 1; }
    return finalize({ rows: rows }, I, flags);
  }

  function bundleSet(r, pool, I, flags, ctx) {
    var b = r.bundle;
    if (!b) b = MR.buildBundle(pool, I, { now: ctx.now }, { anchor: r.item });
    if (!b || !b.within) return null;
    var inf = info();
    var rows = b.lines.map(function (l) { return mkRow(inf[l.item.code], l.qty); });
    var order = { main: 0, side: 1, drink: 2 };
    rows.sort(function (a, c) { return order[a.cat] - order[c.cat]; });
    var set = finalize({ rows: rows }, I, flags);
    set.bundleTotal = b.total;
    if (!set.within) return null;
    return set;
  }

  /* ── 语音改单：只替换对应品类那一行 ── */
  // edit = {cat:'drink'|'side'|'main', target:[code…]|null, avoid:RegExp|null, cheaper:bool}
  function applyEdit(set, edit, I, flags) {
    var inf = info(), cat = edit.cat;
    var idxs = []; set.rows.forEach(function (r, i) { if (r.cat === cat) idxs.push(i); });
    if (!idxs.length) return { ok: false, why: 'nocat', cat: cat };
    var ri = idxs[0];
    if (edit.avoid) { var m = idxs.filter(function (i) { return edit.avoid.test(set.rows[i].name); }); if (m.length) ri = m[0]; }
    else if (edit.target && edit.target.length) { var m2 = idxs.filter(function (i) { return edit.target.indexOf(set.rows[i].code) < 0; }); if (m2.length) ri = m2[0]; }
    var old = set.rows[ri], oldTotal = set.total, oldKcal = set.kcal, oldProtein = set.protein;
    var inSet = {}; set.rows.forEach(function (r) { inSet[r.code] = 1; });
    var cands = [];
    if (edit.target && edit.target.length) {
      cands = edit.target.filter(function (c) { return !inSet[c] || c === old.code && false; }).map(function (c) { return inf[c]; }).filter(Boolean);
      if (!cands.length) return { ok: false, why: 'same', cat: cat, name: inf[edit.target[0]] && inf[edit.target[0]].short };
    } else {
      Object.keys(inf).forEach(function (c) {
        var x = inf[c];
        if (x.cat !== cat || inSet[c]) return;
        if (cat === 'main' ? (x.kind !== 'main' && x.kind !== 'combo') : cat === 'side' ? x.kind !== 'side' : x.kind !== 'drink') return;
        if (edit.avoid && edit.avoid.test(x.name)) return;
        if (!allowed(x, flags || {}, I, cat === 'main' ? 'anchor' : cat)) return;
        cands.push(x);
      });
    }
    if (!(edit.target && edit.target.length) && !edit.cheaper) {       // 泛指“换个饮料”：别越换越贵（单价涨幅 ≤ ¥4），实在没有再放宽
      var unit = old.subtotal / old.qty, near = cands.filter(function (x) { return x.list <= unit + 4; });
      if (near.length) cands = near;
    }
    var usedMap = {}; // 候选之间按场景打分，取最合适的
    cands.sort(function (a, b) { return compScore(b, cat === 'main' ? 'anchor' : cat, I, flags || {}, usedMap) - compScore(a, cat === 'main' ? 'anchor' : cat, I, flags || {}, usedMap) + (edit.cheaper ? (a.list - b.list) * 2 : 0); });
    var chosen = null, trial;
    for (var i = 0; i < cands.length; i++) {
      var copy = JSON.parse(JSON.stringify(set)), nr = mkRow(cands[i], old.qty);
      copy.rows[ri] = nr; reprice(copy);
      if (set.budget && copy.total > set.budget + 1e-9) { if (edit.target) { return { ok: false, why: 'budget', cat: cat, name: cands[i].short, total: copy.total }; } continue; }
      chosen = cands[i]; trial = copy; break;
    }
    if (!chosen) return { ok: false, why: set.budget ? 'budget' : 'none', cat: cat };
    var nr2 = mkRow(chosen, old.qty);
    set.rows[ri] = nr2;
    finalize(set, I || MR.normIntent({}), flags || {});
    var delta = r2(set.total - oldTotal);
    set.edited = { cat: cat, from: old.short, to: nr2.short, delta: delta, dKcal: set.kcal - oldKcal, dProtein: set.protein - oldProtein, row: ri };
    return { ok: true, row: ri, from: old, to: nr2, delta: delta, dKcal: set.kcal - oldKcal, dProtein: set.protein - oldProtein };
  }

  Mai.sets = { mkRow: mkRow, build: build, applyEdit: applyEdit, info: info, reprice: reprice, finalize: finalize, rowNutText: rowNutText, money: money, CAT_CN: CAT_CN, SPICY_RE: SPICY_RE, LIKE_RE: LIKE_RE, shortName: shortName, mainRow: mainRow };
})(typeof window !== 'undefined' ? window : globalThis);
