"""Print text around every regex match in a big minified file (ugrep chokes on these).
Usage: python3 -I grep_context.py <file> <regex> <before> <after> [max]"""
import sys,re
p=sys.argv[1]; pat=sys.argv[2]; before=int(sys.argv[3]); after=int(sys.argv[4]); n=int(sys.argv[5]) if len(sys.argv)>5 else 3
t=open(p,encoding='utf-8',errors='replace').read()
c=0
for m in re.finditer(pat,t):
    print("-----",m.start()); print(t[max(0,m.start()-before):m.end()+after].replace("\n"," ")); c+=1
    if c>=n: break
print("total matches:", len(re.findall(pat,t)))
