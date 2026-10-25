'use strict';
/* agent.js — 麦麦点餐 Agent：DeepSeek function calling，服务端循环（最多 4 轮工具调用）。
 * DeepSeek key 只从 process.env.DEEPSEEK_API_KEY 读取，不写日志、不下发前端。*/
const E = require('./engine'), T = require('./tools');
const API = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const MAX_ROUNDS = 4;
const DEADLINE_MS = +process.env.AGENT_DEADLINE_MS || 8000;

const SYSTEM = `你是「麦麦」，麦当劳点餐小助手，懂你的导购。说话口语、亲切、有点可爱，像朋友聊天，不生硬、不官腔。
规则：
1. 回复最多3句话、尽量短；纯文字，不要 markdown、不要列表、不要表情符号堆砌。「蛋白质」整段话最多出现一次，别反复说。
2. 什么问题都可以聊（闲聊、热量、过敏、怎么吃、门店、优惠、天气、你是谁……），与点餐无关也正常回答，别拒答。你没有实时天气/新闻等信息时就坦白说看不到，再接一句轻松的话。你是麦麦，不要说自己是什么大模型或哪家公司的模型。
3. 价格、热量、营养、优惠、门店这类「事实」只能用工具查到的结果，绝不凭记忆或编造；没有调工具之前不要报任何数字。回复里的数字只能原样引用工具返回的数字，不要自己加减乘除（差价用工具给的 price_delta）。不要编造菜单之外的菜品；用户问菜单外的（如雪碧）可以查营养，但要说明店里菜单（演示店）没有上架。
4. 工具选择：配餐/推荐/「来点…」→ recommend_meal；换一个东西（换成可乐、不要牛奶）→ edit_meal（只换一行）；「换一套/再来一套」→ next_card；热量/营养/卡路里/过敏→ get_nutrition；多少钱→ calculate_price；优惠/券→ query_coupons；门店/地址/营业时间→ store_info；放进购物车→ add_to_cart；看购物车→ open_cart；下单/结算/买单/付款→ checkout。不需要工具的直接回答。
5. 下单和支付：这是演示，支付是假的，不会真的扣款，也没有在麦当劳真的下单。只能说「帮你放进购物车」「带你去结算页」，要用户自己在结算页点支付。不要声称已经付款或下单成功。购物车和餐卡都没有时，先问想吃什么再配，不要直接下单。
6. 过敏原：营养数据里没有过敏原信息，被问到就诚实说明，建议以门店/包装标注为准，不要下结论。
7. 配餐/换餐成功后，用1-2句话口语化地说明为什么这么搭（只引用工具返回的菜名和数字，别凭空夸）。工具返回失败时，如实说明并给下一步建议。
8. 用户的话含糊（如「随便搞搞」）但意思是要点餐时，可以直接 recommend_meal 给一套通用推荐；完全看不出想干嘛才回问一句。
9. 如果当前状态里有餐卡，用户说「这个」「这套」指的就是当前餐卡。`;

function stateBlock(c) {
  const st = { 当前餐卡: null, 购物车: { 件数: 0 }, 上一次意图: c.last ? { 标签: c.last.mi && c.last.mi.tags, 人数: c.last.mi && c.last.mi.people, 预算: c.last.mi && c.last.mi.budget, 状态: c.last.mi && c.last.mi.state, 限制: c.last.flags } : null,
    演示门店: E.STORE.name, 菜单可选商品: E.menu() };
  if (c.card) { const rs = E.rowsToSet(c.card); if (rs) st.当前餐卡 = E.setSummary(rs.set); }
  if (c.cart && c.cart.count) {
    const INF = E.S.info();
    st.购物车 = { 件数: c.cart.count, 总价: c.cart.total, 菜品: (c.cart.entries || []).map(e => (e.rows || []).map(r => (INF[r.code] ? INF[r.code].short : '?') + '×' + r.qty).join('、')).slice(0, 6) };
  }
  return JSON.stringify(st);
}
function numbersIn(s) { return (String(s).match(/\d+(?:\.\d+)?/g) || []).map(Number); }
function badNumbers(reply, allowed) {
  return numbersIn(reply).filter(n => !(Number.isInteger(n) && n < 10) && !allowed.some(a => Math.abs(a - n) < 1e-6));
}
function cleanReply(s) {
  s = String(s || '').replace(/[*_`#>]+/g, '').replace(/\n{2,}/g, '\n').trim();
  if (s.length > 170) { const cut = s.slice(0, 170), i = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('～'), cut.lastIndexOf('？')); s = i > 30 ? cut.slice(0, i + 1) : cut; }
  return s;
}
function dropBadSentences(reply, allowed) {
  const parts = reply.match(/[^。！？!?\n]+[。！？!?～]*/g) || [reply];
  return parts.filter(p => !badNumbers(p, allowed).length).join('').trim();
}

async function llm(messages, withTools, deadline) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('no_key');
  const left = deadline - Date.now();
  if (left < 600) throw new Error('deadline');
  const body = { model: MODEL, messages, temperature: 0.3, max_tokens: 400 };
  if (withTools) { body.tools = T.SCHEMA; body.tool_choice = 'auto'; }
  const r = await fetch(API, { method: 'POST', signal: AbortSignal.timeout(Math.min(left, 7000)), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('llm_http_' + r.status);
  const j = await r.json();
  const m = j.choices && j.choices[0] && j.choices[0].message;
  if (!m) throw new Error('llm_empty');
  return m;
}
const STATUS = { recommend_meal: '在帮你搭配…', edit_meal: '在帮你换…', next_card: '在翻另一套…', get_nutrition: '在查麦当劳的营养数据…', calculate_price: '在用麦当劳的算价接口算价…',
  query_coupons: '在看有什么优惠…', store_info: '在查门店信息…', add_to_cart: '在放进购物车…', open_cart: '在打开购物车…', checkout: '在准备去结算…' };

/* input: {messages:[{role,content}], context:{card,cart,last}}；onStatus(text) 可选 */
async function run(input, onStatus) {
  const t0 = Date.now(), deadline = t0 + DEADLINE_MS;
  const say = t => { try { onStatus && onStatus(t); } catch (_) {} };
  const ctx = input.context || {};
  const msgsIn = (Array.isArray(input.messages) ? input.messages : []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-10).map(m => ({ role: m.role, content: m.content.slice(0, 200) }));
  if (!msgsIn.length || msgsIn[msgsIn.length - 1].role !== 'user') return { ok: false, reason: 'bad_input' };
  const userText = msgsIn[msgsIn.length - 1].content;
  const c = { card: ctx.card || null, cart: ctx.cart || null, last: ctx.last || null, _text: userText };
  const state = stateBlock(c);
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'system', content: '当前状态（JSON，事实以此为准）：' + state }].concat(msgsIn);
  const used = [], ui = { card: null, actions: [] }, results = [];
  let reply = null, rounds = 0;
  try {
    for (; rounds <= MAX_ROUNDS; rounds++) {
      const m = await llm(messages, rounds < MAX_ROUNDS, deadline);
      const calls = m.tool_calls || [];
      if (!calls.length) { reply = m.content || ''; break; }
      messages.push({ role: 'assistant', content: m.content || '', tool_calls: calls });
      const outs = await Promise.all(calls.map(async tc => {
        const name = tc.function && tc.function.name; let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}
        say(STATUS[name] || '在想…');
        const impl = T.IMPL[name]; let r;
        if (!impl) r = { ok: false, error: 'unknown_tool' };
        else { try { r = await impl(args, c); } catch (e) { r = { ok: false, error: 'tool_failed' }; } }
        return { tc, name, r };
      }));
      outs.forEach(({ tc, name, r }) => {
        used.push({ name, ok: !!r.ok, source: r.source || (r.ok ? 'local' : undefined), mcp: !!T.MCP_TOOLS[name] && /mcp/.test(r.source || '') });
        if (r.ok && r.ui) { if (r.ui.card) ui.card = r.ui.card; if (r.ui.actions) r.ui.actions.forEach(a => ui.actions.push(a)); }
        const { ui: _u, ...forModel } = r; results.push(forModel);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(forModel) });
      });
      say('在想怎么跟你说…');
    }
  } catch (e) {
    if (!used.some(u => u.ok) || !(ui.card || ui.actions.length)) return { ok: false, reason: String(e.message || e).slice(0, 40), toolsUsed: used };
    reply = null;                                         // 工具已经执行完、只差口语文案：前端用模板文案兜底
  }
  if (reply != null) {
    reply = cleanReply(reply);
    const allowed = numbersIn(userText + ' ' + state + ' ' + JSON.stringify(results)), bad = badNumbers(reply, allowed);
    if (bad.length) {
      try {
        messages.push({ role: 'assistant', content: reply });
        messages.push({ role: 'user', content: '（系统提示）你上一句里的数字 ' + bad.join('、') + ' 不是工具返回的，请重写这句回复：只能用工具给的数字，没有就不要提数字。' });
        reply = cleanReply((await llm(messages, false, deadline)).content || '');
      } catch (_) { reply = ''; }
      if (badNumbers(reply, allowed).length) reply = dropBadSentences(reply, allowed);
    }
    if (!reply) reply = null;
  }
  if (reply == null && !ui.card && !ui.actions.length) return { ok: false, reason: 'empty_reply', toolsUsed: used };
  return { ok: true, source: 'llm', reply, card: ui.card, actions: ui.actions, toolsUsed: used, mcpUsed: used.some(u => u.mcp), rounds, ms: Date.now() - t0, ...(process.env.MAIMAI_DEBUG === '1' ? { debug: { results } } : {}) };
}
module.exports = { run, SYSTEM };
