"""
Last Circle Standing — SKILL model (v3)

Tests the core claim: with deterministic "smallest block dies" + commit-reveal
strategic play, does SKILL measurably beat luck, and do whales still lose?

Mechanics:
  - Open join window -> closed set of P players spread across N blocks.
  - Each instance every living player COMMITS a hidden move (defend / hold / jump),
    all reveal simultaneously, totals update, then the SMALLEST block dies
    (ties broken randomly = the only RNG touching outcomes).
  - Dead-block players refunded r(t) (survival-weighted 65->90%), may re-enter.
  - Players have skill in [0,1] that governs how reliably they read threat,
    defend competently, and abandon doomed blocks. Bad players act ~randomly.
  - Stake caps (anti-whale) still apply on every add.

Output: net P/L bucketed by skill quartile and by whale status, plus the
correlation between skill and profit. If skill>profit correlation is clearly
positive and monotonic across quartiles, it's a skill game.
"""
import random, statistics, math

N_GAMES=2500
N_BLOCKS=12
PLAYERS_PER_BLOCK=(2,6)
STAKE0=(50,1500)
R_LO,R_HI=0.65,0.90
BETA_HI,BETA_LO=1.5,1.05
RHO_RAND,RHO_SKILL=4.0,1.5
HOUSE_FEE=0.03
KAPPA=0.50
P_REENTER_BASE=0.5
T_MAX=N_BLOCKS+6

class Pl:
    __slots__=("pid","skill","dep","ret","bank","block","joinT")
    def __init__(s,pid,skill):
        s.pid=pid; s.skill=skill; s.dep=0.0; s.ret=0.0
        s.bank=random.uniform(200,2500); s.block=None; s.joinT=0

def conv(vals):
    vmin=min(vals)
    if vmin<=0: return 0.0
    rho=max(vals)/vmin
    return min(1.0,max(0.0,(RHO_RAND-rho)/(RHO_RAND-RHO_SKILL)))

def run():
    players={}; pid=0
    house=[0.0]; leftover=0.0
    def dep(p,amt): f=amt*HOUSE_FEE; house[0]+=f; p.dep+=amt; return amt-f
    blocks={}  # bid -> {"stakes":{pid:amt},"init":pid}
    for b in range(N_BLOCKS):
        stakes={}; init=None
        for i in range(random.randint(*PLAYERS_PER_BLOCK)):
            p=Pl(pid, random.random()); players[pid]=p
            amt=random.uniform(*STAKE0); net=dep(p,amt)
            p.bank-=0  # bank separate from initial stake
            stakes[pid]=net; p.block=b
            if init is None: init=pid
            pid+=1
        blocks[b]={"stakes":stakes,"init":init}
    t=0
    while len(blocks)>1:
        t+=1
        vals={b:sum(bl["stakes"].values()) for b,bl in blocks.items()}
        c=max(conv(list(vals.values())), min(1.0,t/T_MAX))
        beta=BETA_HI*(1-c)+BETA_LO*c
        vmed=statistics.median(list(vals.values()))
        ranked=sorted(vals,key=lambda b:vals[b])         # ascending value
        bottom=set(ranked[:2])                            # the danger zone
        strongest=ranked[-1]
        # ---- commit phase: collect hidden moves (credited to the real player) ----
        adds=[]   # (pid, block, amt)  new money into own block
        jumps=[]  # (pid, from_b, to_b, amt)
        for b in list(blocks):
            for p_id in list(blocks[b]["stakes"]):
                p=players[p_id]
                vt=vals[b]
                cap=max(0.0, min(beta*vmed - vt, 0.5*vmed))
                threatened = b in bottom
                if threatened:
                    # skilled players reliably defend; bad players often freeze
                    if random.random() < p.skill and p.bank>1 and cap>1:
                        # skilled also sometimes ABANDON a chronically weakest block
                        if b==ranked[0] and random.random() < p.skill*0.35 and len(blocks)>2:
                            tgt=strongest if strongest!=b else ranked[-2]
                            capj=max(0.0, min(beta*vmed - vals[tgt], 0.5*vmed))
                            amt=min(p.bank*0.5, capj)
                            if amt>1: jumps.append((p_id,b,tgt,amt)); continue
                        amt=min(p.bank*0.6, cap)
                        if amt>1: adds.append((p_id,b,amt))
                else:
                    if random.random() < p.skill*c*0.4 and cap>1 and p.bank>1:
                        amt=min(p.bank*0.2, cap*0.5)
                        if amt>1: adds.append((p_id,b,amt))
        # ---- reveal: apply fees, credit each player's own stake ----
        for (p_id,b,amt) in adds:
            p=players[p_id]; net=amt-amt*HOUSE_FEE; house[0]+=amt*HOUSE_FEE
            p.bank-=amt; p.dep+=amt
            blocks[b]["stakes"][p_id]=blocks[b]["stakes"].get(p_id,0)+net
        for (p_id,fb,tb,amt) in jumps:
            p=players[p_id]; net=amt-amt*HOUSE_FEE; house[0]+=amt*HOUSE_FEE
            p.bank-=amt; p.dep+=amt
            blocks[tb]["stakes"][p_id]=blocks[tb]["stakes"].get(p_id,0)+net
            p.block=tb; p.joinT=t
        # recompute & kill smallest
        vals={b:sum(bl["stakes"].values()) for b,bl in blocks.items()}
        lo=min(vals.values())
        cand=[b for b in vals if abs(vals[b]-lo)<1e-9]
        dead=random.choice(cand)
        r=R_LO+(R_HI-R_LO)*min(1.0,t/T_MAX)
        pot=vals[dead]; leftover+=pot*(1-r)
        deadbl=blocks.pop(dead)
        survivors=list(blocks)
        for k,amt in deadbl["stakes"].items():
            p=players[k]; refund=amt*r; p.ret+=refund; p.bank+=refund
            if survivors and random.random()<P_REENTER_BASE*(0.5+p.skill):
                tgt=max(survivors,key=lambda b:sum(x for x in blocks[b]["stakes"].values()))
                vt=sum(x for x in blocks[tgt]["stakes"].values())
                cap=max(0.0,min(beta*vmed - vt,0.5*vmed))
                amt2=min(p.bank*0.5,cap)
                if amt2>1:
                    net=amt2-amt2*HOUSE_FEE; house[0]+=amt2*HOUSE_FEE
                    p.dep+=amt2; p.bank-=amt2
                    blocks[tgt]["stakes"][k]=blocks[tgt]["stakes"].get(k,0)+net
                    p.block=tgt; p.joinT=t
    # endgame
    win=list(blocks.values())[0]; init=win["init"]
    players[init].ret+=leftover*KAPPA
    pool=leftover*(1-KAPPA)
    joiners=[k for k in win["stakes"] if k!=init]
    if joiners:
        wsum=sum(players[k].joinT+1 for k in joiners)
        for k in joiners: players[k].ret+=pool*(players[k].joinT+1)/wsum
    else:
        players[init].ret+=pool
    for k,amt in win["stakes"].items():
        players[k].ret+=amt
    return players,house[0]

# ---- aggregate -------------------------------------------------------------
rows=[]; H=0;D=0;R=0
for _ in range(N_GAMES):
    pls,h=run(); H+=h
    for p in pls.values():
        net=p.ret-p.dep; rows.append((p.skill,p.dep,net)); D+=p.dep; R+=p.ret
n=len(rows)
print(f"games={N_GAMES} entries={n}")
print(f"deposited ${D:,.0f} returned ${R:,.0f} house ${H:,.0f} ({H/D*100:.1f}%)")
print(f"solvency diff ${R+H-D:,.0f}")
# skill quartiles
rows.sort(key=lambda x:x[0])
q=n//4
for i,name in enumerate(["Q1 worst","Q2","Q3","Q4 best"]):
    seg=rows[i*q:(i+1)*q] if i<3 else rows[3*q:]
    nets=[x[2] for x in seg]; sk=[x[0] for x in seg]
    print(f"{name}: skill~{statistics.mean(sk):.2f}  mean net ${statistics.mean(nets):,.2f}  median ${statistics.median(nets):,.2f}  win% {sum(1 for v in nets if v>0)/len(nets)*100:.0f}")
# correlation skill vs net
sk=[x[0] for x in rows]; nt=[x[2] for x in rows]
ms,mn=statistics.mean(sk),statistics.mean(nt)
cov=sum((a-ms)*(b-mn) for a,b in zip(sk,nt))/n
corr=cov/(statistics.pstdev(sk)*statistics.pstdev(nt))
print(f"corr(skill, net P/L) = {corr:+.3f}")
# whales
wh=[x[2] for x in rows if x[1]>1500]; sm=[x[2] for x in rows if x[1]<=1500]
print(f"WHALE(dep>1500) mean ${statistics.mean(wh):,.2f}  SMALL mean ${statistics.mean(sm):,.2f}")
