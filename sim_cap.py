# Reuse v6 engine but sweep the MAX stake cap; report loss distribution.
import random, statistics
src=open("C:/Users/HP/Desktop/buzz/sim_final.py").read().split("def batch")[0]
for CAP in (500,1000,2000,5000,100000):
    g={}; exec(src.replace("STAKE0=(50,1500)",f"STAKE0=(50,{CAP})"),g)
    random.seed(99); nets=[]; deps=[]
    for _ in range(2000):
        pls,h,ws,np_=g["run"]()
        for p in pls.values(): nets.append(p.ret-p.dep); deps.append(p.dep)
    nets.sort(); n=len(nets)
    worst=nets[0]; p1=nets[int(.01*n)]; p5=nets[int(.05*n)]
    bigloss=sum(1 for x in nets if x<-1000)/n*100
    avgdep=statistics.mean(deps)
    print(f"cap ${CAP:>6}: worst ${worst:>9,.0f} | p1 ${p1:>8,.0f} | p5 ${p5:>7,.0f} | %losing >$1k: {bigloss:4.1f}% | avg dep ${avgdep:,.0f}")
