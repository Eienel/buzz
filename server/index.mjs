// BUZZ server: serves the static site and a cached game-state API.
//
// Why this exists: every spectator polling getProgramAccounts directly rate-limits
// the public RPC (the 429s we hit on devnet). One poller here, cached, means a
// thousand viewers cost one RPC subscription instead of a thousand.
//
//   PORT=3000 RPC=https://api.devnet.solana.com node server/index.mjs
//
// Set RUN_SWARM=1 to also run the agent swarm in this process.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Connection, PublicKey } from "@solana/web3.js";

const ROOT = fileURLToPath(new URL("../app/", import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PROGRAM_ID = process.env.PROGRAM_ID ?? "4TNbztSMd3zxG57M25y8WhpcKrQMJQVYEK6EnnkQy1Hw";
const POLL_MS = Number(process.env.POLL_MS ?? 2000);

const connection = new Connection(RPC, "confirmed");
const PID = new PublicKey(PROGRAM_ID);

// ---- account decoding (manual borsh; avoids pulling anchor into the server) --
const DISC = { game: [27,90,166,125,74,100,121,18], circle: [27,59,8,117,62,199,222,252] };
const u8=(d,o)=>d[o], u16=(d,o)=>d[o]|d[o+1]<<8, u32=(d,o)=>(d[o]|d[o+1]<<8|d[o+2]<<16|d[o+3]<<24)>>>0;
const u64=(d,o)=>{let n=0n;for(let i=7;i>=0;i--)n=n<<8n|BigInt(d[o+i]);return n};
const eq=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const b58=(()=>{const A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  return (bytes)=>{let n=0n;for(const b of bytes)n=n<<8n|BigInt(b);let s="";
    while(n>0n){s=A[Number(n%58n)]+s;n/=58n}
    for(const b of bytes){if(b===0)s="1"+s;else break}return s||"1"};})();

function decodeGame(d){let o=8;const g={};
  g.gameId=String(u64(d,o));o+=8;o+=32;g.status=u8(d,o);o+=1;g.numCircles=u8(d,o);o+=1;
  g.lockInstance=u16(d,o);o+=2;g.instance=u16(d,o);o+=2;g.phase=u8(d,o);o+=1;
  g.phaseEndsAt=Number(u64(d,o));o+=8;g.instanceSeconds=u32(d,o);o+=4;
  g.doomed=u8(d,o);o+=1;g.circleCount=u8(d,o);o+=1;g.aliveCircles=u8(d,o);o+=1;
  g.players=u32(d,o);o+=4;g.leftover=String(u64(d,o));o+=8;g.fees=String(u64(d,o));o+=8;
  g.deposited=String(u64(d,o));o+=8;g.points=String(u64(d,o));o+=8;o+=16;
  o+=1;o+=1;g.insane=!!u8(d,o);return g;}

function decodeCircle(d){let o=8;const c={};
  c.game=b58(d.slice(o,o+32));o+=32;c.id=u8(d,o);o+=1;
  c.creator=b58(d.slice(o,o+32));o+=32;
  c.members=u32(d,o);o+=4;c.stake=String(u64(d,o));o+=8;c.alive=!!u8(d,o);o+=1;
  c.refundBps=u16(d,o);return c;}

// ---- poller: one RPC scan, cached for every viewer ---------------------------
let snapshot = { ok:false, updatedAt:0, games:[], error:"starting" };

async function poll(){
  try{
    const accs = await connection.getProgramAccounts(PID, { encoding:"base64" });
    const games=[], circles=[];
    for(const {pubkey, account} of accs){
      const d = account.data;
      const disc = Array.from(d.slice(0,8));
      if(eq(disc,DISC.game)) games.push({ pubkey: pubkey.toBase58(), ...decodeGame(d) });
      else if(eq(disc,DISC.circle)) circles.push(decodeCircle(d));
    }
    for(const g of games) g.combs = circles.filter(c=>c.game===g.pubkey).sort((a,b)=>a.id-b.id);
    games.sort((a,b)=>Number(BigInt(b.gameId)-BigInt(a.gameId)));
    snapshot = { ok:true, updatedAt:Date.now(), programId:PROGRAM_ID, cluster:RPC.includes("devnet")?"devnet":"mainnet",
                 live:games.filter(g=>g.status===0||g.status===1), finished:games.filter(g=>g.status>=2).length };
  }catch(e){
    snapshot = { ...snapshot, ok:false, error:String(e.message).slice(0,120), updatedAt:Date.now() };
  }
}
poll(); setInterval(poll, POLL_MS);

// ---- static + api ------------------------------------------------------------
const MIME = {".html":"text/html; charset=utf-8",".css":"text/css",".js":"text/javascript",
  ".png":"image/png",".svg":"image/svg+xml",".json":"application/json",".ico":"image/x-icon"};

createServer(async (req,res)=>{
  const url = new URL(req.url, "http://x");
  let p = decodeURIComponent(url.pathname);

  if(p === "/api/state"){
    res.writeHead(200,{ "content-type":"application/json",
      "cache-control":"no-store", "access-control-allow-origin":"*" });
    return res.end(JSON.stringify(snapshot));
  }
  if(p === "/healthz"){
    res.writeHead(snapshot.ok?200:503,{ "content-type":"text/plain" });
    return res.end(snapshot.ok ? "ok" : "rpc: "+snapshot.error);
  }

  if(p === "/") p = "/index.html";
  if(p === "/arena") p = "/arena.html";
  // contain path traversal: resolve inside ROOT only
  const file = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if(!file.startsWith(ROOT) || !existsSync(file)){
    res.writeHead(404,{ "content-type":"text/plain" });
    return res.end("not found");
  }
  try{
    const body = await readFile(file);
    res.writeHead(200,{ "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": extname(file)===".html" ? "no-cache" : "public, max-age=3600" });
    res.end(body);
  }catch{
    res.writeHead(500,{ "content-type":"text/plain" }); res.end("read error");
  }
}).listen(PORT, ()=>console.log(`buzz server on :${PORT} (rpc ${RPC}, poll ${POLL_MS}ms)`));

// ---- optional: run the agent swarm alongside the web service -----------------
if(process.env.RUN_SWARM === "1"){
  const start = () => {
    console.log("[swarm] starting");
    const c = spawn("node", [fileURLToPath(new URL("../agents/swarm.mjs", import.meta.url))],
      { stdio:"inherit", env: process.env });
    c.on("exit", (code)=>{ console.log(`[swarm] exited ${code}, restarting in 20s`); setTimeout(start, 20000); });
  };
  start();
}
