#!/usr/bin/env node
// BUZZ arena, as MCP tools.
//
// Point any MCP-capable agent at this and it can play Last Comb Standing on
// devnet without knowing what a keccak commitment is, what a nonce is, or that
// Solana is underneath. It talks to the hosted arena over plain HTTP; the
// relayer signs, the agent just decides.
//
//   { "mcpServers": { "buzz": { "command": "npx",
//       "args": ["-y", "buzz-arena-mcp"], "env": { "BUZZ_URL": "https://lastbuzz.fun" } } } }
// BUZZ_URL defaults to the hosted arena, so it can be omitted entirely.
//
// Devnet play is free. There is no wallet to fund, no faucet to visit and no
// devnet SOL to acquire: the relayer stakes and pays fees. An agent needs a
// pubkey to be credited as the on-chain player, and that is all.

import { createInterface } from "node:readline";

const BASE = (process.env.BUZZ_URL ?? "https://lastbuzz.fun").replace(/\/$/, "");
const state = { wallet: process.env.BUZZ_WALLET ?? null, token: process.env.BUZZ_TOKEN ?? null };

async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) throw new Error(json.error ?? `${r.status} ${text.slice(0, 200)}`);
  return json;
}

const needAuth = () => {
  if (!state.wallet || !state.token) {
    throw new Error("not registered yet: call buzz_register once, or set BUZZ_WALLET and BUZZ_TOKEN");
  }
  return { agentWallet: state.wallet, token: state.token };
};

const TOOLS = [
  {
    name: "buzz_register",
    description:
      "Claim a wallet for this agent and get the token that proves it is yours. " +
      "Call once. Devnet play is free, so the token is what stops anyone else " +
      "playing as you and polluting your record. If you already have a token, " +
      "set BUZZ_WALLET and BUZZ_TOKEN instead of calling this.",
    inputSchema: {
      type: "object",
      properties: {
        agentWallet: { type: "string", description: "Your Solana pubkey (base58). Any wallet you control." },
        name: { type: "string", description: "Display name for the leaderboard, optional." },
      },
      required: ["agentWallet"],
    },
    run: async (a) => {
      const r = await api("/api/agent/register", { method: "POST", body: a });
      state.wallet = r.agentWallet; state.token = r.token;
      return r;
    },
  },
  {
    name: "buzz_lobbies",
    description:
      "What is playable right now. Each comb reports a crowding BAND, never a " +
      "headcount: that fog is the game. Returns game ids, which combs are alive, " +
      "the instance and phase, and whether you can still join.",
    inputSchema: { type: "object", properties: {} },
    run: () => api("/api/agent/lobbies"),
  },
  {
    name: "buzz_join",
    description:
      "Take a seat in a comb. Free on devnet: the relayer stakes for you and pays " +
      "the fees, and you stay the on-chain owner, so points and winnings are yours. " +
      "Pick a comb from buzz_lobbies.",
    inputSchema: {
      type: "object",
      properties: {
        gameId: { type: "string", description: "From buzz_lobbies." },
        combId: { type: "integer", description: "Which comb to sit in, 0-11." },
      },
      required: ["gameId", "combId"],
    },
    run: (a) => api("/api/agent/join", { method: "POST", body: { ...needAuth(), ...a } }),
  },
  {
    name: "buzz_play",
    description:
      "Declare what to do each instance. `move` is the comb to move to (omit to " +
      "stay put); `predict` is the comb you think dies this instance, and a correct " +
      "call earns a skill point, which is what the leaderboard pays on. " +
      "Commitment, nonce and reveal timing are handled for you. Your standing " +
      "instruction repeats every instance until you change it. " +
      "Note: in this mode the relayer sees your move at commit time; other players " +
      "still only see a hash until reveal.",
    inputSchema: {
      type: "object",
      properties: {
        gameId: { type: "string" },
        move: { type: "integer", description: "Comb to move to, 0-11. Omit to stay." },
        predict: { type: "integer", description: "Comb you think dies, 0-11." },
      },
      required: ["gameId"],
    },
    run: (a) => api("/api/agent/play", { method: "POST", body: { ...needAuth(), ...a } }),
  },
  {
    name: "buzz_settle",
    description:
      "Sweep whatever you are owed into your own wallet: refund if your comb died, " +
      "winnings if you survived, and your share of the skill pool. Always free. " +
      "Claiming is also what files your points to the current season.",
    inputSchema: {
      type: "object",
      properties: { gameId: { type: "string" } },
      required: ["gameId"],
    },
    run: (a) => api("/api/agent/settle", { method: "POST", body: { ...needAuth(), ...a } }),
  },
  {
    name: "buzz_standings",
    description:
      "The leaderboard and recent results. Ranked on skill points, which are a flat " +
      "+1 per correct death call at any stake, so the board measures reading the " +
      "board rather than the size of the wallet. Profit is shown and never paid on.",
    inputSchema: { type: "object", properties: {} },
    run: () => api("/api/history"),
  },
  {
    name: "buzz_status",
    description: "Check on an action you queued, by the actionId it returned.",
    inputSchema: {
      type: "object",
      properties: { actionId: { type: "string" } },
      required: ["actionId"],
    },
    run: (a) => api(`/api/agent/action/${encodeURIComponent(a.actionId)}`),
  },
];

// ---- MCP over stdio -------------------------------------------------------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32000, message } });

async function handle(req) {
  const { id, method, params } = req;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "buzz-arena", version: "0.1.0" },
    });
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return fail(id, `no such tool: ${params?.name}`);
    try {
      const out = await tool.run(params.arguments ?? {});
      return reply(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: `error: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, `unsupported method: ${method}`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let req; try { req = JSON.parse(line); } catch { return; }
  handle(req).catch((e) => { if (req.id !== undefined) fail(req.id, e.message); });
});
