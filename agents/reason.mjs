// A strategy that thinks, instead of following a rule.
//
// The house agents have always been three if-statements: herd, contrarian and
// random. They are a fine control group and a poor demonstration, because the
// interesting question about an arena for AI agents is whether reasoning beats
// a rule when the board is hidden. This asks a model that question every
// instance and lets the leaderboard settle it.
//
// Routed through whichever provider has a key: OPENROUTER_KEY, GROQ_KEY or
// USEPOD_TOKEN, in that order. All three are OpenAI chat-completions. See
// PROVIDERS below for why the list exists and what the free tiers actually
// allow.
//
// With no key at all the arena runs exactly as before, and every failure
// inside falls back to a heuristic, because a model that is slow, broke or
// wrong must never be able to stall a live game.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the thinking is bought.
 *
 * UsePod was the only route and it is prepaid, so when the balance ran out the
 * whole reasoning cohort stopped and the traces page went blank. Money is not
 * always available and the arena should not need it to be interesting, so the
 * route is now a list and the first provider holding a key wins. All three
 * speak OpenAI chat-completions; the only real difference is where the
 * credential goes, which is why UsePod needed a special case at all (its token
 * is a path segment, not a header).
 *
 * Free tiers are the point of this, and they are small. Measured against the
 * live arena, which makes 105 calls an hour, 2,518 a day:
 *
 *   OpenRouter :free, no credits ever bought    50/day    2% of demand
 *   OpenRouter :free, $10 bought lifetime    1,000/day   40%
 *   Groq free tier, 30 req/min               1,000/day   40%
 *
 * So no single free tier carries the arena as it runs today, which is what
 * DAILY_CAP below is for: the demand is a choice, not a constraint.
 *
 * UNVERIFIED, and worth knowing before trusting a leaderboard built on it: the
 * free model ids below have never answered this prompt. Only UsePod's three
 * have. This file already documents the failure to watch for, because it has
 * bitten four models here: one that spends its allowance on hidden reasoning
 * tokens returns finish_reason "length" with empty content and never answers
 * inside a commit window. It shows up on /thinking as "no usable answer", and
 * the fix is to swap that id out of the list.
 */
const PROVIDERS = [
  { name: "openrouter",
    env: "OPENROUTER_KEY",
    url: () => "https://openrouter.ai/api/v1/chat/completions",
    // The referer and title are how OpenRouter attributes traffic on its own
    // leaderboards. Free either way, and being visible there costs nothing.
    headers: (k) => ({ authorization: `Bearer ${k}`,
                       "http-referer": "https://lastbuzz.fun", "x-title": "BUZZ arena" }),
    // Read off the live /api/v1/models list on 2026-09-10, not remembered: the
    // three ids guessed from memory first time round all 404'd. The free roster
    // churns, so re-check with
    //   curl -s https://openrouter.ai/api/v1/models | jq -r '.data[].id|select(endswith(":free"))'
    // Three labs, for the same reason DEFAULT_MODELS has three: identical pods
    // asking one model are one agent with three wallets. Reasoning-tagged and
    // task-specific variants are left out on purpose, see below.
    models: ["google/gemma-4-31b-it:free",
             "nvidia/nemotron-3-super-120b-a12b:free",
             "nex-agi/nex-n2.5-pro:free"] },
  { name: "groq",
    env: "GROQ_KEY",
    url: () => "https://api.groq.com/openai/v1/chat/completions",
    headers: (k) => ({ authorization: `Bearer ${k}` }),
    // Named in Groq's own rate-limit table. Same caveat as OpenRouter above.
    models: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"] },
  { name: "usepod",
    env: "USEPOD_TOKEN",
    url: (k) => `https://api.usepod.ai/proxy/${k}/v1/chat/completions`,
    headers: () => ({}),
    models: ["meta-llama/llama-4-maverick",
             "mistralai/mistral-medium-3.1",
             "anthropic/claude-haiku-4.5"] },
];

/** The first provider with a key, or null when none is configured. */
export function activeProvider() {
  for (const p of PROVIDERS) if ((process.env[p.env] ?? "").length) return p;
  return null;
}
// Four pods asking one model the same question at the same temperature are one
// agent with four wallets. Each pod gets its own model and its own disposition
// so the reasoning cohort is four independent opinions, which is the only way
// the comparison against five heuristics means anything.
// One lab per pod. Chosen by measurement, not by reputation: models that stream
// hidden reasoning tokens spend the whole budget thinking and return empty
// content with finish_reason "length", so they never answer inside a commit
// window and are unusable here. That list was glm-4.7-flash, gemini-3.5-flash
// and deepseek-v4-flash; openai/gpt-5.4-mini has joined it and was in play
// while it did. Measured against the real prompt: nothing at 700 tokens,
// aborted at 1200, nothing again at 1800. It answers a short prompt fine,
// which is exactly why a short probe did not catch it.
const DEFAULT_MODELS = [
  "meta-llama/llama-4-maverick",
  "mistralai/mistral-medium-3.1",
  "anthropic/claude-haiku-4.5",
];
const MODELS = (() => {
  const named = (process.env.INFER_MODELS ?? process.env.USEPOD_MODELS ?? "")
    .split(",").map((m) => m.trim()).filter(Boolean);
  if (named.length) return named;
  return activeProvider()?.models ?? DEFAULT_MODELS;
})();
const PERSONAS = [
  "You weight recent trend over the current snapshot; a comb that has been bleeding keeps bleeding.",
  "You assume the other agents are more predictable than they look and lean hard on the known field.",
  "You are cautious: when two combs are close, you take the one that keeps you alive over the one that scores.",
  "You hunt the point: you will sit somewhere risky if it puts you on the right side of a prediction.",
];
export const modelFor = (i) => MODELS[i % MODELS.length];
export const personaFor = (i) => PERSONAS[i % PERSONAS.length];
// Measured on the live proxy, not guessed: llama answered in 2.8s and 18.5s on
// consecutive calls, mistral in 2.1s and 9.6s, gpt-5.4-mini in 10.5s. The old
// 20s cap sat inside that spread, so the arena logged aborts at exactly 20000ms
// while the models were still working. The commit window is the real bound and
// budgetFor already applies it; this only stops a long tempo authorising a
// minute-long call.
// Raised again on production numbers rather than sandbox ones. Over a 255-call
// window the live arena answered 121 and skipped 134, and 111 of those 134 were
// "This operation was aborted": the deadline, not the model. Answered latency
// was p50 12.7s, p95 25.2s, so a 27s deadline was cutting off roughly half the
// calls while the model was still working.
const TIMEOUT_CAP = Number(process.env.USEPOD_TIMEOUT_MS ?? 34000);
const MAX_TOKENS = Number(process.env.USEPOD_MAX_TOKENS ?? 700);

// A fixed timeout does not survive short games. Commit is 60% of an instance,
// so a 24s round leaves a 14s window that also has to carry two on-chain
// commits per agent. Thinking gets a slice of that window, never the whole
// thing, so a model that runs long is cut off with time left to abstain
// cleanly rather than stalling the round for everyone else.
function budgetFor(instanceSeconds, stagger = 0) {
  if (!instanceSeconds) return TIMEOUT_CAP;
  const commitWindow = instanceSeconds * 0.6 * 1000;
  // 0.45 was sized for four calls racing each other, which is the thing the
  // stagger now removes. Measured: four concurrent calls all inflate to
  // whatever the cap is (1 of 4 answered), the same four spaced out answer in
  // 5.3s, 8.9s and 14.4s (3 of 4). Spacing them buys the room to wait longer,
  // and a quarter of the window is still held back for the two commits.
  // 0.75 of a 60s tempo's window is 27s, which sat right on the measured p95.
  // Two commits take a couple of seconds, not the nine that 0.75 held back, so
  // the reserve is 15% now. That is the most this lever can give: at 60s the
  // budget only reaches 30.6s, and the tail runs past it. The window itself is
  // the real bound, so pods want a slower tempo (at 120s the cap binds first,
  // at 34s, which is clear of the p95 by nine seconds).
  return Math.max(2500, Math.min(TIMEOUT_CAP, commitWindow * 0.85 - stagger));
}

export const reasoningEnabled = () => !!activeProvider();

const SYSTEM =
  "You play Last Comb Standing. Six combs, one dies each round, last one alive wins.\n\n" +
  "THE RULE: the comb holding the FEWEST members AFTER everyone moves dies. Ties go to " +
  "the comb with the least stake, then pseudo-random. 15% of rounds a fate strike kills " +
  "a random comb instead.\n\n" +
  "THE HARD PART: the counts you are shown are LAST round's, taken before anyone moved. " +
  "Every agent is moving right now, simultaneously, off the same stale numbers you have. " +
  "So naming the comb that is smallest in the numbers in front of you is almost always " +
  "WRONG: everyone can see it is smallest, nobody wants to be in the doomed comb, and the " +
  "ones who can leave it do. Meanwhile the comb that looks safe attracts nobody and can " +
  "empty out. Work out where the crowd is about to go, subtract the leavers, add the " +
  "arrivers, then name the smallest comb in the board you just forecast.\n\n" +
  "WHO YOU ARE PLAYING: five rule-following agents, working off the same stale counts you " +
  "have. Two always move into whichever comb is currently LARGEST. Two never move at all, " +
  "ever, whatever the board looks like. One moves to a comb picked at random. That is the " +
  "whole field, it never changes, and it means the board is largely forecastable: the " +
  "largest comb gains about two, every other comb loses whichever herd members it held, " +
  "and one random walker lands somewhere. A comb that is small and is not the largest does " +
  "NOT refill, because the only agents who would move there are the ones who never move.\n\n" +
  "YOUR OWN SURVIVAL: you are in one of these combs. If the comb you are sitting in ends " +
  "the round smallest, you are eliminated and play no further rounds. Apply the same " +
  "forecast to yourself: if your comb is at or near the bottom of the board you just " +
  "forecast, move. Staying put is correct only when your forecast puts your comb clear of " +
  "last place. Never predict your own comb dies and then stay in it.\n\n" +
  "WHAT THINKING COSTS: you have a limited number of thinking calls for this whole " +
  "game, bought with skill points you earned in earlier games. Every call spends one, " +
  "including this one, and they are not refilled. When they run out you stop reasoning " +
  "for the rest of the game: you hold your comb and forfeit every remaining prediction. " +
  "So spend them where they change something. An early board with six combs and an " +
  "obvious answer is worth less than a late board with three combs and a real choice, " +
  "and predicting well is what earns the calls you get next game.\n\n" +
  "Reply with JSON only, in this field order:\n" +
  "{\"mine\": <forecast member count of YOUR current comb after this round's moves>,\n" +
  " \"move\": <the comb id you will SIT IN this round>,\n" +
  " \"predict\": <the comb id you forecast dies this round>,\n" +
  " \"think_next\": <true to spend a call next round, false to save it>,\n" +
  " \"why\": \"<12 words>\"}\n" +
  "Work mine out first, then move, then predict. move must always be a comb id, never null: " +
  "name your current comb only if you worked out it survives. If mine puts your comb at or " +
  "near the bottom, name a different comb. A correct predict scores a point whether or not " +
  "you survive, and points are what the season pays on, but a dead agent predicts nothing " +
  "in later rounds. Never predict a comb because it is smallest right now, and never sit in " +
  "a comb you just forecast to be smallest.";



/**
 * Only ids that are actually alive may be used; a model may hallucinate one.
 * Returns null when the answer cannot be used, because a repaired answer is
 * not the model's answer and scoring it as one corrupts the benchmark.
 */
function sanitise(raw, fog, self) {
  const ids = Object.keys(fog).map(Number);
  const ok = (v) => Number.isInteger(v) && ids.includes(v);
  if (!ok(raw?.predict)) return null;            // no prediction, no round
  const move = ok(raw?.move) ? raw.move : null;  // no move is a real choice: stay put
  const why = typeof raw?.why === "string" ? raw.why.slice(0, 70) : "";
  // Default to thinking. A model that omits the field has not chosen to skip.
  const thinkNext = raw?.think_next === false ? false : true;
  // The forecast the prediction was drawn from. Not used to play, kept so the
  // feed can show what the model expected rather than only what it chose.
  const mine = Number.isInteger(raw?.mine) ? raw.mine : null;
  return { move: move === self ? null : move, predict: raw.predict, why, thinkNext, mine };
}

/**
 * One decision, or null when the model did not answer usably in time.
 *
 * A reasoning agent that silently degraded to the herd rule scored points the
 * model never earned, which is exactly the comparison this exists to make. So
 * every failure path returns null instead. The caller keeps the agent in the
 * game and holding its comb; it forfeits only the prediction for that round.
 */
/**
 * When the prepaid UsePod account is empty, and until when.
 *
 * A 402 insufficient_balance is not a per-agent condition and it is not fast:
 * measured on the live arena, being told there is no money took 13.1s and
 * 24.9s on consecutive calls. Every pod paid that out of its own commit window,
 * every round, to learn the same thing the pod before it had just learned. Over
 * one sampled window 53 of 60 calls were that, and the agents that spent it
 * still had their full 60 call budget untouched.
 *
 * So the first 402 opens the breaker for the whole cohort and the rest drop
 * straight to the heuristic with the window intact. It closes on its own,
 * because the account is topped up out of band and nothing here would be told.
 *
 * Written through a file because the swarm is spawned per game, so process
 * memory buys one game's quiet and then pays again: measured after shipping the
 * in-memory version, every new swarm re-learned it at 6.2s to 9.0s while the
 * pods behind it in the same process skipped at 0ms.
 *
 * Only when DATA_DIR is set, which in production is a volume and locally is
 * nothing. Read from the environment rather than imported from keypair.mjs on
 * purpose: this file has no imports at all beyond node builtins, and a strategy
 * module that pulls in web3.js to find a directory is a worse trade than a
 * breaker that holds in memory only when running from a checkout, where there
 * is one swarm anyway. Best effort in both directions: the cost of it failing
 * is one slow call per game, which is what this already improved on.
 */
/**
 * A ceiling on model calls per UTC day, so a free tier is not blown by lunchtime.
 *
 * Measured on the live arena: 105 calls an hour, 2,518 a day, from three pods
 * in each of about three concurrent games. Both free tiers worth using cap at
 * 1,000 a day, so the arena as it runs cannot fit in one and the honest fix is
 * to want less rather than to pretend the limit is not there.
 *
 * Running out is not an error and does not stop the game: a pod with no call
 * left holds its comb and forfeits the prediction, exactly as it does when the
 * model misses the commit window, and /thinking says which. Nine hundred is
 * deliberately under a thousand, because the provider counts retries and
 * failures that never reached us.
 *
 * Persisted for the same reason as the breaker below: the swarm is a child
 * process per game, so an in-memory count would reset every sixty seconds and
 * cap nothing at all.
 */
const DAILY_CAP = Number(process.env.INFER_DAILY_CAP ?? 900);

const DRY_MS = Number(process.env.USEPOD_DRY_COOLDOWN_MS ?? 10 * 60 * 1000);
const DRY_FILE = process.env.DATA_DIR ? join(process.env.DATA_DIR, "inference-dry.json") : null;
const SPEND_FILE = process.env.DATA_DIR ? join(process.env.DATA_DIR, "inference-spend.json") : null;

const today = () => new Date().toISOString().slice(0, 10);      // UTC day

/** Calls made so far today, read fresh because another swarm may have spent. */
function spentToday() {
  if (!SPEND_FILE) return 0;
  try {
    const s = JSON.parse(readFileSync(SPEND_FILE, "utf8"));
    return s.day === today() ? Number(s.calls) || 0 : 0;
  } catch { return 0; }
}

/** Count one call against the day. Best effort: a lost write costs one call. */
function spend() {
  if (!SPEND_FILE) return;
  try { writeFileSync(SPEND_FILE, JSON.stringify({ day: today(), calls: spentToday() + 1 })); }
  catch { /* the cap is a courtesy to the provider, not a correctness guard */ }
}

/** What is left of today's allowance, for the page and for the tests. */
export const dailyBudget = () => ({ cap: DAILY_CAP, spent: spentToday(),
                                    left: Math.max(0, DAILY_CAP - spentToday()) });
let dryUntil = 0;
if (DRY_FILE) {
  try { dryUntil = Number(JSON.parse(readFileSync(DRY_FILE, "utf8")).until) || 0; }
  catch { /* no file yet, or a shape we did not write: start closed */ }
}

/** ms timestamp the prepaid account is assumed empty until, or 0 if not. */
export const inferenceDry = () => (dryUntil > Date.now() ? dryUntil : 0);

function openBreaker() {
  dryUntil = Date.now() + DRY_MS;
  if (!DRY_FILE) return;
  try { writeFileSync(DRY_FILE, JSON.stringify({ until: dryUntil, at: Date.now() })); }
  catch { /* see above: a breaker that only holds in memory still helps */ }
}

export async function decide(fog, self, opts = {}) {
  // Reasoning switched off is a state worth publishing, not a silent return.
  // This was the one path that produced no record of any kind, which made an
  // arena with no token look exactly like an arena whose feed was broken, and
  // cost an evening telling the two apart.
  if (!activeProvider()) {
    const names = PROVIDERS.map((p) => p.env).join(", ");
    if (opts.onSkip) opts.onSkip(`no inference key set (${names}): reasoning is off`, 0);
    return null;
  }
  if (DAILY_CAP > 0 && spentToday() >= DAILY_CAP) {
    if (opts.onSkip) opts.onSkip(`daily inference cap reached: ${DAILY_CAP} calls used today`, 0);
    return null;
  }
  if (dryUntil > Date.now()) {
    const mins = Math.ceil((dryUntil - Date.now()) / 60000);
    if (opts.onSkip) opts.onSkip(`402 insufficient balance: prepaid account is empty, not retrying for ${mins}m`, 0);
    return null;
  }
  // Thinking is not free. An agent out of budget does not fall back to a rule,
  // it stops reasoning: it holds its comb and forfeits the prediction, exactly
  // as it does when the model misses the window. Being broke and being slow
  // cost the same thing, which is the round.
  if (opts.budget) {
    // The agent's own call to sit this one out, made last round when it could
    // still see the board. Honoured before the balance is even checked: a
    // saved call is the whole point of letting it decide.
    if (opts.budget.saving) {
      opts.budget.saving = false;
      if (opts.onSkip) opts.onSkip("chose to save a call");
      return null;
    }
    if (opts.budget.left <= 0) {
      if (opts.onSkip) opts.onSkip("out of inference budget");
      return null;
    }
  }

  // History is the only thing that distinguishes a comb that is steadily
  // bleeding from one that just took a crowd. Without it every round looks
  // like the first one and there is nothing to reason over.
  const hist = (opts.history ?? []).slice(-4);
  const trend = Object.keys(fog).map((id) => {
    const seen = hist.map((h) => h[id]).filter((v) => v !== undefined);
    return `comb ${id}: ${fog[id]} now${seen.length > 1 ? `, was ${seen.join(" -> ")}` : ""}`;
  }).join("\n");
  const user =
    `Round ${opts.instance ?? "?"}. You are in comb ${self}.\n` +
    `Last round's counts, and how each comb has trended:\n${trend}\n\n` +
    `${Object.values(fog).reduce((a, b) => a + b, 0)} members across ${Object.keys(fog).length} combs.\n` +
    `Your comb holds ${fog[self]} of them${fog[self] === Math.min(...Object.values(fog)) ? " and is currently tied for smallest" : ""}.\n` +
    (opts.budget
      ? `Thinking calls left after this one: ${Math.max(0, opts.budget.left)}. ` +
        `About ${Math.max(0, Object.keys(fog).length - 1)} rounds remain.\n`
      : "") +
    `Forecast this round's counts after everyone moves. Name the smallest as predict, ` +
    `and decide whether your own comb is safe to sit in. JSON only.`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), budgetFor(opts.instanceSeconds, opts.stagger ?? 0));
  const t0 = Date.now();
  try {
    const prov = activeProvider();
    const key = process.env[prov.env];
    // Count it before it is sent. A call that fails still consumed the
    // provider's allowance, and a cap that only counts successes is not a cap.
    spend();
    const r = await fetch(prov.url(key), {
      method: "POST",
      headers: { "content-type": "application/json", ...prov.headers(key) },
      signal: ctl.signal,
      body: JSON.stringify({
        model: opts.model ?? MODELS[0],
        messages: [
          { role: "system", content: opts.persona ? `${SYSTEM}\n\nYOUR DISPOSITION: ${opts.persona}` : SYSTEM },
          { role: "user", content: user },
        ],
        // 260 was enough for a forecast and not enough for a model that thinks
        // before it answers. gpt-5.4-mini spends the whole allowance on hidden
        // reasoning tokens and returns finish_reason "length" with empty
        // content: measured, 0 characters at 260 and valid JSON at 700. That is
        // the same failure this file already documents for glm and gemini, and
        // it had quietly reached one of the models actually in play.
        max_tokens: MAX_TOKENS,
        // Identical agents on an identical board would herd, so each pod is
        // spread across the range rather than all sitting at one value.
        temperature: opts.temperature ?? 0.7,
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 120);
      // The account, not this call. Trip the breaker before throwing so the
      // rest of the cohort skips instead of queueing behind the same answer.
      if (r.status === 402 || /insufficient[_ ]balance/i.test(body)) openBreaker();
      throw new Error(`${r.status} ${body}`);
    }
    const j = await r.json();
    // What the call actually cost and who served it. UsePod discloses the
    // serving provider and the route on every response, and prices the call in
    // the usage block, so the spend on this page is the marketplace's own
    // number rather than our estimate of it. Verified against the live API:
    // the documented X-Balance-Cost-Microunits header is not sent, but
    // usage.cost is, and two different provider ids served four models.
    const meta = {
      cost: j?.usage?.cost ?? null,
      tokensIn: j?.usage?.prompt_tokens ?? null,
      tokensOut: j?.usage?.completion_tokens ?? null,
      // UsePod discloses who served the call; the others do not, so fall back
      // to naming the route we chose, which is the honest answer either way.
      provider: r.headers.get("x-pod-provider-id") ?? prov.name,
      route: r.headers.get("x-pod-route") ?? prov.name,
    };
    const text = j?.choices?.[0]?.message?.content ?? "";
    // tolerate a model that wraps its JSON in prose or a code fence
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no json in reply");
    const plan = sanitise(JSON.parse(m[0]), fog, self);
    // Charge for an answer, not for an attempt. Charging on the attempt meant a
    // 24s round, where the think budget is 6.5s, could burn a whole game's
    // allowance on calls that timed out and returned nothing: the agent paid
    // for silence and then abstained for the rest of the game. That is what
    // took the reasoning cohort from 0.171 skill per game to 0.067.
    if (plan && opts.budget) opts.budget.spend();
    return plan && { ...plan, by: "model", ms: Date.now() - t0, model: opts.model ?? MODEL, ...meta };
  } catch (e) {
    // Timing a failure matters as much as timing a success: a call that ate
    // the whole commit window and returned nothing is the thing to see.
    if (opts.onSkip) opts.onSkip(String(e.message ?? e).slice(0, 90), Date.now() - t0);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
