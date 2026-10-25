"""大模型 Agent 自测：python3 tests/selftest_llm.py
 · 启动 server.js（后台子进程，结束时只 kill 这个 PID），真实调用 DeepSeek（key 取自环境变量 DEEPSEEK_API_KEY，脚本不打印、不落盘）；
 · 覆盖：配餐、改单、查卡路里（MCP）、下单（有/无餐卡，且绝不真的支付）、换一套、开放问答、听不懂；
 · 断言：来源为 llm、toolsUsed 里确实调用了工具、价格由本地算价给出（合计=各行之和）、回复里的数字都来自工具（服务端 debug 回传工具结果比对）、改单只改一行；
 · 回退：不带 key 的服务端 / file:// 静态打开 → 自动用规则解析、可用、console 无 error；
 · 密钥不泄露：扫描所有 /api 响应与页面 HTML，不含 key 与 MCP token。"""
import asyncio, json, os, re, subprocess, sys, time, socket
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY = os.environ.get('DEEPSEEK_API_KEY', '')
try: MCP_TOKEN = (os.environ.get('MCD_MCP_TOKEN') or open(os.environ.get('MCD_MCP_TOKEN_FILE','')).read().strip())
except Exception: MCP_TOKEN = ''
assert KEY, '需要环境变量 DEEPSEEK_API_KEY'
fails, errors, calls, lat = [], [], [], []
def ok(c, m):
    if not c: fails.append(m); print('  ✗ FAIL:', m)
    else: print('  ✓', m)

def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p
procs = []
def start_server(with_key=True):
    port = free_port(); env = dict(os.environ, PORT=str(port), MAIMAI_DEBUG='1')
    if not with_key: env.pop('DEEPSEEK_API_KEY', None)
    p = subprocess.Popen(['node', ROOT + '/server.js'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    procs.append(p)
    for _ in range(50):
        try: socket.create_connection(('127.0.0.1', port), 0.2).close(); break
        except Exception: time.sleep(0.1)
    return port

def nums(s): return [float(x) for x in re.findall(r'\d+(?:\.\d+)?', s or '')]

async def new_page(b, url, key_check=True):
    ctx = await b.new_context(viewport={'width': 390, 'height': 844})
    page = await ctx.new_page()
    page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    async def on_resp(r):
        try:
            if '/api/agent' in r.url:
                txt = await r.text(); lines = [json.loads(l) for l in txt.split('\n') if l.strip()]
                res = [l for l in lines if l.get('type') == 'result']
                calls.append(res[-1] if res else {}); 
                if res and res[-1].get('ms'): lat.append(res[-1]['ms'])
                if KEY in txt or (MCP_TOKEN and MCP_TOKEN in txt): fails.append('API 响应里出现了密钥！')
        except Exception: pass
    page.on('response', lambda r: asyncio.ensure_future(on_resp(r)))
    await page.goto(url); await page.wait_for_selector('body.ready'); await page.wait_for_timeout(300)
    return page

async def say(page, text, timeout=20000):
    n0 = await page.evaluate("document.querySelectorAll('#chatList .msg.agent.turn:not(.typing-row)').length")
    c0 = len(calls)
    await page.evaluate("t=>Mai.chat.submit(t,{src:'typed'})", text)
    await page.wait_for_function("n=>document.querySelectorAll('#chatList .msg.agent.turn:not(.typing-row)').length>n && !document.querySelector('#chatList .typing-row')", arg=n0, timeout=timeout)
    for _ in range(40):
        if len(calls) > c0: break
        await page.wait_for_timeout(100)
    await page.wait_for_timeout(900)
    return calls[-1] if len(calls) > c0 else None

CARD = """()=>{const a=Mai.chat.state.active; if(!a||!a.stack) return null; const s=a.stack.center();
  return {id:s.id,title:s.title,total:s.total,people:s.people,budget:s.budget,rows:s.rows.map(r=>({code:r.code,short:r.short,cat:r.cat,qty:r.qty,sub:r.subtotal,name:r.name})),
          sum:Math.round(s.rows.reduce((t,r)=>t+r.subtotal,0)*100)/100}}"""
LAST_BUBBLE = "()=>{const l=[...document.querySelectorAll('#chatList .msg.agent.turn:not(.typing-row) .mbt')]; return l.length?l[l.length-1].textContent:''}"
def used(res, name): return any(u['name'] == name for u in (res or {}).get('toolsUsed', []))
def tool_numbers(res):
    out = []
    for r in (res or {}).get('debug', {}).get('results', []): out += nums(json.dumps(r, ensure_ascii=False))
    return out
def reply_numbers_ok(res, extra=''):
    allow = tool_numbers(res) + nums(extra)
    bad = [n for n in nums((res or {}).get('reply')) if not (n == int(n) and n < 10) and not any(abs(n - a) < 1e-6 for a in allow)]
    return not bad, bad

async def main():
    port = start_server(True); base = f'http://127.0.0.1:{port}/'
    port2 = start_server(False); base2 = f'http://127.0.0.1:{port2}/'
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        import urllib.request
        h = json.loads(urllib.request.urlopen(base + 'api/health').read())
        print('health:', h); ok(h.get('llm') is True, '服务端检测到 DEEPSEEK_API_KEY（只报有无，不回显）')
        print('\n== 1. 新推荐意图（真实 DeepSeek）')
        for text, check in [
            ('今天健身了来点高蛋白', lambda L, c: '高蛋白' in L['mi']['tags'] and L['mi']['state'].get('workout')),
            ('昨天吃得油腻今天想清淡', lambda L, c: '清淡' in L['mi']['tags']),
            ('3个人预算100', lambda L, c: L['mi'].get('people') == 3 and L['mi'].get('budget') == 100 and c['total'] <= 100),
            ('不要辣的，想吃鸡', lambda L, c: L['flags'].get('noSpicy') and L['flags'].get('like') == 'chicken' and not any('辣' in r['name'] for r in c['rows'])),
        ]:
            pg = await new_page(b, base + 'index.html')
            res = await say(pg, text); card = await pg.evaluate(CARD); last = await pg.evaluate("Mai.chat.state.last"); src = await pg.evaluate("Mai.lastIntentSource")
            print(f'  「{text}」→ {res and res.get("toolsUsed")} {res and res.get("ms")}ms\n    回复: {res and res.get("reply")}\n    餐卡: {card and card["title"]} ¥{card and card["total"]}: {card and "+".join(r["short"] for r in card["rows"])}')
            ok(src == 'llm', f'「{text}」来源=llm'); ok(used(res, 'recommend_meal'), '调用了 recommend_meal 工具')
            ok(card is not None and abs(card['sum'] - card['total']) < 0.011, '价格由本地算价给出：合计=各行之和')
            ok(bool(card) and check(last, card), '意图结构合法且符合预期：' + json.dumps(last, ensure_ascii=False)[:150])
            g, bad = reply_numbers_ok(res, text); ok(g, f'回复里的数字都来自工具{bad if bad else ""}')
            ok(len((res or {}).get('reply') or '') <= 175, '回复简短')
            html = await pg.content(); ok(KEY not in html and (not MCP_TOKEN or MCP_TOKEN not in html), '页面不含密钥')
            await pg.context.close()

        print('\n== 2. 已有餐卡：改单 / 查卡路里 / 换一套 / 帮我配餐 / 下单')
        pg = await new_page(b, base + 'index.html')
        await say(pg, '今天健身了来点高蛋白')
        c0 = await pg.evaluate(CARD)
        res = await say(pg, '换成可乐'); c1 = await pg.evaluate(CARD)
        print('  换成可乐 →', res and res.get('toolsUsed'), res and res.get('reply'), '|', '+'.join(r['short'] for r in c1['rows']), c1['total'])
        diff = [i for i, (a, b2) in enumerate(zip(c0['rows'], c1['rows'])) if a['code'] != b2['code']]
        ok(await pg.evaluate("Mai.lastIntentSource") == 'llm' and used(res, 'edit_meal'), '「换成可乐」来源 llm，调用 edit_meal')
        ok(len(c0['rows']) == len(c1['rows']) and len(diff) == 1 and c1['rows'][diff[0]]['short'] == '可乐', '只改了一行，且换成了可乐')
        ok(abs(c1['sum'] - c1['total']) < 0.011, '改单后价格由本地算价：合计=各行之和')
        g, bad = reply_numbers_ok(res, '换成可乐'); ok(g, f'改单回复的数字来自工具{bad if bad else ""}')
        # 不要牛奶换个饮料：先换回奶铁，再测
        res = await say(pg, '换成奶铁'); c2 = await pg.evaluate(CARD)
        res = await say(pg, '不要牛奶换个饮料'); c3 = await pg.evaluate(CARD)
        d3 = [i for i, (a, b2) in enumerate(zip(c2['rows'], c3['rows'])) if a['code'] != b2['code']]
        print('  不要牛奶换个饮料 →', res and res.get('toolsUsed'), res and res.get('reply'), '|', '+'.join(r['short'] for r in c3['rows']))
        ok(used(res, 'edit_meal') and len(d3) == 1 and c3['rows'][d3[0]]['cat'] == 'drink' and '奶' not in c3['rows'][d3[0]]['short'], '「不要牛奶换个饮料」只改饮料一行且不含奶')
        res = await say(pg, '查查这套的卡路里'); 
        print('  查卡路里 →', res and res.get('toolsUsed'), res and res.get('reply'))
        ok(used(res, 'get_nutrition'), '调用了 get_nutrition（营养数据来自 MCP/缓存）')
        srcs = [u.get('source') for u in res['toolsUsed'] if u['name'] == 'get_nutrition']; print('    营养数据来源:', srcs)
        ok(bool(srcs) and srcs[0] in ('mcp', 'cache', 'mcp+cache'), '结果标注了来源 mcp|cache')
        g, bad = reply_numbers_ok(res, '查查这套的卡路里'); ok(g and len(nums(res['reply'])) > 0, f'回复里的热量数字都来自工具返回{bad if bad else ""}')
        c4 = await pg.evaluate(CARD)
        res = await say(pg, '帮我换一套')
        c5 = await pg.evaluate(CARD)
        print('  帮我换一套 →', res and res.get('toolsUsed'), res and res.get('reply'), '|', c4['title'], '→', c5['title'], c5['id'])
        ok(bool(res and res.get('toolsUsed')) and (used(res, 'next_card') or used(res, 'recommend_meal')) and c5['id'] != c4['id'], '「帮我换一套」用了工具，餐卡已换')
        pg2 = await new_page(b, base + 'index.html')
        res = await say(pg2, '帮我配餐'); c6 = await pg2.evaluate(CARD)
        print('  帮我配餐 →', res and res.get('toolsUsed'), res and res.get('reply'), '|', c6 and c6['title'])
        ok(used(res, 'recommend_meal') and c6 is not None, '「帮我配餐」调用 recommend_meal 并出餐卡')
        await pg2.context.close()

        print('\n== 3. 下单（假支付，绝不真的支付）')
        pg3 = await new_page(b, base + 'index.html')
        await pg3.evaluate("Mai.chat.open()")
        res = await say(pg3, '我要下单')
        print('  无餐卡无购物车 →', res and res.get('toolsUsed'), res and res.get('reply'))
        co = await pg3.evaluate("document.getElementById('coPage').classList.contains('on')")
        ok(not co and await pg3.evaluate("Mai.cart.count()") == 0, '购物车空且没有餐卡：不会跳到结算页，只口头回应')
        ok(not re.search(r'已(经)?(付|支付|下单)|扣款成功|下单成功', (res or {}).get('reply') or ''), '没有声称已付款/已下单')
        await say(pg3, '今天健身了来点高蛋白')
        res = await say(pg3, '我要下单')
        print('  有餐卡未加购 →', res and res.get('toolsUsed'), res and res.get('reply'))
        await pg3.wait_for_timeout(1200)
        co = await pg3.evaluate("document.getElementById('coPage').classList.contains('on')")
        okp = await pg3.evaluate("document.getElementById('okPage').classList.contains('on')")
        orders = await pg3.evaluate("localStorage.getItem('maimai.orders.v1')")
        ok(used(res, 'checkout') and co, '有餐卡：带去结算页（加购并结算）')
        ok(not okp and not orders and await pg3.evaluate("Mai.cart.count()") > 0, '没有自动支付：没有支付成功页、没有订单记录')
        ok(not re.search(r'已(经)?(付|支付|下单)|扣款成功|下单成功', (res or {}).get('reply') or ''), '回复没有声称已付款')
        await pg3.context.close()
        # 购物车有东西、再说一遍
        pg4 = await new_page(b, base + 'index.html')
        await pg4.evaluate("Mai.chat.open()")
        await say(pg4, '3个人预算100'); await pg4.evaluate("Mai.cart.addSet(Mai.chat.state.active.stack.center())")
        res = await say(pg4, '我要下单'); await pg4.wait_for_timeout(1200)
        print('  购物车有餐 →', res and res.get('toolsUsed'), res and res.get('reply'))
        ok(used(res, 'checkout') and await pg4.evaluate("document.getElementById('coPage').classList.contains('on')") and not await pg4.evaluate("document.getElementById('okPage').classList.contains('on')"), '购物车有餐：去结算页，未支付')
        await pg4.context.close()

        print('\n== 4. 开放问答 / 听不懂')
        pg = await new_page(b, base + 'index.html')
        for q in ['麦辣鸡腿堡辣吗', '减脂吃什么', '你是谁', '今天天气怎么样', '麦当劳的雪碧多少热量', '嗯那个随便搞搞']:
            res = await say(pg, q); rp = (res or {}).get('reply') or ''
            g, bad = reply_numbers_ok(res, q)
            print(f'  「{q}」→ {res and [u["name"] for u in res["toolsUsed"]]} {res and res.get("ms")}ms\n    {rp}')
            ok(bool(res) and res.get('source') == 'llm' and len(rp) > 3 or bool(res and res.get('card')), f'「{q}」有回复/餐卡')
            ok(g, f'「{q}」回复数字来自工具{bad if bad else ""}'); ok(len(rp) <= 175 and 'DeepSeek' not in rp and 'deepseek' not in rp.lower(), '简短、不暴露模型身份')
        # 事实类问题必须调工具
        ok(used(await say(pg, '一份巨无霸多少钱'), 'calculate_price'), '「巨无霸多少钱」调用了 calculate_price')
        await pg.context.close()

        print('\n== 5. 回退：服务端无 key / 静态 file:// 打开')
        pg = await new_page(b, base2 + 'index.html')
        t0 = time.time(); res = await say(pg, '今天健身了来点高蛋白'); card = await pg.evaluate(CARD)
        ok(await pg.evaluate("Mai.lastIntentSource") == 'rule' and card is not None, f'服务端无 key（返回 ok:false）→ 自动回退规则解析并出餐卡（{time.time()-t0:.1f}s）')
        res = await say(pg, '换成可乐'); c = await pg.evaluate(CARD)
        ok(any(r['short'] == '可乐' for r in c['rows']), '回退后改单仍可用'); await pg.context.close()
        pg = await new_page(b, 'file://' + ROOT + '/index.html')
        await say(pg, '来点高蛋白的'); card = await pg.evaluate(CARD)
        ok(await pg.evaluate("Mai.lastIntentSource") == 'rule' and card is not None, 'file:// 静态打开 → 规则解析可用')
        await pg.context.close(); await b.close()

    print('\n== console / 网络')
    bad = [e for e in errors if 'favicon' not in e]
    ok(not bad, 'console 无 error/warning、pageerror' + (' ' + str(bad[:3]) if bad else ''))
    if lat: print(f'\nDeepSeek Agent 端到端耗时（含工具）：n={len(lat)} 平均 {sum(lat)/len(lat)/1000:.1f}s 最快 {min(lat)/1000:.1f}s 最慢 {max(lat)/1000:.1f}s')

try:
    asyncio.run(main())
finally:
    for pr in procs:
        try: pr.terminate(); pr.wait(3)
        except Exception:
            try: pr.kill()
            except Exception: pass
print('\n' + ('全部通过 ✅' if not fails else f'失败 {len(fails)} 项 ❌: ' + '; '.join(fails[:8])))
sys.exit(1 if fails else 0)
