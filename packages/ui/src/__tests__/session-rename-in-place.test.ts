import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

/**
 * A rename replaces the name, not the row.
 *
 * The editing row is a wholesale swap and cannot be anything else: Astryx's
 * `SideNavItem` takes `label` as a string and renders the row as one button,
 * which a text field may not live inside. So everything the static row brings
 * has to be restated by the stand-in — and the subtree is the part that costs
 * the most when it is not, because it is not a decoration but every descendant
 * row: renaming a session with running subagents unmounted the whole branch
 * until the edit ended.
 *
 * A source contract rather than a rendered one: `editingSessionId` is internal
 * state with no prop to set it, so no static render can reach this branch, and
 * the E2E fixtures seed no subagent tree. What this pins is the one thing that
 * would silently bring the regression back — an editing branch that renders
 * the field and forgets the children.
 */
// Two levels up from either `src/__tests__` or the compiled `dist/__tests__`,
// which is where the suite actually runs from.
const SOURCE = resolve(import.meta.dirname, '../../src/session-history-list.tsx');

/** The body of the `if (props.editing)` branch, brace-matched. */
function editingBranch(source: string): string {
  const start = source.indexOf('if (props.editing) {');
  assert.notEqual(start, -1, 'SessionRow must still branch on `props.editing`');
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('unterminated editing branch');
}

describe('sidebar rename in place', () => {
  it('keeps the row’s subtree mounted while its name is being typed', async () => {
    const branch = editingBranch(await readFile(SOURCE, 'utf8'));
    assert.match(branch, /renderSessionTree/, 'the editing row must still render its children');
    assert.match(
      branch,
      /maka-session-subtree/,
      'the children need the inset SideNavItem gives them, or every descendant shifts left',
    );
    assert.match(
      branch,
      /hasChildren/,
      'a leaf row must not grow an empty subtree wrapper',
    );
  });
});
