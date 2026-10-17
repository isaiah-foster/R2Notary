// Contract for the R2 list() behaviour the auditor's merge-join depends on (DECISIONS D6.2, D9.1),
// for a list order (worker/src/audit/order.ts):
//   - keys come back in that order: UTF-8 byte order for local R2, real R2's order for real R2.
//     Both differ from JavaScript's UTF-16 order for astral characters; they differ from each
//     other for a key that is a prefix of others;
//   - `listAfter` (`startAfter` underneath) returns exactly the keys after a given key in that
//     order, whether or not it exists, and paging with it visits every key once.
// `startAfter` is in the Workers types and in R2's S3 API (ListObjectsV2 start-after) but not in
// the Workers API reference, so it is pinned here. Runs against local R2 (r2-list-order.test.ts),
// an emulation of real R2 (same file), and, with approval, real R2 (test-remote/,
// docs/OPERATIONS.md). Real R2 orders a key `k` next to `k + ':' + r`, with r starting with a byte
// up to '9', by data the auditor cannot see; such pairs are left out here (r2-emulation.test.ts).

import { compareUtf8 } from '@r2notary/core';
import { expect, it } from 'vitest';
import { listAfter, type ListOrder } from '../../src/audit/order.ts';

/**
 * Keys whose UTF-8 and UTF-16 orders differ, plus ASCII and 2- and 3-byte neighbours, and keys that
 * are prefixes of others, continued below and above ':' (where real R2's order differs, D9.1).
 */
export const ORDER_KEYS: readonly string[] = [
  'A',
  'Z',
  'a',
  'a b',
  'a/b',
  'a0',
  'a:',
  'aA',
  '~',
  'é',
  'ü',
  'ࠀ',
  '퟿',
  '',
  'x',
  '�',
  '\u{10000}',
  '\u{1F600}',
  '\u{1F600}x',
  '\u{20000}',
];

export function sortedUtf8(keys: readonly string[]): string[] {
  return [...keys].sort(compareUtf8);
}

export function listOrderContract(bucket: () => R2Bucket, prefix: string, order: ListOrder): void {
  const full = ORDER_KEYS.map((k) => `${prefix}/${k}`);
  const want = [...full].sort(order.compare);

  // Every loop is bounded: a listing that fails to advance must fail the test, not hang it.
  const MAX_PAGES = 50;
  // About a hundred list() calls each; on real R2 every one is a remote round trip.
  const SLOW = { timeout: 120_000 };

  /** Pages with the opaque cursor only. */
  async function listByCursor(): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await bucket().list({
        prefix: `${prefix}/`,
        limit: 4,
        ...(cursor === undefined ? {} : { cursor }),
      });
      out.push(...page.objects.map((o) => o.key));
      if (!page.truncated) return out;
      cursor = page.cursor;
    }
    throw new Error('listing did not finish');
  }

  /**
   * Pages with listAfter, as the auditor does: each page starts after the previous page's last key.
   * Only keys under the prefix count; the bucket may hold others after them.
   */
  async function listFrom(after: string, limit: number): Promise<string[]> {
    const out: string[] = [];
    let from = after;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await listAfter(bucket(), order, from, limit);
      const keys = page.objects.map((o) => o.key);
      out.push(...keys.filter((k) => k.startsWith(`${prefix}/`)));
      const last = keys.at(-1);
      if (!page.truncated || (last !== undefined && !last.startsWith(`${prefix}/`))) return out;
      if (last === undefined) throw new Error('truncated page with no objects');
      from = last;
    }
    throw new Error('listing did not finish');
  }

  it('the key set really distinguishes UTF-8 from UTF-16 order', () => {
    expect([...full].sort()).not.toEqual(sortedUtf8(full));
  });

  it(`list() returns keys in ${order.name} order`, async () => {
    await Promise.all(full.map((k) => bucket().put(k, k)));
    expect(await listByCursor()).toEqual(want);
  });

  it('listAfter returns exactly the keys after it, present or not', SLOW, async () => {
    await Promise.all(full.map((k) => bucket().put(k, k)));
    const probes = [...full, `${prefix}/\uE000\u0000`, `${prefix}/\u{1F5FF}`, `${prefix}/`];
    for (const after of probes) {
      const expected = want.filter((k) => order.compare(k, after) > 0);
      // One page holds everything: this checks the starting point alone.
      expect(await listFrom(after, 1000), JSON.stringify(after)).toEqual(expected);
    }
  });

  it('paging by listAfter (as the auditor does) visits every key once', SLOW, async () => {
    await Promise.all(full.map((k) => bucket().put(k, k)));
    for (const limit of [1, 3, 4]) {
      expect(await listFrom(`${prefix}/`, limit), `limit ${String(limit)}`).toEqual(want);
    }
  });
}
