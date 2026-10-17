// The R2 contracts against a real bucket: conditional writes (DECISIONS D2.1) and list order /
// startAfter (D6.2), in real R2's order (D9.1). Opt-in only:
//   npm run test:contract:remote            (real R2; needs `wrangler login`; see docs/OPERATIONS.md)
//   R2_CONTRACT_LOCAL=1 npm run test:contract:remote   (same harness against local R2, no network)
import { env } from 'cloudflare:workers';
import { afterAll, describe } from 'vitest';
import { conditionalWriteContract } from '../test/contract/r2-conditional.ts';
import { listOrder, type ListOrderName } from '../src/audit/order.ts';
import { listOrderContract } from '../test/contract/r2-list-order.ts';

const bindings = env as unknown as { CONTRACT: R2Bucket; CONTRACT_LIST_ORDER: ListOrderName };
const bucket = (): R2Bucket => bindings.CONTRACT;
const prefix = `r2notary-contract/${String(Date.now())}`;

describe('R2 conditional-write contract (remote R2)', () => {
  conditionalWriteContract(bucket, prefix);
});

// r2 for real R2, utf8 when the harness runs against local R2 (vitest.remote.config.ts).
describe(`R2 list order contract (${bindings.CONTRACT_LIST_ORDER} order)`, () => {
  listOrderContract(bucket, `${prefix}/order`, listOrder(bindings.CONTRACT_LIST_ORDER));
});

// Everything both contracts wrote (well under list()'s 1,000-key page).
afterAll(async () => {
  const listed = await bucket().list({ prefix: `${prefix}/` });
  await bucket().delete(listed.objects.map((o) => o.key));
});
