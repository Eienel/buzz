"""
Last Circle Standing — simulator v2 (matches SPEC.md v0.1)

Variant A start (1 founder/block), CLOSED participant set, temperature-controlled
death lottery driven by convergence, dynamic anti-whale stake caps, deterministic
survival-weighted refunds, join-time-weighted endgame split.
"""
import random, math, statistics

# ---- master params (mirror SPEC.md) ----------------------------------------
N_GAMES   = 3000
N_FOUNDERS= 12
STAKE0    = (50, 1500)     # initial single stake range (wide -> includes "whales")
RHO_RAND, RHO_SKILL = 4.0, 1.5
T_HI, T_LO   = 5.0, 0.15
BETA_HI, BETA_LO = 1.5, 1.05
R_LO, R_HI   = 0.65, 0.90
KAPPA        = 0.50
SKIM_LO, SKIM_HI = 0.01, 0.05
HOUSE_FEE    = 0.03
T_MAX        = N_FOUNDERS + 4
P_REENTER    = 0.6
P_CARRY      = 0.5
REENTRY_NEW  = (50, 800)   # new-money re-entry draw (before cap)
PLAYER_CAP_FRAC = 0.5      # per-instance per-player cap = frac of pack median
# ----------------------------------------------------------------------------

class Player:
    __slots__=("pid","deposited","returned","bankroll")
    def __init__(s,pid): s.pid=pid; s.deposited=0.0; s.returned=0.0; s.bankroll=0.0

def convergence(vals):
    vmax,vmin=max(vals),min(vals)
    if vmin<=0: return 0.0
    rho=vmax/vmin
    c=(RHO_RAND-rho)/(RHO_RAND-RHO_SKILL)
    return min(1.0,max(0.0,c))

def run_game():
    players={}
    def P(pid):
        if pid not in players: players[pid]=Player(pid)
        return players[pid]
    house=[0.0]; leftover=0.0
    def deposit(pl,amt):
        fee=amt*HOUSE_FEE; house[0]+=fee; return amt-fee

    # instance 0: one founder per block (closed set = these N wallets)
    blocks=[]
    for b in range(N_FOUNDERS):
        pl=P(b); amt=random.uniform(*STAKE0)
        pl.deposited+=amt; pl.bankroll=random.uniform(0,2000)  # spare funds
        net=deposit(pl,amt)
        blocks.append({"stakes":{b:net},"init":b,"join":{b:0}})

    t=0
    while len(blocks)>1:
        t+=1
        vals=[sum(bl["stakes"].values()) for bl in blocks]
        c=max(convergence(vals), min(1.0, t/T_MAX))   # convergence + hard fallback
        m=len(blocks); meanv=sum(vals)/m

        # ---- temperature death lottery ----
        T=T_HI*(1-c)+T_LO*c
        ws=[math.exp(-v/(T*meanv)) for v in vals]
        s=sum(ws); probs=[w/s for w in ws]
        rd=random.random(); acc=0; idx=0
        for i,p in enumerate(probs):
            acc+=p
            if rd<=acc: idx=i; break
        dead=blocks.pop(idx)

        # ---- survival-weighted refund ----
        r=R_LO+(R_HI-R_LO)*min(1.0,t/T_MAX)
        pot=sum(dead["stakes"].values()); leftover+=pot*(1-r)
        survivors=blocks
        if not survivors:
            for pid,amt in dead["stakes"].items(): P(pid).returned+=amt*r
            break

        for pid,amt in dead["stakes"].items():
            refund=amt*r; pl=P(pid); pl.returned+=refund
            if random.random()<P_REENTER:
                # choose a target the player can actually afford to enter
                tgt=random.choice(survivors)
                vmed=statistics.median([sum(b["stakes"].values()) for b in survivors])
                beta=BETA_HI*(1-c)+BETA_LO*c
                vt=sum(tgt["stakes"].values())
                cap_block=max(0.0, beta*vmed - vt)
                cap_player=PLAYER_CAP_FRAC*vmed
                cap=min(cap_block,cap_player)
                if cap<=1:
                    continue
                if random.random()<P_CARRY:
                    add=min(refund,cap); pl.returned-=add  # carry forward, no new fee
                    stake_in=add
                else:
                    want=min(random.uniform(*REENTRY_NEW),cap)
                    pl.deposited+=want; stake_in=deposit(pl,want)
                if pid in tgt["stakes"]: tgt["stakes"][pid]+=stake_in
                else: tgt["stakes"][pid]=stake_in; tgt["join"][pid]=t

    # ---- endgame ----
    win=blocks[0]; init=win["init"]
    init_share=leftover*KAPPA; P(init).returned+=init_share
    pool=leftover-init_share
    joiners=[pid for pid in win["stakes"] if pid!=init]
    if joiners:
        weights={pid:win["join"][pid]+1 for pid in joiners}; W=sum(weights.values())
        for pid in joiners: P(pid).returned+=pool*weights[pid]/W
    else:
        P(init).returned+=pool
    for pid,amt in win["stakes"].items():
        if pid==init: P(pid).returned+=amt
        else:
            sk=random.uniform(SKIM_LO,SKIM_HI)
            P(pid).returned+=amt*(1-sk); P(init).returned+=amt*sk
    return players,house[0]

# ---- aggregate -------------------------------------------------------------
net=[]; H=0.0; D=0.0; Rr=0.0; wins=loss=0
whale_net=[]; small_net=[]
for _ in range(N_GAMES):
    pls,h=run_game(); H+=h
    for pl in pls.values():
        x=pl.returned-pl.deposited; net.append(x); D+=pl.deposited; Rr+=pl.returned
        if x>0: wins+=1
        elif x<0: loss+=1
        (whale_net if pl.deposited>900 else small_net).append(x)

net.sort(); n=len(net)
def pct(p): return net[min(n-1,int(p*n))]
print(f"games={N_GAMES}  entries={n}")
print(f"deposited ${D:,.0f}  returned ${Rr:,.0f}  house ${H:,.0f} ({H/D*100:.1f}%)")
print(f"solvency: returned+house ${Rr+H:,.0f} vs deposited ${D:,.0f}  diff ${Rr+H-D:,.2f}")
print(f"net>0 {wins/n*100:.1f}%   net<0 {loss/n*100:.1f}%")
print(f"median ${statistics.median(net):,.2f}   mean ${statistics.mean(net):,.2f}")
print("percentiles:", " ".join(f"p{int(p*100)}=${pct(p):,.0f}" for p in (.01,.1,.5,.9,.99)))
print(f"WHALE (dep>900) mean ${statistics.mean(whale_net):,.2f}  median ${statistics.median(whale_net):,.2f}")
print(f"SMALL (dep<=900) mean ${statistics.mean(small_net):,.2f}  median ${statistics.median(small_net):,.2f}")
