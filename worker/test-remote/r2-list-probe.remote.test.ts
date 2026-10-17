// Diagnostic, not a contract: records how real R2 orders keys and applies `startAfter`, after the
// list-order contract failed on real R2 (DECISIONS D6.2). Asserts nothing; prints JSON to stdout.
// Runs with the remote contract harness:
//   npm run test:contract:remote -- r2-list-probe --silent=false > probe.json
// (R2_CONTRACT_LOCAL=1 for local R2, which agrees with UTF-8 order.)
import { env } from 'cloudflare:workers';
import { compareUtf8 } from '@r2notary/core';
import { afterAll, it } from 'vitest';
import { ORDER_KEYS } from '../test/contract/r2-list-order.ts';

const bucket = (): R2Bucket => (env as unknown as { CONTRACT: R2Bucket }).CONTRACT;
const prefix = `r2notary-probe/${String(Date.now())}/`;

// The contract's keys, plus `c` and `c` followed by one character from across the ranges, to place
// the end of a key relative to the bytes that can follow it.
const NEXT = [' ', '!', '%', '/', '0', '9', ':', 'A', 'Z', '_', 'a', 'x', '~', '\u007f', 'é', ''];
const KEYS = [...ORDER_KEYS, 'c', ...NEXT.map((ch) => `c${ch}`)];

/** Code points as hex, so the output is unambiguous whatever the terminal renders. */
const show = (key: string): string =>
  Array.from(key.slice(prefix.length), (c) => (c.codePointAt(0) ?? 0).toString(16)).join(' ') ||
  '(empty)';

async function list(options: R2ListOptions): Promise<string[]> {
  const page = await bucket().list({ prefix, ...options });
  return page.objects.map((o) => o.key);
}

it('probe R2 list order and startAfter', async () => {
  const full = KEYS.map((k) => prefix + k);
  await Promise.all(full.map((k) => bucket().put(k, k)));
  const utf8 = [...full].sort(compareUtf8);

  const listed = await list({ limit: 1000 });
  const steps: string[] = [];
  let from = prefix;
  for (let i = 0; i < 2 * full.length; i++) {
    const [next] = await list({ startAfter: from, limit: 1 });
    if (next === undefined) break;
    steps.push(next);
    from = next;
  }
  const after: Record<string, string[]> = {};
  for (const k of utf8) after[show(k)] = (await list({ startAfter: k, limit: 1000 })).map(show);

  console.log(
    JSON.stringify(
      {
        utf8Order: utf8.map(show),
        listOrder: listed.map(show),
        startAfterChainLimit1: steps.map(show),
        startAfterEachKey: after,
      },
      null,
      1,
    ),
  );
});

afterAll(async () => {
  const listed = await bucket().list({ prefix });
  await bucket().delete(listed.objects.map((o) => o.key));
});
