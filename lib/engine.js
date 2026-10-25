'use strict';
/* engine.js — 在 Node 里加载「前端同一份」推荐/算价代码（js/recommend.js、sets.js、pricing.js、intent.js + data/*.js），
 * 给 Agent 的工具用。这样：服务端工具里算出来的餐卡 = 浏览器里用同一意图本地渲染出来的餐卡（价格/营养都不由大模型编造）。
 * 在独立 vm 上下文里跑，不污染服务端全局。 */
const vm = require('vm'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const ctx = vm.createContext({ console, Math, Date, JSON, Object, Array, String, Number, RegExp, parseInt, parseFloat, isNaN });
ctx.window = ctx;
['js/config.js', 'data/meals.js', 'js/recommend.js', 'js/sets.js', 'data/prices.js', 'js/pricing.js', 'js/intent.js'].forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
});
const Mai = ctx.Mai, MR = ctx.MaiRec, S = Mai.sets;
const CAT_CN = { main: '主食', side: '小食', drink: '饮料' };
const STORE = { code: '1450127', name: '麦当劳上海陆家嘴明珠环餐厅', address: '世纪大道55号2F-1室', hours: '07:00-23:00', mode: '到店自提' };

/* 出现在系统提示里的菜单：短名按品类分组（不带价格/营养，事实要靠工具）*/
function menu() {
  const I = S.info(), g = { main: [], side: [], drink: [] };
  Object.values(I).forEach(x => g[x.cat].push(x.short));
  return g;
}
function norm(s) { return String(s || '').replace(/[「」“”"【】\s\-—·（）()]/g, '').replace(/汉堡/g, '堡').toLowerCase(); }
/* 菜名 → 菜单商品（短名/全名模糊匹配），返回 info 列表（最多 4 个）*/
function resolve(q) {
  const k = norm(q); if (k.length < 1) return [];
  const I = Object.values(S.info());
  let r = I.filter(x => norm(x.short) === k);
  if (!r.length) r = I.filter(x => norm(x.name) === k);
  if (!r.length && k.length >= 2) r = I.filter(x => norm(x.short).includes(k) || norm(x.name).includes(k));
  if (!r.length && k.length >= 3) r = I.filter(x => k.includes(norm(x.short)) && norm(x.short).length >= 2);
  return r.slice(0, 4);
}
function rowsToSet(card) {
  const INF = S.info();
  const rows = (card.rows || []).filter(r => INF[r.code]).map(r => S.mkRow(INF[r.code], Math.max(1, Math.min(20, +r.qty || 1))));
  if (!rows.length) return null;
  const intent = (card.intent && card.intent.mi) || {};
  const I = MR.normIntent(intent), flags = (card.intent && card.intent.flags) || {};
  const set = S.finalize({ rows }, I, flags);
  return { set, I, flags };
}
function setSummary(set) {
  return {
    title: set.title, items: set.rows.map(r => ({ name: r.short, qty: r.qty, subtotal: r.subtotal, coupon: r.coupon || undefined })),
    total: set.total, original_total: set.was, saved: set.saved, kcal: set.kcal, protein_g: set.protein, fat_g: set.fat,
    estimated_nutrition: !!set.est, people: set.people, budget: set.budget || undefined, within_budget: set.within
  };
}

/* ── 工具：推荐 ── */
function recommend(args, c) {
  const a = Object.assign({}, args, { text: String(args._text || '') });
  const P = Mai.intent.fromAgent(a, { last: c.last || null });
  const b = S.build(P);
  if (!b.hot.length && !b.new.length) return { ok: false, error: 'no_match', hint: '这个条件下菜单里没有合适搭配，可以放宽条件（比如换个预算/口味）' };
  const center = b.hot[0] || b.new[0];
  const alts = b.hot.concat(b.new).filter(s => s !== center).slice(0, 2).map(s => ({ title: s.title, main: S.mainRow(s).short, total: s.total }));
  return { ok: true, data: { card: setSummary(center), alternatives: alts, note: '价格=菜单价+有效券后真算；营养为菜单营养数据（带「约」的为估算）' },
    ui: { card: { kind: 'recommend', intent: { mi: P.mi, flags: P.flags, refine: P.refine } } } };
}

/* ── 工具：换餐（只换一行）── */
function edit(args, c) {
  if (!c.card) return { ok: false, error: 'no_card', hint: '还没有餐卡，先帮用户配一套再换' };
  const rs = rowsToSet(c.card); if (!rs) return { ok: false, error: 'no_card' };
  const e = { cat: args.cat, target: null, avoidSrc: null, cheaper: args.cheaper === true, unknown: null };
  if (['drink', 'side', 'main'].indexOf(e.cat) < 0) return { ok: false, error: 'bad_cat', hint: 'cat 必须是 drink/side/main' };
  const INF = S.info();
  if (args.target) {
    const hit = resolve(args.target).filter(x => x.cat === e.cat);
    const any = resolve(args.target);
    if (hit.length) e.target = hit.map(x => x.code);
    else if (any.length) { e.cat = any[0].cat; e.target = any.filter(x => x.cat === any[0].cat).map(x => x.code); }
    else e.unknown = String(args.target).slice(0, 12);
  }
  if (args.avoid) {
    const k = String(args.avoid).replace(/[.*+?^${}()|[\]\\]/g, '').slice(0, 12);
    const hit = resolve(args.avoid).filter(x => x.cat === e.cat);
    e.avoidSrc = hit.length ? hit.map(x => x.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') : (k.replace(/^(牛)?奶$/, '奶'));
    if (/牛奶|奶/.test(String(args.avoid))) e.avoidSrc = '奶';
  }
  if (e.unknown) return { ok: false, error: 'not_on_menu', data: { asked: e.unknown, menu_same_category: menu()[e.cat] }, ui: { card: { kind: 'edit', edit: e } } };
  const P = Mai.intent.fromAgentEdit(e);
  const before = setSummary(rs.set);
  const res = S.applyEdit(rs.set, P.edit, rs.I, rs.flags);
  if (!res.ok) return { ok: false, error: res.why, data: { cat: e.cat, name: res.name }, ui: { card: { kind: 'edit', edit: e } } };
  return { ok: true, data: { changed: { cat: CAT_CN[e.cat], from: res.from.short, to: res.to.short, price_delta: res.delta }, card: setSummary(rs.set), only_this_row_changed: true, before_total: before.total },
    ui: { card: { kind: 'edit', edit: e } } };
}

module.exports = { Mai, MR, S, STORE, CAT_CN, menu, resolve, rowsToSet, setSummary, recommend, edit, norm, ROOT };
