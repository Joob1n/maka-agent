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

/**
 * What the rail has selected for a bulk action, and where a range would start.
 *
 * The anchor is the last row toggled, not the last row selected: a range is
 * measured from the row the user last acted on, which is what makes a second
 * Shift-click re-measure rather than accumulate.
 */
export interface SessionSelection {
  readonly selectedIds: ReadonlySet<string>;
  readonly anchorId?: string;
}

export const EMPTY_SESSION_SELECTION: SessionSelection = Object.freeze({
  selectedIds: Object.freeze(new Set<string>()) as ReadonlySet<string>,
});

/**
 * One click on a row, as the rail saw it.
 *
 * `groupSessionIds` is the rendered order of the group the row sits in, and a
 * range never leaves it. The rail cannot do better: a project group's collapsed
 * state lives inside Astryx's `SideNavItem` and is not readable from here, so a
 * range spanning groups could silently include rows nobody can see. Within one
 * group the question does not arise — both endpoints had to be clicked, and a
 * row that can be clicked is a row that is on screen.
 */
export interface SessionSelectionGesture {
  readonly sessionId: string;
  readonly mode: 'toggle' | 'range';
  readonly groupSessionIds: readonly string[];
}

export function applySessionSelectionGesture(
  selection: SessionSelection,
  gesture: SessionSelectionGesture,
): SessionSelection {
  if (gesture.mode === 'toggle') return toggleSession(selection, gesture.sessionId);
  return extendRange(selection, gesture);
}

function toggleSession(selection: SessionSelection, sessionId: string): SessionSelection {
  const selectedIds = new Set(selection.selectedIds);
  if (selectedIds.has(sessionId)) {
    selectedIds.delete(sessionId);
    // The anchor follows the row the user last acted on even when that act was
    // a removal: leaving it on a row no longer in the selection would measure
    // the next range from somewhere the user cannot see marked.
    return { selectedIds, anchorId: sessionId };
  }
  selectedIds.add(sessionId);
  return { selectedIds, anchorId: sessionId };
}

function extendRange(
  selection: SessionSelection,
  gesture: SessionSelectionGesture,
): SessionSelection {
  const targetIndex = gesture.groupSessionIds.indexOf(gesture.sessionId);
  // A row the rail did not list in this group is not a range endpoint. This is
  // the shape a stale render produces, and adding it alone would be a silent
  // half-answer to a request for a span.
  if (targetIndex === -1) return selection;
  const anchorIndex =
    selection.anchorId === undefined ? -1 : gesture.groupSessionIds.indexOf(selection.anchorId);
  // No anchor, or an anchor in another group: this click IS the anchor. Shift
  // on a fresh rail selects the one row rather than nothing, which is what
  // makes the modifier discoverable by trying it.
  if (anchorIndex === -1) {
    return { selectedIds: new Set([...selection.selectedIds, gesture.sessionId]), anchorId: gesture.sessionId };
  }
  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  const selectedIds = new Set(selection.selectedIds);
  for (const sessionId of gesture.groupSessionIds.slice(from, to + 1)) selectedIds.add(sessionId);
  // The anchor stays put. Re-anchoring on the target is what turns a corrected
  // range — Shift-click one row too far, then Shift-click back — into two
  // unions that can never shrink.
  return { selectedIds, anchorId: selection.anchorId };
}

/**
 * Drops ids the catalog no longer lists.
 *
 * A selection outlives the list it was made from: another client deletes a
 * task, a filter narrows, a bulk action removes what it removed. Acting on an
 * id that is gone is at best a no-op and at worst a count that does not add up,
 * so the selection is reconciled against the catalog rather than trusted.
 */
export function pruneSessionSelection(
  selection: SessionSelection,
  listedSessionIds: Iterable<string>,
): SessionSelection {
  const listed = listedSessionIds instanceof Set ? listedSessionIds : new Set(listedSessionIds);
  const selectedIds = new Set<string>();
  for (const sessionId of selection.selectedIds) {
    if (listed.has(sessionId)) selectedIds.add(sessionId);
  }
  if (selectedIds.size === selection.selectedIds.size) return selection;
  const anchorId =
    selection.anchorId !== undefined && listed.has(selection.anchorId)
      ? selection.anchorId
      : undefined;
  return selectedIds.size === 0 ? EMPTY_SESSION_SELECTION : { selectedIds, anchorId };
}
