import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createPackage } from '@electron/asar';
import { assertPackagedDependencyClosure } from './verify-packaged-app.mjs';

// The closure assertion must judge the artifact by its own contents. These
// fixtures build a real `resources/` layout — an actual asar header and an
// actual shipped notices file — because the regression this guards against
// was exactly a verifier that read part of its evidence from the checkout.

const roots = [];

async function makeResources({ asarPackages, notices }) {
  const root = await mkdtemp(join(tmpdir(), 'maka-closure-'));
  roots.push(root);
  const stage = join(root, 'stage');
  for (const name of asarPackages) {
    const directory = join(stage, 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), `{"name":"${name}"}\n`);
  }
  const resources = join(root, 'resources');
  await mkdir(join(resources, 'licenses', 'npm'), { recursive: true });
  await createPackage(stage, join(resources, 'app.asar'));
  await writeFile(join(resources, 'licenses', 'npm', 'THIRD_PARTY_NOTICES.txt'), notices);
  return resources;
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const PTY_PACKAGES = ['@xterm/headless', '@xterm/addon-unicode11'];
const options = {
  readManifest: () => ({ maka: { rendererBundledDependencies: ['react'] } }),
  collectClosure: () => [{ name: 'react', version: '19.2.0' }],
};
const COVERING_NOTICES = 'Header\n\nPackage: react@19.2.0\nDeclared license: MIT\n';

describe('assertPackagedDependencyClosure', () => {
  test('accepts an artifact whose asar and shipped notices match the closure', async () => {
    const resources = await makeResources({
      asarPackages: PTY_PACKAGES,
      notices: COVERING_NOTICES,
    });
    await assertPackagedDependencyClosure(resources, options);
  });

  test('rejects a stale shipped notice even though the checkout copy is complete', async () => {
    // The checkout's own THIRD_PARTY_NOTICES.txt covers react — that is what
    // check:third-party-notices enforces — so a verifier reading from the
    // checkout would pass this artifact. Only the shipped copy is stale.
    const resources = await makeResources({
      asarPackages: PTY_PACKAGES,
      notices: 'Header\n\nPackage: something-else@1.0.0\nDeclared license: MIT\n',
    });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /shipped THIRD_PARTY_NOTICES\.txt is missing packages the artifact ships: react@19\.2\.0/,
    );
  });

  test('rejects a notice entry whose version is not the shipped one', async () => {
    const resources = await makeResources({
      asarPackages: PTY_PACKAGES,
      notices: 'Header\n\nPackage: react@18.0.0\nDeclared license: MIT\n',
    });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /react@19\.2\.0/,
    );
  });

  test('rejects an asar that carries a renderer-only package a second time', async () => {
    const resources = await makeResources({
      asarPackages: [...PTY_PACKAGES, 'react'],
      notices: COVERING_NOTICES,
    });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /carries renderer-only packages a second time: react/,
    );
  });

  test('rejects an asar trimmed past what the PTY stack loads', async () => {
    const resources = await makeResources({
      asarPackages: ['@xterm/addon-unicode11'],
      notices: COVERING_NOTICES,
    });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /missing @xterm\/headless/,
    );
  });
});
