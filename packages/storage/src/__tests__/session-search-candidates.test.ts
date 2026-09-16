/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import type { StoredMessage } from '@maka/core/session';
import { createSessionStore } from '../session-store.js';

function makeInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    cwd: '/tmp/cwd',
    llmConnectionSlug: 'test-connection',
    model: 'test-model',
    permissionMode: 'ask',
    name: 'Session',
    labels: [],
    ...overrides,
  };
}

async function withStore(
  prefix: string,
  body: (store: ReturnType<typeof createSessionStore>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const store = createSessionStore(root);
  try {
    await body(store);
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
}

function userMessage(id: string, text: string, ts: number): StoredMessage {
  return { type: 'user', id, turnId: `turn-${id}`, ts, text } as StoredMessage;
}

function ids(candidates: readonly { message: StoredMessage }[]): string[] {
  return candidates.map((candidate) => candidate.message.id).sort();
}

describe('Session search candidates', () => {
  test('offers records whose stored form contains a term', async () => {
    await withStore('maka-recall-candidates-', async (store) => {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, userMessage('m1', 'context window budget', 10));
      await store.appendMessage(session.id, userMessage('m2', 'unrelated note', 20));

      const candidates = await store.listSearchCandidates?.({
        sessionIds: [session.id],
        terms: ['window'],
        limit: 100,
      });
      assert.deepEqual(ids(candidates ?? []), ['m1']);
    });
  });

  test('a term matching several records offers all of them', async () => {
    await withStore('maka-recall-candidates-multi-', async (store) => {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, userMessage('m1', '上下文 窗口', 10));
      await store.appendMessage(session.id, userMessage('m2', '上下文 预算', 20));
      await store.appendMessage(session.id, userMessage('m3', '完全无关', 30));

      const candidates = await store.listSearchCandidates?.({
        sessionIds: [session.id],
        terms: ['上下文'],
        limit: 100,
      });
      assert.deepEqual(ids(candidates ?? []), ['m1', 'm2']);
    });
  });

  /**
   * Recall's predicate is case-insensitive and its terms arrive folded, so a
   * record that spells the term with capitals has to be offered. A scan of the
   * raw bytes would return nothing here, the fast path would be taken, and the
   * matches would disappear without an error.
   */
  test('a folded term reaches a record that spells it with capitals', async () => {
    await withStore('maka-recall-candidates-case-', async (store) => {
      const session = await store.create(makeInput());
      await store.appendMessage(
        session.id,
        userMessage('m1', 'The React component uses the Context API for state.', 10),
      );
      await store.appendMessage(session.id, userMessage('m2', 'lowercase context here', 20));

      for (const term of ['react', 'api', 'context']) {
        const candidates = await store.listSearchCandidates?.({
          sessionIds: [session.id],
          terms: [term],
          limit: 100,
        });
        assert.ok(
          ids(candidates ?? []).includes('m1'),
          `${term} must reach the capitalized record`,
        );
      }
      const both = await store.listSearchCandidates?.({
        sessionIds: [session.id],
        terms: ['context'],
        limit: 100,
      });
      assert.deepEqual(ids(both ?? []), ['m1', 'm2']);
    });
  });

  test('an unfolded term is refused rather than quietly mismatched', async () => {
    await withStore('maka-recall-candidates-unfolded-', async (store) => {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, userMessage('m1', 'anything', 10));
      for (const term of ['Context', 'ÄPFEL', 'é']) {
        await assert.rejects(
          async () =>
            store.listSearchCandidates?.({ sessionIds: [session.id], terms: [term], limit: 10 }),
          /must be folded/u,
        );
      }
    });
  });

  /**
   * SQLite folds ASCII only. A record whose Unicode fold differs — cased
   * letters outside ASCII, a compatibility character, a decomposed sequence —
   * cannot be matched by `lower()`, so the scan offers it unconditionally and
   * leaves the predicate to decide. Stable records next to it are still
   * filtered, which is what keeps this a narrowing rather than a full read.
   */
  test('a record SQLite cannot fold is offered whatever the term', async () => {
    await withStore('maka-recall-candidates-unicode-', async (store) => {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, userMessage('latin', 'ĐÀ NẴNG trip notes', 10));
      await store.appendMessage(session.id, userMessage('kelvin', 'Kelvin scale', 20));
      await store.appendMessage(
        session.id,
        userMessage('hangul', '한국어 노트'.normalize('NFD'), 30),
      );
      await store.appendMessage(session.id, userMessage('stable', 'plain 中文 record', 40));

      const search = (term: string) =>
        store.listSearchCandidates?.({ sessionIds: [session.id], terms: [term], limit: 100 });

      // Each unstable record is reached by the folded term recall would use.
      assert.ok(ids((await search('đà nẵng')) ?? []).includes('latin'));
      assert.ok(ids((await search('kelvin')) ?? []).includes('kelvin'));
      assert.ok(ids((await search('한국어')) ?? []).includes('hangul'));

      // Unstable records ride along on any term; the stable one is filtered.
      assert.deepEqual(ids((await search('nothing-here')) ?? []), ['hangul', 'kelvin', 'latin']);
      assert.deepEqual(ids((await search('中文')) ?? []), ['hangul', 'kelvin', 'latin', 'stable']);
    });
  });

  test('a chunked record SQLite cannot fold is offered too', async () => {
    await withStore('maka-recall-candidates-unicode-chunked-', async (store) => {
      const session = await store.create(makeInput());
      const filler = 'x'.repeat(80 * 1024);
      await store.appendMessage(session.id, userMessage('big', `${filler} ĐÀ NẴNG ${filler}`, 10));
      const candidates = await store.listSearchCandidates?.({
        sessionIds: [session.id],
        terms: ['đà nẵng'],
        limit: 100,
      });
      assert.deepEqual(ids(candidates ?? []), ['big']);
    });
  });

  test('terms are OR-combined across the whole request', async () => {
    await withStore('maka-recall-candidates-or-', async (store) => {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, userMessage('m1', 'alpha only', 10));
      await store.appendMessage(session.id, userMessage('m2', 'beta only', 20));
      await store.appendMessage(session.id, userMessage('m3', 'neither', 30));

      const candidates = await store.listSearchCandidates?.({
        sessionIds: [session.id],
        terms: ['alpha', 'beta'],
        limit: 100,
      });
      assert.deepEqual(ids(candidates ?? []), ['m1', 'm2']);
    });
  });

  /**
   * A record above the chunk threshold keeps only a marker in `record_json`,
   * so a scan of that column alone would silently miss every large message —
   * the exact failure the superset contract exists to prevent.
   */
  test('a message larger than the chunk threshold is still reachable', async () => {
    await withStore('maka-recall-candidates-chunked-', async (store) => {
      const session = await store.create(makeInput());
      const filler = 'x'.repeat(80 * 1024);
      await store.appendMessage(
        session.id,
        userMessage('big', `${filler} 上下文窗口 ${filler}`, 10),
      );

      const stored = await store.readMessages(session.id);
      assert.equal(stored.length, 1, 'the fixture must actually exceed the inline limit');

      const candidates = await store.listSearchCandidates?.({
        sessionIds: [session.id],
        terms: ['上下文窗口'],
        limit: 100,
      });
      assert.deepEqual(ids(candidates ?? []), ['big']);
      assert.equal(
        candidates?.[0]?.message.type === 'user' ? candidates[0]?.message.text.length : 0,
        `${filler} 上下文窗口 ${filler}`.length,
        'a chunked candidate must come back reassembled',
      );
    });
  });

  /**
   * A chunk boundary can split a multi-byte character, so matching chunk by
   * chunk would miss a term that straddles one. Reassembly happens before the
   * match, which is what makes the boundary invisible.
   */
  test('a term straddling a chunk boundary is still reachable', async () => {
    await withStore('maka-recall-candidates-boundary-', async (store) => {
      const session = await store.create(makeInput());
      const chunkBytes = 64 * 1024;
      // Land the term across the first boundary: pad with single-byte filler
      // to three bytes short of it, so the first character's UTF-8 encoding is
      // cut in half.
      const head = 'x'.repeat(chunkBytes - 2);
      const tail = 'y'.repeat(chunkBytes);
      await store.appendMessage(session.id, userMessage('edge', `${head}上下文${tail}`, 10));

      const candidates = await store.listSearchCandidates?.({
        sessionIds: [session.id],
        terms: ['上下文'],
        limit: 100,
      });
      assert.deepEqual(ids(candidates ?? []), ['edge']);
    });
  });

  test('non-visible records are never offered as candidates', async () => {
    await withStore('maka-recall-candidates-types-', async (store) => {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, userMessage('m1', 'visible marker', 10));
      await store.appendMessage(session.id, {
        type: 'turn_state',
        id: 'state',
        turnId: 'turn-m1',
        ts: 20,
        status: 'completed',
      } as unknown as StoredMessage);

      const candidates = await store.listSearchCandidates?.({
        sessionIds: [session.id],
        terms: ['visible marker'],
        limit: 100,
      });
      assert.deepEqual(ids(candidates ?? []), ['m1']);
    });
  });

  test('candidates stay inside the requested Sessions', async () => {
    await withStore('maka-recall-candidates-scope-', async (store) => {
      const wanted = await store.create(makeInput({ name: 'wanted' }));
      const other = await store.create(makeInput({ name: 'other' }));
      await store.appendMessage(wanted.id, userMessage('m1', 'shared term', 10));
      await store.appendMessage(other.id, userMessage('m2', 'shared term', 20));

      const candidates = await store.listSearchCandidates?.({
        sessionIds: [wanted.id],
        terms: ['shared term'],
        limit: 100,
      });
      assert.deepEqual(ids(candidates ?? []), ['m1']);
    });
  });

  /**
   * Past the ceiling the store declines instead of returning a prefix. A
   * truncated candidate set is no longer a superset, and the matches it
   * dropped would disappear without any error.
   */
  test('the store declines rather than truncating past its ceiling', async () => {
    await withStore('maka-recall-candidates-ceiling-', async (store) => {
      const session = await store.create(makeInput());
      for (let index = 0; index < 5; index += 1) {
        await store.appendMessage(session.id, userMessage(`m${index}`, 'common term', 10 + index));
      }

      const declined = await store.listSearchCandidates?.({
        sessionIds: [session.id],
        terms: ['common term'],
        limit: 3,
      });
      assert.equal(declined, undefined);

      const accepted = await store.listSearchCandidates?.({
        sessionIds: [session.id],
        terms: ['common term'],
        limit: 5,
      });
      assert.equal(accepted?.length, 5);
    });
  });

  test('an empty request is answered without touching storage', async () => {
    await withStore('maka-recall-candidates-empty-', async (store) => {
      const session = await store.create(makeInput());
      assert.deepEqual(
        await store.listSearchCandidates?.({ sessionIds: [], terms: ['x'], limit: 10 }),
        [],
      );
      assert.deepEqual(
        await store.listSearchCandidates?.({ sessionIds: [session.id], terms: [], limit: 10 }),
        [],
      );
    });
  });

  test('the searchable corpus count excludes non-visible records', async () => {
    await withStore('maka-recall-corpus-count-', async (store) => {
      const session = await store.create(makeInput());
      await store.appendMessage(session.id, userMessage('m1', 'one', 10));
      await store.appendMessage(session.id, userMessage('m2', 'two', 20));
      await store.appendMessage(session.id, {
        type: 'turn_state',
        id: 'state',
        turnId: 'turn-m2',
        ts: 30,
        status: 'completed',
      } as unknown as StoredMessage);

      assert.equal(await store.countSearchableMessages?.([session.id]), 2);
      assert.equal(await store.countSearchableMessages?.([]), 0);
    });
  });
});
