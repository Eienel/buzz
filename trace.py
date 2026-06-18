import random
random.seed(7)
N=6; KAPPA=0.25; R_LO,R_HI=0.65,0.90; FEE=0.03; G=60; tau=G/(N-1)
names=["Ava","Ben","Cy","Dot","Eli","Fox","Gus","Hal","Ivy","Jax","Kai","Lux"]
skills={"Ava":.9,"Ben":.2,"Cy":.8,"Dot":.5,"Eli":.95,"Fox":.3,"Gus":.7,"Hal":.15,"Ivy":.85,"Jax":.4,"Kai":.6,"Lux":.25}
stake0={n:random.choice([100,150,200,300,500,800]) for n in names}
# assign 2 players per block
members={b:[] for b in range(N)}
for i,n in enumerate(names): members[i//2].append(n)
stake={n:stake0[n]*(1-FEE) for n in names}; dep={n:stake0[n] for n in names}
joinT={n:0 for n in names}; block={n:b for b in members for n in members[b]}
alive=set(range(N)); leftover=0.0; t=0
print(f"LOBBY: 6 circles, 12 players, {tau:.0f}s/instance, ~60s game, K={KAPPA}\n")
for b in range(N):
    print(f"  Circle {b}: "+", ".join(f"{n}(${dep[n]},skill{skills[n]})" for n in members[b]))
print()
while len(alive)>1:
    t+=1; clock=int((t-1)*tau)
    cnt={b:len(members[b]) for b in alive}
    order=sorted(alive,key=lambda b:cnt[b]); atrisk=set(order[:max(1,len(alive)//3)]); safehi=order[-1]
    print(f"--- t={t}  (clock {clock}s)  headcounts: "+", ".join(f"C{b}:{cnt[b]}" for b in order)+f"  | AT RISK: {sorted(atrisk)}")
    moves=[]
    for b in list(alive):
        for n in list(members[b]):
            if b in atrisk:
                if random.random()<skills[n]:
                    tgt=order[-2] if (random.random()<skills[n]*0.4 and len(order)>2) else safehi
                    if tgt!=b: moves.append((n,tgt)); print(f"    {n:4} (C{b} at risk, skill {skills[n]}) -> FLEES to C{tgt}")
                    else: print(f"    {n:4} (C{b} at risk) holds (already safest target)")
                else:
                    print(f"    {n:4} (C{b} at risk, skill {skills[n]}) FREEZES - stays  [risky]")
            else:
                print(f"    {n:4} (C{b} safe) holds")
    for n,tgt in moves:
        members[block[n]].remove(n); members[tgt].append(n); block[n]=tgt; joinT[n]=t
    cnt={b:len(members[b]) for b in alive}; lo=min(cnt.values())
    cand=[b for b in alive if cnt[b]==lo]
    if len(cand)>1:
        money={b:sum(stake[x] for x in members[b]) for b in cand}; mlo=min(money.values()); cand=[b for b in cand if money[b]==mlo]
    dead=random.choice(cand); r=R_LO+(R_HI-R_LO)*min(1,t/(N+2))
    print(f"  REVEAL -> new counts: "+", ".join(f"C{b}:{len(members[b])}" for b in alive))
    print(f"  >> Circle {dead} has fewest players -> DIES. Refund {r*100:.0f}%")
    for n in list(members[dead]):
        ref=stake[n]*r; leftover+=stake[n]*(1-r); stake[n]=ref
        alive_left=[b for b in alive if b!=dead]
        tgt=max(alive_left,key=lambda b:len(members[b]))
        members[dead].remove(n); members[tgt].append(n); block[n]=tgt; joinT[n]=t
        print(f"     {n} refunded -> ${ref:.0f}, carries into C{tgt}")
    alive.discard(dead); print(f"     leftover pot now ${leftover:.0f}\n")
win=next(iter(alive)); wm=members[win]; init=min(wm,key=lambda x:joinT[x])
print(f"=== WINNER: Circle {win} -> {wm} ===")
ret={n:0.0 for n in names}
ret[init]+=leftover*KAPPA; pool=leftover*(1-KAPPA)
joiners=[x for x in wm if x!=init]
if joiners:
    ws=sum(joinT[x]+1 for x in joiners)
    for x in joiners: ret[x]+=pool*(joinT[x]+1)/ws
for x in wm: ret[x]+=stake[x]
print(f"initiator {init} takes {KAPPA*100:.0f}% of ${leftover:.0f} pot = ${leftover*KAPPA:.0f}")
print("\nFINAL P/L:")
for n in sorted(names,key=lambda x:-(ret[x]-dep[x])):
    print(f"  {n:4} skill{skills[n]:<4} dep ${dep[n]:<4} -> got ${ret[n]:6.0f}  net ${ret[n]-dep[n]:+7.0f}  {'WINNER-CIRCLE' if n in wm else 'eliminated(refunded)'}")
