// The auditor's merge-join (PLAN §5.6): one page of the monitored bucket's listing against the
// log's expected state (the Sequencer's `objects` view). Pure and synchronous; the Sequencer runs
// it inside the transaction that records its result.
//
// Both inputs are sorted in the scan's list order (order.ts): UTF-8 byte order for local R2, and
// the order real R2 lists keys in, which differs from it for keys that are prefixes of others
// (DECISIONS D6.2, D9.1). The Sequencer reads its rows in the same order. JavaScript's `<` is
// neither, so every comparison here goes through `order.compare`, and out-of-order input is
// rejected rather than merged wrongly.
//
// A page covers the keys in (after, end]. Each side is read with a limit, so `end` is the smaller
// of the two last keys of whichever sides were truncated: past that point one side has not been
// read yet, and merging there would report false MISSING or UNLOGGED objects. `end` null means
// both sides are exhausted and the scan's listing is complete.

import type { ExpectedState, FindingKind, ObservedState } from '@r2notary/core';
import { eventMillis, type ObjectState } from '../store.ts';
import type { ListOrder } from './order.ts';

/** One object from the bucket listing. `uploaded` is epoch milliseconds (R2Object.uploaded). */
export interface ListedObject {
  readonly key: string;
  readonly etag: string;
  readonly size: number;
  readonly uploaded: number;
}

export type ReconcileKind = Exclude<FindingKind, 'CONTENT_DRIFT'>;

/**
 * A divergence seen on this page. It becomes a finding only if the log's state for the key is
 * still `basisSeq` after the grace window (confirmation, DECISIONS D6.3).
 */
export interface Candidate {
  readonly kind: ReconcileKind;
  readonly key: string;
  /** seq of the objects row the decision was based on; null if the log had no row for the key. */
  readonly basisSeq: number | null;
  readonly observed?: ObservedState;
  readonly expected?: ExpectedState;
}

export interface PageInput {
  /** Exclusive lower bound of the page (the previous page's end); null for the first page. */
  readonly after: string | null;
  /** Listed objects with key > after, in `order`. */
  readonly listed: readonly ListedObject[];
  readonly listTruncated: boolean;
  /** Live (not deleted) rows of the objects view with key > after, in `order`. */
  readonly live: readonly ObjectState[];
  readonly liveTruncated: boolean;
  /** The objects-view row, live or deleted, for listed keys that have one. */
  readonly rows: ReadonlyMap<string, ObjectState>;
  readonly now: number;
  readonly graceMs: number;
  readonly order: ListOrder;
}

export interface PageResult {
  /** Last key covered (inclusive); null when the listing is complete. */
  readonly end: string | null;
  /** Listed objects in (after, end]. */
  readonly scanned: number;
  readonly candidates: Candidate[];
}

export class ReconcileError extends Error {
  override name = 'ReconcileError';
}

/** Throws unless the keys are strictly increasing in `order` and all after `after`. */
export function checkOrder(
  keys: readonly string[],
  after: string | null,
  what: string,
  order: ListOrder,
): void {
  let prev = after;
  for (const k of keys) {
    if (prev !== null && order.compare(k, prev) <= 0) {
      // A wrong LIST_ORDER, or keys real R2 lists out of any order the auditor can compare (D9.1).
      throw new ReconcileError(
        `${what} is not strictly increasing in ${order.name} list order after the cursor` +
          ' (LIST_ORDER; DECISIONS D9.1)',
      );
    }
    prev = k;
  }
}

/** The page's last key: the earlier of the truncated sides' last keys, or null if neither is. */
export function pageEnd(
  listed: readonly { key: string }[],
  listTruncated: boolean,
  live: readonly { key: string }[],
  liveTruncated: boolean,
  order: ListOrder,
): string | null {
  const ends: string[] = [];
  for (const [side, truncated, what] of [
    [listed, listTruncated, 'listing'],
    [live, liveTruncated, 'live rows'],
  ] as const) {
    if (!truncated) continue;
    const last = side.at(-1);
    // A truncated side that returned nothing gives no point to advance to.
    if (last === undefined) throw new ReconcileError(`${what} truncated with no entries`);
    ends.push(last.key);
  }
  if (ends.length === 0) return null;
  return ends.reduce((a, b) => (order.compare(a, b) <= 0 ? a : b));
}

const iso = (ms: number): string => new Date(ms).toISOString();

function observed(o: ListedObject): ObservedState {
  return { etag: o.etag, size: o.size, uploaded: iso(o.uploaded) };
}

function expected(r: ObjectState): ExpectedState {
  return {
    ...(r.etag === null ? {} : { etag: r.etag }),
    ...(r.size === null ? {} : { size: r.size }),
    eventTime: r.eventTime,
    seq: r.seq,
  };
}

/**
 * Classifies one listed object against its expected state. Each condition waits until everything
 * that could explain the difference is older than the grace window: the upload, and the logged
 * event. Unlike PLAN §5.6's table, a mismatch or a phantom delete is reported whichever of the two
 * is newer (D6.4): an object older than the logged event that contradicts it is divergence too.
 */
function classify(
  o: ListedObject,
  r: ObjectState | undefined,
  quiet: (ms: number) => boolean,
): Candidate | null {
  if (r === undefined) {
    return quiet(o.uploaded)
      ? { kind: 'UNLOGGED_OBJECT', key: o.key, basisSeq: null, observed: observed(o) }
      : null;
  }
  if (!quiet(Math.max(o.uploaded, eventMillis(r.eventTime)))) return null;
  let kind: ReconcileKind | null = null;
  if (r.deleted) kind = 'PHANTOM_DELETE';
  else if (r.etag !== null && r.etag !== o.etag) kind = 'ETAG_MISMATCH';
  else if (r.size !== null && r.size !== o.size) kind = 'SIZE_MISMATCH';
  if (kind === null) return null;
  return { kind, key: o.key, basisSeq: r.seq, observed: observed(o), expected: expected(r) };
}

export function reconcilePage(p: PageInput): PageResult {
  checkOrder(
    p.listed.map((o) => o.key),
    p.after,
    'listing',
    p.order,
  );
  checkOrder(
    p.live.map((r) => r.key),
    p.after,
    'live rows',
    p.order,
  );
  if (p.live.some((r) => r.deleted)) throw new ReconcileError('live rows include a deleted row');
  const end = pageEnd(p.listed, p.listTruncated, p.live, p.liveTruncated, p.order);
  const inPage = (k: string): boolean => end === null || p.order.compare(k, end) <= 0;
  const quiet = (ms: number): boolean => ms <= p.now - p.graceMs;

  // Merge the two sorted streams so candidates come out in key order.
  const candidates: Candidate[] = [];
  const listed = p.listed.filter((o) => inPage(o.key));
  const live = p.live.filter((r) => inPage(r.key));
  let i = 0;
  let j = 0;
  while (i < listed.length || j < live.length) {
    const o = listed[i];
    const r = live[j];
    const c = o === undefined ? 1 : r === undefined ? -1 : p.order.compare(o.key, r.key);
    let found: Candidate | null = null;
    if (c > 0 && r !== undefined) {
      // Live in the log, not in the bucket.
      if (quiet(eventMillis(r.eventTime))) {
        found = { kind: 'MISSING_OBJECT', key: r.key, basisSeq: r.seq, expected: expected(r) };
      }
      j++;
    } else if (o !== undefined) {
      found = classify(o, p.rows.get(o.key) ?? (c === 0 ? r : undefined), quiet);
      i++;
      if (c === 0) j++;
    }
    if (found !== null) candidates.push(found);
  }
  return { end, scanned: listed.length, candidates };
}
