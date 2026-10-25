/*!
 * recommend.js — 麦麦「懂你的导购」推荐算法（纯 JS，零依赖）
 * 浏览器：<script src="recommend.js"></script> → window.MaiRec
 * Node：  const MaiRec = require('./recommend.js')
 *
 * ┌─ 首页交互约定（可交换配置，见 CONFIG.deck.swipe）──────────────────────────┐
 * │  左滑 = 新品序（rankNew）      右滑 = 爆品序（rankHot）                   │
 * │  这【不是】左滑跳过/右滑要：左右滑只是选「往哪条浏览序里继续往下翻」，     │
 * │  两条序都是“想吃的东西”。想对调只改 CONFIG.deck.swipe = {left:'hot',right:'new'}。│
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * 导出：
 *   rankHot(items, ctx)            爆品序，返回 [{item,score,breakdown,reason,...}]
 *   rankNew(items, ctx)            新品序
 *   applyIntent(items, intent, ctx) 意图重排/过滤层（两条序都能叠加；预算/人数→凑单组合）
 *   buildBundle(items, intent, ctx, opts) 凑单：N 人 + 预算 → 套餐组合（价格真算，含券）
 *   createDeck(items, ctx)         左右滑牌堆：next('left'|'right')、peek、heads，去重
 *   parseIntent(text)              「3个人预算100」「今天健身了来点高蛋白」「昨天油腻想清淡」→ intent
 *   CONFIG                         全部权重（可直接改，或经 ctx.config 局部覆盖）
 *
 * ctx（全部可选）：
 *   now        Date | 'YYYY-MM-DD HH:mm'   默认当前时间（券有效期/活动/时段都据此判断）
 *   intent     见 parseIntent；rankHot/rankNew 内部会自动叠加 applyIntent
 *   coupons    默认 DEFAULT_COUPONS（门店实测“我的券”）；传 [] 关闭
 *   campaigns  默认 DEFAULT_CAMPAIGNS（活动日历）
 *   sales      {code: 销量}  真实销量（接入后替代“人气热卖榜位”代理指标）
 *   history    {orders:{code:次数}, kinds:{kind:次数}, recent:[code…]}  个人历史
 *   soldOut    [code…] 售罄/不可售
 *   config     局部覆盖 CONFIG（深合并）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MaiRec = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /* ════════════════════ 1. 权重配置（唯一需要调参的地方）════════════════════ */
  var CONFIG = {
    // 爆品序：各因子取 0..1，乘以权重后求和（权重合计 100，得分 0..100）
    hot: { popularity: 28, deal: 14, kind: 26, priceFit: 12, timeFit: 6, value: 14, personal: 12 },
    //            ↑人气热卖榜位   ↑券/特价  ↑套餐优先  ↑价格合理  ↑时段   ↑性价比(热量/元)（个人历史 personal 仅有 history 时额外加分，不占100）
    // 新品序
    new: { newness: 28, recency: 14, campaign: 14, kind: 10, priceFit: 10, deal: 8, popularity: 8, timeFit: 4, value: 4, personal: 8 },
    // 品类权重：爆品序里套餐 > 单点；新品序里甜品/饮品新品也值得看
    kindWeight: {
      hot: { combo: 1, share: 0.8, main: 0.65, side: 0.35, dessert: 0.25, drink: 0.12 },
      new: { combo: 1, main: 0.85, share: 0.75, side: 0.6, dessert: 0.6, drink: 0.45 }
    },
    // 各品类“合理价”中心（元），偏离越远 priceFit 越低（对数距离）
    priceTarget: { combo: 52, share: 45, main: 27, side: 17, dessert: 15, drink: 12 },
    priceTolerance: 2.5,   // 偏离多少倍后 priceFit=0
    // 时段 × 品类适配（0..1）
    period: {
      meal:  { combo: 1,   main: 0.8, share: 0.7, side: 0.4, dessert: 0.2, drink: 0.3 },   // 10:30-14:00, 17:00-21:00
      tea:   { combo: 0.5, main: 0.5, share: 0.6, side: 0.8, dessert: 1,   drink: 1 },     // 14:00-17:00
      night: { combo: 0.6, main: 0.8, share: 0.5, side: 0.6, dessert: 0.6, drink: 0.5 }    // 其他
    },
    deal: { couponFullAt: 0.5, limitedFullAt: 0.5 },   // 折扣达到 50% 记满分
    newness: { tagOnly: 0.7, flagged: 1 },            // 仅 tags 含“上新/回归”给 0.7；new 标记给 1
    recency: { halfLifeDays: 21, noLaunchDate: 0.6, flaggedNoCampaign: 0.35 },
    campaign: { today: 1, within3d: 0.6, afterLaunch30d: 0.4 },
    // 意图层加减分（单位：分，叠在 0..100 基础分上）
    intent: {
      protein: 34,          // 高蛋白：蛋白质总量+蛋白密度
      light: 30,            // 清淡
      filling: 18,          // 顶饱
      cheap: 18,            // 省钱
      perk: 14,             // 提神
      shareBonus: 10,       // 多人时分享型加分
      soloSharePenalty: 10, // 单人时分享型扣分
      overPerPersonPenalty: 28, // 单品价超过人均预算的惩罚上限
      companionPenalty: 12, // 有明确意图时，饮品/小食/甜品不应抢主食位置
      hardGreasy: 0.6,      // 清淡：油腻指数 ≥ 此值直接过滤（过滤后不足 minKeep 则放宽）
      hardLowProtein: 12,   // 高蛋白：每份蛋白 < 12g 直接过滤（候选不足时放宽）
      minKeep: 6,
      bundleTopK: 14,       // 有预算/人数意图时，为前 K 名各算一份凑单
      infeasiblePenalty: 40, // 凑不出预算内组合的商品（如分享盒已占去大半预算）扣分
      sweetFactor: 0.35     // 清淡：甜品/高热量饮品的“清淡度”打折
    },
    bundle: {
      maxCopies: 2,         // 同一商品最多 2 份（第 2 份效用 ×0.8）
      secondCopyFactor: 0.8,
      extraMax: 2,          // 分享小食/甜品最多追加几件（再 +人数/3 取整）
      useBudgetBonus: 10,   // 用满预算的奖励（0..此值）
      extraFactor: 0.7,
      blend: { hot: 0.55, new: 0.45 }
    },
    deck: {
      swipe: { left: 'new', right: 'hot' },   // ← 可交换：左滑=新品序，右滑=爆品序
      exclusive: true,      // 两条序互斥选牌（草稿式分配），同一道菜只会出现在一边
      familyDedupe: true,   // 单点与三件套视作同一道菜，只留一个
      peek: 3
    }
  };

  /* ════════════════════ 2. 真实数据（来自 mcd-mcp-lujiazui 抓取）════════════════════ */
  // 营养：code → [kcal, 蛋白g, 脂肪g, 碳水g, 钠mg, est]；数据源 06-nutrition-parsed.json（官方营养表），
  // 套餐=主食+中薯条+可乐中杯 按成分相加；est=1 表示用相近商品代理估算（菜单无同名营养条目）。
  var NUTRITION = {"9900016076": [558, 19, 31, 47, 1411, 1], "9900016075": [1134, 40, 48, 129, 1795, 1], "9900016073": [921, 28, 36, 116, 1373, 1], "9900016077": [332, 22, 18, 16, 812, 1], "521952": [485, 24, 24, 42, 1208, 1], "9900016566": [292, 2, 18, 28, 622, 1], "521950": [266, 5, 9, 40, 116, 1], "9900014092": [282, 5, 9, 44, 126, 1], "515946": [135, 8, 6, 12, 77, 1], "507409": [148, 8, 7, 13, 77, 0], "521953": [634, 32, 32, 51, 1503, 1], "9900015850": [921, 28, 36, 116, 1373, 1], "521900": [485, 24, 24, 42, 1208, 1], "9900005462": [827, 27, 29, 109, 1206, 0], "1440": [485, 24, 24, 42, 1208, 0], "1406": [391, 23, 17, 35, 1041, 0], "1450": [369, 15, 17, 39, 731, 0], "9900006332": [960, 85, 55, 30, 2970, 1], "9900015730": [914, 34, 46, 84, 1687, 1], "9900015851": [761, 20, 25, 109, 721, 1], "521903": [325, 16, 13, 35, 556, 1], "9900005466": [949, 31, 38, 116, 1126, 0], "1100": [513, 27, 26, 42, 961, 0], "1600": [325, 16, 13, 35, 556, 0], "9900008747": [248, 13, 8, 29, 492, 1], "511782": [696, 32, 44, 43, 897, 0], "1401": [213, 12, 12, 13, 422, 0], "521986": [192, 11, 11, 12, 380, 1], "9900016082": [182, 1, 11, 18, 389, 1], "521917": [266, 5, 9, 40, 116, 1], "4810": [289, 4, 12, 38, 165, 0], "4437": [87, 4, 1, 12, 2, 0], "6102": [32, 0, 0, 7, 0, 0], "9900008752": [232, 2, 12, 28, 159, 0], "507411": [13, 1, 0, 2, 0, 0], "9900011121": [463, 18, 17, 57, 652, 1], "9900009245": [495, 26, 24, 42, 764, 1], "521817": [117, 0, 0, 29, 17, 1], "9900008751": [147, 0, 0, 36, 0, 0], "515280": [117, 0, 0, 29, 17, 0], "3757": [0, 0, 0, 0, 0, 0], "3505": [2, 0, 0, 0, 0, 0]};

  // 门店实测“我的券”(08-my-coupons)：周一至周五 10:30-23:59，2026-10-19 ~ 10-23。
  // 「王牌炸鸡任选2」适用商品接口未返回，这里按 蘸酱炸鸡/麦乐鸡 假设（assumed:true），接入券详情后替换。
  var DEFAULT_COUPONS = [
    { id: 'cp-1440', title: '11.9元麦辣鸡腿堡', price: 11.9, units: 1, codes: ['1440'],
      from: '2026-10-19 10:30', to: '2026-10-23 23:59', weekdays: [1, 2, 3, 4, 5], daily: ['10:30', '23:59'], owned: true },
    { id: 'cp-wangpai2', title: '19.9元王牌炸鸡任选2', price: 19.9, units: 2, codes: ['9900016077', '1401'], assumed: true,
      from: '2026-10-19 10:30', to: '2026-10-23 23:59', weekdays: [1, 2, 3, 4, 5], daily: ['10:30', '23:59'], owned: true }
  ];

  // 活动日历(10-campaign-calendar)：match=商品名正则；launch=开售日；dates=日历里出现该活动的日期
  var DEFAULT_CAMPAIGNS = [
    { id: 'dip', title: '韩式蘸酱上新', match: '蘸酱炸鸡|鸡薯双全盒|心形薯饼', launch: '2026-10-08', dates: ['2026-10-22', '2026-10-24'] },
    { id: 'dragon', title: 'GD联动·龙焰鸡腿堡', match: '龙焰', launch: '2026-10-08', dates: ['2026-10-22', '2026-10-25', '2026-10-28'] },
    { id: 'blueberry', title: '蓝莓麦旋风上新', match: '蓝莓爆爆珠', launch: null, dates: ['2026-10-22', '2026-11-03'] },
    { id: 'choco', title: '浓浓黑巧13.9元', match: '浓浓黑巧', launch: null, dates: ['2026-10-22', '2026-10-30'] }
  ];

  /* ════════════════════ 3. 小工具 ════════════════════ */
  function clamp(x, a, b) { return Math.max(a === undefined ? 0 : a, Math.min(b === undefined ? 1 : b, x)); }
  function r2(x) { return Math.round(x * 100) / 100; }
  function round1(x) { return Math.round(x * 10) / 10; }
  function isObj(o) { return o && typeof o === 'object' && !Array.isArray(o); }
  function deepMerge(base, over) {
    if (!isObj(over)) return base;
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = isObj(base[k]) ? deepMerge(base[k], {}) : base[k]; });
    Object.keys(over).forEach(function (k) { out[k] = isObj(base[k]) && isObj(over[k]) ? deepMerge(base[k], over[k]) : over[k]; });
    return out;
  }
  function cfgOf(ctx) { return ctx && ctx.config ? deepMerge(CONFIG, ctx.config) : CONFIG; }
  function parseDT(s) {                       // 'YYYY-MM-DD[ HH:mm]' → Date（本地时区）
    if (s instanceof Date) return s;
    if (!s) return new Date();
    var m = String(s).match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    return m ? new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : new Date(s);
  }
  function ymd(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function hm(d) { return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function daysBetween(a, b) { return Math.round((parseDT(b) - parseDT(a)) / 864e5); }
  function periodOf(d) { var m = d.getHours() * 60 + d.getMinutes();
    if ((m >= 630 && m < 840) || (m >= 1020 && m < 1260)) return 'meal'; if (m >= 840 && m < 1020) return 'tea'; return 'night'; }
  var PERIOD_LABEL = { meal: '正餐', tea: '下午茶', night: '夜宵' };

  /* ════════════════════ 4. 商品特征化（enrich）════════════════════ */
  var KIND_CN = { combo: '套餐', main: '主食', share: '分享', side: '小食', dessert: '甜品', drink: '饮品' };
  var FRIED_RE = /炸鸡|麦乐鸡|薯饼|薯条|芝士条|V翅|翅|脆汁|龙焰|薄皮|拉丝|鸡薯|麦辣|派/;
  function familyKey(name) {
    return String(name).replace(/[【】“”"（）()\s]/g, '').replace(/三件套|套餐|单品精选|\d+块/g, '');
  }
  function couponActive(cp, now) {
    if (!cp || cp.owned === false) return false;
    var t = now.getTime();
    if (cp.from && t < parseDT(cp.from).getTime()) return false;
    if (cp.to && t > parseDT(cp.to).getTime()) return false;
    if (cp.weekdays && cp.weekdays.indexOf(now.getDay()) < 0) return false;
    if (cp.daily && (hm(now) < cp.daily[0] || hm(now) > cp.daily[1])) return false;
    return true;
  }
  function nutritionOf(it, ctx) {
    if (it.nutrition) return it.nutrition;
    var n = (ctx && ctx.nutrition && ctx.nutrition[it.code]) || NUTRITION[it.code];
    if (n) return { kcal: n[0], protein: n[1], fat: n[2], carb: n[3], sodium: n[4], est: !!n[5], known: true };
    var g = { combo: [850, 28, 33], main: [450, 22, 20], share: [550, 22, 28], side: [250, 8, 12], dessert: [260, 4, 9], drink: [120, 1, 2] }[it.kind] || [300, 8, 12];
    return { kcal: g[0], protein: g[1], fat: g[2], carb: 0, sodium: 0, est: true, known: false };
  }
  // 为一批商品做一次特征化：有效价(含券)、营养、油腻指数、人气原始值……
  function prep(items, ctx, cfg) {
    ctx = ctx || {};
    var now = parseDT(ctx.now), today = ymd(now), per = periodOf(now);
    var coupons = (ctx.coupons || DEFAULT_COUPONS).filter(function (c) { return couponActive(c, now); });
    var camps = ctx.campaigns || DEFAULT_CAMPAIGNS;
    var soldOut = {}; (ctx.soldOut || []).forEach(function (c) { soldOut[c] = 1; });
    var hotCat = items.filter(function (i) { return i.category === '人气热卖'; });
    var salesVals = ctx.sales ? Object.keys(ctx.sales).map(function (k) { return ctx.sales[k]; }).sort(function (a, b) { return a - b; }) : null;
    var out = [];
    items.forEach(function (it) {
      if (soldOut[it.code] || it.available === false) return;           // 在售过滤
      var list = +it.currentPrice, orig = +(it.originalPrice || it.currentPrice);
      var cp = null;
      coupons.forEach(function (c) { if (c.codes.indexOf(it.code) >= 0 && c.price / c.units < list && (!cp || c.price / c.units < cp.price / cp.units)) cp = c; });
      var unitCoupon = cp ? cp.price / cp.units : null;
      var nut = nutritionOf(it, ctx);
      var fatShare = nut.kcal ? nut.fat * 9 / nut.kcal : 0;
      var fried = FRIED_RE.test(it.name + ' ' + (it.tags || []).join(' ')) ? 1 : 0;
      var greasy = it.kind === 'drink' ? clamp(nut.fat / 12) * 0.5
        : clamp(0.45 * clamp((fatShare - 0.28) / 0.2) + 0.35 * clamp(nut.fat / 40) + 0.2 * fried);
      // 人气：优先真实销量分位；否则用“人气热卖”榜位（门店菜单顺序即热度顺序）
      var pop, popNote;
      if (salesVals && ctx.sales[it.code] != null) {
        pop = salesVals.filter(function (v) { return v <= ctx.sales[it.code]; }).length / salesVals.length; popNote = '销量分位' + Math.round(pop * 100);
      } else if (it.category === '人气热卖') {
        var idx = hotCat.indexOf(it); pop = 0.65 + 0.35 * (1 - idx / Math.max(1, hotCat.length - 1)); popNote = '人气热卖榜 No.' + (idx + 1);
      } else if (it.hot) { pop = 0.7; popNote = '人气经典'; }
      else if ((it.tags || []).join('').match(/人气|粉丝之选/)) { pop = 0.5; popNote = '粉丝之选'; }
      else { pop = 0.12; popNote = '常规在售'; }
      // 新品度 / 活动
      var tagText = (it.tags || []).join('|');
      var newness = it.new ? cfg.newness.flagged : (/上新|回归/.test(tagText) ? cfg.newness.tagOnly : 0);
      var camp = null, heat = 0, recency = 0;
      camps.forEach(function (c) {
        if (!new RegExp(c.match).test(it.name)) return;
        var h = 0;
        if (c.dates && c.dates.indexOf(today) >= 0) h = cfg.campaign.today;
        else if (c.dates && c.dates.some(function (d) { var k = daysBetween(today, d); return k > 0 && k <= 3; })) h = cfg.campaign.within3d;
        else if (c.launch && daysBetween(c.launch, today) >= 0 && daysBetween(c.launch, today) <= 30) h = cfg.campaign.afterLaunch30d;
        if (h >= heat) { heat = h; camp = c; }
      });
      if (camp) recency = camp.launch ? Math.pow(0.5, Math.max(0, daysBetween(camp.launch, today)) / cfg.recency.halfLifeDays) : cfg.recency.noLaunchDate;
      else if (newness) recency = cfg.recency.flaggedNoCampaign * (it.new ? 1 : 0.6);
      out.push({
        item: it, code: it.code, name: it.name, kind: it.kind, taste: it.taste || [], tags: it.tags || [],
        listPrice: list, origPrice: orig, coupon: cp, unitCoupon: unitCoupon,
        price: cp ? Math.min(list, unitCoupon) : list,
        limitedOff: orig > list ? (orig - list) / orig : 0,
        servings: it.kind === 'share' ? (list >= 50 ? 3 : 1.5) : 1,
        nut: nut, greasy: greasy, fried: fried, protein: nut.protein / (it.kind === 'share' ? (list >= 50 ? 3 : 1.5) : 1),
        proteinDensity: nut.kcal ? nut.protein / nut.kcal * 100 : 0,
        fam: familyKey(it.name), pop: pop, popNote: popNote, newness: newness, camp: camp, heat: heat, recency: recency,
        period: per, now: now
      });
    });
    return out;
  }

  /* ════════════════════ 5. 基础打分：rankHot / rankNew ════════════════════ */
  function factorDeal(e, cfg) {
    var c = e.coupon ? clamp((e.listPrice - e.unitCoupon) / e.listPrice / cfg.deal.couponFullAt) : 0;
    var l = clamp(e.limitedOff / cfg.deal.limitedFullAt);
    return { v: Math.max(c, l), note: c >= l && c > 0 ? '有券¥' + round1(e.unitCoupon) : l > 0 ? '特惠省' + Math.round(e.limitedOff * 100) + '%' : '无优惠' };
  }
  function factorPrice(e, cfg) {
    var t = cfg.priceTarget[e.kind] || 25;
    return clamp(1 - Math.abs(Math.log(e.listPrice / t)) / Math.log(cfg.priceTolerance));
  }
  function factorValue(e) { return clamp(e.nut.kcal / Math.max(1, e.listPrice) / 25); }
  function factorPersonal(e, ctx) {
    var h = ctx && ctx.history; if (!h) return null;
    var o = (h.orders && h.orders[e.code]) || 0, k = (h.kinds && h.kinds[e.kind]) || 0;
    var recent = (h.recent || []).indexOf(e.code) >= 0 ? -0.5 : 0;     // 刚点过，降权避免腻
    return clamp(0.6 * clamp(o / 3) + 0.4 * clamp(k / 6) + recent, -0.5, 1);
  }
  function scoreBase(e, mode, ctx, cfg) {
    var W = cfg[mode], bd = [];
    function add(key, label, v, note) { bd.push({ key: key, label: label, raw: round1(v * 100) / 100, weight: W[key], pts: round1(v * W[key]), note: note || '' }); }
    var kv = cfg.kindWeight[mode][e.kind] || 0.3, tv = cfg.period[e.period][e.kind] || 0.5, dl = factorDeal(e, cfg);
    if (mode === 'hot') {
      add('popularity', '人气', e.pop, e.popNote);
    } else {
      add('newness', '新品标记', e.newness, e.newness >= 1 ? '新品标记' : e.newness ? '标签含上新/回归' : '非新品');
      add('recency', '上新时效', e.recency, e.camp && e.camp.launch ? '自' + e.camp.launch + '起售' : e.recency ? '近期上新' : '—');
      add('campaign', '活动关联', e.heat, e.camp ? e.camp.title + (e.heat >= 1 ? '·今日有活动' : '') : '无活动');
      add('popularity', '已验证人气', e.pop, e.popNote);
    }
    add('kind', '品类', kv, KIND_CN[e.kind] + (mode === 'hot' && e.kind === 'combo' ? '(套餐优先)' : ''));
    add('priceFit', '价格合理', factorPrice(e, cfg), '¥' + e.listPrice);
    add('deal', '优惠', dl.v, dl.note);
    add('timeFit', '时段', tv, PERIOD_LABEL[e.period]);
    add('value', '性价比', factorValue(e), Math.round(e.nut.kcal / e.listPrice) + '千卡/元');
    var pv = factorPersonal(e, ctx), total = 0;
    bd.forEach(function (b) { total += b.pts; });
    if (pv !== null) { var pp = round1(pv * W.personal); bd.push({ key: 'personal', label: '个人历史', raw: round1(pv), weight: W.personal, pts: pp, note: '' }); total += pp; }
    return { score: total, breakdown: bd };
  }

  /* ════════════════════ 6. 意图层 ════════════════════ */
  var TAG_ALIAS = { '蛋白': '高蛋白', '增肌': '高蛋白', '高蛋白': '高蛋白', '低脂': '清淡', '减脂': '清淡', '清爽': '清淡', '清淡': '清淡',
    '顶饱': '顶饱', '管饱': '顶饱', '省钱': '省钱', '实惠': '省钱', '提神': '提神' };
  function normIntent(intent) {
    var it = intent || {}, tags = [];
    (it.tags || []).concat(it.mood ? [it.mood] : []).forEach(function (t) { var a = TAG_ALIAS[t] || t; if (tags.indexOf(a) < 0) tags.push(a); });
    var st = it.state || {};
    if (st.workout && tags.indexOf('高蛋白') < 0) tags.push('高蛋白');       // 健身了 → 默认高蛋白
    if (st.greasy && tags.indexOf('清淡') < 0) tags.push('清淡');           // 昨天油腻 → 默认清淡
    var n = it.people ? +it.people : null, b = it.budget ? +it.budget : null;
    return { people: n, budget: b, tags: tags, state: st, text: it.text || '', empty: !n && !b && !tags.length };
  }
  function isShareKind(e) { return e.kind === 'share'; }
  // 单个商品的意图加减分：返回 {pts, parts[], drop}
  function intentAdjust(e, I, cfg) {
    var C = cfg.intent, parts = [], pts = 0, drop = null;
    function add(key, label, v, note) { if (!v) return; parts.push({ key: key, label: label, pts: round1(v), note: note || '' }); pts += v; }
    var has = function (t) { return I.tags.indexOf(t) >= 0; };
    var companion = e.kind === 'drink' || e.kind === 'side' || e.kind === 'dessert';
    if (I.budget && e.price > I.budget) drop = '超预算';
    if (has('高蛋白')) {
      var pf = 0.6 * clamp(e.protein / 32) + 0.4 * clamp(e.proteinDensity / 6);
      add('protein', '高蛋白', C.protein * (pf * 2 - 0.6), '蛋白' + Math.round(e.protein) + 'g' + (e.nut.est ? '(估)' : ''));
      if (e.protein < C.hardLowProtein && !drop) drop = '蛋白不足';
    }
    if (has('清淡')) {
      var tasteLight = e.taste.indexOf('清淡') >= 0 ? 1 : 0;
      var lf = 0.4 * tasteLight + 0.6 * (1 - e.greasy);
      if (e.kind === 'dessert' || (e.kind === 'drink' && e.nut.kcal > 200)) lf *= C.sweetFactor;
      add('light', '清淡', C.light * (lf * 2 - 1), '油腻指数' + Math.round(e.greasy * 100) + '·脂肪' + Math.round(e.nut.fat) + 'g');
      if (e.greasy >= C.hardGreasy && !drop) drop = '太油腻';
    }
    if (has('顶饱')) add('filling', '顶饱', C.filling * (clamp(e.nut.kcal / 800) * 2 - 0.8), e.nut.kcal + '千卡');
    if (has('省钱')) add('cheap', '省钱', C.cheap * (clamp((40 - e.price) / 30) * 2 - 0.6), '¥' + round1(e.price));
    if (has('提神')) add('perk', '提神', C.perk * ((e.taste.indexOf('提神') >= 0 ? 1 : 0) - 0.3), '');
    var N = I.people || 1;
    if (I.people || I.budget) {
      var per = I.budget ? I.budget / N : null;
      if (N >= 2 && isShareKind(e)) add('people', '多人分享', C.shareBonus, N + '人分享');
      if (N === 1 && isShareKind(e)) add('people', '单人不宜分享', -C.soloSharePenalty, '');
      if (per && (e.kind === 'combo' || e.kind === 'main')) {
        var over = e.price / per - 1;
        if (over > 0) add('budget', '超人均预算', -C.overPerPersonPenalty * clamp(over / 0.6), '人均¥' + round1(per) + '·此品¥' + round1(e.price));
        else if (N >= 2) add('budget', '人均内', C.shareBonus * 0.4, '人均¥' + round1(per));
      }
      if (I.budget && isShareKind(e) && e.price > I.budget * 0.6 && !drop) add('budget', '分享品占预算过半', -C.overPerPersonPenalty * 0.6, '');
    }
    if (!I.empty && companion) add('companion', '配角降权', e.kind === 'drink' ? -C.companionPenalty * 1.5 : -C.companionPenalty * 0.8, '');
    return { pts: pts, parts: parts, drop: drop };
  }

  function toResult(e, base, mode) {
    return { item: e.item, code: e.code, seq: mode, score: base.score, breakdown: base.breakdown,
      reason: '', price: r2(e.price), listPrice: e.listPrice, coupon: e.coupon ? e.coupon.title : null,
      nutrition: e.nut, _e: e };
  }
  function sortResults(rs) {
    return rs.sort(function (a, b) { return b.score - a.score || a._e.listPrice - b._e.listPrice; });
  }

  // applyIntent：items 可以是原始商品数组，也可以是 rankHot/rankNew 的结果（保留其基础分叠加）
  function applyIntent(items, intent, ctx) {
    ctx = ctx || {}; var cfg = cfgOf(ctx), I = normIntent(intent);
    var rs;
    if (items.length && items[0] && items[0].item && items[0]._e) rs = items.map(function (r) { return Object.assign({}, r, { breakdown: r.breakdown.slice() }); });
    else rs = prep(items, ctx, cfg).map(function (e) { return toResult(e, { score: 0, breakdown: [] }, 'intent'); });
    var mode = rs.length && rs[0].seq || 'hot';
    var kept = [], filtered = [];
    rs.forEach(function (r) {
      var adj = intentAdjust(r._e, I, cfg);
      r.intent = adj.parts; r.dropWhy = adj.drop;
      r.score = Math.max(0, r.score + adj.pts);
      adj.parts.forEach(function (p) { r.breakdown.push({ key: p.key, label: '意图·' + p.label, raw: null, weight: null, pts: p.pts, note: p.note }); });
      (adj.drop ? filtered : kept).push(r);
    });
    // 硬过滤：预算超出始终过滤；清淡/蛋白过滤在候选不足时放宽（保证牌堆不空）
    var hardBudget = filtered.filter(function (r) { return r.dropWhy === '超预算'; });
    var soft = filtered.filter(function (r) { return r.dropWhy !== '超预算'; });
    if (kept.length < cfg.intent.minKeep) { soft.sort(function (a, b) { return b.score - a.score; }); while (soft.length && kept.length < cfg.intent.minKeep) { var x = soft.shift(); x.relaxed = true; kept.push(x); } }
    var out = sortResults(kept);
    out.filtered = hardBudget.concat(soft).map(function (r) { return { item: r.item, why: r.dropWhy }; });
    out.intent = I;
    // 预算/人数 → 为前 K 名各配一份凑单组合
    if ((I.people > 1 || I.budget) && !ctx._noBundle) {
      var rawIt = items.length && items[0]._e ? items.map(function (x) { return x.item; }) : items;
      out.slice(0, cfg.intent.bundleTopK).forEach(function (r) {
        r.bundle = buildBundle(rawIt, I, Object.assign({}, ctx, { _noBundle: true }), { anchor: r.item });
        if (!r.bundle.within) { r.score = Math.max(0, r.score - cfg.intent.infeasiblePenalty); r.breakdown.push({ key: 'infeasible', label: '意图·凑不齐预算', raw: null, weight: null, pts: -cfg.intent.infeasiblePenalty, note: r.bundle.note }); }
      });
      sortResults(out);
    }
    out.forEach(function (r) { r.reason = makeReason(r, I, cfg); });
    return out;
  }

  /* ════════════════════ 7. rankHot / rankNew ════════════════════ */
  function rank(items, ctx, mode) {
    ctx = ctx || {}; var cfg = cfgOf(ctx);
    var rs = prep(items, ctx, cfg).map(function (e) { return toResult(e, scoreBase(e, mode, ctx, cfg), mode); });
    var I = normIntent(ctx.intent);
    if (!I.empty) return applyIntent(sortResults(rs), ctx.intent, ctx);
    sortResults(rs).forEach(function (r) { r.reason = makeReason(r, I, cfg); });
    return rs;
  }
  function rankHot(items, ctx) { return rank(items, ctx, 'hot'); }
  function rankNew(items, ctx) { return rank(items, ctx, 'new'); }

  /* ════════════════════ 8. 一行理由 ════════════════════ */
  function makeReason(r, I, cfg) {
    var e = r._e, frags = [], mode = r.seq;
    function bd(k) { return r.breakdown.filter(function (b) { return b.key === k; })[0]; }
    function ip(k) { return (r.intent || []).filter(function (b) { return b.key === k && b.pts > 4; })[0]; }
    if (ip('protein')) frags.push('蛋白' + Math.round(e.protein) + 'g·' + (I.state && I.state.workout ? '练完补充' : '高蛋白'));
    if (ip('light')) frags.push(e.taste.indexOf('清淡') >= 0 ? '清淡不腻' : '脂肪' + Math.round(e.nut.fat) + 'g偏轻');
    if (ip('filling')) frags.push('顶饱' + e.nut.kcal + 'kcal');
    if (ip('cheap')) frags.push('¥' + round1(e.price) + '很省');
    if (r.bundle && I.budget) frags.push(I.people + '人¥' + I.budget + '内·共¥' + round1(r.bundle.total));
    else if (I.budget && ip('budget')) frags.push('人均¥' + round1(I.budget / (I.people || 1)) + '内');
    if (e.coupon) frags.push(e.coupon.units > 1 ? '券：' + e.coupon.title.replace(/^[\d.]+元/, '').replace(/任选\d/, '') + e.coupon.units + '件¥' + e.coupon.price : '券后¥' + round1(e.price));
    else if (e.limitedOff >= 0.2) frags.push('特惠¥' + e.listPrice + '(原¥' + e.origPrice + ')');
    if (mode === 'hot') { if (e.item.category === '人气热卖') frags.push('人气热卖 ' + e.popNote.replace('人气热卖榜 ', '')); else if (e.item.hot) frags.push('人气经典'); else if (e.kind === 'combo') frags.push('套餐更划算'); }
    else if (mode === 'new') {
      var t = e.tags.filter(function (x) { return !/^(上新|单品|套餐|新升级)$/.test(x); })[0];
      frags.push(e.newness ? '新品' + (t ? '·' + t : '') : '店里常青款');
      if (e.camp && e.heat >= 1) frags.push('今日·' + e.camp.title.replace(/·.*/, ''));
    }
    if (!frags.length) frags.push(KIND_CN[e.kind] + '·' + PERIOD_LABEL[e.period] + '合适');
    r.reasonLong = frags.join(' · ');
    var out = [], len = 0;
    frags.forEach(function (f) { if (len + f.length <= 30 && out.length < 3) { out.push(f); len += f.length + 3; } });
    return out.length ? out.join(' · ') : frags[0];
  }

  /* ════════════════════ 9. 凑单：N 人 + 预算 → 组合（分组背包 DP，价格真算）════════════════════ */
  function buildBundle(items, intent, ctx, opts) {
    ctx = Object.assign({}, ctx || {}); opts = opts || {}; var cfg = cfgOf(ctx), BC = cfg.bundle, I = normIntent(intent);
    var N = Math.max(1, I.people || 1), B = I.budget || N * 35;
    var rawItems = items.length && items[0] && items[0].item && items[0]._e ? items.map(function (r) { return r.item; }) : items;
    var Es = prep(rawItems, ctx, cfg);
    // 每个商品的效用 = (0.55·爆品分 + 0.45·新品分) + 意图加减分；被意图过滤的不入池
    var pool = [];
    Es.forEach(function (e) {
      var adj = intentAdjust(e, I, cfg); if (adj.drop && !(opts.anchor && opts.anchor.code === e.code)) return;
      var u = BC.blend.hot * scoreBase(e, 'hot', ctx, cfg).score + BC.blend.new * scoreBase(e, 'new', ctx, cfg).score + adj.pts;
      pool.push({ e: e, u: Math.max(1, u) });
    });
    var byCode = {}; pool.forEach(function (p) { byCode[p.e.code] = p; });
    var T = function (x) { return Math.round(x * 10); };                 // 价格 → 0.1 元整数
    var anchor = opts.anchor && byCode[opts.anchor.code];
    var usedCoupon = {};                                                  // 券已用份数
    function priceOf(e, copyIdx) { return e.coupon && copyIdx === 0 && (usedCoupon[e.coupon.id] || 0) < e.coupon.units ? e.unitCoupon : e.listPrice; }
    var lines = [], spent = 0;
    function addLine(p, price, note) {
      var ex = lines.filter(function (l) { return l.item.code === p.e.code; })[0];
      var usedCp = price < p.e.listPrice - 1e-9;
      if (usedCp) usedCoupon[p.e.coupon.id] = (usedCoupon[p.e.coupon.id] || 0) + 1;
      if (ex) { ex.qty++; ex.subtotal = r2(ex.subtotal + price); } else lines.push({ item: p.e.item, qty: 1, unitPrice: r2(price), listPrice: p.e.listPrice, subtotal: r2(price), coupon: usedCp ? p.e.coupon.title : null, role: note });
      spent += price;
    }
    var drinks = pool.filter(function (p) { return p.e.kind === 'drink'; }).sort(function (a, b) { return b.u / b.e.price - a.u / a.e.price; }).slice(0, 4);
    // 分组背包：每个“主食/套餐”是一组，组内选项 = 取 1 份或 2 份（各自配饮品）；同组只能选一个选项 → 同款最多 2 份，券只用一次
    var groups = [];
    pool.forEach(function (p) {
      if (p.e.kind !== 'combo' && p.e.kind !== 'main') return;
      if (forcedAnchor(p)) return;
      var ds = p.e.kind === 'combo' ? [null] : drinks.concat([null]), opts = [];
      ds.forEach(function (d1) {
        var c1 = p.e.price + (d1 ? d1.e.price : 0), u1 = p.e.kind === 'main' && !d1 ? p.u * 0.75 : p.u + (d1 ? 0.75 * d1.u : 0);
        opts.push({ q: 1, cost: T(c1), u: u1, parts: [{ p: p, d: d1 }] });
        if (BC.maxCopies >= 2) ds.forEach(function (d2, j) {
          if (ds.indexOf(d1) > j) return;
          var c2 = c1 + p.e.listPrice + (d2 ? d2.e.price : 0), u2 = u1 + BC.secondCopyFactor * (p.e.kind === 'main' && !d2 ? p.u * 0.75 : p.u + (d2 ? 0.75 * d2.u : 0));
          opts.push({ q: 2, cost: T(c2), u: u2, parts: [{ p: p, d: d1 }, { p: p, d: d2 }] });
        });
      });
      groups.push(opts);
    });
    function forcedAnchor(p) { return anchor && (anchor.e.kind === 'combo' || anchor.e.kind === 'main') && p === anchor; }
    var forcedUnit = null, extrasForced = [];
    if (anchor) {
      if (anchor.e.kind === 'combo' || anchor.e.kind === 'main') {
        var ds0 = anchor.e.kind === 'combo' ? [null] : drinks;
        forcedUnit = ds0.map(function (d) { return { p: anchor, d: d, u: anchor.u + (d ? 0.75 * d.u : 0), c: anchor.e.price + (d ? d.e.price : 0) }; })
          .filter(function (x) { return x.c <= B; }).sort(function (a, b) { return b.u / b.c - a.u / a.c; })[0] || { p: anchor, d: null, u: anchor.u, c: anchor.e.price };
      } else extrasForced.push(anchor);
    }
    var needUnits = N;
    if (forcedUnit) { addLine(forcedUnit.p, priceOf(forcedUnit.p.e, 0), forcedUnit.p.e.kind === 'combo' ? '套餐' : '主食'); if (forcedUnit.d) addLine(forcedUnit.d, priceOf(forcedUnit.d.e, 0), '饮品'); needUnits--; }
    extrasForced.forEach(function (p) { addLine(p, priceOf(p.e, 0), '你正在看'); });
    var rest = B - spent;
    var CAP = Math.max(0, T(rest)), K = needUnits, NEG = -1e9;
    var dp = []; for (var k = 0; k <= K; k++) dp.push(new Float64Array(CAP + 1).fill(NEG));
    dp[0][0] = 0;
    var stride = (K + 1) * (CAP + 1), picks = new Uint8Array(groups.length * stride);
    groups.forEach(function (opts, gi) {
      for (var kk = K; kk >= 1; kk--) for (var c = CAP; c >= 0; c--) {
        for (var oi = 0; oi < opts.length; oi++) {
          var o = opts[oi]; if (o.q > kk || o.cost > c) continue;
          var prev = dp[kk - o.q][c - o.cost]; if (prev === NEG) continue;
          if (prev + o.u > dp[kk][c]) { dp[kk][c] = prev + o.u; picks[gi * stride + kk * (CAP + 1) + c] = oi + 1; }
        }
      }
    });
    // 3) 分享/小食/甜品追加：贪心（效用/价格）；在每个成本点评估总目标，选最优
    var extraPool = pool.filter(function (p) { return (p.e.kind === 'share' || p.e.kind === 'side' || p.e.kind === 'dessert') && !extrasForced.some(function (f) { return f.e.fam === p.e.fam; }); })
      .sort(function (a, b) { return b.u / b.e.price - a.u / a.e.price; });
    var extraMax = BC.extraMax + Math.floor(N / 3);
    function fillExtras(budgetLeft) {
      var pickE = [], left = budgetLeft, sum = 0, fams = {}, couponLeft = {};
      extraPool.forEach(function (p) {
        if (pickE.length >= extraMax || fams[p.e.fam]) return;
        var cp = p.e.coupon, cl = cp ? (couponLeft[cp.id] === undefined ? cp.units - (usedCoupon[cp.id] || 0) : couponLeft[cp.id]) : 0;
        var pr = cp && cl > 0 ? p.e.unitCoupon : p.e.listPrice;
        if (T(pr) <= T(left)) { pickE.push({ p: p, price: pr, cp: cp && cl > 0 }); left -= pr; sum += p.u; fams[p.e.fam] = 1; if (cp && cl > 0) couponLeft[cp.id] = cl - 1; }
      });
      return { picks: pickE, sum: sum, left: left };
    }
    var bestC = -1, bestObj = NEG, bestEx = null;
    if (K === 0) { bestC = 0; bestEx = fillExtras(rest); bestObj = 0; }
    else for (var cc = 0; cc <= CAP; cc++) {
      if (dp[K][cc] === NEG) continue;
      var ex = fillExtras(rest - cc / 10);
      var spentAll = B - ex.left, obj = dp[K][cc] + BC.extraFactor * ex.sum + BC.useBudgetBonus * clamp(spentAll / B);
      if (obj > bestObj) { bestObj = obj; bestC = cc; bestEx = ex; }
    }
    var feasible = bestC >= 0;
    if (!feasible) {   // 预算连每人最便宜的一份都不够：退而求其次，每人最便宜主食
      var cheapMain = pool.filter(function (p) { return p.e.kind === 'main' || p.e.kind === 'combo'; }).sort(function (a, b) { return a.e.price - b.e.price; })[0];
      for (var q = 0; q < K && cheapMain; q++) addLine(cheapMain, q === 0 ? priceOf(cheapMain.e, 0) : cheapMain.e.listPrice, '主食');
    } else {
      // 回溯所选单元
      var cur = bestC, kleft = K;
      for (var gi2 = groups.length - 1; gi2 >= 0 && kleft > 0; gi2--) {
        var oi2 = picks[gi2 * stride + kleft * (CAP + 1) + cur]; if (!oi2) continue;
        var o2 = groups[gi2][oi2 - 1];
        o2.parts.forEach(function (pt) {
          var ex0 = lines.filter(function (l) { return l.item.code === pt.p.e.code; })[0];
          addLine(pt.p, priceOf(pt.p.e, ex0 ? ex0.qty : 0), pt.p.e.kind === 'combo' ? '套餐' : '主食');
          if (pt.d) { var ex1 = lines.filter(function (l) { return l.item.code === pt.d.e.code; })[0]; addLine(pt.d, priceOf(pt.d.e, ex1 ? ex1.qty : 0), '饮品'); }
        });
        cur -= o2.cost; kleft -= o2.q;
      }
      bestEx.picks.forEach(function (x) { addLine(x.p, x.cp ? x.p.e.unitCoupon : x.p.e.listPrice, '分享'); if (x.cp) { /* 券份数已在 addLine 中计数 */ } });
    }
    // 同一款饮品最多 2 杯：超出的换成别的饮品（不超预算）
    lines.slice().forEach(function (l) {
      while (l.role === '饮品' && l.qty > 2) {
        var alt = drinks.concat(pool.filter(function (p) { return p.e.kind === 'drink'; })).filter(function (p) {
          var ex = lines.filter(function (x) { return x.item.code === p.e.code; })[0]; return p.e.code !== l.item.code && (!ex || ex.qty < 2) && spent - l.unitPrice + p.e.price <= B + 1e-9; })
          .sort(function (a, b) { return b.u - a.u; })[0];
        if (!alt) break;
        l.qty--; l.subtotal = r2(l.subtotal - l.unitPrice); spent -= l.unitPrice; addLine(alt, alt.e.price, '饮品');
      }
    });
    spent = r2(spent);
    var cnt = 0; lines.forEach(function (l) { cnt += l.qty; });
    var listTotal = 0; lines.forEach(function (l) { listTotal += l.listPrice * l.qty; });
    var summary = lines.map(function (l) { return l.item.name.replace(/[“”]/g, '') + (l.qty > 1 ? '×' + l.qty : '') + (l.coupon ? (l.qty > 1 ? '(1份用券)' : '(券)') : ''); }).join(' + ');
    return { people: N, budget: B, lines: lines, count: cnt, total: spent, perPerson: round1(spent / N), left: round1(B - spent),
      within: spent <= B + 1e-9, saved: round1(listTotal - spent), summary: summary,
      note: spent <= B ? ('共¥' + spent + '，人均¥' + round1(spent / N) + (B - spent > 0.05 ? '，还剩¥' + round1(B - spent) : '') + (listTotal - spent > 0.05 ? '，用券省¥' + round1(listTotal - spent) : '')) : ('预算不够，最低也要¥' + spent) };
  }

  /* ════════════════════ 10. 语音意图解析（轻量规则；真实场景由 LLM 产出同结构 intent）════════════════════ */
  var CNUM = { 零: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 仨: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  function cnToNum(s) {
    if (/^\d+$/.test(s)) return +s;
    var m = s.match(/^([一二两三四五六七八九])?百([一二两三四五六七八九])?(?:十)?$/);
    if (m) { return (CNUM[m[1]] || 1) * 100 + (m[2] ? (s.indexOf('十') >= 0 ? CNUM[m[2]] * 10 : CNUM[m[2]] * 10) : 0); }
    m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
    if (m) return (m[1] ? CNUM[m[1]] : 1) * 10 + (m[2] ? CNUM[m[2]] : 0);
    return s.length === 1 && CNUM[s] !== undefined ? CNUM[s] : null;
  }
  function parseIntent(text) {
    var t = String(text || ''), o = { text: t, tags: [], state: {} };
    var m = t.match(/(\d+|[一二两俩三仨四五六七八九])\s*(?:个)?\s*(?:人|位)/);
    if (m) o.people = cnToNum(m[1]);
    if (/一个人|我自己|单人|自己吃/.test(t)) o.people = 1;
    var NUMRE = '(\\d+|[一二两三四五六七八九]?百[一二两三四五六七八九]?|[一二两三四五六七八九]?十[一二三四五六七八九]?)';
    var b = t.match(new RegExp('预算\\s*' + NUMRE)) || t.match(new RegExp('[¥￥]\\s*' + NUMRE)) || t.match(new RegExp(NUMRE + '\\s*(?:块|元|以内|左右)'));
    if (b) o.budget = cnToNum(b[1]);
    else if (o.people) { var rest = t.replace(m ? m[0] : '', ''); var n = rest.match(/\d{2,4}/); if (n) o.budget = +n[0]; }
    if (/健身|练完|撸铁|增肌|练了|运动/.test(t)) o.state.workout = true;
    if (/高蛋白|蛋白|增肌|健身|练完|撸铁/.test(t)) o.tags.push('高蛋白');
    if (/(昨天|昨晚|前天|刚|太|最近).{0,4}(油腻|吃多|吃撑|大鱼大肉|重口|辣)|油腻/.test(t)) o.state.greasy = true;
    if (/清淡|清爽|不油|少油|低脂|减脂|低卡|轻食|清清/.test(t) || o.state.greasy) o.tags.push('清淡');
    if (/顶饱|管饱|很饿|饿死|多吃/.test(t)) o.tags.push('顶饱');
    if (/省钱|便宜|实惠|划算/.test(t)) o.tags.push('省钱');
    if (/提神|犯困|困了|咖啡/.test(t)) o.tags.push('提神');
    return o;
  }

  /* ════════════════════ 11. 左右滑牌堆（去重 + 两序互斥）════════════════════ */
  // 草稿式分配：两条序轮流“挑牌”，同一道菜只归一边（谁相对更需要它就归谁），保证
  //  ① 两序首张不同 ② 全程不重复 ③ 每条序内部顺序不变。单点/三件套视作同一道菜（familyKey）。
  function createDeck(items, ctx) {
    ctx = ctx || {}; var cfg = cfgOf(ctx), D = cfg.deck;
    var seq = { new: rankNew(items, ctx), hot: rankHot(items, ctx) };
    var sides = { left: D.swipe.left, right: D.swipe.right };
    var lists = { new: [], hot: [] }, taken = {}, takenFam = {};
    var ptr = { new: 0, hot: 0 }, top = { new: seq.new[0] ? seq.new[0].score : 1, hot: seq.hot[0] ? seq.hot[0].score : 1 };
    function claimable(r) { return !taken[r.code] && !(D.familyDedupe && takenFam[r._e.fam]); }
    function head(m) { while (ptr[m] < seq[m].length && !claimable(seq[m][ptr[m]])) ptr[m]++; return seq[m][ptr[m]]; }
    if (D.exclusive) {
      var first = sides.left === 'new' ? ['new', 'hot'] : ['hot', 'new'];
      for (var guard = 0; guard < 4 * (items.length + 2); guard++) {
        var a = head('new'), b = head('hot'); if (!a && !b) break;
        function give(m, r) { if (!r) return; taken[r.code] = 1; takenFam[r._e.fam] = 1; lists[m].push(r); ptr[m]++; }
        if (a && b && a.code === b.code) {
          // 争同一张：谁“相对榜首”的分更高归谁；平手给新品序（新品稀缺）
          var ra = a.score / top.new, rb = b.score / top.hot;
          if (ra >= rb) { give('new', a); give('hot', head('hot')); } else { give('hot', b); give('new', head('new')); }
        } else { give('new', a); give('hot', head('hot')); }
      }
    } else { lists.new = seq.new.slice(); lists.hot = seq.hot.slice(); }
    var cur = { new: 0, hot: 0 }, seen = {};
    function listFor(dir) { return lists[sides[dir]]; }
    function nextUnseen(m, from) { var L = lists[m]; for (var i = from; i < L.length; i++) if (!seen[L[i].code]) return i; return L.length; }
    return {
      sides: sides, lists: lists, sequences: seq,
      heads: function () { return { left: this.peek('left', 1)[0] || null, right: this.peek('right', 1)[0] || null }; },
      peek: function (dir, n) { var m = sides[dir], L = lists[m], out = [], i = nextUnseen(m, cur[m]); while (out.length < (n || D.peek) && i < L.length) { out.push(L[i]); i = nextUnseen(m, i + 1); } return out; },
      next: function (dir) {                       // 往 dir 方向再翻一张；返回刚翻出的牌（沿同序往下）
        var m = sides[dir], i = nextUnseen(m, cur[m]); if (i >= lists[m].length) return null;
        var r = lists[m][i]; seen[r.code] = 1; cur[m] = i + 1; return r; },
      remaining: function (dir) { var m = sides[dir]; return lists[m].filter(function (r) { return !seen[r.code]; }).length - 0; },
      reset: function () { cur.new = cur.hot = 0; seen = {}; }
    };
  }

  return {
    CONFIG: CONFIG, DEFAULT_COUPONS: DEFAULT_COUPONS, DEFAULT_CAMPAIGNS: DEFAULT_CAMPAIGNS, NUTRITION: NUTRITION,
    rankHot: rankHot, rankNew: rankNew, applyIntent: applyIntent, buildBundle: function (it, intent, ctx, o) { return buildBundle(it, normIntent(intent), ctx, o); },
    createDeck: createDeck, parseIntent: parseIntent, normIntent: normIntent, familyKey: familyKey
  };
});
