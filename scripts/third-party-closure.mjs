// The dependency closure a packaged artifact actually ships: the Node
// production closure that lands in `app.asar/node_modules`, plus everything
// reachable from the workspace's declared renderer roots, which vite bundles
// into `dist-renderer`. The notice generator writes from this closure and the
// packaged-artifact verifier checks against it, so both must read the same
// definition — this module is that single definition.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { npmSpawnOptions } from './npm-spawn.mjs';

const repoRoot = resolve(import.meta.dirname, '..');

export const WORKSPACE_PREFIX = '@maka/';

export function npmWorkspaceTree(workspaceName, omitDev) {
  const tree = JSON.parse(
    execFileSync(
      'npm',
      ['ls', '--workspace', workspaceName, ...(omitDev ? ['--omit=dev'] : []), '--all', '--json'],
      npmSpawnOptions({
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      }),
    ),
  );
  const workspace = tree.dependencies?.[workspaceName];
  if (!workspace) throw new Error(`npm ls did not return the ${workspaceName} workspace`);
  return workspace;
}

function collectInto(packages, dependencies) {
  for (const [name, dependency] of Object.entries(dependencies ?? {})) {
    if (!dependency || typeof dependency !== 'object') continue;
    if (!name.startsWith(WORKSPACE_PREFIX) && typeof dependency.version === 'string') {
      packages.set(`${name}@${dependency.version}`, { name, version: dependency.version });
    }
    collectInto(packages, dependency.dependencies);
  }
}

/**
 * Packages the workspace declares as bundled into the renderer.
 *
 * They live in `devDependencies` so electron-builder keeps a second, unread
 * copy of their sources out of `app.asar` — but vite bundles them into
 * `dist-renderer`, which the archive does carry. So they ship, and their
 * notices have to ship with them. Reading the list from the manifest keeps the
 * notice generator and the packaged-artifact verifier from drifting apart.
 */
export function rendererBundledRoots(manifestPath) {
  if (!manifestPath) return [];
  const declared = JSON.parse(readFileSync(manifestPath, 'utf8'))?.maka
    ?.rendererBundledDependencies;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(
      `${manifestPath}: maka.rendererBundledDependencies must list the renderer roots`,
    );
  }
  return declared;
}

/**
 * Every third-party `{ name, version }` the workspace ships, sorted. Pass
 * `manifestPath` only for a workspace that bundles a renderer; without it the
 * closure is the production closure alone.
 */
export function collectWorkspaceClosure({ workspaceName, manifestPath }) {
  const packages = new Map();
  collectInto(packages, npmWorkspaceTree(workspaceName, true).dependencies);

  const roots = new Set(rendererBundledRoots(manifestPath));
  if (roots.size > 0) {
    const full = npmWorkspaceTree(workspaceName, false).dependencies ?? {};
    for (const [name, dependency] of Object.entries(full)) {
      if (!roots.has(name) || !dependency || typeof dependency !== 'object') continue;
      if (!name.startsWith(WORKSPACE_PREFIX) && typeof dependency.version === 'string') {
        packages.set(`${name}@${dependency.version}`, { name, version: dependency.version });
      }
      collectInto(packages, dependency.dependencies);
    }
    // Every declared root must be reachable, the workspace ones included: a
    // workspace root (`@maka/ui`) carries no notice of its own — it is first
    // party — but its third-party dependencies are only collected through it,
    // so its absence from the tree would silently drop their notices.
    const missing = [...roots].filter((root) => !Object.hasOwn(full, root));
    if (missing.length > 0) {
      throw new Error(`renderer roots absent from the dependency tree: ${missing.join(', ')}`);
    }
  }

  return [...packages.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );
}
