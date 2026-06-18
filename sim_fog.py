"""
Last Circle Standing — FOG + REWARD-DILUTION model (v5)

Fixes the "flee-the-smallest is a solved algorithm + everyone funnels" flaw:

  1. FOG OF WAR: players do NOT see live exact headcounts. They perceive LAGGED
     (previous-instance) counts plus NOISE whose size grows as skill drops. So
     "which block is smallest" is an intuition, not a calculation. Skilled players
     read the board more accurately; weak players are guessing.

  2. NO DOMINANT STRATEGY (reward dilution): the leftover-pot bonus is split across
     the winning block's members, so a giant safe crowd pays each member almost
     nothing while a lean surviving block pays big. Now every move is a risk/reward
     judgment: hide in the herd (survive, win little) vs hold a lean block (risky,
     win big). Skilled play = balancing these AND predicting the crowd; sometimes
     the right move is to STAY, sometimes to trim an overcrowded block.

Death rule unchanged: fewest players dies (tie -> least money -> VRF).
Whale-neutral: money sets reward slice, never survival.

We run 3 independent batches (different seeds) and tally.
"""
import random, statistics

N_BLOCKS=10
PLAYERS_PER_BLOCK=(5,10)
STAKE0=(50,1500)
R_LO,R_HI=0.65,0.90
KAPPA=0.25
HOUSE_FEE=0.03
BASE_NOISE=3.0          # perception noise at skill 0
T_MAX=N_BLOCKS+6

class Pl:
    __slots__=("pid","skill","dep","ret","stake","block","joinT")
    def __init__(s,pid,sk): s.pid=pid; s.skill=sk; s.dep=0; s.ret=0; s.stake=0; s.block=None; s.joinT=0

def run():
    players={}; pid=0; house=0.0; leftover=0.0
    members={b:set() for b in range(N_BLOCKS)}; alive=set(range(N_BLOCKS))
    for b in range(N_BLOCKS):
        for _ in range(random.randint(*PLAYERS_PER_BLOCK)):
            p=Pl(pid,random.random()); players[pid]=p
            amt=random.uniform(*STAKE0); fee=amt*HOUSE_FEE; house+=fee
            p.dep=amt; p.stake=amt-fee; p.block=b; members[b].add(pid); pid+=1
    prev_cnt={b:len(members[b]) for b in alive}   # lagged info source
    t=0
    while len(alive)>1:
        t+=1
        true_cnt={b:len(members[b]) for b in alive}
        live=sorted(alive); k=max(1,len(alive)//3)
        moves=[]
        for b in list(alive):
            for q in list(members[b]):
                p=players[q]
                # perceive LAGGED counts + skill-scaled noise
                perc={x:max(0.0, prev_cnt.get(x,true_cnt[x]) + random.gauss(0,BASE_NOISE*(1-p.skill))) for x in alive}
                rank=sorted(alive,key=lambda x:perc[x])     # ascending perceived count
                danger=set(rank[:k])
                myrank=rank.index(b)
                act=False
                if b in danger:
                    act = random.random() < (0.4+0.6*p.skill)         # skilled act correctly more often
                elif b==rank[-1] and len(alive)>3:
                    act = random.random() < p.skill*0.30              # anti-herd: trim a bloated block
                if act:
                    safe=rank[k:] if len(rank)>k else rank[-1:]
                    if random.random() < p.skill:
                        tgt=safe[0]      # skilled: leanest SAFE block = survive + low dilution
                    else:
                        tgt=rank[-1]     # unskilled: herd into the biggest
                    if tgt!=b: moves.append((q,tgt))
        for q,tgt in moves:
            p=players[q]; members[p.block].discard(q); members[tgt].add(q); p.block=tgt; p.joinT=t
        prev_cnt={b:len(members[b]) for b in alive}
        # death = fewest players (true)
        cnt={b:len(members[b]) for b in alive}; lo=min(cnt.values())
        cand=[b for b in alive if cnt[b]==lo]
        if len(cand)>1:
            money={b:sum(players[x].stake for x in members[b]) for b in cand}; mlo=min(money.values())
            cand=[b for b in cand if money[b]==mlo]
        dead=random.choice(cand); r=R_LO+(R_HI-R_LO)*min(1,t/T_MAX)
        alive.discard(dead)
        for q in list(members[dead]):
            p=players[q]; ref=p.stake*r; leftover+=p.stake*(1-r); p.stake=ref
            tgt=max(alive,key=lambda b:len(members[b])) if alive else None
            if tgt is not None:
                members[dead].discard(q); members[tgt].add(q); p.block=tgt; p.joinT=t
        members[dead].clear(); prev_cnt={b:len(members[b]) for b in alive}
    win=next(iter(alive)); wm=members[win]
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
    random.seed(seed)
    rows=[]; H=D=R=0; winsizes=[]; totalP=0
    for _ in range(games):
        pls,h,wsize,np_=run(); H+=h; winsizes.append(wsize); totalP+=np_
        for p in pls.values(): rows.append((p.skill,p.dep,p.ret-p.dep)); D+=p.dep; R+=p.ret
    n=len(rows); rows.sort(key=lambda x:x[0]); q=n//4
    qstats=[]
    for i in range(4):
        seg=rows[i*q:(i+1)*q] if i<3 else rows[3*q:]
        nets=[x[2] for x in seg]
        qstats.append((statistics.mean(nets), sum(1 for v in nets if v>0)/len(nets)*100))
    band=[x for x in rows if 400<x[1]<800]; band.sort(key=lambda x:x[0]); bq=max(1,len(band)//4)
    blo=statistics.mean([x[2] for x in band[:bq]]); bhi=statistics.mean([x[2] for x in band[-bq:]])
    wh=statistics.mean([x[2] for x in rows if x[1]>1200]); sm=statistics.mean([x[2] for x in rows if x[1]<=400])
    funnel=statistics.mean(winsizes)/(totalP/games)   # frac of players in winning block
    return dict(solv=R+H-D, q=qstats, band=(blo,bhi), whale=wh, small=sm, funnel=funnel, house=H/D*100)

print(f"{'seed':>5} | {'Q1':>7}{'Q2':>7}{'Q3':>7}{'Q4':>7} (mean net) | {'win% Q1->Q4':>12} | same-stake lo->hi | whale  small | funnel | house")
agg=[]
for s in (11,22,33):
    r=batch(s); agg.append(r)
    qm=[x[0] for x in r["q"]]; qw=[x[1] for x in r["q"]]
    print(f"{s:>5} | {qm[0]:7.1f}{qm[1]:7.1f}{qm[2]:7.1f}{qm[3]:7.1f} | {qw[0]:5.0f}->{qw[3]:<5.0f} | {r['band'][0]:6.1f}->{r['band'][1]:<6.1f} | {r['whale']:6.1f} {r['small']:6.1f} | {r['funnel']*100:4.0f}%  | {r['house']:.1f}%  solv${r['solv']:.0f}")

print("\nTALLY (avg of 3 batches):")
def avg(f): return statistics.mean(f(r) for r in agg)
print(f"  mean net by skill quartile: Q1 {avg(lambda r:r['q'][0][0]):.1f}  Q2 {avg(lambda r:r['q'][1][0]):.1f}  Q3 {avg(lambda r:r['q'][2][0]):.1f}  Q4 {avg(lambda r:r['q'][3][0]):.1f}")
print(f"  win-rate worst->best:       {avg(lambda r:r['q'][0][1]):.0f}% -> {avg(lambda r:r['q'][3][1]):.0f}%")
print(f"  same-stake band lo->hi:     ${avg(lambda r:r['band'][0]):.1f} -> ${avg(lambda r:r['band'][1]):.1f}")
print(f"  whale vs small:             ${avg(lambda r:r['whale']):.1f}  vs  ${avg(lambda r:r['small']):.1f}")
print(f"  funnel (players in winner): {avg(lambda r:r['funnel'])*100:.0f}%  (lower = less herding)")
