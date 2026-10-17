// The committed wrangler configs: placeholders only, and the dev simulator sharing the Worker's
// bucket and log (DECISIONS D9.3). Real names go in worker/deploy.local.json (gitignored); a real
// bucket name committed in worker/wrangler.jsonc once left the simulator writing to a bucket the
// Worker did not monitor, so `npm run dev:sim` and the harnesses logged nothing.
import { describe, expect, it } from 'vitest';
import simulator from '../dev/wrangler.simulator.jsonc?raw';
import contract from '../test-remote/wrangler.remote.jsonc?raw';
import worker from '../wrangler.jsonc?raw';

/** Every `"key": "value"` in a config's text, comments aside. */
function values(text: string, key: string): string[] {
  const code = text.replace(/^\s*\/\/.*$/gm, '');
  return Array.from(code.matchAll(new RegExp(`"${key}":\\s*"([^"]*)"`, 'g')), (m) => m[1] ?? '');
}

describe('committed wrangler configs', () => {
  it('name only placeholder buckets', () => {
    for (const [name, text] of [
      ['worker/wrangler.jsonc', worker],
      ['worker/dev/wrangler.simulator.jsonc', simulator],
      ['worker/test-remote/wrangler.remote.jsonc', contract],
    ] as const) {
      const buckets = [
        ...values(text, 'bucket_name'),
        ...values(text, 'MONITORED_BUCKET_NAME'),
        ...values(text, 'LOG_BUCKET_NAME'),
      ];
      expect(buckets.length, name).toBeGreaterThan(0);
      for (const b of buckets) expect(b, name).toMatch(/^example-/);
    }
    expect(values(worker, 'LOG_ORIGIN')).toEqual(['r2notary.example.com/log/example-log']);
  });

  it('give the dev simulator the bucket and log the Worker uses', () => {
    const monitoredBinding = (text: string): string[] =>
      Array.from(
        text.matchAll(/"binding":\s*"MONITORED",\s*"bucket_name":\s*"([^"]*)"/g),
        (m) => m[1] ?? '',
      );
    expect(monitoredBinding(simulator)).toEqual(monitoredBinding(worker));
    expect(values(simulator, 'MONITORED_BUCKET_NAME')).toEqual(
      values(worker, 'MONITORED_BUCKET_NAME'),
    );
    expect(values(simulator, 'LOG_NAME')).toEqual(values(worker, 'LOG_NAME'));
  });
});
