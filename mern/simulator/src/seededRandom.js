/**
 * seededRandom.js — Mulberry32 seeded PRNG
 *
 * ALL randomness in the simulator (drops, delays, exploration, tampering) is
 * routed through an instance returned by createSeededRng() so that every
 * experiment run is fully deterministic and reproducible by seed alone.
 *
 * Usage:
 *   import { createSeededRng, randInt, randChoice } from './seededRandom.js';
 *   const rng = createSeededRng(42);
 *   rng();             // → float in [0, 1)
 *   randInt(rng, 1, 6) // → integer in [1, 6]
 *
 * Algorithm: Mulberry32 — a fast, single-seed 32-bit generator with excellent
 * statistical properties for simulation use.
 */

/**
 * Create a seeded pseudo-random number generator.
 * @param {number} seed  32-bit unsigned integer seed (default 1)
 * @returns {() => number}  Returns floats in [0, 1)
 */
export function createSeededRng(seed = 1) {
  // Ensure non-zero seed to avoid degenerate sequence
  let s = (seed >>> 0) || 1;

  return function rand() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Random integer in [min, max] inclusive using the provided rng.
 * @param {() => number} rng
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/**
 * Random element from an array using the provided rng.
 * @param {() => number} rng
 * @param {Array} arr
 */
export function randChoice(rng, arr) {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Shuffle an array in-place using Fisher-Yates with the provided rng.
 * @param {() => number} rng
 * @param {Array} arr
 * @returns {Array}  The same array, shuffled
 */
export function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
