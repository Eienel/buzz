// Who sits where when a game is dealt.
//
// Its own module because it is the fix for a measured bias and deserves a test,
// and swarm.mjs cannot be imported by one: it has top level await and starts
// playing the moment it loads.
//
// The old rule was `i < MIN_COMBS ? i : i % combs`, which put every extra agent
// in the lowest combs: with nine agents and six combs, 0, 1 and 2 opened with
// two members and 3, 4 and 5 with one, every single game. The program kills the
// comb with the FEWEST members, so half the board was doomed by the deal.
// Measured over 200 recorded games: comb 0 won 60%, comb 1 28%, comb 5 never.

/**
 * Deal `n` agents over `combs` combs: every comb gets one before any gets two,
 * and which combs get the extras is shuffled per game.
 *
 * Returns an array of comb ids, one per agent, in roster order.
 */
export function dealSeats(n, combs = 6, rand = Math.random) {
  const deck = Array.from({ length: combs }, (_, k) => k);
  for (let k = deck.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [deck[k], deck[j]] = [deck[j], deck[k]];
  }
  return Array.from({ length: n }, (_, i) => deck[i % combs]);
}
