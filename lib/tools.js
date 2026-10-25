'use strict';
/* tools.js — Agent 的工具（服务端实现）。每个工具返回 {ok, data|error, source, ui?}：
 *   source = 'mcp'（真实调用了麦当劳 MCP，只读 tool）| 'cache'（MCP 不可用，退回本地缓存/预计算数据）| 'local'（本地算法）
 *   ui = 给前端的指令（card / actions），不进模型上下文。
 * 麦当劳 MCP 只用只读 tool：list-nutrition-foods、calculate-price、query-store-coupons、available-coupons；没有也绝不调用下单/支付类。 */
const fs = require('fs'), path = require('path');
const E = require('./engine'), mcp = require('./mcp');
const { S, MR, Mai, norm } = E;

/* ── 营养：MCP list-nutrition-foods（内存缓存 30 分钟；失败退回 data/nutrition_mcp_snapshot.json）── */
let NUT = { ts: 0, list: null, source: null };
function parseNutText(txt) {
  const out = [];
  String(txt || '').split('\n').forEach(l => {
    const p = l.trim().split(',');
    if (p.length < 9 || /^\[|productName/.test(l.trim())) return;
    const n = x => (x === 'null' || x === '' ? null : +x);
    out.push({ productName: p[0], energyKj: n(p[2]), energyKcal: n(p[3]), protein: n(p[4]), fat: n(p[5]), carbohydrate: n(p[6]), sodium: n(p[7]), calcium: n(p[8]) });
  });
  return out;
}
async function nutList() {
  if (NUT.list && NUT.source === 'mcp' && Date.now() - NUT.ts < 30 * 60e3) return NUT;
  if (mcp.available()) {
    try {
      const r = await mcp.call('list-nutrition-foods', {}, 5000);
      const list = r.ok ? parseNutText(r.data) : [];
      if (list.length > 20) { NUT = { ts: Date.now(), list, source: 'mcp' }; return NUT; }
    } catch (_) {}
  }
  if (!NUT.list) {
    try { NUT = { ts: Date.now(), list: JSON.parse(fs.readFileSync(path.join(E.ROOT, 'data/nutrition_mcp_snapshot.json'), 'utf8')).items, source: 'cache' }; }
    catch (_) { NUT = { ts: Date.now(), list: [], source: 'cache' }; }
  }
  return NUT;
}
function findNut(list, q, prefer) {
  const k = norm(q); if (!k) return null;
  const L = list.map(x => Object.assign({ _k: norm(x.productName) }, x));
  let c = L.filter(x => x._k === k);
  if (!c.length) c = L.filter(x => x._k.includes(k));
  if (!c.length) c = L.filter(x => k.includes(x._k) && x._k.length >= 3);
  if (!c.length) return null;
  const pref = c.find(x => /中杯|5块/.test(x.productName)) || c[0];
  return prefer ? (c.find(x => x._k.includes(prefer)) || pref) : pref;
}
const fmtNut = (n, name, qty, source, extra) => Object.assign({ name, qty, kcal: n.energyKcal, protein_g: n.protein, fat_g: n.fat, carb_g: n.carbohydrate, sodium_mg: n.sodium, source, matched: n.productName }, extra || {});

async function getNutrition(args, c) {
  const nl = await nutList(), items = [];
  const INF = S.info();
  const want = [];
  if (args.current_set !== false && (args.current_set === true || !(args.items && args.items.length))) {
    if (c.card) (c.card.rows || []).forEach(r => INF[r.code] && want.push({ inf: INF[r.code], qty: +r.qty || 1 }));
  }
  (args.items || []).forEach(q => { const r = E.resolve(q); if (r.length) want.push({ inf: r[0], qty: 1, q }); else want.push({ q, inf: null, qty: 1 }); });
  if (!want.length) return { ok: false, error: 'nothing_to_look_up', hint: '没有指定菜品也没有当前餐卡，请用户说想查哪个菜，或先配一套' };
  let mcpUsed = 0, cacheUsed = 0, tot = { kcal: 0, protein_g: 0, fat_g: 0, carb_g: 0, sodium_mg: 0 }, totN = 0;
  want.forEach(w => {
    const nm = w.inf ? w.inf.short : w.q;
    let n = findNut(nl.list, w.inf ? w.inf.short : w.q);
    if (!n && w.inf) n = findNut(nl.list, w.inf.name);
    if (n) {
      const src = nl.source; src === 'mcp' ? mcpUsed++ : cacheUsed++;
      const it = fmtNut(n, nm, w.qty, src, w.inf ? undefined : { not_on_menu: true });
      items.push(it); totN++;
      ['kcal', 'protein_g', 'fat_g', 'carb_g', 'sodium_mg'].forEach(k => { tot[k] += (it[k] || 0) * w.qty; });
    } else if (w.inf && w.inf.nut) {                                            // 菜单自带营养数据（来自早先 MCP 拉取 + 估算）
      cacheUsed++; const x = w.inf.nut;
      items.push({ name: nm, qty: w.qty, kcal: x.kcal, protein_g: x.protein, fat_g: x.fat, carb_g: x.carb, source: 'cache', estimated: !!x.est });
      totN++; tot.kcal += x.kcal * w.qty; tot.protein_g += x.protein * w.qty; tot.fat_g += x.fat * w.qty; tot.carb_g += (x.carb || 0) * w.qty;
    } else items.push({ name: nm, qty: w.qty, error: '没有查到这道菜的营养数据' });
  });
  const data = { items, allergens: '麦当劳 MCP 的营养接口没有过敏原信息，过敏相关请提醒用户以门店/包装标注为准，不要自己下结论' };
  if (want.length > 1 && totN) { Object.keys(tot).forEach(k => { tot[k] = Math.round(tot[k]); }); data.sum = tot; }
  return { ok: true, data, source: mcpUsed && !cacheUsed ? 'mcp' : (mcpUsed ? 'mcp+cache' : 'cache') };
}

/* ── 算价：MCP calculate-price（只读）；失败退回 pricing.js 的预计算实算表 / 本地估算 ── */
async function calcPrice(args, c) {
  const INF = S.info(), rows = [];
  (args.items || []).forEach(x => { const r = E.resolve(x && x.name || x); if (r.length) rows.push({ code: r[0].code, qty: Math.max(1, Math.min(20, +(x && x.qty) || 1)) }); });
  if (args.current_set === true || (!rows.length && c.card)) (c.card ? c.card.rows || [] : []).forEach(r => INF[r.code] && rows.push({ code: r.code, qty: +r.qty || 1 }));
  if (!rows.length && args.cart === true) (c.cart && c.cart.entries || []).forEach(e => (e.rows || []).forEach(r => INF[r.code] && rows.push({ code: r.code, qty: +r.qty || 1 })));
  if (!rows.length) return { ok: false, error: 'nothing_to_price', hint: '没有指定菜品，也没有当前餐卡/购物车' };
  const merged = {}; rows.forEach(r => { merged[r.code] = (merged[r.code] || 0) + r.qty; });
  const loc = Mai.pricing.quote(Object.keys(merged).map(code => ({ code, qty: merged[code] })));
  const lines = Object.keys(merged).map(code => ({ name: INF[code].short, qty: merged[code] }));
  if (mcp.available()) {
    try {
      const r = await mcp.call('calculate-price', { storeCode: E.STORE.code, orderType: 1, beType: 1, items: Object.keys(merged).map(code => ({ productCode: code, quantity: merged[code] })) }, 5000);
      if (r.ok && r.data && r.data.price != null) {
        const d = r.data, y = v => Math.round(v) / 100;
        return { ok: true, source: 'mcp', data: { lines: (d.productList || []).map(p => ({ name: (INF[p.productCode] || {}).short || p.productName, qty: p.quantity, subtotal: y(p.subtotal) })),
          price_no_coupon: y(d.price), original_price: y(d.originalPrice), discount: y(d.discount || 0),
          coupon_note: '这是麦当劳 MCP 实算价（不含券）；券抵扣按演示数据估算，以结算页为准', est_with_coupons: loc.payable } };
      }
    } catch (_) {}
  }
  return { ok: true, source: 'cache', data: { lines, price: loc.base, payable_with_estimated_coupons: loc.payable, status: loc.status, note: '实时算价不可用，用的是预先用麦当劳 MCP 算好的价格表/本地估算' } };
}

/* ── 优惠券 / 门店 ── */
async function coupons() {
  const owned = (MR.DEFAULT_COUPONS || []).map(c => ({ title: c.title, price: c.price, valid_to: c.to, weekdays: '周一至周五', note: c.assumed ? '适用商品为假设' : undefined }));
  let claimable = null, store = null, used = false;
  if (mcp.available()) {
    try {
      const [a, b] = await Promise.all([mcp.call('available-coupons', {}, 4000), mcp.call('query-store-coupons', { storeCode: E.STORE.code, orderType: 1, beType: 1 }, 4000)]);
      if (a.ok && Array.isArray(a.data)) { claimable = a.data.map(x => x.couponName).slice(0, 8); used = true; }
      if (b.ok && Array.isArray(b.data)) { store = b.data.map(x => x.title).slice(0, 8); used = true; }
    } catch (_) {}
  }
  return { ok: true, source: used ? 'mcp' : 'cache', data: { claimable_in_app: claimable, usable_at_store_now: store, my_coupons_snapshot: owned, note: '我的券是演示快照（2026-10-22 抓取）；不会帮用户自动领券' } };
}
function storeInfo() {
  return { ok: true, source: 'cache', data: { name: E.STORE.name, code: E.STORE.code, address: E.STORE.address, hours: E.STORE.hours, mode: '到店自提（演示店，约75米）', note: '门店信息为演示快照' } };
}

/* ── 购物车 / 下单：只发前端 UI 指令；支付永远是前端「假支付」，agent 不得声称真实扣款或真的下了麦当劳订单 ── */
function cartInfo(c) { const ct = c.cart || {}; return { count: +ct.count || 0, total: ct.total }; }
function addToCart(_a, c) {
  if (!c.card) return { ok: false, error: 'no_card', hint: '当前没有餐卡，先帮用户配一套' };
  const rs = E.rowsToSet(c.card); const s = rs ? E.setSummary(rs.set) : null;
  return { ok: true, source: 'local', data: { added: s && s.title, total: s && s.total, note: '只是放进演示购物车，还没结算' }, ui: { actions: [{ type: 'add_cart' }] } };
}
function openCart(_a, c) {
  if (!cartInfo(c).count) return { ok: false, error: 'cart_empty', hint: '购物车是空的，问用户要不要把当前餐卡放进去，或先配一套', data: { has_current_card: !!c.card } };
  return { ok: true, source: 'local', data: { cart_count: cartInfo(c).count, cart_total: cartInfo(c).total }, ui: { actions: [{ type: 'open_cart' }] } };
}
function checkout(a, c) {
  const ci = cartInfo(c);
  const useCurrent = a.which === 'current' || (!ci.count && c.card);
  if (useCurrent && c.card) {
    const rs = E.rowsToSet(c.card), s = rs && E.setSummary(rs.set);
    return { ok: true, source: 'local', data: { checking_out: s && s.title, total: s && s.total, note: '当前这套已放进购物车，带用户去结算页；支付是演示用的假支付，要用户自己点「支付」，不是真的扣款，也没有真的在麦当劳下单' }, ui: { actions: [{ type: 'add_cart' }, { type: 'open_checkout', needConfirm: true }] } };
  }
  if (ci.count) return { ok: true, source: 'local', data: { cart_count: ci.count, cart_total: ci.total, note: '带用户去结算页；支付是演示用的假支付，要用户自己点「支付」，不是真的扣款，也没有真的在麦当劳下单' }, ui: { actions: [{ type: 'open_checkout', needConfirm: true }] } };
  return { ok: false, error: 'nothing_to_checkout', hint: '购物车是空的，也没有当前餐卡：先问用户想吃什么口味/预算再帮他配一套，不要直接下单' };
}
function nextCard(_a, c) {
  if (!c.card) return { ok: false, error: 'no_card', hint: '当前没有餐卡，先配一套' };
  return { ok: true, source: 'local', data: { note: '已翻到另一套备选，具体内容会显示在餐卡上；回复里不要具体描述菜品和价格，说一句换好了、还可以左右滑着看就行' }, ui: { actions: [{ type: 'next_card' }] } };
}

/* ── 工具定义（给模型）── */
const TOOLS = [
  { name: 'recommend_meal', desc: '配餐/推荐：按用户的口味、状态、人数、预算、忌口给出一张餐卡（价格和营养由本地算法真算）。用户说「帮我配餐」「来点…」「想吃…」「几个人预算多少」时用。没有任何偏好也可以调用（给通用推荐）。',
    params: { type: 'object', properties: {
      people: { type: 'integer', description: '几个人' }, budget: { type: 'integer', description: '总预算（元）' },
      tags: { type: 'array', items: { type: 'string', enum: ['高蛋白', '清淡', '顶饱', '省钱', '提神'] }, description: '口味/目标：健身增肌→高蛋白；油腻想清爽/减脂→清淡；吃饱→顶饱；便宜→省钱；犯困→提神' },
      workout: { type: 'boolean', description: '刚健身/运动完' }, greasy: { type: 'boolean', description: '最近吃得油腻' }, no_spicy: { type: 'boolean' }, cheaper: { type: 'boolean' },
      like: { type: 'string', enum: ['chicken', 'beef', 'fish'], description: '想吃鸡肉/牛肉/鱼' }, breakfast: { type: 'boolean' },
      refine: { type: 'boolean', description: '只是在上一次推荐上追加条件（如「便宜点」「不要辣」）' } } } },
  { name: 'edit_meal', desc: '改单：只替换当前餐卡里某一类（饮料/小食/主食）的一个商品。用户说「换成可乐」「不要牛奶」「换个饮料」「小食换成薯条」时用。没有当前餐卡会失败。',
    params: { type: 'object', properties: { cat: { type: 'string', enum: ['drink', 'side', 'main'] }, target: { type: 'string', description: '想换成的菜名（必须是菜单里的短名；没提就不填）' },
      avoid: { type: 'string', description: '不想要的东西，如「牛奶」「辣」' }, cheaper: { type: 'boolean' } }, required: ['cat'] } },
  { name: 'next_card', desc: '用户想「换一套/再来一套/看看别的搭配」（不是只换一个商品）时：翻到当前餐卡的另一套备选。', params: { type: 'object', properties: {} } },
  { name: 'get_nutrition', desc: '查热量/营养（调用麦当劳 MCP 营养数据）：可查当前餐卡，也可查指定菜名（包括不在菜单上的，如雪碧）。回答任何热量/蛋白/脂肪/钠相关问题前必须调用。',
    params: { type: 'object', properties: { current_set: { type: 'boolean', description: '查当前餐卡整套' }, items: { type: 'array', items: { type: 'string' }, description: '菜名列表' } } } },
  { name: 'calculate_price', desc: '算价（调用麦当劳 MCP calculate-price）：指定菜品+数量，或当前餐卡，或购物车。回答「多少钱」前必须调用。',
    params: { type: 'object', properties: { current_set: { type: 'boolean' }, cart: { type: 'boolean' }, items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'integer' } }, required: ['name'] } } } } },
  { name: 'query_coupons', desc: '查优惠券/有什么优惠（麦当劳 MCP）。', params: { type: 'object', properties: {} } },
  { name: 'store_info', desc: '查门店信息：名字、地址、营业时间。', params: { type: 'object', properties: {} } },
  { name: 'add_to_cart', desc: '把当前餐卡放进（演示）购物车。', params: { type: 'object', properties: {} } },
  { name: 'open_cart', desc: '打开购物车页面。', params: { type: 'object', properties: {} } },
  { name: 'checkout', desc: '「我要下单/结算/买单/付款」：带用户去结算页（演示假支付，不会真的扣款）。购物车有东西 → which=cart；只有当前餐卡没加购 → which=current。两者都没有会失败，这时先问用户想吃什么。',
    params: { type: 'object', properties: { which: { type: 'string', enum: ['cart', 'current'] } } } }
];
const IMPL = {
  recommend_meal: async (a, c) => recommendWrap(a, c), edit_meal: async (a, c) => E.edit(a, c), next_card: async (a, c) => nextCard(a, c),
  get_nutrition: getNutrition, calculate_price: calcPrice, query_coupons: coupons, store_info: async () => storeInfo(),
  add_to_cart: async (a, c) => addToCart(a, c), open_cart: async (a, c) => openCart(a, c), checkout: async (a, c) => checkout(a, c)
};
function recommendWrap(a, c) {
  const b = Object.assign({}, a, { noSpicy: a.no_spicy === true, _text: c._text || '' });
  const r = E.recommend(b, c); if (r.ok) r.source = 'local'; return r;
}
const SCHEMA = TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.desc, parameters: t.params } }));
const MCP_TOOLS = { get_nutrition: 1, calculate_price: 1, query_coupons: 1 };
module.exports = { SCHEMA, IMPL, MCP_TOOLS, nutList, parseNutText };
