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
import { describe, test } from 'node:test';
import { sessionSelectionGestureMode } from '@maka/ui';
import {
  applySessionSelectionGesture,
  EMPTY_SESSION_SELECTION,
  pruneSessionSelection,
  type SessionSelection,
} from '../../renderer/features/session-navigation/testing.js';

const GROUP = ['a', 'b', 'c', 'd', 'e'];

function ids(selection: SessionSelection): string[] {
  return [...selection.selectedIds].sort();
}

function toggle(selection: SessionSelection, sessionId: string): SessionSelection {
  return applySessionSelectionGesture(selection, {
    sessionId,
    mode: 'toggle',
    groupSessionIds: GROUP,
  });
}

function range(selection: SessionSelection, sessionId: string, group = GROUP): SessionSelection {
  return applySessionSelectionGesture(selection, {
    sessionId,
    mode: 'range',
    groupSessionIds: group,
  });
}

describe('sessionSelectionGestureMode', () => {
  test('a plain click is not a selection gesture', () => {
    // The rail is a navigation surface first: an unmodified click must keep
    // opening the task, or selecting would cost the rail its primary job.
    assert.equal(
      sessionSelectionGestureMode({ metaKey: false, ctrlKey: false, shiftKey: false }),
      undefined,
    );
  });

  test('either platform modifier toggles', () => {
    assert.equal(sessionSelectionGestureMode({ metaKey: true, ctrlKey: false, shiftKey: false }), 'toggle');
    assert.equal(sessionSelectionGestureMode({ metaKey: false, ctrlKey: true, shiftKey: false }), 'toggle');
  });

  test('shift wins over the toggle modifier', () => {
    // A range is the more specific request; resolving both as a toggle would
    // drop it.
    assert.equal(sessionSelectionGestureMode({ metaKey: true, ctrlKey: false, shiftKey: true }), 'range');
  });
});

describe('toggle', () => {
  test('adds, removes, and anchors on the row last acted on', () => {
    const one = toggle(EMPTY_SESSION_SELECTION, 'b');
    assert.deepEqual(ids(one), ['b']);
    assert.equal(one.anchorId, 'b');

    const two = toggle(one, 'd');
    assert.deepEqual(ids(two), ['b', 'd']);
    assert.equal(two.anchorId, 'd');

    const removed = toggle(two, 'b');
    assert.deepEqual(ids(removed), ['d']);
    // The anchor follows a removal too: leaving it on a row that is no longer
    // marked would measure the next range from somewhere invisible.
    assert.equal(removed.anchorId, 'b');
  });

  test('the input selection is never mutated', () => {
    const one = toggle(EMPTY_SESSION_SELECTION, 'b');
    toggle(one, 'c');
    assert.deepEqual(ids(one), ['b']);
  });
});

describe('range', () => {
  test('spans from the anchor in either direction', () => {
    const anchored = toggle(EMPTY_SESSION_SELECTION, 'd');
    assert.deepEqual(ids(range(anchored, 'b')), ['b', 'c', 'd']);
    assert.deepEqual(ids(range(toggle(EMPTY_SESSION_SELECTION, 'b'), 'd')), ['b', 'c', 'd']);
  });

  test('a corrected range does not accumulate', () => {
    // Shift-click one row too far, then Shift-click back. Re-anchoring on each
    // target would union the two spans and the selection could never shrink.
    const anchored = toggle(EMPTY_SESSION_SELECTION, 'a');
    const tooFar = range(anchored, 'e');
    assert.deepEqual(ids(tooFar), ['a', 'b', 'c', 'd', 'e']);
    const corrected = range(tooFar, 'b');
    assert.equal(corrected.anchorId, 'a');
    // The span itself is a..b; the rows the first Shift-click added stay
    // selected because a range adds, and the anchor is what had to stay put.
    assert.deepEqual(ids(corrected), ['a', 'b', 'c', 'd', 'e']);
  });

  test('shift on a fresh rail selects the row it lands on', () => {
    // Otherwise the first Shift-click does nothing at all, and a modifier that
    // appears broken is a modifier nobody tries twice.
    const first = range(EMPTY_SESSION_SELECTION, 'c');
    assert.deepEqual(ids(first), ['c']);
    assert.equal(first.anchorId, 'c');
  });

  test('an anchor in another group re-anchors instead of spanning', () => {
    // The two groups have no common order, so there is no span to compute.
    const other = toggle(EMPTY_SESSION_SELECTION, 'a');
    const next = range(other, 'y', ['x', 'y', 'z']);
    assert.deepEqual(ids(next), ['a', 'y']);
    assert.equal(next.anchorId, 'y');
  });

  test('a row the group does not list is not an endpoint', () => {
    const anchored = toggle(EMPTY_SESSION_SELECTION, 'a');
    const next = range(anchored, 'missing');
    assert.deepEqual(ids(next), ['a']);
    assert.equal(next.anchorId, 'a');
  });
});

describe('pruneSessionSelection', () => {
  test('drops ids the catalog no longer lists', () => {
    const selection = toggle(toggle(EMPTY_SESSION_SELECTION, 'a'), 'b');
    const pruned = pruneSessionSelection(selection, ['a']);
    assert.deepEqual(ids(pruned), ['a']);
  });

  test('clears an anchor that went with them', () => {
    const selection = toggle(toggle(EMPTY_SESSION_SELECTION, 'a'), 'b');
    assert.equal(selection.anchorId, 'b');
    assert.equal(pruneSessionSelection(selection, ['a']).anchorId, undefined);
  });

  test('returns the same value when nothing was dropped', () => {
    // Identity matters here: this runs on every catalog refresh, and a new Set
    // each time would re-render every row of the rail for no change.
    const selection = toggle(EMPTY_SESSION_SELECTION, 'a');
    assert.equal(pruneSessionSelection(selection, ['a', 'b']), selection);
  });

  test('an emptied selection settles on the shared empty value', () => {
    const selection = toggle(EMPTY_SESSION_SELECTION, 'a');
    assert.equal(pruneSessionSelection(selection, []), EMPTY_SESSION_SELECTION);
  });
});
