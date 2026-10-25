import json, mcd_calc as m, time
M=json.load(open('../data/meals.json'))['items']
out={}
for it in M:
    r=m.calc([{'productCode':it['code'],'quantity':1}]); d=r.get('data') or {}
    out[it['code']]={'ok':r['ok'],'code':r['code'],'msg':r['msg'],'price':d.get('price'),'orig':d.get('originalPrice'),'menu':it['currentPrice'],'menuOrig':it['originalPrice'],'name':it['name']}
    print(it['code'],it['name'],it['currentPrice'],it['originalPrice'],'->',d.get('price'),d.get('originalPrice'),r['msg'] if not r['ok'] else '',flush=True)
json.dump(out,open('/tmp/singles.json','w'),ensure_ascii=False)
