import openpyxl, sys, json, subprocess, datetime, collections
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
def q(sql):
    return subprocess.run(['psql','-h','127.0.0.1','-U','levanto','levanto','-AtF','\x1f','-c',sql],capture_output=True,text=True,env={'PGPASSWORD':'levanto','PATH':'/usr/bin:/bin'}).stdout
tabs = dict(l.split('\x1f') for l in q("select name,id from tabs").splitlines())
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
tot = bad = 0; missing_tabs = []
for ws in wb.worksheets:
    if ws.title not in tabs: missing_tabs.append(ws.title); continue
    db = {}
    for l in q(f"select row_no, cells from tab_rows where tab_id={tabs[ws.title]}").splitlines():
        n, c = l.split('\x1f', 1); db[int(n)] = json.loads(c)
    tbad = ttot = 0; ex = []
    for row in ws.iter_rows():
        for c in row:
            v = c.value
            if v is None or v == '': continue
            ttot += 1
            r = db.get(c.row, []); d = r[c.column-1] if c.column-1 < len(r) else ''
            ok = False
            if isinstance(v, datetime.datetime):
                ok = isinstance(d, dict) and '$d' in d and abs(datetime.datetime.fromtimestamp(d['$d']/1000, IST).replace(tzinfo=None) - v).total_seconds() < 1
            elif isinstance(v, datetime.time):
                ok = isinstance(d, dict) and '$t' in d and d['$t'] == v.hour*3600+v.minute*60+v.second
            elif isinstance(v, bool): ok = d is v
            elif isinstance(v, (int, float)): ok = isinstance(d, (int, float)) and not isinstance(d, bool) and abs(d - v) <= 1e-9*max(1, abs(v))
            else: ok = d == str(v)
            if not ok:
                tbad += 1
                if len(ex) < 3: ex.append((c.coordinate, repr(v)[:40], repr(d)[:40]))
    extra = sum(1 for n, r in db.items() for i, x in enumerate(r) if x not in ('', None) and ws.cell(n, i+1).value in (None, ''))
    tot += ttot; bad += tbad
    flag = 'OK  ' if not tbad and not extra else 'DIFF'
    print(f"{flag} {ws.title!r:26} cells {ttot:>7} mismatched {tbad} extra-in-db {extra} {ex if ex else ''}")
print('TOTAL cells', tot, 'mismatched', bad, 'missing tabs', missing_tabs)
