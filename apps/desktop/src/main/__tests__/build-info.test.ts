/**
 * The build stamp exists to tell a locally built tree apart from a release.
 * A linked worktree is the checkout where that matters most — it is the one
 * whose HEAD differs from the tree a developer thinks they are running — and
 * it is also the one whose `.git` is a file rather than a directory, so a
 * resolver that only reads `<root>/.git/HEAD` finds nothing there and the
 * stamp falls back to a bare version number.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { resolveBuildInfo } from '../build-info.js';

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const SHA = '4d223d05beea1bfa8af3b4bb4fe1211a9e93acfe';

test('a packaged build reports no commit and does not read the filesystem for one', () => {
  // `app.isPackaged` is the whole answer: a packaged tree has no repository,
  // and a commit resolved from one next to it would describe the wrong thing.
  assert.deepEqual(resolveBuildInfo(true, process.cwd()), { mode: 'packaged', commit: null });
});

test('an ordinary clone resolves the commit through a ref', async () => {
  const root = await makeRoot();
  await seedGitDir(join(root, '.git'), { head: 'ref: refs/heads/main', refs: { 'refs/heads/main': SHA } });
  assert.deepEqual(resolveBuildInfo(false, root), { mode: 'dev', commit: SHA.slice(0, 7) });
});

test('a linked worktree resolves through its gitdir pointer', async () => {
  // `.git` is a FILE here, holding `gitdir: <path>`. This is the case the
  // resolver used to miss entirely.
  const root = await makeRoot();
  const real = join(root, 'real-git-dir');
  await seedGitDir(real, { head: 'ref: refs/heads/feature', refs: { 'refs/heads/feature': SHA } });
  await writeFile(join(root, '.git'), `gitdir: ${real}\n`);
  assert.deepEqual(resolveBuildInfo(false, root), { mode: 'dev', commit: SHA.slice(0, 7) });
});

test('a worktree pointer relative to the checkout resolves', async () => {
  // Git writes a relative pointer for a worktree created inside the repo.
  const root = await makeRoot();
  await seedGitDir(join(root, 'nested', 'git-dir'), {
    head: 'ref: refs/heads/main',
    refs: { 'refs/heads/main': SHA },
  });
  await writeFile(join(root, '.git'), 'gitdir: nested/git-dir\n');
  assert.deepEqual(resolveBuildInfo(false, root), { mode: 'dev', commit: SHA.slice(0, 7) });
});

test('a detached HEAD is already the sha', async () => {
  const root = await makeRoot();
  await seedGitDir(join(root, '.git'), { head: SHA, refs: {} });
  assert.deepEqual(resolveBuildInfo(false, root), { mode: 'dev', commit: SHA.slice(0, 7) });
});

test('a packed ref resolves when no loose ref file exists', async () => {
  const root = await makeRoot();
  const gitDir = join(root, '.git');
  await seedGitDir(gitDir, { head: 'ref: refs/heads/main', refs: {} });
  await writeFile(join(gitDir, 'packed-refs'), `# pack-refs with: peeled\n${SHA} refs/heads/main\n`);
  assert.deepEqual(resolveBuildInfo(false, root), { mode: 'dev', commit: SHA.slice(0, 7) });
});

test('an unreadable checkout reports dev with no commit rather than throwing', async () => {
  // Absence is a supported answer: the stamp shows the version alone. A throw
  // here would fail `app:info`, which carries far more than the commit.
  const root = await makeRoot();
  assert.deepEqual(resolveBuildInfo(false, root), { mode: 'dev', commit: null });

  const dangling = await makeRoot();
  await writeFile(join(dangling, '.git'), 'gitdir: /nowhere/that/exists\n');
  assert.deepEqual(resolveBuildInfo(false, dangling), { mode: 'dev', commit: null });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'maka-build-info-'));
  roots.push(root);
  return root;
}

async function seedGitDir(
  gitDir: string,
  input: { head: string; refs: Readonly<Record<string, string>> },
): Promise<void> {
  await mkdir(gitDir, { recursive: true });
  await writeFile(join(gitDir, 'HEAD'), `${input.head}\n`);
  for (const [ref, sha] of Object.entries(input.refs)) {
    const refPath = join(gitDir, ...ref.split('/'));
    await mkdir(join(refPath, '..'), { recursive: true });
    await writeFile(refPath, `${sha}\n`);
  }
}
