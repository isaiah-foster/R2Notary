import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineProject } from 'vitest/config';

// Opt-in project for the R2 contract test on real R2. Not part of `npm test` (the root config
// lists only the default worker project). R2_CONTRACT_LOCAL=1 disables remote bindings so the
// harness itself can be checked without touching Cloudflare; the list order it expects follows
// (local R2 lists in UTF-8 order, real R2 in its own; DECISIONS D9.1).
const local = process.env.R2_CONTRACT_LOCAL === '1';

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test-remote/wrangler.remote.jsonc' },
      remoteBindings: !local,
      miniflare: { bindings: { CONTRACT_LIST_ORDER: local ? 'utf8' : 'r2' } },
    }),
  ],
  test: {
    name: 'worker-remote-contract',
    root: import.meta.dirname,
    include: ['test-remote/**/*.remote.test.ts'],
  },
});
