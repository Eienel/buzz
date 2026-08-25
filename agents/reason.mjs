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
const MODEL = process.env.USEPOD_MODEL ?? "deepseek-v3.2";
const TIMEOUT_MS = Number(process.env.USEPOD_TIMEOUT_MS ?? 6000);

export const reasoningEnabled = () => TOKEN.length > 0;

const SYSTEM =
  "You play Last Comb Standing, a survival game. Each round the comb with the " +
  "fewest members dies, though a rare fate-strike can take another instead. " +
  "You see only how many members each comb held LAST round, never this round. " +
  "Everyone else sees the same and moves at the same time, so crowds shift. " +
  "Answer with JSON only: {\"move\": <comb id or null>, \"predict\": <comb id>}. " +
  "move is the comb to move to, or null to stay. predict is the comb you think " +
  "dies this round; a correct call scores a point whether or not you survive.";

/** Last-resort rule, and the thing every failure path falls back to. */
function herd(fog, self) {
  const alive = Object.entries(fog).map(([id, m]) => ({ id: +id, m }));
  alive.sort((a, b) => b.m - a.m);
  const thin = alive[alive.length - 1].id;
  return { move: alive[0].id === self ? null : alive[0].id, predict: thin };
}

/** Only ids that are actually alive may be used; a model may hallucinate one. */
function sanitise(raw, fog, self) {
  const ids = Object.keys(fog).map(Number);
  const ok = (v) => Number.isInteger(v) && ids.includes(v);
  const move = ok(raw?.move) ? raw.move : null;
  const predict = ok(raw?.predict) ? raw.predict : herd(fog, self).predict;
  return { move: move === self ? null : move, predict };
}

/**
 * One decision. Returns { move, predict, by } where `by` is "model" or
 * "fallback", so callers can log how often the model actually answered.
 */
export async function decide(fog, self, opts = {}) {
  if (!TOKEN) return { ...herd(fog, self), by: "fallback" };

  const board = Object.entries(fog)
    .map(([id, m]) => `comb ${id}: ${m} member${m === 1 ? "" : "s"} last round`)
    .join("\n");
  const user =
    `You are in comb ${self}.\nAlive combs and last round's counts:\n${board}\n` +
    `Round ${opts.instance ?? "?"} of the game. Reply with JSON only.`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(BASE(TOKEN), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctl.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
        max_tokens: 60,
        temperature: 0.7,          // identical agents on an identical board would herd
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    const text = j?.choices?.[0]?.message?.content ?? "";
    // tolerate a model that wraps its JSON in prose or a code fence
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no json in reply");
    return { ...sanitise(JSON.parse(m[0]), fog, self), by: "model" };
  } catch (e) {
    return { ...herd(fog, self), by: "fallback", error: String(e.message ?? e).slice(0, 90) };
  } finally {
    clearTimeout(timer);
  }
}
