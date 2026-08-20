import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

// `timeoutMs` is opt-in, for the commands that have actually hung: node-pty
// under conpty keeps a handle open after its child exits. Everything else runs
// unbounded on purpose — codesign and notarization assessment on a full app
// bundle have no honest upper bound, and a wrong deadline fails a good release.
// The workflow timeout is the outer bound; the verifier's stage log says where.
export function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const deadline =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            child.kill('SIGKILL');
            reject(
              new Error(
                `${command} ${args.join(' ')} did not finish within ${options.timeoutMs}ms` +
                  `${stdout.trim() ? `\nstdout: ${stdout.trim()}` : ''}` +
                  `${stderr.trim() ? `\nstderr: ${stderr.trim()}` : ''}`,
              ),
            );
          }, options.timeoutMs);
    const settle = (finish) => (value) => {
      if (deadline) clearTimeout(deadline);
      finish(value);
    };
    resolvePromise = settle(resolvePromise);
    reject = settle(reject);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    if (options.input !== undefined) child.stdin.end(options.input);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed with ${
            signal ? `signal ${signal}` : `exit code ${code}`
          }\n${stderr.trim()}`,
        ),
      );
    });
  });
}

export async function assertMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Forbidden release resource exists: ${path}`);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

/**
 * One budget for every wait a cold Windows runner can stretch — exposing CDP
 * and mounting React alike. The runner scans a first-run executable before
 * letting it serve, and a step that had been observed taking 74 seconds was
 * failing a 30-second line. Holding it in one place is what keeps a second
 * launch path from silently keeping the old, too-tight deadline.
 */
export const RENDERER_READY_TIMEOUT_MS = 120_000;

/**
 * The port Chromium actually bound, read from the DevToolsActivePort file it
 * writes into the user-data directory. The verifier used to reserve a port,
 * release it, and hand the number to Electron — leaving a window in which
 * anything else on the runner could take it, and a timeout log that could not
 * say whether the app was even listening where the poll looked (issue #3196).
 */
async function readDevToolsPort(userDataDirectory) {
  try {
    const content = await readFile(join(userDataDirectory, 'DevToolsActivePort'), 'utf8');
    const port = Number.parseInt(content.split('\n')[0] ?? '', 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export async function findRendererTarget(userDataDirectory, child) {
  const startedAt = Date.now();
  const deadline = startedAt + RENDERER_READY_TIMEOUT_MS;
  let port = null;
  let lastState = 'DevToolsActivePort was never written under the user-data directory';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged Maka exited before its renderer was ready.`);
    }
    // Re-read rather than latch the first value: Chromium writes this file at
    // startup, so a caller that left a predecessor's file in place is polling
    // a dead port only until the child overwrites it. Callers should still
    // remove it before spawning — a stale file that is never overwritten
    // cannot be told from a fresh one — but the poll converges either way.
    const current = await readDevToolsPort(userDataDirectory);
    if (current !== null) port = current;
    if (port !== null) {
      try {
        // Per-attempt timeout: undici's default headers timeout is 300 seconds,
        // so a single hanging attempt against a bound-but-unresponsive endpoint
        // (a main process stuck in startup) would otherwise blow straight
        // through the loop's deadline — one run overshot it to 355 seconds.
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) {
          const targets = await response.json();
          const page = targets.find(
            (target) => target.type === 'page' && target.webSocketDebuggerUrl,
          );
          if (page) return page;
          lastState = `port ${port} answered with ${targets.length} targets but no debuggable page`;
        } else {
          lastState = `port ${port} answered HTTP ${response.status}`;
        }
      } catch (error) {
        lastState = `port ${port} did not answer: ${error.message}`;
      }
    }
    await delay(250);
  }
  // Say exactly where discovery stalled, so classifying the failure does not
  // take a re-run: no port file, a port that never answers, an unexpected
  // HTTP status, and a healthy endpoint with no page target are four
  // different faults.
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  throw new Error(
    `Packaged Maka renderer did not expose CDP within ${elapsedSeconds} seconds: ${lastState}.`,
  );
}

/**
 * Evaluate one expression in a renderer over CDP and return its
 * `returnByValue` result. `awaitPromise` resolves a returned promise before
 * reporting, which is how the auto-update harness drives `window.maka.app`
 * calls; the plain smoke below keeps its original synchronous expression.
 */
export async function evaluateInRenderer(
  webSocketDebuggerUrl,
  expression,
  { awaitPromise = false, timeoutMs = 10_000 } = {},
) {
  if (typeof WebSocket !== 'function') {
    throw new Error('The release verifier requires Node.js WebSocket support.');
  }
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  try {
    return await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('CDP renderer evaluation timed out.'));
      }, timeoutMs);
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        clearTimeout(timeout);
        if (message.error) {
          reject(new Error(message.error.message));
          return;
        }
        if (message.result?.exceptionDetails) {
          reject(
            new Error(
              message.result.exceptionDetails.exception?.description ??
                message.result.exceptionDetails.text ??
                'Renderer evaluation threw.',
            ),
          );
          return;
        }
        resolvePromise(message.result?.result?.value);
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression,
            returnByValue: true,
            awaitPromise,
          },
        }),
      );
    });
  } finally {
    socket.close();
  }
}

export const RENDERER_STATE_EXPRESSION = `({
  readyState: document.readyState,
  hasBridge: Boolean(window.maka),
  hasRoot: Boolean(document.querySelector('#root')),
  hasPreloadSkeleton: Boolean(document.querySelector('#root > .maka-preload')),
  hasAppShell: Boolean(document.querySelector('#root [data-agents-page]'))
})`;

function evaluateRenderer(webSocketDebuggerUrl) {
  return evaluateInRenderer(webSocketDebuggerUrl, RENDERER_STATE_EXPRESSION);
}

export function isPackagedRendererUsable(rendererState) {
  return (
    rendererState?.readyState === 'complete' &&
    rendererState.hasBridge === true &&
    rendererState.hasRoot === true &&
    rendererState.hasPreloadSkeleton === false &&
    rendererState.hasAppShell === true
  );
}

export async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once('exit', () => resolvePromise(true))),
    delay(5_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

export function makePtyProbe(shellFile, shellArgs) {
  return String.raw`
const { createRequire } = require('node:module');
const requireFromApp = createRequire(process.argv[1]);
const pty = requireFromApp('node-pty');
const child = pty.spawn(${JSON.stringify(shellFile)}, ${JSON.stringify(shellArgs)}, {
  name: 'xterm-color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});
let output = '';
const timeout = setTimeout(() => {
  console.error('node-pty packaged smoke timed out');
  process.exit(1);
}, 5000);
child.onData((data) => {
  output += data;
});
child.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  const ok = exitCode === 0 && output.includes('maka-node-pty-ok');
  // conpty keeps a handle open after its child exits, so on Windows this process
  // never ends on its own and the probe would hang instead of report. Writing
  // through the callback exits only once the output has been flushed.
  const stream = ok ? process.stdout : process.stderr;
  const message = ok ? 'maka-node-pty-ok' : 'node-pty packaged smoke failed';
  stream.write(message + '\n', () => process.exit(ok ? 0 : 1));
});
`;
}

// A packaged app is verified against the user state of whoever runs the
// verifier, so every probe gets its own home. The macOS and Windows variables
// are set together because Electron and Node read different ones per platform
// and setting the unused ones is inert.
export function isolatedUserEnv(homeDirectory, { temporaryDirectory = homeDirectory } = {}) {
  return {
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    APPDATA: join(homeDirectory, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(homeDirectory, 'AppData', 'Local'),
    TMPDIR: temporaryDirectory,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
  };
}

export async function smokePackagedRenderer(executable, { workingDirectory } = {}) {
  const home = join(workingDirectory, 'home');
  const userData = join(workingDirectory, 'user-data');
  const userEnv = isolatedUserEnv(home);
  await mkdir(home, { recursive: true });
  await mkdir(userData, { recursive: true });
  // Chromium removes DevToolsActivePort only on a clean exit, and the
  // upgrade-lifecycle check reuses one user-data directory across two app
  // versions with a SIGKILL between them — so a file found here can belong to
  // the previous instance, pointing the poll at a port nothing listens on
  // anymore. Deleting it first means whatever appears was written by this
  // child. This is what the first run of the port-file diagnostics caught:
  // the poll read a bound-looking port and fetch failed for the full window.
  await rm(join(userData, 'DevToolsActivePort'), { force: true });
  await mkdir(userEnv.APPDATA, { recursive: true });
  await mkdir(userEnv.LOCALAPPDATA, { recursive: true });
  const child = spawn(
    executable,
    // Port 0: Chromium binds a free port itself and records it in the
    // user-data directory's DevToolsActivePort file, which is where the poll
    // reads it back — no reserve-then-release window for another process on
    // the runner to take the number first.
    ['--remote-debugging-port=0', `--user-data-dir=${userData}`, '--enable-logging=stderr'],
    {
      cwd: workingDirectory,
      env: {
        ...process.env,
        MAKA_SKIP_SHELL_ENV: '1',
        ...userEnv,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });

  try {
    const target = await findRendererTarget(userData, child);
    const deadline = Date.now() + RENDERER_READY_TIMEOUT_MS;
    let rendererState;
    while (Date.now() < deadline) {
      rendererState = await evaluateRenderer(target.webSocketDebuggerUrl);
      if (isPackagedRendererUsable(rendererState)) {
        return;
      }
      if (child.exitCode !== null) {
        throw new Error('Packaged Maka exited before React mounted.');
      }
      await delay(250);
    }
    throw new Error(`Packaged renderer did not become usable: ${JSON.stringify(rendererState)}`);
  } catch (error) {
    throw new Error(`${error.message}${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
  } finally {
    await stopChild(child);
  }
}

export async function assertPackagedResources(
  resourcesPath,
  {
    requirePath,
    forbidPath = assertMissing,
    requireWindowsSandbox = process.platform === 'win32',
    // The upgrade-lifecycle check runs this against a previously released
    // build, which predates the disclaimer being packaged. Requiring it there
    // would fail a release that was correct when it shipped.
    requireDisclaimer = true,
  } = {},
) {
  const required = [
    'app.asar',
    'bundled-tools.json',
    'bundled-git.json',
    join('licenses', 'git', 'LICENSE.txt'),
    join('licenses', 'git', 'SOURCE_OFFER.txt'),
    join('workers', 'filesystem-worker.js'),
    join('licenses', 'maka', 'LICENSE'),
    join('licenses', 'maka', 'NOTICE'),
    ...(requireDisclaimer ? [join('licenses', 'maka', 'DISCLAIMER-WIP')] : []),
    join('licenses', 'dugite', 'LICENSE'),
    join('licenses', 'git', 'NOTICE.txt'),
    join('licenses', 'electron', 'LICENSE'),
    join('licenses', 'electron', 'LICENSES.chromium.html'),
    join('licenses', 'npm', 'THIRD_PARTY_NOTICES.txt'),
    join('licenses', 'renderer', 'THIRD_PARTY_LICENSES.txt'),
    join('licenses', 'renderer', 'GEIST_LICENSE.txt'),
    join('licenses', 'renderer', 'GEIST_MONO_LICENSE.txt'),
    join('licenses', 'renderer', 'ANT_DESIGN_ICONS_LICENSE.txt'),
    join('licenses', 'renderer', 'SIMPLE_ICONS_LICENSE.md'),
    join('licenses', 'renderer', 'TDESIGN_ICONS_LICENSE.txt'),
    join('licenses', 'renderer', 'ALLOGO_LICENSE.txt'),
    join('licenses', 'renderer', 'SEMI_ICONS_LICENSE.txt'),
    join('licenses', 'renderer', 'MINGCUTE_APACHE_LICENSE.txt'),
    ...(requireWindowsSandbox
      ? [
          join('windows-sandbox', 'maka-windows-sandbox.exe'),
          join('licenses', 'cargo', 'THIRD_PARTY_NOTICES.txt'),
        ]
      : []),
  ];
  for (const path of required) {
    await requirePath(join(resourcesPath, path));
  }
  const forbidden = [
    join('tools', 'officecli'),
    join('licenses', 'officecli'),
    // cua-driver is gone from this repository, and these two forbids stay for the
    // same reason the officecli ones next to them do: `apps/desktop/resources/bin`
    // is gitignored, so a binary a developer prepared before this change is still
    // sitting in their tree and would be packaged without anything noticing.
    join('bin', 'cua-driver'),
    join('tools', 'cua-driver'),
    // maka-cu is built from source locally and is not signed, so it may not be in
    // a packaged build at all — an ad-hoc helper fails notarization for the whole
    // app, and `distributionReady` is false for exactly this reason.
    join('bin', 'maka-cu'),
    join('tools', 'maka-cu'),
  ];
  for (const path of forbidden) {
    await forbidPath(join(resourcesPath, path));
  }
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  const file = createReadStream(path);
  for await (const chunk of file) hash.update(chunk);
  return hash.digest('hex');
}
