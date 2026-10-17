// This deployment's own names, which never go in the repository (DECISIONS D9.3): the real bucket
// names, the log's origin, the route it is served on, and the bucket for the remote R2 contract
// tests. They live in worker/deploy.local.json, which is gitignored (so `git reset --hard`, as
// r2notary/update.sh does, keeps it too), and are applied to generated copies of the committed
// configs, which keep the placeholders that the simulator, the harnesses and the tests rely on.
//
// worker/deploy.local.json:
//   {
//     "vars": {
//       "MONITORED_BUCKET_NAME": "my-bucket",
//       "LOG_BUCKET_NAME": "my-bucket-log",
//       "LOG_ORIGIN": "r2notary.example.org/log/example-log"
//     },
//     "routes": [{ "pattern": "r2notary.example.org", "custom_domain": true }],
//     "contractBucket": "my-contract-test-bucket"
//   }
//
// `vars` may set any var worker/wrangler.jsonc declares; the bucket bindings follow
// MONITORED_BUCKET_NAME and LOG_BUCKET_NAME. `routes` is passed to wrangler as written.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');
export const LOCAL_CONFIG = join(ROOT, 'worker/deploy.local.json');

export interface LocalConfig {
  readonly vars: Readonly<Record<string, string>>;
  readonly routes?: readonly Readonly<Record<string, unknown>>[];
  readonly contractBucket?: string;
}

const KEYS = ['vars', 'routes', 'contractBucket'];
const BUCKET_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

/** worker/deploy.local.json, checked; null if there is none. */
export function readLocalConfig(): LocalConfig | null {
  if (!existsSync(LOCAL_CONFIG)) return null;
  const where = 'worker/deploy.local.json';
  let o: unknown;
  try {
    o = JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8'));
  } catch (e) {
    throw new Error(`${where}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) {
    throw new Error(`${where} must be a JSON object`);
  }
  const c = o as Record<string, unknown>;
  for (const k of Object.keys(c)) {
    if (!KEYS.includes(k)) throw new Error(`${where}: unknown key ${k}`);
  }
  const vars: unknown = c.vars ?? {};
  if (
    typeof vars !== 'object' ||
    vars === null ||
    Array.isArray(vars) ||
    !Object.values(vars).every((v) => typeof v === 'string')
  ) {
    throw new Error(`${where}: vars must be an object of strings`);
  }
  if (
    c.routes !== undefined &&
    (!Array.isArray(c.routes) ||
      !c.routes.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r)))
  ) {
    throw new Error(`${where}: routes must be an array of objects`);
  }
  if (c.contractBucket !== undefined) {
    if (typeof c.contractBucket !== 'string' || !BUCKET_RE.test(c.contractBucket)) {
      throw new Error(`${where}: contractBucket is not a valid R2 bucket name`);
    }
  }
  return c as unknown as LocalConfig;
}

/** Replaces the one match of `pattern` in a config's text, or fails naming `what`. */
export function replaceOnce(text: string, pattern: RegExp, value: string, what: string): string {
  const matches = text.match(new RegExp(pattern.source, 'g')) ?? [];
  if (matches.length !== 1) {
    throw new Error(`${what}: expected one match in the config, found ${String(matches.length)}`);
  }
  return text.replace(pattern, (_whole, before: string) => `${before}${JSON.stringify(value)}`);
}
