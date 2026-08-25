// A strategy that thinks, instead of following a rule.
//
// The house agents have always been three if-statements: herd, contrarian and
// random. They are a fine control group and a poor demonstration, because the
// interesting question about an arena for AI agents is whether reasoning beats
// a rule when the board is hidden. This asks a model that question every
// instance and lets the leaderboard settle it.
//
// Routed through UsePod, which is OpenAI-compatible with the token in the URL
// path rather than a header:
//
//   OPENAI_BASE_URL=https://api.usepod.ai/proxy/<token>/v1
//
// Set USEPOD_TOKEN to switch it on. With no token the arena runs exactly as
// before, and every failure inside falls back to a heuristic, because a model
// that is slow, broke or wrong must never be able to stall a live game.

const BASE = (t) => `https://api.usepod.ai/proxy/${t}/v1/chat/completions`;
const TOKEN = process.env.USEPOD_TOKEN ?? "";
const MODEL = process.env.USEPOD_MODEL ?? "llama-4-maverick";
// Four pods asking one model the same question at the same temperature are one
// agent with four wallets. Each pod gets its own model and its own disposition
// so the reasoning cohort is four independent opinions, which is the only way
// the comparison against five heuristics means anything.
// Four labs, one per pod. Chosen by measurement, not by reputation: models that
// stream hidden reasoning tokens (glm-4.7-flash, gemini-3.5-flash, deepseek-v4-flash)
// spend the whole budget thinking and return empty content with finish_reason
// "length", so they never answer inside a commit window and are unusable here.
const DEFAULT_MODELS = [
  "meta-llama/llama-4-maverick",
  "openai/gpt-5.4-mini",
  "mistralai/mistral-medium-3.1",
  "anthropic/claude-haiku-4.5",
];
const MODELS = (process.env.USEPOD_MODELS ?? DEFAULT_MODELS.join(","))
  .split(",").map((m) => m.trim()).filter(Boolean);
const PERSONAS = [
  "You weight recent trend over the current snapshot; a comb that has been bleeding keeps bleeding.",
  "You assume the other agents are more predictable than they look and lean hard on the known field.",
  "You are cautious: when two combs are close, you take the one that keeps you alive over the one that scores.",
  "You hunt the point: you will sit somewhere risky if it puts you on the right side of a prediction.",
];
export const modelFor = (i) => MODELS[i % MODELS.length];
export const personaFor = (i) => PERSONAS[i % PERSONAS.length];
const TIMEOUT_CAP = Number(process.env.USEPOD_TIMEOUT_MS ?? 20000);

// A fixed timeout does not survive short games. Commit is 60% of an instance,
// so a 24s round leaves a 14s window that also has to carry two on-chain
// commits per agent. Thinking gets a slice of that window, never the whole
// thing, so a model that runs long is cut off with time left to abstain
// cleanly rather than stalling the round for everyone else.
function budgetFor(instanceSeconds) {
  if (!instanceSeconds) return TIMEOUT_CAP;
  const commitWindow = instanceSeconds * 0.6 * 1000;
  return Math.max(2500, Math.min(TIMEOUT_CAP, commitWindow * 0.45));
}

export const reasoningEnabled = () => TOKEN.length > 0;

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
  return { move: move === self ? null : move, predict: raw.predict, why, thinkNext };
}

/**
 * One decision, or null when the model did not answer usably in time.
 *
 * A reasoning agent that silently degraded to the herd rule scored points the
 * model never earned, which is exactly the comparison this exists to make. So
 * every failure path returns null instead. The caller keeps the agent in the
 * game and holding its comb; it forfeits only the prediction for that round.
 */
export async function decide(fog, self, opts = {}) {
  if (!TOKEN) return null;
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
    if (!opts.budget.spend()) {
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
  const timer = setTimeout(() => ctl.abort(), budgetFor(opts.instanceSeconds));
  try {
    const r = await fetch(BASE(TOKEN), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctl.signal,
      body: JSON.stringify({
        model: opts.model ?? MODEL,
        messages: [
          { role: "system", content: opts.persona ? `${SYSTEM}\n\nYOUR DISPOSITION: ${opts.persona}` : SYSTEM },
          { role: "user", content: user },
        ],
        max_tokens: 260,   // a forecast needs room to be worked out, not just asserted
        // Identical agents on an identical board would herd, so each pod is
        // spread across the range rather than all sitting at one value.
        temperature: opts.temperature ?? 0.7,
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content ?? "";
    // tolerate a model that wraps its JSON in prose or a code fence
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no json in reply");
    const plan = sanitise(JSON.parse(m[0]), fog, self);
    return plan && { ...plan, by: "model" };
  } catch (e) {
    if (opts.onSkip) opts.onSkip(String(e.message ?? e).slice(0, 90));
    return null;
  } finally {
    clearTimeout(timer);
  }
}
