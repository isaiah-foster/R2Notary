// PLAN M6: "Unicode-key ordering test". The merge-join needs R2 list() and the Sequencer's SQLite
// reads to agree on one order: UTF-8 byte order (compareUtf8) for local R2, and real R2's order
// (R2_ORDER, D9.1), checked here against an emulation of real R2 (r2-emulation.ts).
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { R2_ORDER, UTF8_ORDER } from '../src/audit/order.ts';
import { SequencerStore } from '../src/store.ts';
import { ORDER_KEYS, listOrderContract } from './contract/r2-list-order.ts';
import { realR2Listing } from './r2-emulation.ts';

afterEach(() => reset());

describe('R2 list order contract (local R2)', () => {
  listOrderContract(() => env.MONITORED, 'order', UTF8_ORDER);
});

describe('R2 list order contract (real R2, emulated)', () => {
  listOrderContract(() => realR2Listing(env.MONITORED), 'order', R2_ORDER);
});

describe.each([UTF8_ORDER, R2_ORDER])('SQLite key order in the Sequencer ($name)', (order) => {
  it('objectStates orders and bounds keys like the listing', async () => {
    await runInDurableObject(env.SEQUENCER.getByName(`order-${order.name}`), (_, state) => {
      const store = new SequencerStore(state.storage);
      store.migrate();
      for (const [i, key] of ORDER_KEYS.entries()) {
        state.storage.sql.exec(
          `INSERT INTO objects(key, etag, size, event_time, event_ms, seq, deleted)
           VALUES (?, 'e', 1, '2026-01-01T00:00:00Z', 0, ?, 0)`,
          key,
          i,
        );
      }
      const want = [...ORDER_KEYS].sort(order.compare);
      const keys = (range: Parameters<SequencerStore['objectStates']>[0]): string[] =>
        store.objectStates({ ...range, order: order.name }).map((o) => o.key);
      expect(keys({ limit: 100 })).toEqual(want);
      for (const bound of [...ORDER_KEYS, '\u0000', '\u{1F5FF}', 'a9', 'a;']) {
        const what = JSON.stringify(bound);
        expect(keys({ after: bound, limit: 100, liveOnly: true }), what).toEqual(
          want.filter((k) => order.compare(k, bound) > 0),
        );
        expect(keys({ through: bound, limit: 100 }), what).toEqual(
          want.filter((k) => order.compare(k, bound) <= 0),
        );
      }
    });
  });
});

it("the auditor's live-key range scan in R2 order uses its index, without sorting", async () => {
  await runInDurableObject(env.SEQUENCER.getByName('plan'), (_, state) => {
    new SequencerStore(state.storage).migrate();
    const plan = state.storage.sql
      .exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT key FROM objects WHERE key || ':' > ? || ':' AND deleted = 0
         ORDER BY key || ':' LIMIT 10`,
        'a',
      )
      .toArray()
      .map((r) => r.detail)
      .join('; ');
    expect(plan).toContain('objects_live_r2');
    expect(plan).not.toContain('TEMP B-TREE');
  });
});
