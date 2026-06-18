"""
Last Circle Standing — v6 (FOG + DILUTION + CHOOSE-LANDING / SIT-OUT)

Adds the final skill beat: when your block dies you are NOT forced into the
biggest survivor. You either
  (a) CHOOSE which surviving block to land in — a fog-based read (skilled players
      pick a lean-but-safe block for better reward; weak players herd or misjudge), or
  (b) SIT OUT — take your refund as a final cash-out, lock the gain, stop playing.
      You can't win the leftover pot, but you avoid further haircuts. Knowing WHEN
      to bank is itself skill.

Everything else as v5 (fog perception, fewest-players dies, reward dilution,
whale-neutral, 65-90% refunds). 3 batches, tally + compare to v5.
"""
import random, statistics

N_BLOCKS=10
PLAYERS_PER_BLOCK=(5,10)
STAKE0=(50,1500)
R_LO,R_HI=0.65,0.90
KAPPA=0.25
HOUSE_FEE=0.03
BASE_NOISE=3.0
T_MAX=N_BLOCKS+6

class Pl:
    __slots__=("pid","skill","dep","ret","stake","block","joinT","refunds","out")
    def __init__(s,pid,sk):
        s.pid=pid; s.skill=sk; s.dep=0; s.ret=0; s.stake=0
        s.block=None; s.joinT=0; s.refunds=0; s.out=False

def perceive(p, alive, prev_cnt, true_cnt):
    return {x:max(0.0, prev_cnt.get(x,true_cnt[x]) + random.gauss(0,BASE_NOISE*(1-p.skill))) for x in alive}

def run():
    players={}; pid=0; house=0.0; leftover=0.0
    members={b:set() for b in range(N_BLOCKS)}; alive=set(range(N_BLOCKS))
    for b in range(N_BLOCKS):
        for _ in range(random.randint(*PLAYERS_PER_BLOCK)):
            p=Pl(pid,random.random()); players[pid]=p
            amt=random.uniform(*STAKE0); fee=amt*HOUSE_FEE; house+=fee
            p.dep=amt; p.stake=amt-fee; p.block=b; members[b].add(pid); pid+=1
    prev_cnt={b:len(members[b]) for b in alive}; t=0
    while len(alive)>1:
        t+=1
        true_cnt={b:len(members[b]) for b in alive}; k=max(1,len(alive)//3)
        moves=[]
        for b in list(alive):
            for q in list(members[b]):
                p=players[q]; perc=perceive(p,alive,prev_cnt,true_cnt)
                rank=sorted(alive,key=lambda x:perc[x]); danger=set(rank[:k])
                act=False
                if b in danger: act=random.random()<(0.4+0.6*p.skill)
                elif b==rank[-1] and len(alive)>3: act=random.random()<p.skill*0.30
                if act:
                    safe=rank[k:] if len(rank)>k else rank[-1:]
                    tgt=safe[0] if random.random()<p.skill else rank[-1]
                    if tgt!=b: moves.append((q,tgt))
        for q,tgt in moves:
            p=players[q]; members[p.block].discard(q); members[tgt].add(q); p.block=tgt; p.joinT=t
        prev_cnt={b:len(members[b]) for b in alive}
        cnt={b:len(members[b]) for b in alive}; lo=min(cnt.values())
        cand=[b for b in alive if cnt[b]==lo]
        if len(cand)>1:
            money={b:sum(players[x].stake for x in members[b]) for b in cand}; mlo=min(money.values())
            cand=[b for b in cand if money[b]==mlo]
        dead=random.choice(cand); r=R_LO+(R_HI-R_LO)*min(1,t/T_MAX)
        alive.discard(dead)
        for q in list(members[dead]):
            p=players[q]; p.refunds+=1; ref=p.stake*r; leftover+=p.stake*(1-r); p.stake=ref
            members[dead].discard(q)
            if not alive:
                p.ret+=p.stake; p.out=True; continue
            # SIT-OUT decision: skilled players bank more readily, esp. after a haircut
            sitout = random.random() < min(0.7, 0.10 + 0.45*p.skill + 0.10*(p.refunds-1))
            if sitout:
                p.ret+=p.stake; p.out=True       # cash out, locked
            else:
                # CHOOSE landing via fog read (skill), not forced to biggest
                perc=perceive(p,alive,prev_cnt,true_cnt)
                rank=sorted(alive,key=lambda x:perc[x]); kk=max(1,len(alive)//3)
                safe=rank[kk:] if len(rank)>kk else rank[-1:]
                tgt=safe[0] if random.random()<p.skill else rank[-1]
                members[tgt].add(q); p.block=tgt; p.joinT=t
        members[dead].clear(); prev_cnt={b:len(members[b]) for b in alive}
    win=next(iter(alive)); wm=members[win]
    if wm:
        init=min(wm,key=lambda x:players[x].joinT)
        players[init].ret+=leftover*KAPPA; pool=leftover*(1-KAPPA)
        joiners=[x for x in wm if x!=init]
        if joiners:
            ws=sum(players[x].joinT+1 for x in joiners)
            for x in joiners: players[x].ret+=pool*(players[x].joinT+1)/ws
        else: players[init].ret+=pool
        for x in wm: players[x].ret+=players[x].stake
    return players,house,len(wm),pid

def batch(seed,games=1500):
    random.seed(seed); rows=[]; H=D=R=0; winsizes=[]; totalP=0; satout=0; tot=0
    for _ in range(games):
        pls,h,wsize,np_=run(); H+=h; winsizes.append(wsize); totalP+=np_
        for p in pls.values():
            rows.append((p.skill,p.dep,p.ret-p.dep)); D+=p.dep; R+=p.ret; tot+=1
            if p.out: satout+=1
    n=len(rows); rows.sort(key=lambda x:x[0]); q=n//4
    qs=[]
    for i in range(4):
        seg=rows[i*q:(i+1)*q] if i<3 else rows[3*q:]; nets=[x[2] for x in seg]
        qs.append((statistics.mean(nets), sum(1 for v in nets if v>0)/len(nets)*100))
    band=[x for x in rows if 400<x[1]<800]; band.sort(key=lambda x:x[0]); bq=max(1,len(band)//4)
    blo=statistics.mean([x[2] for x in band[:bq]]); bhi=statistics.mean([x[2] for x in band[-bq:]])
    wh=statistics.mean([x[2] for x in rows if x[1]>1200]); sm=statistics.mean([x[2] for x in rows if x[1]<=400])
    return dict(solv=R+H-D,q=qs,band=(blo,bhi),whale=wh,small=sm,
                funnel=statistics.mean(winsizes)/(totalP/games), satout=satout/tot*100, house=H/D*100)

print(f"{'seed':>4} |   Q1     Q2     Q3     Q4  | win% Q1->Q4 | same-stake | whale  small | funnel | sat-out")
agg=[]
for s in (11,22,33):
    r=batch(s); agg.append(r); qm=[x[0] for x in r["q"]]; qw=[x[1] for x in r["q"]]
    print(f"{s:>4} | {qm[0]:6.1f}{qm[1]:7.1f}{qm[2]:7.1f}{qm[3]:7.1f} | {qw[0]:4.0f}->{qw[3]:<4.0f} | {r['band'][0]:5.1f}->{r['band'][1]:<5.1f}| {r['whale']:6.1f}{r['small']:6.1f} | {r['funnel']*100:3.0f}%   | {r['satout']:.0f}%")
print("\nTALLY (avg of 3):")
a=lambda f: statistics.mean(f(r) for r in agg)
print(f"  mean net by skill:    Q1 {a(lambda r:r['q'][0][0]):.1f}  Q2 {a(lambda r:r['q'][1][0]):.1f}  Q3 {a(lambda r:r['q'][2][0]):.1f}  Q4 {a(lambda r:r['q'][3][0]):.1f}")
print(f"  win-rate worst->best: {a(lambda r:r['q'][0][1]):.0f}% -> {a(lambda r:r['q'][3][1]):.0f}%")
print(f"  same-stake lo->hi:    ${a(lambda r:r['band'][0]):.1f} -> ${a(lambda r:r['band'][1]):.1f}")
print(f"  whale vs small:       ${a(lambda r:r['whale']):.1f} vs ${a(lambda r:r['small']):.1f}")
print(f"  funnel (in winner):   {a(lambda r:r['funnel'])*100:.0f}%   (was 100% in v5)")
print(f"  sat-out (cashed early): {a(lambda r:r['satout']):.0f}% of players")
print(f"  solvency: ${a(lambda r:r['solv']):.0f}  | house {a(lambda r:r['house']):.1f}%")
