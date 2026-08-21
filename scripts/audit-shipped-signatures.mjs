// Registry-signature coverage for what the desktop artifact ships, not for
// what npm labels production.
//
// `npm audit signatures --omit=dev` covers the Node production closure. The
// renderer roots live in `devDependencies` so electron-builder keeps their
// unread sources out of `app.asar`, but vite bundles them into
// `dist-renderer` — so their code ships while `--omit=dev` skips them. An
// unsigned or tampered `react` would reach users with the signature gate
// green.
//
// Auditing the full installed tree would close that hole and open a different
// one: it fails the release on tooling that never ships (playwright, vite,
// storybook), which trains the gate to be ignored. This audits the full tree
// and fails only on packages whose exact `{name, version}` is in the shipped
// closure — the same authority `audit-shipped-dependencies.mjs` uses for
// vulnerabilities.
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { npmSpawnOptions } from './npm-spawn.mjs';
import { collectWorkspaceClosure } from './third-party-closure.mjs';

const repoRoot = resolve(import.meta.dirname, '..');

function npmSignatureReport() {
  const options = npmSpawnOptions({
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(execFileSync('npm', ['audit', 'signatures', '--json'], options));
  } catch (error) {
    // npm exits nonzero when anything is invalid or missing; the JSON is complete.
    if (typeof error.stdout === 'string' && error.stdout.trim().startsWith('{')) {
      return JSON.parse(error.stdout);
    }
    throw error;
  }
}

const closure = collectWorkspaceClosure({
  workspaceName: '@maka/desktop',
  manifestPath: join(repoRoot, 'apps', 'desktop', 'package.json'),
});
const shipped = new Set(closure.map(({ name, version }) => `${name}@${version}`));

const report = npmSignatureReport();
const findings = [];
for (const [kind, entries] of [
  ['invalid signature', report.invalid ?? []],
  ['missing signature', report.missing ?? []],
]) {
  for (const entry of entries) {
    // npm reports `name` and `version` separately on both lists.
    const identity = `${entry.name}@${entry.version}`;
    if (shipped.has(identity)) findings.push(`${identity}: ${kind}`);
  }
}

if (findings.length > 0) {
  console.error('[audit-shipped-signatures] shipped packages failed the registry signature check:');
  for (const finding of findings) console.error(`  ${finding}`);
  process.exit(1);
}

console.log(
  `[audit-shipped-signatures] desktop shipped closure: ${shipped.size} packages; signature failures reaching it: 0`,
);
