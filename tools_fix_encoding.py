import os,re,sys
CP=set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ')
def isc(ch): return ch in CP or 0x80<=ord(ch)<=0xFF
def enc(s):
    b=bytearray()
    for ch in s:
        try: b+=ch.encode('cp1252')
        except UnicodeEncodeError: b.append(ord(ch))
    return bytes(b)
run=re.compile('[\u0080-ÿ'+''.join(CP)+']{2,}')
def fix(t):
    def r(m):
        s=m.group(0)
        for _ in range(3):
            try: n=enc(s).decode('utf-8')
            except Exception: break
            if n==s: break
            s=n
        return s
    prev=None
    while prev!=t: prev=t; t=run.sub(r,t)
    return t
apply='--apply' in sys.argv
roots=['src','dashboard/src','dashboard/main.js','dashboard/preload.js','tests','overlay/README.md','README.md']
files=[]
for r in roots:
    if os.path.isfile(r): files.append(r); continue
    for root,ds,fs in os.walk(r):
        ds[:]=[d for d in ds if d not in('node_modules','build','dist')]
        for f in fs:
            if f.endswith(('.cpp','.hpp','.h','.c','.js','.html','.md','.ini','.py','.json','.css')): files.append(os.path.join(root,f))
tot=0
for p in files:
    raw=open(p,'rb').read()
    try: t=raw.decode('utf-8-sig')
    except: print('NOT UTF8',p); continue
    n=fix(t)
    if n!=t:
        diffs=[(a,b) for a,b in zip(t.splitlines(),n.splitlines()) if a!=b]
        tot+=len(diffs); print(f'== {p}: {len(diffs)} linhas')
        for a,b in diffs[:4]: print('  -',a.strip()[:110]); print('  +',b.strip()[:110])
        if apply:
            bom=raw.startswith(b'\xef\xbb\xbf')
            nl='\r\n' if b'\r\n' in raw else None
            open(p,'wb').write((b'\xef\xbb\xbf' if bom else b'')+n.encode('utf-8'))
print('total',tot)
