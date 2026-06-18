"""v7: member cap + softmax death lottery, WITH an explicit Sybil attacker.
Attacker controls SYBIL_N cheap $10 wallets, all piled into one circle, never move
(classic 'be biggest, stay safe' bloc). We measure the attacker's ROI and check the
normal skill gradient + whale-neutrality still hold. 3 seeds."""
import random, statistics, math

N_BLOCKS=10; PLAYERS_PER_BLOCK=(5,9); STAKE0=(10,2000)
R_LO,R_HI=0.65,0.90; KAPPA=0.25; FEE=0.03
BASE_NOISE=3.0; T_MAX=N_BLOCKS+6
MEMBER_CAP=12          # fix #1
DEATH_TEMP=2.2         # fix #2: softmax temperature (lower=closer to strict smallest)
MIN_STAKE=10

class Pl:
    __slots__=("pid","skill","dep","ret","stake","block","surv","out","syb")
    def __init__(s,pid,sk,syb=False):
        s.pid=pid; s.skill=sk; s.dep=0; s.ret=0; s.stake=0; s.block=None
        s.surv=0; s.out=False; s.syb=syb

def death_pick(alive, counts):
    ws={b:math.exp(-counts[b]/DEATH_TEMP) for b in alive}
    tot=sum(ws.values()); r=random.random(); acc=0
    for b in alive:
        acc+=ws[b]/tot
        if r<=acc: return b
    return next(iter(alive))

def run(sybil_n=0):
    players={}; pid=0; house=0.0; leftover=0.0
    members={b:set() for b in range(N_BLOCKS)}; alive=set(range(N_BLOCKS))
    def add(p,b,amt):
        nonlocal house
        if len(members[b])>=MEMBER_CAP: return False
        fee=amt*FEE; house+=fee; p.dep+=amt; p.stake=amt-fee; p.block=b; members[b].add(p.pid); return True
    for b in range(N_BLOCKS):
        for _ in range(random.randint(*PLAYERS_PER_BLOCK)):
            if len(members[b])>=MEMBER_CAP: break
            p=Pl(pid,random.random()); players[pid]=p; add(p,b,random.uniform(*STAKE0)); pid+=1
    # inject Sybil bloc into circle 0 (capped by MEMBER_CAP)
    syb_ids=[]
    for _ in range(sybil_n):
        if len(members[0])>=MEMBER_CAP: break
        p=Pl(pid,0.0,syb=True); players[pid]=p; add(p,0,MIN_STAKE); syb_ids.append(pid); pid+=1
    prev={b:len(members[b]) for b in alive}; t=0
    while len(alive)>1:
        t+=1; true={b:len(members[b]) for b in alive}; k=max(1,len(alive)//3)
        moves=[]
        for b in list(alive):
            for q in list(members[b]):
                p=players[q]
                if p.syb: continue   # attacker never moves: pure 'stay biggest' bloc
                perc={x:max(0.0,prev.get(x,true[x])+random.gauss(0,BASE_NOISE*(1-p.skill))) for x in alive}
                rank=sorted(alive,key=lambda x:perc[x]); danger=set(rank[:k]); act=False
                if b in danger: act=random.random()<(0.4+0.6*p.skill)
                elif b==rank[-1] and len(alive)>3: act=random.random()<p.skill*0.30
                if act:
                    safe=[x for x in (rank[k:] if len(rank)>k else rank[-1:]) if len(members[x])<MEMBER_CAP]
                    if not safe: continue
                    tgt=safe[0] if random.random()<p.skill else safe[-1]
                    if tgt!=b: moves.append((q,tgt))
        for q,tgt in moves:
            if len(members[tgt])>=MEMBER_CAP: continue
            p=players[q]; members[p.block].discard(q); members[tgt].add(q); p.block=tgt
        for b in alive: 
            for q in members[b]: players[q].surv+=1
        prev={b:len(members[b]) for b in alive}
        counts={b:len(members[b]) for b in alive}
        dead=death_pick(alive,counts); r=R_LO+(R_HI-R_LO)*min(1,t/T_MAX); alive.discard(dead)
        for q in list(members[dead]):
            p=players[q]; ref=p.stake*r; leftover+=p.stake*(1-r); p.stake=ref; members[dead].discard(q)
            if not alive: p.ret+=p.stake; p.out=True; continue
            if not p.syb and random.random()<min(0.7,0.10+0.45*p.skill):
                p.ret+=p.stake; p.out=True; continue
            opts=[x for x in alive if len(members[x])<MEMBER_CAP]
            if not opts: p.ret+=p.stake; p.out=True; continue
            perc={x:max(0.0,prev.get(x,1)+random.gauss(0,BASE_NOISE*(1-p.skill))) for x in opts}
            rank=sorted(opts,key=lambda x:perc[x]); kk=max(1,len(rank)//3)
            tgt=(rank[kk:] or rank[-1:])[0] if random.random()<p.skill else rank[-1]
            members[tgt].add(q); p.block=tgt
        members[dead].clear(); prev={b:len(members[b]) for b in alive}
    win=next(iter(alive)); wm=members[win]
    if wm:
        init=max(wm,key=lambda x:players[x].surv)  # fix #3: time-survived weight
        players[init].ret+=leftover*KAPPA; pool=leftover*(1-KAPPA)
        js=[x for x in wm if x!=init]; ws=sum(players[x].surv+1 for x in js) or 1
        for x in js: players[x].ret+=pool*(players[x].surv+1)/ws
        for x in wm: players[x].ret+=players[x].stake
    syb_net=sum(players[i].ret-players[i].dep for i in syb_ids)
    syb_dep=sum(players[i].dep for i in syb_ids)
    return players,house,syb_net,syb_dep,syb_ids

def batch(seed,sybil_n,games=1200):
    random.seed(seed); rows=[]; sn=sd=0
    for _ in range(games):
        pls,h,snet,sdep,sids=run(sybil_n); sn+=snet; sd+=sdep
        for p in pls.values():
            if p.syb: continue
            rows.append((p.skill,p.dep,p.ret-p.dep))
    rows.sort(key=lambda x:x[0]); n=len(rows); q=n//4
    qs=[(statistics.mean([x[2] for x in (rows[i*q:(i+1)*q] if i<3 else rows[3*q:])]),
         sum(1 for x in (rows[i*q:(i+1)*q] if i<3 else rows[3*q:]) if x[2]>0)/(q if i<3 else n-3*q)*100) for i in range(4)]
    wh=statistics.mean([x[2] for x in rows if x[1]>1200]); sm=statistics.mean([x[2] for x in rows if x[1]<=300])
    roi=(sn/sd*100) if sd else 0
    return qs,wh,sm,roi

print("=== normal skill/whale check (no attacker), avg 3 seeds ===")
A=[batch(s,0) for s in (11,22,33)]
av=lambda i: statistics.mean(b[0][i][0] for b in A); aw=lambda i: statistics.mean(b[0][i][1] for b in A)
print(f"  mean net Q1..Q4: {av(0):.1f} {av(1):.1f} {av(2):.1f} {av(3):.1f}")
print(f"  win% Q1->Q4:     {aw(0):.0f}% -> {aw(3):.0f}%")
print(f"  whale ${statistics.mean(b[1] for b in A):.1f}  small ${statistics.mean(b[2] for b in A):.1f}")
print("\n=== Sybil attacker ROI (his total return on capital deployed), avg 3 seeds ===")
for sn in (5,10,12,20):
    R=[batch(s,sn) for s in (11,22,33)]
    print(f"  Sybil bloc of {sn:>2} x $10 wallets -> attacker ROI {statistics.mean(b[3] for b in R):+.1f}%   (negative = attack loses money)")
