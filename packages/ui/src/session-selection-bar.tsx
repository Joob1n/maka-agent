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

import { Button } from '@astryxdesign/core/Button';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { getConversationCopy } from './conversation-copy.js';
import { ICON_SIZE, Archive, Trash2 } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { useSessionRailSelection } from './session-rail-context.js';

/**
 * What the rail shows once rows are marked.
 *
 * It lives in the rail's sticky top region rather than above the rows: a bar
 * that scrolls away with the list is a bar the user has to scroll back to after
 * marking the rows at the bottom, which is exactly the case multi-select is for.
 *
 * Nothing renders until something is marked. The rail at rest is unchanged, so
 * the count is the only thing that ever announces itself, and it announces a
 * number the user produced.
 */
export function SessionSelectionBar() {
  const selection = useSessionRailSelection();
  const copy = getConversationCopy(useUiLocale()).sessions;
  const count = selection?.selectedIds.size ?? 0;
  if (!selection || count === 0) return null;
  const busy = selection.busy === true;
  return (
    <div className="maka-session-selection-bar" aria-label={copy.selectionBarAriaLabel} role="group">
      <HStack gap={1} vAlign="center">
        {/* `aria-live` so the count reaches a screen reader as it changes: the
            bar is not focused while the user is clicking rows, so nothing else
            would say how many are marked. */}
        <Text size="sm" aria-live="polite">
          {copy.selectedCount(count)}
        </Text>
        <span className="maka-session-selection-bar-spacer" />
        <Button
          variant="ghost"
          size="sm"
          icon={<Archive size={ICON_SIZE.meta} />}
          isDisabled={busy}
          onClick={() => void selection.onArchiveSelected()}
          label={copy.selectionArchive}
        />
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 size={ICON_SIZE.meta} />}
          isDisabled={busy}
          onClick={() => void selection.onDeleteSelected()}
          label={copy.selectionDelete}
        />
        <Button
          variant="ghost"
          size="sm"
          // Not disabled while a sweep runs: clearing asks for nothing of the
          // Host, and a user who changed their mind should not have to wait for
          // the action they no longer want.
          onClick={() => selection.onClear()}
          label={copy.selectionClear}
        />
      </HStack>
    </div>
  );
}
