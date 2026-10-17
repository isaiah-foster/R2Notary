// Diagnostic, not a contract: records how real R2 orders keys and applies `startAfter`, after the
// list-order contract failed on real R2 (DECISIONS D6.2, results in D9.1). Asserts nothing; prints
// JSON to stdout, which the workers pool swallows unless console interception is off:
//   npm run test:contract:remote -- r2-list-probe --silent=false --disableConsoleIntercept
// (R2_CONTRACT_LOCAL=1 for local R2, which agrees with UTF-8 order.)
import { env } from 'cloudflare:workers';
import { compareUtf8 } from '@r2notary/core';
import { afterAll, it } from 'vitest';
import { ORDER_KEYS } from '../test/contract/r2-list-order.ts';

const bucket = (): R2Bucket => (env as unknown as { CONTRACT: R2Bucket }).CONTRACT;
const prefix = `r2notary-probe/${String(Date.now())}/`;

// The contract's keys, plus `c` and `c` followed by one character from across the ranges, to place
// the end of a key relative to the bytes that can follow it; then keys continuing `c:` and `c9`,
// to tell "a key ends in `:`" from "a key ends in `:` and something more".
const NEXT = [' ', '!', '%', '/', '0', '9', ':', 'A', 'Z', '_', 'a', 'x', '~', '\u007f', 'é', ''];
const AFTER_COLON = ['c:0', 'c:9', 'c::', 'c:A', 'c;', 'c9z'];
const KEYS = [...ORDER_KEYS, 'c', ...NEXT.map((ch) => `c${ch}`), ...AFTER_COLON];
/** The start the auditor would pass to list the keys after `key` (D9.1). */
const pastEnd = (key: string): string => `${key}9\u{10FFFF}`;

/** Code points as hex, so the output is unambiguous whatever the terminal renders. */
const show = (key: string): string =>
  Array.from(key.slice(prefix.length), (c) => (c.codePointAt(0) ?? 0).toString(16)).join(' ') ||
  '(empty)';

async function list(options: R2ListOptions): Promise<string[]> {
  const page = await bucket().list({ prefix, ...options });
  return page.objects.map((o) => o.key);
}

/** A rejected call is a result too (R2 answered some startAfter values with a 400). */
const errorText = (e: unknown): string => `error: ${e instanceof Error ? e.message : String(e)}`;

// Every call is a remote round trip (about a hundred of them), far over vitest's 5 s default.
it('probe R2 list order and startAfter', { timeout: 300_000 }, async () => {
  const full = KEYS.map((k) => prefix + k);
  const putErrors: Record<string, string> = {};
  await Promise.all(
    full.map((k) =>
      bucket()
        .put(k, k)
        .catch((e: unknown) => {
          putErrors[show(k)] = errorText(e);
        }),
    ),
  );
  const utf8 = [...full].sort(compareUtf8);

  const listed = await list({ limit: 1000 });
  const steps: string[] = [];
  let from = prefix;
  for (let i = 0; i < 2 * full.length; i++) {
    let next: string | undefined;
    try {
      [next] = await list({ startAfter: from, limit: 1 });
    } catch (e) {
      steps.push(`${errorText(e)} (startAfter ${show(from)})`);
      break;
    }
    if (next === undefined) break;
    steps.push(show(next));
    from = next;
  }
  const after: Record<string, string[] | string> = {};
  const afterPastEnd: Record<string, string[] | string> = {};
  for (const k of utf8) {
    for (const [out, start] of [
      [after, k],
      [afterPastEnd, pastEnd(k)],
    ] as const) {
      try {
        out[show(k)] = (await list({ startAfter: start, limit: 1000 })).map(show);
      } catch (e) {
        out[show(k)] = errorText(e);
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        putErrors,
        utf8Order: utf8.map(show),
        listOrder: listed.map(show),
        startAfterChainLimit1: steps,
        startAfterEachKey: after,
        startAfterPastEnd: afterPastEnd,
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
