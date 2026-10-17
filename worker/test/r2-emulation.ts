// Real R2's list() as measured on 2026-10-17 (DECISIONS D9.1), over a local bucket, so the auditor's
// `r2` list order can be tested without an account. Local R2 lists in UTF-8 order; real R2 lists by
// `key + ':' + hidden` and applies `startAfter` to that, never returning the startAfter key itself.
// R2's hidden part is unknown but starts with a digit; `5` places `c` between `c:0` and `c:9`, as
// observed. test/r2-emulation.test.ts checks this against the recorded listings.
//
// Only what the auditor and the contract use is emulated: prefix, startAfter, cursor, limit.

import { compareUtf8 } from '@r2notary/core';

const sortKey = (key: string): string => `${key}:5`;

export function realR2Listing(bucket: R2Bucket): R2Bucket {
  const list = async (o: R2ListOptions = {}): Promise<R2Objects> => {
    if (o.delimiter !== undefined || o.include !== undefined) throw new Error('not emulated');
    const all: R2Object[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await bucket.list({
        limit: 1000,
        ...(o.prefix === undefined ? {} : { prefix: o.prefix }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      all.push(...page.objects);
      if (!page.truncated) break;
      cursor = page.cursor;
    }
    all.sort((a, b) => compareUtf8(sortKey(a.key), sortKey(b.key)));
    // The cursor is the sort key of the last object returned: opaque to callers, as R2's is.
    const from = o.cursor ?? o.startAfter;
    const after =
      from === undefined
        ? all
        : all.filter((x) => x.key !== from && compareUtf8(sortKey(x.key), from) > 0);
    const limit = o.limit ?? 1000;
    const objects = after.slice(0, limit);
    const last = objects.at(-1);
    return after.length > limit && last !== undefined
      ? { objects, truncated: true, cursor: sortKey(last.key), delimitedPrefixes: [] }
      : { objects, truncated: false, delimitedPrefixes: [] };
  };
  return new Proxy(bucket, {
    get(target, p) {
      if (p === 'list') return list;
      const v: unknown = Reflect.get(target, p);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
