/* intent.js — 把一句话（语音识别结果 / 打字）解析成：新推荐意图 | 改单 | 需要回问
 *  依赖 MaiRec.parseIntent（健身高蛋白 / 油腻想清淡 / 几人+预算），在此基础上补口语：
 *  「便宜点」「不要辣」「想吃鸡」「早餐」…；改单：「不要牛奶，换个饮料」「换成可乐」「只换饮料」
 *  能解析多少解析多少；解析不出 → kind:'clarify'（agent 一句话回问 + 标签按钮），不乱推。 */
(function (root) {
  'use strict';
  var Mai = (root.Mai = root.Mai || {});
  var MR = root.MaiRec;

  var CAT_WORDS = [
    ['drink', /饮料|饮品|喝的|喝点|喝什么|饮|杯子/],
    ['side', /小食|配菜|零食|小吃|甜品|点心|薯条|炸鸡|麦乐鸡|玉米|苹果片|芝士条|薯饼/],
    ['main', /汉堡|主食|主餐|套餐|堡/]
  ];
  // 口语 → 菜单里的商品（短名子串匹配）。找不到的（如“雪碧”）会回问。
  var ALIAS = [
    [/可乐/, ['可乐']], [/牛奶|奶茶|奶/, ['奶铁', '奶昔']], [/咖啡|美式|拿铁|提神/, ['美式', '奶铁']],
    [/红茶|茶/, ['红茶']], [/柠檬|柠柠|果汁/, ['柠']], [/矿泉水|纯净水|纯悦|白开水|水/, ['纯悦']],
    [/奶昔/, ['奶昔']], [/黑巧|巧克力/, ['黑巧']], [/薯条/, ['薯条']], [/麦乐鸡|鸡块/, ['麦乐鸡']], [/蘸酱|炸鸡/, ['蘸酱炸鸡']],
    [/玉米/, ['玉米']], [/苹果/, ['苹果']], [/薯饼/, ['薯饼']], [/芝士条|芝士棒/, ['芝士条']]
  ];
  var NOT_IN_MENU = /雪碧|芬达|七喜|豆浆|啤酒|冰淇淋|圣代|奶茶/;

  function norm(t) { return String(t || '').replace(/[，。！？、,.!?\s]+/g, ' ').trim(); }

  function shortMatches(words) {
    var I = Mai.sets.info(), out = [];
    Object.keys(I).forEach(function (c) { var s = I[c].short; if (words.some(function (w) { return s.indexOf(w) >= 0; })) out.push(c); });
    return out;
  }

  /* ── 改单解析：返回 {cat, target:[code]|null, avoid:RegExp|null, cheaper, unknown} 或 null ── */
  function parseEdit(text) {
    var t = String(text || '');
    var verb = /换|不要|不想要|别要|去掉|改成|改为|替换|不喝|不吃|来杯|来个|加个/.test(t);
    var cheaperWord = /便宜|省钱|实惠/.test(t);
    var cat = null;
    // 优先看“换成/换个/改成 X”里的 X，其次整句
    var tail = (t.match(/(?:换成|换个|换点|改成|改为|换|来杯|来个)([^，。！？,.!?]*)$/) || [])[1] || '';
    var head = (t.match(/(?:不要|不想要|别要|去掉|不喝|不吃)([^，。！？,.!?换改]*)/) || [])[1] || '';
    var target = null, avoid = null, unknown = null;
    if (/^(?:换个|换点|换一个|换一种)$/.test(tail.trim()) === false && tail) {
      for (var i = 0; i < ALIAS.length; i++) if (ALIAS[i][0].test(tail)) {
        var codes = shortMatches(ALIAS[i][1]);
        if (codes.length) { target = codes; break; }
      }
      if (!target && NOT_IN_MENU.test(tail)) unknown = (tail.match(NOT_IN_MENU) || [])[0];
    }
    if (target) { var inf0 = Mai.sets.info(); cat = inf0[target[0]].cat; }
    if (head) {
      for (var j = 0; j < ALIAS.length; j++) if (ALIAS[j][0].test(head)) {
        var names = ALIAS[j][1]; avoid = new RegExp(names.map(function (n) { return n; }).join('|'));
        if (j === 1) avoid = /奶/;      // 牛奶 → 所有带奶的饮品
        if (!cat) { var c0 = shortMatches(names); if (c0.length) cat = Mai.sets.info()[c0[0]].cat; }
        break;
      }
    }
    if (!cat) for (var k = 0; k < CAT_WORDS.length; k++) if (CAT_WORDS[k][1].test(t)) { cat = CAT_WORDS[k][0]; break; }
    if (!cat && unknown) cat = 'drink';
    if (!verb && !(cat && /只换/.test(t))) return null;
    if (!cat) return null;
    return { cat: cat, target: target, avoid: avoid, cheaper: cheaperWord, unknown: unknown };
  }

  /* ── 推荐意图解析 ── */
  function parseFlags(t) {
    var f = {};
    if (/不要辣|不吃辣|别太辣|不辣|怕辣|少辣|不要太辣|别辣/.test(t)) f.noSpicy = true;
    if (/便宜|省钱|实惠|划算|经济|穷/.test(t)) f.cheaper = true;
    if (/想吃鸡|吃鸡|鸡肉|鸡腿|炸鸡|来点鸡/.test(t)) f.like = 'chicken';
    else if (/牛肉|牛堡|吃牛/.test(t)) f.like = 'beef';
    else if (/吃鱼|鱼堡|海鲜|三文鱼/.test(t)) f.like = 'fish';
    if (/早餐|早饭|早点|早上/.test(t)) f.meal = 'breakfast';
    return f;
  }

  /* parse(text, ctx)：ctx = {hasStack:boolean, last:{mi,flags}|null}
   * 返回：
   *  {kind:'empty'}                                  没内容/太短
   *  {kind:'edit', edit}                             改单
   *  {kind:'recommend', mi, flags, refine:boolean}   新推荐（refine=在上一次意图上追加约束）
   *  {kind:'clarify', text}                          解析不出 */
  function parse(text, ctx) {
    ctx = ctx || {};
    var raw = String(text || ''), t = norm(raw).replace(/\s/g, '');
    if (t.length < 2) return { kind: 'empty' };
    var mi = MR.parseIntent(raw), flags = parseFlags(t);
    var topicTags = mi.tags.filter(function (x) { return x !== '省钱'; });
    var hasTopic = !!(mi.people || mi.budget || topicTags.length || mi.state.workout || mi.state.greasy);
    if (ctx.hasStack && !hasTopic) {
      var ed = parseEdit(raw);
      if (ed) return { kind: 'edit', edit: ed };
    }
    if (flags.cheaper && mi.tags.indexOf('省钱') < 0) mi.tags.push('省钱');
    var hasRefine = !!(flags.noSpicy || flags.cheaper || flags.like || flags.meal);
    if (!hasTopic && !hasRefine) {
      if (/顶饱|饱|饿/.test(t)) { mi.tags.push('顶饱'); hasTopic = true; }
      else return { kind: 'clarify', text: '想吃得饱一点还是清淡一点？', chips: ['吃得饱一点', '清淡一点', '高蛋白'] };
    }
    if (!hasTopic && ctx.last) {                // 只有修饰（便宜点/不要辣/想吃鸡）→ 在上一次意图上追加
      var m = JSON.parse(JSON.stringify(ctx.last.mi)), f = Object.assign({}, ctx.last.flags, flags);
      mi.tags.forEach(function (x) { if (m.tags.indexOf(x) < 0) m.tags.push(x); });
      return { kind: 'recommend', mi: m, flags: f, refine: true, text: raw };
    }
    if (flags.meal === 'breakfast' && mi.tags.indexOf('清淡') < 0 && !hasTopic) mi.tags.push('清淡');
    return { kind: 'recommend', mi: mi, flags: flags, refine: false, text: raw };
  }


  /* ── 大模型 Agent 结构化意图 → 与 parse() 同构的结果（浏览器与 Node 服务端共用，保证本地渲染 = 服务端工具里算的那一套）──
   *  a = {people, budget, tags[], workout, greasy, noSpicy, cheaper, like:'chicken|beef|fish', breakfast, refine}
   *  只认白名单字段，其余丢弃；推荐出什么、多少钱仍由 recommend.js + sets.js 算，模型不参与。 */
  var TAGS_OK = ['高蛋白', '清淡', '顶饱', '省钱', '提神'];
  function fromAgent(a, ctx) {
    a = a || {}; ctx = ctx || {};
    var mi = { text: String(a.text || ''), tags: [], state: {} }, flags = {};
    var n = Math.round(+a.people), b = Math.round(+a.budget);
    if (n >= 1 && n <= 20) mi.people = n;
    if (b >= 10 && b <= 2000) mi.budget = b;
    (Array.isArray(a.tags) ? a.tags : []).forEach(function (t) { if (TAGS_OK.indexOf(t) >= 0 && mi.tags.indexOf(t) < 0) mi.tags.push(t); });
    if (a.workout === true) mi.state.workout = true;
    if (a.greasy === true) mi.state.greasy = true;
    if (a.noSpicy === true) flags.noSpicy = true;
    if (a.cheaper === true) { flags.cheaper = true; if (mi.tags.indexOf('省钱') < 0) mi.tags.push('省钱'); }
    if (['chicken', 'beef', 'fish'].indexOf(a.like) >= 0) flags.like = a.like;
    if (a.breakfast === true) flags.meal = 'breakfast';
    var hasTopic = !!(mi.people || mi.budget || mi.state.workout || mi.state.greasy || mi.tags.filter(function (x) { return x !== '省钱'; }).length);
    if (!hasTopic && ctx.last && (a.refine === true || flags.noSpicy || flags.cheaper || flags.like || flags.meal)) {
      var m = JSON.parse(JSON.stringify(ctx.last.mi)), f = Object.assign({}, ctx.last.flags, flags);
      mi.tags.forEach(function (x) { if (m.tags.indexOf(x) < 0) m.tags.push(x); });
      return { kind: 'recommend', mi: m, flags: f, refine: true, text: mi.text };
    }
    if (flags.meal === 'breakfast' && !hasTopic && mi.tags.indexOf('清淡') < 0) mi.tags.push('清淡');
    return { kind: 'recommend', mi: mi, flags: flags, refine: false, text: mi.text };
  }
  /* e = {cat, target:[code], avoidSrc:string|null, cheaper, unknown} （服务端已按菜单校验）→ parseEdit 同构 */
  function fromAgentEdit(e) {
    e = e || {};
    if (['drink', 'side', 'main'].indexOf(e.cat) < 0) return null;
    var avoid = null;
    if (e.avoidSrc) { try { avoid = new RegExp(String(e.avoidSrc).slice(0, 60)); } catch (_) { avoid = null; } }
    return { kind: 'edit', edit: { cat: e.cat, target: Array.isArray(e.target) && e.target.length ? e.target : null, avoid: avoid, cheaper: !!e.cheaper, unknown: e.unknown || null } };
  }

  /* 标签按钮 / 示例快捷语对应的文本 */
  var CHIP_TEXT = { '吃得饱一点': '想吃得饱一点，顶饱的', '清淡一点': '想清淡一点', '高蛋白': '来点高蛋白的' };

  Mai.intent = { fromAgent: fromAgent, fromAgentEdit: fromAgentEdit, parse: parse, parseEdit: parseEdit, parseFlags: parseFlags, CHIP_TEXT: CHIP_TEXT };
})(typeof window !== 'undefined' ? window : globalThis);
