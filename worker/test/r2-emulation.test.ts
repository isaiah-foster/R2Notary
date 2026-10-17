// Real R2's list order and `startAfter`, from listings recorded on real R2 (DECISIONS D9.1): what
// the auditor's `r2` order gets right and the one case it cannot, and that the emulation the other
// tests use (r2-emulation.ts) reproduces every recorded listing.
import { env } from 'cloudflare:workers';
import { reset } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { R2_ORDER, listAfter } from '../src/audit/order.ts';
import { checkOrder } from '../src/audit/reconcile.ts';
import recorded from './fixtures/r2-list-2026-10-17.json';
import { realR2Listing } from './r2-emulation.ts';

afterEach(() => reset());

const decode = (hex: string): string =>
  String.fromCodePoint(...hex.split(' ').map((h) => parseInt(h, 16)));
/** The keys in the order real R2 listed them. */
const KEYS = recorded.keys.map(decode);
const at = (indices: number[]): string[] => indices.map((i) => KEYS[i] ?? '?');
const results = (m: Record<string, number[] | string>): [string, number[]][] =>
  Object.entries(m).flatMap(([k, v]) => (typeof v === 'string' ? [] : [[decode(k), v]]));
const after = (x: string): string[] => KEYS.filter((k) => R2_ORDER.compare(k, x) > 0);

describe('R2_ORDER against listings recorded on real R2', () => {
  it('sorts the keys as R2 listed them, except `c` and `c:0`, which R2 orders by hidden data', () => {
    const sorted = [...KEYS].sort(R2_ORDER.compare);
    expect(sorted.filter((k) => k !== 'c')).toEqual(KEYS.filter((k) => k !== 'c'));
    expect(sorted.slice(sorted.indexOf('c'), sorted.indexOf('c') + 2)).toEqual(['c', 'c:0']);
    expect(KEYS.slice(KEYS.indexOf('c:0'), KEYS.indexOf('c:0') + 2)).toEqual(['c:0', 'c']);
  });

  it('its startAfter never misses a key after the start, and adds only the start itself', () => {
    const cases = results(recorded.startAfterPastEnd);
    expect(cases).toHaveLength(KEYS.length - 1); // one probe failed through the remote proxy
    for (const [x, got] of cases) {
      const keys = at(got).filter((k) => k !== x);
      expect(keys, x).toEqual(expect.arrayContaining(after(x)));
      if (x === 'c:0') {
        // R2 lists `c` after `c:0`; the auditor refuses the page rather than skip `c`.
        expect(keys.filter((k) => !after(x).includes(k))).toEqual(['c']);
        expect(() => {
          checkOrder(keys, x, 'listing', R2_ORDER);
        }).toThrow(/r2 list order/);
      } else {
        expect(keys, x).toEqual(after(x));
      }
    }
  });

  it('a key as startAfter repeats the keys continuing it up to "9" (why the auditor avoids it)', () => {
    const [, got] = results(recorded.startAfter).find(([x]) => x === 'a') ?? ['', []];
    expect(at(got).slice(0, 4)).toEqual(['a b', 'a/b', 'a0', 'c ']);
    expect(after('a')[0]).toBe('c ');
  });
});

describe('the emulation of real R2 (r2-emulation.ts)', () => {
  it('reproduces every recorded listing', async () => {
    const prefix = 'emulated/';
    await Promise.all(KEYS.map((k) => env.MONITORED.put(prefix + k, k)));
    const bucket = realR2Listing(env.MONITORED);
    const list = async (o: R2ListOptions): Promise<string[]> =>
      (await bucket.list({ prefix, ...o })).objects.map((o) => o.key.slice(prefix.length));
    expect(await list({})).toEqual(KEYS);
    for (const [field, start] of [
      ['startAfter', (k: string) => k],
      ['startAfterPastEnd', (k: string) => `${k}9\u{10FFFF}`],
    ] as const) {
      for (const [x, got] of results(recorded[field])) {
        expect(await list({ startAfter: prefix + start(x) }), `${field} ${x}`).toEqual(at(got));
      }
    }
  });

  it('pages by cursor in R2 order', async () => {
    await Promise.all(KEYS.map((k) => env.MONITORED.put(k, k)));
    const bucket = realR2Listing(env.MONITORED);
    const byCursor: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page = await bucket.list({ limit: 7, ...(cursor === undefined ? {} : { cursor }) });
      byCursor.push(...page.objects.map((o) => o.key));
      if (!page.truncated) break;
      cursor = page.cursor;
    }
    expect(byCursor).toEqual(KEYS);
  });
});

describe('paging with listAfter and R2_ORDER, as the auditor does', () => {
  /** Every key, page by page, each page checked as the merge-join checks it. */
  async function walk(bucket: R2Bucket, limit: number): Promise<string[]> {
    const keys: string[] = [];
    let from: string | null = null;
    for (let i = 0; i < 100; i++) {
      const page = await listAfter(bucket, R2_ORDER, from, limit);
      const listed = page.objects.map((o) => o.key);
      checkOrder(listed, from, 'listing', R2_ORDER);
      expect(listed.length).toBeLessThanOrEqual(limit);
      keys.push(...listed);
      if (!page.truncated) return keys;
      from = listed.at(-1) ?? null;
    }
    throw new Error('listing did not finish');
  }

  it('visits every key once, whatever the page size', async () => {
    const keys = KEYS.filter((k) => k !== 'c:0');
    await Promise.all(keys.map((k) => env.MONITORED.put(k, k)));
    for (const limit of [1, 2, 3, 1000]) {
      expect(await walk(realR2Listing(env.MONITORED), limit), `limit ${String(limit)}`).toEqual(
        keys,
      );
    }
  });

  it('refuses a bucket holding `c` and `c:0`, at whichever page they meet', async () => {
    await Promise.all(KEYS.map((k) => env.MONITORED.put(k, k)));
    for (const limit of [1, 2, 3, 1000]) {
      await expect(
        walk(realR2Listing(env.MONITORED), limit),
        `limit ${String(limit)}`,
      ).rejects.toThrow(/r2 list order/);
    }
  });
});
