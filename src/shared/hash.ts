/**
 * 64-bit FNV-1a over UTF-16 code units, rendered as 16 hex characters. It keys the judgment cache
 * by page text and the sentence memo by sentence text, so it only has to be fast and stable across
 * runs; it is not a security primitive. Two 32-bit halves keep the loop on plain numbers: a page of
 * 100k characters hashes in a few milliseconds, where BigInt would take several times longer.
 *
 * For ASCII input this is byte-for-byte canonical FNV-1a 64; code units above 0xFF are folded in
 * whole, which keeps the hash deterministic without a UTF-8 pass.
 */
export function hashText(s: string): string {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (let i = 0; i < s.length; i++) {
    lo ^= s.charCodeAt(i);
    // h × 0x100000001b3 mod 2^64 = h × 0x1b3 + (h << 40); the shifted term only reaches the high
    // half, as lo << 8, and every intermediate stays below 2^53 so doubles hold it exactly.
    const lp = lo * 0x1b3;
    hi = (hi * 0x1b3 + Math.floor(lp / 0x1_0000_0000) + ((lo << 8) >>> 0)) >>> 0;
    lo = lp >>> 0;
  }
  return hex8(hi) + hex8(lo);
}

function hex8(n: number): string {
  return n.toString(16).padStart(8, "0");
}
