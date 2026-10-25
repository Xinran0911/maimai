#!/usr/bin/env python3
"""precompute_prices.py — 预先对「常见套餐 / 单品 / 勾选子集」用 MCP calculate-price 实算（只读），结果写成静态 data/prices.json + data/prices.js。
  先跑 harvest_sets.py 得 /tmp/harvest.json（所有会出现的套）；本脚本枚举：每个套的整套 ×1、×2，及其非空子集 ×1（≤4 种菜的套取全部子集；更大的多人套只取「去掉一行」，购物车里取消勾选时会用到）；
  再加 42 道菜的单品 ×1、×2。token 只在 mcd_calc.py 内存里使用，不会写进输出。绝不调用 create-order。
  用法：python3 tools/precompute_prices.py   （约 5~8 分钟；已算过的 key 会从 data/prices.json 复用，加 --fresh 重算）"""
import json, sys, os, itertools, time
from concurrent.futures import ThreadPoolExecutor
import mcd_calc as m
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = ROOT + '/data/prices.json'
meals = json.load(open(ROOT + '/data/meals.json'))
codes = [i['code'] for i in meals['items']]
def key(lines): return '|'.join(f'{c}:{q}' for c, q in sorted(lines.items()))
want = {}
def add(lines): want[key(lines)] = dict(lines)
for c in codes:
    add({c: 1}); add({c: 2})
harvest = json.load(open('/tmp/harvest.json'))
for s in harvest:
    base = {}
    for r in s['rows']: base[r['code']] = base.get(r['code'], 0) + r['qty']
    add(base); add({c: q * 2 for c, q in base.items()})
    cs = sorted(base)
    for n in (range(1, len(cs)) if len(cs) <= 4 else [len(cs) - 1]):
        for sub in itertools.combinations(cs, n): add({c: base[c] for c in sub})
cache = {}
if os.path.exists(OUT) and '--fresh' not in sys.argv:
    cache = {k: v for k, v in json.load(open(OUT)).get('combos', {}).items() if not ('err' in v and v.get('errCode') not in (60006, 600012))}   # 临时网络失败的重算
todo = [k for k in want if k not in cache]
print(len(want), 'keys,', len(todo), 'to calc', flush=True)
def one(k):
    lines = want[k]
    for attempt in range(3):
        r = m.calc([{'productCode': c, 'quantity': q} for c, q in sorted(lines.items())])
        if r['ok'] or r.get('code') in (60006, 600012) or attempt == 2: break
        time.sleep(1.5)
    if not r['ok']:
        return k, {'err': r.get('msg'), 'errCode': r.get('code') or r.get('http')}
    d = r['data']
    return k, {'price': d['price'] / 100, 'orig': d['originalPrice'] / 100, 'discount': d['discount'] / 100,
               'lines': {p['productCode']: [p['subtotal'] / 100, p['originalSubtotal'] / 100] for p in d['productList']},
               'takeWay': [t['code'] for t in d.get('takeWayList', [])]}
m.init()
done = 0
with ThreadPoolExecutor(6) as ex:
    for k, v in ex.map(one, todo):
        cache[k] = v; done += 1
        if done % 50 == 0:
            print(done, '/', len(todo), flush=True)
            json.dump({'partial': True, 'combos': cache}, open(OUT, 'w'), ensure_ascii=False)
unavailable = sorted({c for k, v in cache.items() if 'err' in v and k.count(':') == 1 for c in [k.split(':')[0]]})
out = {'meta': {'store': meals['storeCode'], 'storeName': meals['storeName'], 'tool': 'calculate-price（只读）', 'beType': 1, 'orderType': 1,
                'generatedAt': time.strftime('%Y-%m-%d %H:%M:%S') + ' (Asia/Shanghai)', 'unit': '元',
                'note': '商品价为 calculate-price 实算（不带券）；券为本地估算。key = 按 code 排序的 "code:qty|code:qty"。err = 核价失败（多为当前不可售）。'},
       'unavailable': unavailable, 'combos': cache}
json.dump(out, open(OUT, 'w'), ensure_ascii=False, separators=(',', ':'))
open(ROOT + '/data/prices.js', 'w').write('window.MAI_PRICES=' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n')
ok = sum(1 for v in cache.values() if 'price' in v); print('done', ok, 'ok,', len(cache) - ok, 'failed; unavailable singles:', unavailable)
