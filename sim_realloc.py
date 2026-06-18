"""
Last Circle Standing — FIXED-BUDGET REALLOCATION model (v4)

Core redesign to make SKILL predominant and whales neutral:

  * Each player deposits ONCE (fee once). That single stake is all they ever risk.
    No re-deposits, no "spend to win". Bankroll size cannot buy safety.
  * You always stand in exactly ONE block. Each instance (commit-reveal) you may
    MOVE your whole stake to another living block — for FREE. That free choice is
    the entire skill expression.
  * DEATH RULE = the block with the FEWEST PLAYERS dies (ties -> least money ->
    random). Survival depends on crowd-reading, NOT on money. A whale's big stake
    makes its block richer but not safer.
  * Dead block: each player's stake refunded r(t) (65->90% by survival time),
    carried forward into a living block. Haircut -> leftover pot.
  * Last block standing: stake-back (money-weighted) + leftover split. So MONEY
    decides how much you WIN, SKILL decides whether you SURVIVE. Clean separation.

Test: does corr(skill, net) jump vs v3's +0.027, and are whales neutral?
"""
import random, statistics

N_GAMES=2500
N_BLOCKS=12
PLAYERS_PER_BLOCK=(4,9)
STAKE0=(50,1500)
R_LO,R_HI=0.65,0.90
KAPPA=0.50
HOUSE_FEE=0.03
T_MAX=N_BLOCKS+6

class Pl:
    __slots__=("pid","skill","dep","ret","stake","block","joinT")
    def __init__(s,pid,skill):
        s.pid=pid; s.skill=skill; s.dep=0.0; s.ret=0.0
        s.stake=0.0; s.block=None; s.joinT=0

def run():
    players={}; pid=0; house=[0.0]; leftover=0.0
    members={b:set() for b in range(N_BLOCKS)}   # block -> set(pid)
    alive=set(range(N_BLOCKS))
    for b in range(N_BLOCKS):
        for _ in range(random.randint(*PLAYERS_PER_BLOCK)):
            p=Pl(pid,random.random()); players[pid]=p
            amt=random.uniform(*STAKE0); fee=amt*HOUSE_FEE; house[0]+=fee
            p.dep=amt; p.stake=amt-fee; p.block=b
            members[b].add(pid); pid+=1
    t=0
    def counts(): return {b:len(members[b]) for b in alive}
    while len(alive)>1:
        t+=1
        cnt=counts()
        order=sorted(alive,key=lambda b:cnt[b])           # ascending headcount
        k=max(1,len(alive)//3)
        atrisk=set(order[:k])                              # bottom third by crowd
        safehi=order[-1]                                   # biggest crowd
        # ---- commit phase: free moves (hidden) ----
        moves=[]   # (pid, to_block)
        for b in list(alive):
            for p_id in list(members[b]):
                p=players[p_id]
                if b in atrisk:
                    # skilled players reliably flee a thin crowd; bad players freeze
                    if random.random() < p.skill:
                        # anticipation: most flee to the biggest crowd, but the most
                        # skilled sometimes pick the 2nd-biggest to dodge the stampede
                        if random.random() < p.skill*0.4 and len(order)>2:
                            tgt=order[-2]
                        else:
                            tgt=safehi
                        if tgt!=b: moves.append((p_id,tgt))
                else:
                    # comfortable but skilled players sometimes reinforce a wobbling
                    # ally block to bank goodwill / late-join weight; rarely move
                    if random.random() < p.skill*0.08:
                        tgt=random.choice(order[:max(1,k)])
                        if tgt!=b and tgt in alive: moves.append((p_id,tgt))
        # ---- reveal: apply moves simultaneously ----
        for (p_id,tgt) in moves:
            p=players[p_id]
            members[p.block].discard(p_id)
            members[tgt].add(p_id); p.block=tgt; p.joinT=t
        # ---- kill the smallest crowd ----
        cnt=counts()
        lo=min(cnt.values())
        cand=[b for b in alive if cnt[b]==lo]
        if len(cand)>1:  # tie-break by least money, then random
            money={b:sum(players[q].stake for q in members[b]) for b in cand}
            mlo=min(money.values()); cand=[b for b in cand if money[b]==mlo]
        dead=random.choice(cand)
        r=R_LO+(R_HI-R_LO)*min(1.0,t/T_MAX)
        alive.discard(dead)
        for p_id in list(members[dead]):
            p=players[p_id]; refund=p.stake*r
            leftover+=p.stake*(1-r); p.stake=refund
            if alive:
                tgt=max(alive,key=lambda b:len(members[b]))  # carry into a safe crowd
                members[dead].discard(p_id); members[tgt].add(p_id)
                p.block=tgt; p.joinT=t
        members[dead].clear()
    # ---- endgame ----
    win=next(iter(alive)); win_members=members[win]
    # initiator = earliest joiner present (joinT smallest); approximate richest-original
    init=min(win_members,key=lambda q:players[q].joinT)
    players[init].ret+=leftover*KAPPA
    pool=leftover*(1-KAPPA)
    joiners=[q for q in win_members if q!=init]
    if joiners:
        wsum=sum(players[q].joinT+1 for q in joiners)
        for q in joiners: players[q].ret+=pool*(players[q].joinT+1)/wsum
    else:
        players[init].ret+=pool
    for q in win_members:
        players[q].ret+=players[q].stake   # stake-back (money-weighted reward)
    return players,house[0]

rows=[]; H=0;D=0;R=0
for _ in range(N_GAMES):
    pls,h=run(); H+=h
    for p in pls.values():
        rows.append((p.skill,p.dep,p.ret-p.dep)); D+=p.dep; R+=p.ret
n=len(rows)
print(f"games={N_GAMES} entries={n}")
print(f"deposited ${D:,.0f} returned ${R:,.0f} house ${H:,.0f} ({H/D*100:.1f}%)  solvency diff ${R+H-D:,.0f}")
rows.sort(key=lambda x:x[0]); q=n//4
for i,name in enumerate(["Q1 worst","Q2","Q3","Q4 best"]):
    seg=rows[i*q:(i+1)*q] if i<3 else rows[3*q:]
    nets=[x[2] for x in seg]; sk=[x[0] for x in seg]
    print(f"{name}: skill~{statistics.mean(sk):.2f}  mean ${statistics.mean(nets):,.2f}  median ${statistics.median(nets):,.2f}  win% {sum(1 for v in nets if v>0)/len(nets)*100:.0f}")
sk=[x[0] for x in rows]; nt=[x[2] for x in rows]
ms,mn=statistics.mean(sk),statistics.mean(nt)
corr=(sum((a-ms)*(b-mn) for a,b in zip(sk,nt))/n)/(statistics.pstdev(sk)*statistics.pstdev(nt))
print(f"corr(skill, net) = {corr:+.3f}")
wh=[x[2] for x in rows if x[1]>1200]; sm=[x[2] for x in rows if x[1]<=400]
print(f"WHALE(dep>1200) mean ${statistics.mean(wh):,.2f}   SMALL(dep<=400) mean ${statistics.mean(sm):,.2f}")
# skill within a fixed stake band, to isolate skill from money
band=[x for x in rows if 400<x[1]<800]; band.sort(key=lambda x:x[0]); bq=len(band)//4
blo=band[:bq]; bhi=band[3*bq:]
print(f"same-stake band: low-skill mean ${statistics.mean([x[2] for x in blo]):,.2f}  high-skill mean ${statistics.mean([x[2] for x in bhi]):,.2f}")
