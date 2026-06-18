import importlib.util, statistics, random
# load run() from sim_realloc by exec with KAPPA override
src=open("C:/Users/HP/Desktop/buzz/sim_realloc.py").read()
for KAP in (0.0,0.25,0.50,0.75):
    g={}; 
    code=src.replace("KAPPA=0.50",f"KAPPA={KAP}").split("rows=[]")[0]
    exec(code,g)
    rows=[];H=D=R=0
    random.seed(42)
    for _ in range(1500):
        pls,h=g["run"](); H+=h
        for p in pls.values(): rows.append((p.skill,p.dep,p.ret-p.dep)); D+=p.dep;R+=p.ret
    n=len(rows); rows.sort(key=lambda x:x[0]); q=n//4
    qm=[statistics.mean([x[2] for x in (rows[i*q:(i+1)*q] if i<3 else rows[3*q:])]) for i in range(4)]
    qw=[sum(1 for x in (rows[i*q:(i+1)*q] if i<3 else rows[3*q:]) if x[2]>0)/q*100 for i in range(4)]
    spread=qm[3]-qm[0]
    print(f"K={KAP:.2f} | Q-means {qm[0]:7.1f}{qm[1]:7.1f}{qm[2]:7.1f}{qm[3]:7.1f} | skill-spread ${spread:6.1f} | winrate {qw[0]:.0f}->{qw[3]:.0f}%")
