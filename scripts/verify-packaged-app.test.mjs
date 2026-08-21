import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { createPackage } from '@electron/asar';
import { asarLookupPath, assertPackagedDependencyClosure } from './verify-packaged-app.mjs';

describe('asarLookupPath', () => {
  // The archive stores `/`-joined paths, but `@electron/asar` resolves a lookup
  // by splitting it on `path.sep`. Passing an archive path straight through
  // therefore works on macOS and Linux and silently finds nothing on Windows,
  // which is how this shipped green from a mac and failed the Windows lane.
  test('leaves archive paths alone where the separator already matches', () => {
    assert.equal(asarLookupPath('dist/main/app-ipc-main.js', '/'), 'dist/main/app-ipc-main.js');
  });

  test('localizes every segment for a Windows separator', () => {
    assert.equal(asarLookupPath('dist/main/app-ipc-main.js', '\\'), 'dist\\main\\app-ipc-main.js');
  });

  test('resolves a real archive path under a Windows separator', () => {
    // Mirrors `@electron/asar`'s own descent so the assertion fails on any
    // platform rather than only on the one that has the bug.
    const header = {
      files: { dist: { files: { main: { files: { 'app-ipc-main.js': { size: 1 } } } } } },
    };
    const descend = (path, separator) =>
      path
        .split(separator)
        .filter(Boolean)
        .reduce((node, part) => node?.files?.[part], header);

    assert.ok(descend(asarLookupPath('dist/main/app-ipc-main.js', '\\'), '\\'));
    assert.equal(descend('dist/main/app-ipc-main.js', '\\'), undefined);
  });
});

// The closure assertion must judge the artifact by its own contents. These
// fixtures build a real `resources/` layout — an actual asar carrying both a
// node_modules tree and the renderer's bundled-package record, plus a shipped
// notices file — because the regressions this guards against were verifiers
// that read part of their evidence from the checkout.

const roots = [];

const PTY_PACKAGES = ['@xterm/headless', '@xterm/addon-unicode11'];
const COVERING_NOTICES = 'Header\n\nPackage: react@19.2.0\nDeclared license: MIT\n';

async function makeResources({
  asarPackages = PTY_PACKAGES,
  bundled = ['react'],
  notices = COVERING_NOTICES,
  rendererLicenses = [],
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'maka-closure-'));
  roots.push(root);
  const stage = join(root, 'stage');
  for (const name of asarPackages) {
    const directory = join(stage, 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), `{"name":"${name}"}\n`);
  }
  if (bundled !== null) {
    await mkdir(join(stage, 'dist-renderer'), { recursive: true });
    await writeFile(
      join(stage, 'dist-renderer', 'bundled-npm-packages.json'),
      `${JSON.stringify(bundled)}\n`,
    );
  }
  const resources = join(root, 'resources');
  await mkdir(join(resources, 'licenses', 'npm'), { recursive: true });
  await createPackage(stage, join(resources, 'app.asar'));
  await writeFile(join(resources, 'licenses', 'npm', 'THIRD_PARTY_NOTICES.txt'), notices);
  for (const relativePath of rendererLicenses) {
    const path = join(resources, relativePath);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'license text\n');
  }
  return resources;
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const options = {
  collectClosure: () => [{ name: 'react', version: '19.2.0' }],
  collectPackagedAllowlist: () => new Set(PTY_PACKAGES),
};

describe('assertPackagedDependencyClosure', () => {
  test('accepts an artifact whose asar, bundle record, and shipped notices match', async () => {
    const resources = await makeResources();
    await assertPackagedDependencyClosure(resources, options);
  });

  test('rejects a stale shipped notice even though the checkout copy is complete', async () => {
    // The checkout's own THIRD_PARTY_NOTICES.txt covers react — that is what
    // check:third-party-notices enforces — so a verifier reading from the
    // checkout would pass this artifact. Only the shipped copy is stale.
    const resources = await makeResources({
      notices: 'Header\n\nPackage: something-else@1.0.0\nDeclared license: MIT\n',
    });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /shipped THIRD_PARTY_NOTICES\.txt is missing packages the artifact ships: react@19\.2\.0/,
    );
  });

  test('rejects a notice entry whose version is not the shipped one', async () => {
    const resources = await makeResources({
      notices: 'Header\n\nPackage: react@18.0.0\nDeclared license: MIT\n',
    });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /react@19\.2\.0/,
    );
  });

  test('rejects a leak hidden inside a nested node_modules', async () => {
    // npm nests a second copy under a package on version conflict; a walk that
    // stops at the top level certifies an archive it has not fully inspected.
    const resources = await makeResources({
      asarPackages: [...PTY_PACKAGES, '@xterm/headless/node_modules/left-pad'],
    });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /app\.asar carries packages outside the production closure: left-pad/,
    );
  });

  test('rejects any package outside the production closure, transitive ones included', async () => {
    // The old check compared the archive against the declared renderer roots,
    // so a renderer-only transitive package (never a root) could leak back in
    // silently. The allowlist is the production closure, so anything else —
    // root or transitive — is a leak.
    const resources = await makeResources({
      asarPackages: [...PTY_PACKAGES, 'lodash-es'],
    });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /app\.asar carries packages outside the production closure: lodash-es/,
    );
  });

  test('rejects an asar trimmed past what the PTY stack loads', async () => {
    const resources = await makeResources({ asarPackages: ['@xterm/addon-unicode11'] });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /missing @xterm\/headless/,
    );
  });

  test('rejects a bundle record naming a package the closure does not declare', async () => {
    // The record is written by the vite build from the real module graph, so
    // this is the failure a package entering through a new path (a CSS import,
    // an asset chain) produces until it is declared.
    const resources = await makeResources({ bundled: ['react', 'left-pad'] });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /renderer bundle carries packages outside the declared closure: left-pad/,
    );
  });

  test('rejects an artifact with no bundle record at all', async () => {
    const resources = await makeResources({ bundled: null });
    await assert.rejects(
      () => assertPackagedDependencyClosure(resources, options),
      /does not carry dist-renderer\/bundled-npm-packages\.json/,
    );
  });

  test('asset-licensed packages need their shipped license file, not an npm notice', async () => {
    const closure = () => [
      { name: 'react', version: '19.2.0' },
      { name: '@fontsource-variable/geist', version: '5.3.0' },
    ];
    const withLicense = await makeResources({
      bundled: ['react', '@fontsource-variable/geist'],
      rendererLicenses: [join('licenses', 'renderer', 'GEIST_LICENSE.txt')],
    });
    await assertPackagedDependencyClosure(withLicense, { ...options, collectClosure: closure });

    const withoutLicense = await makeResources({
      bundled: ['react', '@fontsource-variable/geist'],
    });
    await assert.rejects(
      () =>
        assertPackagedDependencyClosure(withoutLicense, { ...options, collectClosure: closure }),
      /shipped license file for @fontsource-variable\/geist is missing/,
    );
  });
});
