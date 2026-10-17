// The order in which the monitored bucket lists keys, and how to list the keys after a given one
// (DECISIONS D9.1). The auditor's merge-join needs the listing and the Sequencer's objects view in
// one order, so both sides take it from here.
//
// - `utf8`: UTF-8 byte order, with `startAfter` meaning "keys greater than this one". Local R2
//   (Miniflare) behaves this way, and so did the plan's reading of the R2 docs (D6.2).
// - `r2`: what real R2 does, as measured on 2026-10-17 (D9.1). It lists keys in UTF-8 byte order of
//   `key + ':'` followed by something hidden that starts with a digit, so a key that is a prefix of
//   others comes after those that continue it with a byte up to '9' (`a b`, `a/b`, `a0`, then `a`).
//   Its `startAfter: s` returns the keys whose `key + ':' + hidden` is greater than s, except a key
//   equal to s, so passing a key repeats the keys that continue it.
//
// The hidden suffix cannot be compared, so `r2` compares `key + ':'`. That agrees with R2 except for
// a key `k` next to `k + ':' + r` where r starts with a byte up to '9' (`c` and `c:0` were listed
// either side of it). There the listing is out of this order and the merge-join refuses it: an
// audit of such a bucket stops instead of reporting false findings.

import { compareUtf8 } from '@r2notary/core';

export const LIST_ORDERS = ['r2', 'utf8'] as const;
export type ListOrderName = (typeof LIST_ORDERS)[number];

/** R2's limit on keys per list() call. */
const MAX_LIST_LIMIT = 1000;

export interface ListOrder {
  readonly name: ListOrderName;
  readonly compare: (a: string, b: string) => number;
  /**
   * list() options for up to `limit` keys after `after` (null: from the first key). The listing
   * may also hold `after` itself, which `listAfter` drops; with `r2` it then asks for one more.
   */
  readonly listOptions: (after: string | null, limit: number) => R2ListOptions;
}

export const UTF8_ORDER: ListOrder = {
  name: 'utf8',
  compare: compareUtf8,
  listOptions: (after, limit) => ({ limit, ...(after === null ? {} : { startAfter: after }) }),
};

/**
 * `after + '9' + U+10FFFF` sorts after every key that continues `after` with a byte up to '9' (they
 * come before `after` in R2's order) and before `after + ':' + hidden`, so R2 returns exactly the
 * keys after `after`, and `after` itself. Checked on real R2 for 41 keys (D9.1).
 */
export const R2_ORDER: ListOrder = {
  name: 'r2',
  compare: (a, b) => compareUtf8(`${a}:`, `${b}:`),
  listOptions: (after, limit) =>
    after === null
      ? { limit }
      : { limit: Math.min(limit + 1, MAX_LIST_LIMIT), startAfter: `${after}9\u{10FFFF}` },
};

export function listOrder(name: ListOrderName): ListOrder {
  return name === 'r2' ? R2_ORDER : UTF8_ORDER;
}

/**
 * One page of the listing after `after`, without `after` itself. The keys are not checked here:
 * the merge-join (and backfill) refuse any key that is not after `after` in `order`, or out of it.
 */
export async function listAfter(
  bucket: { list(options: R2ListOptions): Promise<R2Objects> },
  order: ListOrder,
  after: string | null,
  limit: number,
): Promise<{ readonly objects: R2Object[]; readonly truncated: boolean }> {
  const page = await bucket.list(order.listOptions(after, limit));
  const objects = after === null ? page.objects : page.objects.filter((o) => o.key !== after);
  // The extra key asked for when `after` was not listed (it need not exist: a page can end on a
  // key only the log has).
  if (objects.length > limit) return { objects: objects.slice(0, limit), truncated: true };
  return { objects, truncated: page.truncated };
}
