import json, mcd_calc as m
M=json.load(open('../data/meals.json'))['items']
for it in M[:4]:
    r=m.calc([{'productCode':it['code'],'quantity':1}]); d=r.get('data') or {}
    print(it['code'],it['name'],it['currentPrice'],it['originalPrice'],r['ok'],r['code'],d.get('price'),d.get('originalPrice'),d.get('discount'),r['msg'] if not r['ok'] else '',flush=True)
r=m.calc([{'productCode':'521952','quantity':2},{'productCode':'9900016077','quantity':1}]); print(json.dumps(r,ensure_ascii=False)[:900],flush=True)
r=m.calc([{'productCode':'1440','quantity':1,'couponId':'A255280326E3328D179C362B7B8DDA65','couponCode':'MCD61040J6EWS69711000'}]); print(json.dumps(r,ensure_ascii=False)[:500],flush=True)
r=m.calc([{'productCode':'1440','quantity':1}]); print(json.dumps(r,ensure_ascii=False)[:500],flush=True)
