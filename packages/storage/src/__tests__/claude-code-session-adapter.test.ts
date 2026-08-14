import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeStoredMessage, deriveTurnRecords } from '@maka/core/session';
import {
  ClaudeCodeSessionAdapter,
  convertClaudeCodeTranscript,
} from '../claude-code-session-adapter.js';
import { createExternalSessionAdapterRegistry } from '../external-session-adapters.js';

const CURRENT_FIXTURE = fixturePath('claude-code-transcript-v2.1.jsonl');
const LEGACY_FIXTURE = fixturePath('claude-code-transcript-v2.0.jsonl');
const TURN_1 = 'claude-code-claude-session-1-turn-3';
const TURN_2 = 'claude-code-claude-session-1-turn-15';

describe('ClaudeCodeSessionAdapter', () => {
  test('is registered in the default adapter registry', () => {
    const registry = createExternalSessionAdapterRegistry();
    assert.equal(registry.require('claude-code').id, 'claude-code');
    assert.deepEqual(
      registry.list().map((adapter) => adapter.id),
      ['codex', 'claude-code'],
    );
  });

  test('lists root transcripts and reads project identity from record cwd', async () => {
    await withClaudeHome(async (claudeHome) => {
      await seedFixtureTranscript(claudeHome, '-workspace-project', 'claude-session-1');
      await seedTranscript(claudeHome, '-workspace-other', 'claude-session-2', [
        {
          type: 'user',
          uuid: 'other-1',
          cwd: '/workspace/other',
          isSidechain: false,
          timestamp: '2026-08-08T01:00:00.000Z',
          message: { role: 'user', content: 'Another project' },
        },
      ]);

      const adapter = new ClaudeCodeSessionAdapter({ claudeHome });
      assert.equal(await adapter.detect(), true);

      const sessions = await adapter.listSessions();
      assert.deepEqual(
        sessions.map((session) => session.id),
        ['claude-session-2', 'claude-session-1'],
      );
      assert.deepEqual(sessions.at(-1), {
        id: 'claude-session-1',
        name: 'Fix the tail-line parser bug',
        cwd: '/workspace/project',
        createdAt: Date.parse('2026-08-08T00:00:02.000Z'),
        updatedAt: Date.parse('2026-08-08T00:00:13.000Z'),
      });

      // The directory name mangles path separators, so only the records' own
      // cwd can answer a project-scoped query.
      assert.deepEqual(
        (await adapter.listSessions({ cwd: '/workspace/project/' })).map((s) => s.id),
        ['claude-session-1'],
      );
    });
  });

  test('dates a conversation by its newest record, not by the head window', async () => {
    await withClaudeHome(async (claudeHome) => {
      // The head probe stops as soon as `cwd` is known, so anything past it is
      // only visible through the tail window. A long conversation must not be
      // dated — and therefore sorted — by its opening records.
      await seedTranscript(claudeHome, '-workspace-project', 'claude-long', [
        {
          type: 'user',
          uuid: 'long-1',
          cwd: '/workspace/project',
          isSidechain: false,
          timestamp: '2026-08-08T00:00:00.000Z',
          message: { role: 'user', content: 'Start' },
        },
        {
          type: 'assistant',
          uuid: 'long-2',
          cwd: '/workspace/project',
          timestamp: '2026-08-08T00:00:01.000Z',
          message: {
            id: 'msg_long',
            role: 'assistant',
            model: 'claude-opus-5',
            content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }],
          },
        },
        {
          type: 'user',
          uuid: 'long-3',
          cwd: '/workspace/project',
          isSidechain: false,
          timestamp: '2026-08-09T12:00:00.000Z',
          message: { role: 'user', content: 'Much later' },
        },
      ]);

      const [summary] = await new ClaudeCodeSessionAdapter({ claudeHome }).listSessions();
      assert.equal(summary?.updatedAt, Date.parse('2026-08-09T12:00:00.000Z'));
      assert.equal(summary?.createdAt, Date.parse('2026-08-08T00:00:00.000Z'));
    });
  });

  test('excludes sub-agent transcripts, which are whole sidechain files', async () => {
    await withClaudeHome(async (claudeHome) => {
      await seedFixtureTranscript(claudeHome, '-workspace-project', 'claude-session-1');
      await seedTranscript(claudeHome, '-workspace-project', 'agent-9f2c1ab', [
        {
          type: 'user',
          uuid: 'sub-1',
          cwd: '/workspace/project',
          isSidechain: true,
          timestamp: '2026-08-08T00:30:00.000Z',
          message: { role: 'user', content: 'Explore the parser' },
        },
      ]);

      const adapter = new ClaudeCodeSessionAdapter({ claudeHome });
      assert.deepEqual(
        (await adapter.listSessions()).map((session) => session.id),
        ['claude-session-1'],
      );
      await assert.rejects(
        () => adapter.readSession('agent-9f2c1ab'),
        /Claude Code Session not found/,
      );
    });
  });

  test('folds the records of one model response into a single assistant step', async () => {
    await withClaudeHome(async (claudeHome) => {
      await seedFixtureTranscript(claudeHome, '-workspace-project', 'claude-session-1');
      const adapter = new ClaudeCodeSessionAdapter({ claudeHome });

      const session = await adapter.readSession('claude-session-1');
      assert.deepEqual(session.metadata, {
        name: 'Fix the tail-line parser bug',
        cwd: '/workspace/project',
      });
      for (const message of session.messages) {
        assert.deepEqual(decodeStoredMessage(message), message);
      }

      // Claude Code writes thinking, text, and tool_use of one response as three
      // records sharing message.id. They must import as one assistant step.
      assert.deepEqual(session.messages[1], {
        type: 'assistant',
        id: 'msg_step1',
        turnId: TURN_1,
        ts: Date.parse('2026-08-08T00:00:03.000Z'),
        text: 'Let me read the parser first.',
        thinking: { text: 'The parser drops the tail line.', signature: 'sig-1' },
        contentOrder: ['thinking', 'text', 'tools'],
        modelId: 'claude-opus-5',
      });
      assert.deepEqual(session.messages[2], {
        type: 'tool_call',
        id: 'toolu_read',
        turnId: TURN_1,
        ts: Date.parse('2026-08-08T00:00:05.000Z'),
        toolName: 'Read',
        args: { file_path: '/workspace/project/parser.ts' },
        stepId: 'msg_step1',
      });

      // A response that is only a tool call has no assistant text to show, so
      // it contributes the call alone and the call has no step to point at.
      const editCall = session.messages.find(
        (message) => message.type === 'tool_call' && message.id === 'toolu_edit',
      );
      assert.deepEqual(editCall, {
        type: 'tool_call',
        id: 'toolu_edit',
        turnId: TURN_1,
        ts: Date.parse('2026-08-08T00:00:07.000Z'),
        toolName: 'Edit',
        args: { file_path: '/workspace/project/parser.ts', old_string: 'a', new_string: 'b' },
      });
      assert.equal(
        session.messages.some(
          (message) => message.type === 'assistant' && message.id === 'msg_step2',
        ),
        false,
      );
    });
  });

  test('converts tool results without attributing them to the user', async () => {
    const text = await readFile(CURRENT_FIXTURE, 'utf8');
    const session = convertClaudeCodeTranscript(text, 'claude-session-1', '', '/fallback');

    // The classic failure: Claude returns tool output as `type: 'user'`. Every
    // user-typed message in this transcript is accounted for, so any extra user
    // row would be misattributed tool output.
    assert.deepEqual(
      session.messages
        .filter((message) => message.type === 'user')
        .map((message) => ({ id: message.id, text: message.text })),
      [
        { id: 'u-1', text: 'Fix the parser' },
        { id: 'u-6', text: '[Image]' },
      ],
    );

    assert.deepEqual(
      session.messages.filter((message) => message.type === 'tool_result'),
      [
        {
          type: 'tool_result',
          id: 'u-2',
          turnId: TURN_1,
          ts: Date.parse('2026-08-08T00:00:06.000Z'),
          toolUseId: 'toolu_read',
          isError: false,
          content: { kind: 'text', text: '1 export function parse() {}' },
        },
        {
          type: 'tool_result',
          id: 'u-3',
          turnId: TURN_1,
          ts: Date.parse('2026-08-08T00:00:08.000Z'),
          toolUseId: 'toolu_edit',
          isError: true,
          content: { kind: 'text', text: 'String to replace not found in file.' },
        },
      ],
    );
  });

  test('opens a Turn only on user-typed messages', async () => {
    const text = await readFile(CURRENT_FIXTURE, 'utf8');
    const session = convertClaudeCodeTranscript(text, 'claude-session-1', '', '/fallback');

    // Two typed messages, so exactly two Turns: tool results and injected
    // context must not start one.
    assert.deepEqual(
      [...new Set(session.messages.flatMap((m) => (m.turnId === undefined ? [] : [m.turnId])))],
      [TURN_1, TURN_2],
    );
    const lastAssistant = session.messages.filter((m) => m.type === 'assistant').at(-1);
    assert.deepEqual(lastAssistant, {
      type: 'assistant',
      id: 'msg_step3',
      turnId: TURN_2,
      ts: Date.parse('2026-08-08T00:00:13.000Z'),
      text: 'That screenshot shows the tail bug.',
      contentOrder: ['text'],
      modelId: 'claude-opus-5',
    });
  });

  test('routes injected context, compaction, and provider errors away from the transcript', async () => {
    const text = await readFile(CURRENT_FIXTURE, 'utf8');
    const session = convertClaudeCodeTranscript(text, 'claude-session-1', '', '/fallback');

    // isMeta is Claude Code's own injected context and is dropped entirely.
    assert.equal(
      session.messages.some((message) => message.id === 'u-4'),
      false,
    );
    assert.deepEqual(
      session.messages.filter((message) => message.type === 'system_note'),
      [
        {
          type: 'system_note',
          id: 'a-5',
          turnId: TURN_1,
          ts: Date.parse('2026-08-08T00:00:10.000Z'),
          kind: 'error',
          data: { text: 'API Error: 500 upstream failure' },
        },
        {
          type: 'system_note',
          id: 'u-5',
          turnId: TURN_1,
          ts: Date.parse('2026-08-08T00:00:11.000Z'),
          kind: 'context_compacted',
        },
      ],
    );
  });

  test('records a terminal turn_state only for a fact the transcript carries', async () => {
    const text = await readFile(CURRENT_FIXTURE, 'utf8');
    const session = convertClaudeCodeTranscript(text, 'claude-session-1', '', '/fallback');
    const turns = deriveTurnRecords(session.messages);

    // The provider error is written down, so that Turn's terminal state is
    // `recorded`. Nothing in the transcript says the second Turn ended — only
    // that another one began — so its status is derived and labelled as such.
    assert.deepEqual(
      turns.map((turn) => turn.statusSource),
      ['recorded', 'inferred'],
    );
    assert.deepEqual(
      turns.map((turn) => turn.status),
      ['failed', 'completed'],
    );
    assert.equal(turns[0]?.errorClass, 'claude_code_error');
  });

  test('does not report an unfinished Turn as a completed one', () => {
    const line = (record: unknown): string => JSON.stringify(record);
    // A killed process, a crash, or a Session still running: the last prompt has
    // no answer after it. Importing this as a `recorded` completed Turn told
    // Runtime that a conversation which never finished had finished normally.
    const text = [
      line({
        type: 'user',
        uuid: 'k-1',
        cwd: '/workspace/project',
        timestamp: '2026-08-08T00:00:01.000Z',
        message: { role: 'user', content: 'Start the migration' },
      }),
      line({
        type: 'assistant',
        uuid: 'k-2',
        timestamp: '2026-08-08T00:00:02.000Z',
        message: {
          id: 'msg_k1',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'On it.' }],
        },
      }),
      line({
        type: 'user',
        uuid: 'k-3',
        cwd: '/workspace/project',
        timestamp: '2026-08-08T00:00:03.000Z',
        message: { role: 'user', content: 'Now do the second half' },
      }),
    ].join('\n');

    const session = convertClaudeCodeTranscript(text, 'claude-killed', '', '/fallback');
    assert.equal(
      session.messages.some((message) => message.type === 'turn_state'),
      false,
    );
    const turns = deriveTurnRecords(session.messages);
    assert.deepEqual(
      turns.map((turn) => turn.statusSource),
      ['inferred', 'inferred'],
    );
  });

  test('reads a declined tool call as an abort rather than an ordinary result', () => {
    const line = (record: unknown): string => JSON.stringify(record);
    const text = [
      line({
        type: 'user',
        uuid: 'r-1',
        cwd: '/workspace/project',
        timestamp: '2026-08-08T00:00:01.000Z',
        message: { role: 'user', content: 'Delete the build directory' },
      }),
      line({
        type: 'assistant',
        uuid: 'r-2',
        timestamp: '2026-08-08T00:00:02.000Z',
        message: {
          id: 'msg_r1',
          model: 'claude-opus-5',
          content: [
            { type: 'tool_use', id: 'toolu_r1', name: 'Bash', input: { command: 'rm -rf build' } },
          ],
        },
      }),
      line({
        type: 'user',
        uuid: 'r-3',
        timestamp: '2026-08-08T00:00:03.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_r1',
              is_error: true,
              content:
                "The user doesn't want to proceed with this tool use. The tool use was rejected.",
            },
          ],
        },
      }),
    ].join('\n');

    const session = convertClaudeCodeTranscript(text, 'claude-rejected', '', '/fallback');
    // An ordinary tool failure is also an errored result, so the abort has to
    // come from the rejection sentence, not from `is_error`.
    assert.ok(
      session.messages.some(
        (message) => message.type === 'system_note' && message.kind === 'abort',
      ),
    );
    assert.equal(deriveTurnRecords(session.messages)[0]?.status, 'aborted');
  });

  test('keeps an ordinary errored tool result out of the abort path', () => {
    const line = (record: unknown): string => JSON.stringify(record);
    const text = [
      line({
        type: 'user',
        uuid: 'e-1',
        cwd: '/workspace/project',
        timestamp: '2026-08-08T00:00:01.000Z',
        message: { role: 'user', content: 'Read the config' },
      }),
      line({
        type: 'assistant',
        uuid: 'e-2',
        timestamp: '2026-08-08T00:00:02.000Z',
        message: {
          id: 'msg_e1',
          model: 'claude-opus-5',
          content: [
            { type: 'tool_use', id: 'toolu_e1', name: 'Read', input: { path: '/missing' } },
          ],
        },
      }),
      line({
        type: 'user',
        uuid: 'e-3',
        timestamp: '2026-08-08T00:00:03.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_e1', is_error: true, content: 'ENOENT' },
          ],
        },
      }),
    ].join('\n');

    const session = convertClaudeCodeTranscript(text, 'claude-tool-error', '', '/fallback');
    assert.equal(
      session.messages.some(
        (message) => message.type === 'system_note' && message.kind === 'abort',
      ),
      false,
    );
  });

  test('drops a tool result that arrives before any Turn exists', () => {
    const line = (record: unknown): string => JSON.stringify(record);
    // Two real transcripts open with a result whose `tool_use_id` points into a
    // conversation that is not in this file. Opening a Turn to hold it produced
    // a row with no prompt and no answer.
    const text = [
      line({
        type: 'user',
        uuid: 'o-1',
        timestamp: '2026-08-08T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_elsewhere', content: 'ok' }],
        },
      }),
      line({
        type: 'user',
        uuid: 'o-2',
        cwd: '/workspace/project',
        timestamp: '2026-08-08T00:00:02.000Z',
        message: { role: 'user', content: 'Now start properly' },
      }),
    ].join('\n');

    const session = convertClaudeCodeTranscript(text, 'claude-orphan', '', '/fallback');
    assert.deepEqual(
      session.messages.map((message) => message.type),
      ['user'],
    );
  });

  test('treats an interrupt notice as the end of its Turn, not a new one', () => {
    const line = (record: unknown): string => JSON.stringify(record);
    const text = [
      line({
        type: 'user',
        uuid: 'i-1',
        cwd: '/workspace/project',
        timestamp: '2026-08-08T00:00:01.000Z',
        message: { role: 'user', content: 'Run the long job' },
      }),
      line({
        type: 'assistant',
        uuid: 'i-2',
        cwd: '/workspace/project',
        timestamp: '2026-08-08T00:00:02.000Z',
        message: {
          id: 'msg_i',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'Starting.' }],
        },
      }),
      line({
        type: 'user',
        uuid: 'i-3',
        cwd: '/workspace/project',
        timestamp: '2026-08-08T00:00:03.000Z',
        message: { role: 'user', content: '[Request interrupted by user]' },
      }),
    ].join('\n');

    const session = convertClaudeCodeTranscript(
      text,
      'claude-session-1',
      'Interrupted',
      '/fallback',
    );
    const turns = deriveTurnRecords(session.messages);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.status, 'aborted');
    // The notice is Claude Code's own marker, so it never becomes a user message.
    assert.deepEqual(
      session.messages.filter((message) => message.type === 'user').map((message) => message.text),
      ['Run the long job'],
    );
  });

  test('converts a Claude Code 2.0 transcript', async () => {
    // 2.0 predates the `ai-title` and `last-prompt` records and never emits
    // thinking blocks, and it puts text and tool_use in ONE record where 2.1
    // splits them. Each of those is a branch the 2.1 fixture never reaches.
    const text = await readFile(LEGACY_FIXTURE, 'utf8');
    const session = convertClaudeCodeTranscript(text, 'claude-v20', '', '/fallback');

    // No title record, so the name falls back to the opening request.
    assert.equal(session.metadata.name, 'Count the rows in data.csv');
    assert.equal(session.metadata.cwd, '/workspace/legacy');

    const turns = deriveTurnRecords(session.messages);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.status, 'completed');
    // Nothing in a 2.0 transcript records that the Turn ended either.
    assert.equal(turns[0]?.statusSource, 'inferred');

    // text + tool_use arriving in one record still yields one assistant step
    // plus a call that points back at it.
    assert.deepEqual(
      session.messages.map((message) => message.type),
      ['user', 'assistant', 'tool_call', 'tool_result', 'assistant'],
    );
    const assistant = session.messages[1];
    assert.equal(assistant?.type === 'assistant' && assistant.text, 'Let me count them.');
    assert.deepEqual(assistant?.type === 'assistant' ? assistant.contentOrder : undefined, [
      'text',
      'tools',
    ]);
    const call = session.messages[2];
    assert.equal(call?.type === 'tool_call' && call.stepId, 'msg_v20_step1');

    for (const message of session.messages) {
      assert.deepEqual(decodeStoredMessage(JSON.parse(JSON.stringify(message))), message);
    }
  });

  test('skips malformed lines instead of failing the import', async () => {
    const text = await readFile(CURRENT_FIXTURE, 'utf8');
    assert.match(text, /^\{ this line is not valid json$/m);
    const session = convertClaudeCodeTranscript(text, 'claude-session-1', '', '/fallback');
    assert.equal(session.messages.length, 11);
  });

  test('keeps message ids unique when a transcript repeats a record uuid', () => {
    const line = (record: unknown): string => JSON.stringify(record);
    const text = [
      line({
        type: 'user',
        uuid: 'dup',
        cwd: '/workspace/project',
        timestamp: '2026-08-08T00:00:01.000Z',
        message: { role: 'user', content: 'first' },
      }),
      line({
        type: 'user',
        uuid: 'dup',
        cwd: '/workspace/project',
        timestamp: '2026-08-08T00:00:02.000Z',
        message: { role: 'user', content: 'second' },
      }),
    ].join('\n');

    const session = convertClaudeCodeTranscript(text, 'claude-session-1', 'Repeat', '/fallback');
    assert.deepEqual(
      session.messages.filter((message) => message.type === 'user').map((message) => message.id),
      ['dup', 'dup-2'],
    );
  });

  test('never reads outside the projects root and rejects unsafe ids', async () => {
    await withClaudeHome(async (claudeHome) => {
      await seedFixtureTranscript(claudeHome, '-workspace-project', 'claude-session-1');
      const adapter = new ClaudeCodeSessionAdapter({ claudeHome });

      await assert.rejects(
        () => adapter.readSession('../../../etc/passwd'),
        /Invalid Claude Code Session id/,
      );
      await assert.rejects(() => adapter.readSession('missing'), /Claude Code Session not found/);
    });
  });

  test('refuses a transcript that resolves outside the projects root', async () => {
    await withClaudeHome(async (claudeHome) => {
      await seedFixtureTranscript(claudeHome, '-workspace-project', 'claude-session-1');
      // A name inside the root is not enough: the id check passes and the walk
      // finds it, so only resolving the real path keeps the read inside.
      // Same basename as the link, so the id and basename checks both pass.
      // Two layers refuse this: the walk skips symlinks, and `realpath` +
      // root-prefix refuses one that got past it. The assertion fails only when
      // both are gone — verified by mutating each in turn.
      const outside = join(claudeHome, 'escaped-session.jsonl');
      await writeFile(
        outside,
        `${JSON.stringify({
          type: 'user',
          uuid: 'x-1',
          cwd: '/elsewhere',
          isSidechain: false,
          timestamp: '2026-08-08T00:00:00.000Z',
          message: { role: 'user', content: 'Not ours to read' },
        })}\n`,
        'utf8',
      );
      await symlink(
        outside,
        join(claudeHome, 'projects', '-workspace-project', 'escaped-session.jsonl'),
      );

      const adapter = new ClaudeCodeSessionAdapter({ claudeHome });
      assert.deepEqual(
        (await adapter.listSessions()).map((session) => session.id),
        ['claude-session-1'],
      );
      await assert.rejects(
        () => adapter.readSession('escaped-session'),
        /Claude Code Session not found/,
      );
    });
  });

  test('grows the head probe when the opening window carries no cwd', async () => {
    await withClaudeHome(async (claudeHome) => {
      // `cwd` past the 256KB probe is only reachable by the second, larger
      // window. Without the growth step the Session lists with no project and
      // drops out of every cwd-scoped query.
      await seedTranscript(claudeHome, '-workspace-project', 'claude-late-cwd', [
        {
          type: 'assistant',
          uuid: 'late-1',
          timestamp: '2026-08-08T00:00:00.000Z',
          message: {
            id: 'msg_late',
            role: 'assistant',
            model: 'claude-opus-5',
            content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }],
          },
        },
        {
          type: 'user',
          uuid: 'late-2',
          cwd: '/workspace/project',
          isSidechain: false,
          timestamp: '2026-08-08T00:00:01.000Z',
          message: { role: 'user', content: 'Where am I?' },
        },
      ]);

      const [summary] = await new ClaudeCodeSessionAdapter({ claudeHome }).listSessions();
      assert.equal(summary?.cwd, '/workspace/project');
    });
  });

  test('leaves the external store byte-identical', async () => {
    await withClaudeHome(async (claudeHome) => {
      const path = await seedFixtureTranscript(
        claudeHome,
        '-workspace-project',
        'claude-session-1',
      );
      const before = await readFile(path);
      const beforeStat = await stat(path);

      const adapter = new ClaudeCodeSessionAdapter({ claudeHome });
      await adapter.listSessions();
      await adapter.readSession('claude-session-1');

      assert.deepEqual(await readFile(path), before);
      assert.equal((await stat(path)).mtimeMs, beforeStat.mtimeMs);
    });
  });

  test('refuses a transcript larger than the configured bound', async () => {
    await withClaudeHome(async (claudeHome) => {
      await seedFixtureTranscript(claudeHome, '-workspace-project', 'claude-session-1');
      const adapter = new ClaudeCodeSessionAdapter({ claudeHome, maxTranscriptBytes: 64 });
      await assert.rejects(
        () => adapter.readSession('claude-session-1'),
        /Claude Code transcript exceeds 64 bytes/,
      );
      // And it is not offered by the catalog, so a picker cannot hand the user
      // a conversation whose import is guaranteed to fail.
      assert.deepEqual(await adapter.listSessions(), []);
    });
  });

  test('is not detected when Claude Code reads are switched off', async () => {
    await withClaudeHome(async (claudeHome) => {
      await seedFixtureTranscript(claudeHome, '-workspace-project', 'claude-session-1');
      assert.equal(
        await new ClaudeCodeSessionAdapter({
          claudeHome,
          env: { MAKA_IMPORT_CLAUDE_CODE: '0' },
        }).detect(),
        false,
      );
      assert.equal(await new ClaudeCodeSessionAdapter({ claudeHome, env: {} }).detect(), true);
    });
  });
});

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../src/__tests__/fixtures/${name}`, import.meta.url));
}

async function withClaudeHome(run: (claudeHome: string) => Promise<void>): Promise<void> {
  const claudeHome = await mkdtemp(join(tmpdir(), 'maka-claude-adapter-'));
  try {
    await run(claudeHome);
  } finally {
    await rm(claudeHome, { recursive: true, force: true });
  }
}

async function seedFixtureTranscript(
  claudeHome: string,
  project: string,
  sessionId: string,
): Promise<string> {
  const directory = join(claudeHome, 'projects', project);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${sessionId}.jsonl`);
  await writeFile(path, await readFile(CURRENT_FIXTURE, 'utf8'), 'utf8');
  return path;
}

async function seedTranscript(
  claudeHome: string,
  project: string,
  sessionId: string,
  records: readonly unknown[],
): Promise<string> {
  const directory = join(claudeHome, 'projects', project);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${sessionId}.jsonl`);
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return path;
}
