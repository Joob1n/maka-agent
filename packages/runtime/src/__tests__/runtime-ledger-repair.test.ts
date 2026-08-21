import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { StoredMessage } from '@maka/core/session';
import {
  createSqliteAgentRunStore,
  createSqliteRuntimeStore,
  createSessionStore,
} from '@maka/storage';
import { buildRuntimeEventModelReplayPlan } from '../model-history.js';
import { buildPriorRuntimeContext } from '../prior-run-context.js';
import { backfillRuntimeEventsFromStoredMessages } from '../runtime-event-backfill.js';
import { RuntimeLedgerRepair } from '../runtime-ledger-repair.js';

test('repairs imported transcript turns into provider-neutral canonical history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-transcript-ledger-repair-'));
  const sessions = createSessionStore(root);
  const runs = createSqliteAgentRunStore(root);
  const runtimeEvents = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  let sequence = 0;
  const newId = () => `repair-${++sequence}`;

  try {
    const externalTs = Date.now() + 86_400_000;
    const messages: StoredMessage[] = [
      {
        type: 'user',
        id: 'z-user',
        turnId: 'turn-1',
        ts: externalTs,
        text: 'Fix the parser',
      },
      {
        type: 'assistant',
        id: 'a-assistant',
        turnId: 'turn-1',
        ts: externalTs,
        text: 'I found the issue.',
        thinking: { text: 'provider-specific reasoning' },
        modelId: 'external-model',
      },
      {
        type: 'tool_call',
        id: 'tool-1',
        turnId: 'turn-1',
        ts: externalTs,
        toolName: 'codex::exec',
        args: { command: 'pwd' },
      },
      {
        type: 'tool_result',
        id: 'result-1',
        turnId: 'turn-1',
        ts: externalTs,
        toolUseId: 'tool-1',
        isError: false,
        content: { kind: 'text', text: '/repo' },
      },
      {
        type: 'turn_state',
        id: 'state-1',
        turnId: 'turn-1',
        ts: externalTs,
        status: 'completed',
        partialOutputRetained: true,
      },
    ];
    const session = await sessions.createImportedSession(
      {
        cwd: '/repo',
        llmConnectionSlug: 'deepseek',
        model: 'deepseek-v4-flash',
        permissionMode: 'ask',
      },
      messages,
      { adapterId: 'test', sourceSessionId: 'source-session-1' },
    );
    assert.equal(session.transcriptLedgerVersion, 0);
    const repair = new RuntimeLedgerRepair({
      runStore: runs,
      runtimeEventStore: runtimeEvents,
      readMessages: (sessionId) => sessions.readMessages(sessionId),
      appendMessage: (sessionId, message) => sessions.appendMessage(sessionId, message),
      appendTurnState: async () => undefined,
      newId,
      now: () => 100,
    });

    await repair.materializeTranscriptLedger(session);
    await repair.materializeTranscriptLedger(session);

    const [importedRun] = await runs.listSessionRuns(session.id);
    assert.ok(importedRun);
    assert.equal(importedRun.turnId, 'turn-1');
    assert.equal(importedRun.status, 'completed');
    assert.ok(importedRun.createdAt < session.createdAt);

    const importedEvents = await runtimeEvents.readRuntimeEvents(session.id, importedRun.runId);
    assert.deepEqual(
      buildRuntimeEventModelReplayPlan(importedEvents).items.map((item) =>
        item.kind === 'text' ? [item.role, item.content] : item.kind,
      ),
      [
        ['user', 'Fix the parser'],
        ['assistant', 'I found the issue.'],
      ],
    );

    const continuedMessages: StoredMessage[] = [
      {
        type: 'user',
        id: 'continued-user',
        turnId: 'turn-2',
        ts: session.createdAt + 1,
        text: 'What should I do next?',
      },
      {
        type: 'assistant',
        id: 'continued-assistant',
        turnId: 'turn-2',
        ts: session.createdAt + 2,
        text: 'Add a regression test.',
        modelId: 'continued-model',
      },
      {
        type: 'turn_state',
        id: 'continued-state',
        turnId: 'turn-2',
        ts: session.createdAt + 3,
        status: 'completed',
        partialOutputRetained: true,
      },
    ];
    const continuedRun = await runs.createRun({
      ...importedRun,
      runId: 'continued-run',
      invocationId: 'continued-invocation',
      turnId: 'turn-2',
      status: 'completed',
      createdAt: session.createdAt + 1,
      updatedAt: session.createdAt + 3,
      completedAt: session.createdAt + 3,
    });
    for (const event of backfillRuntimeEventsFromStoredMessages({
      run: continuedRun,
      messages: continuedMessages,
      newId,
      now: () => session.createdAt + 3,
    }).events) {
      await runtimeEvents.appendRuntimeEvent(session.id, continuedRun.runId, event);
    }

    const currentRunId = 'current-run';
    await runs.createRun({
      ...continuedRun,
      runId: currentRunId,
      invocationId: 'current-invocation',
      turnId: 'turn-3',
      status: 'running',
      createdAt: session.createdAt + 4,
      updatedAt: session.createdAt + 4,
      completedAt: undefined,
    });
    const prior = await buildPriorRuntimeContext({
      sessionId: session.id,
      currentRunId,
      currentTurnId: 'turn-3',
      linkedChildSession: false,
      runStore: runs,
      runtimeEventStore: runtimeEvents,
      runStoreAvailable: true,
      runtimeEventStoreAvailable: true,
      readMessages: () => sessions.readMessages(session.id),
    });
    assert.deepEqual(
      buildRuntimeEventModelReplayPlan(prior?.events ?? []).items.map((item) =>
        item.kind === 'text' ? [item.role, item.content] : item.kind,
      ),
      [
        ['user', 'Fix the parser'],
        ['assistant', 'I found the issue.'],
        ['user', 'What should I do next?'],
        ['assistant', 'Add a regression test.'],
      ],
    );
  } finally {
    runtimeEvents.close();
    runs.close?.();
    await sessions.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The Claude Code adapter records a turn the transcript stops inside as
 * `aborted` with `abortSource: 'external_session_snapshot'`, rather than
 * emitting no terminal state at all.
 *
 * The difference is only visible here. An adapter-level assertion can show
 * which `turn_state` was emitted, but not what the Ledger does with it — and
 * what it does is the whole reason the choice matters: an uncorroborated
 * terminal is refused and the repair path writes `failed`, so a transcript
 * that was merely cut short would import as internal corruption.
 */
test('an imported snapshot cutoff survives materialization as aborted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-snapshot-cutoff-'));
  const sessions = createSessionStore(root);
  const runs = createSqliteAgentRunStore(root);
  const runtimeEvents = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  let sequence = 0;
  const newId = () => `cutoff-${++sequence}`;

  try {
    const ts = Date.now() + 86_400_000;
    const cutoffMessages: StoredMessage[] = [
      { type: 'user', id: 'c-user', turnId: 'turn-cut', ts, text: 'read the file' },
      {
        type: 'assistant',
        id: 'c-assistant',
        turnId: 'turn-cut',
        ts,
        text: 'Reading it now.',
        contentOrder: ['text'],
        modelId: 'claude-opus-5',
      },
      {
        type: 'tool_call',
        id: 'c-tool',
        turnId: 'turn-cut',
        ts,
        toolName: 'Read',
        args: { path: '/repo/a.ts' },
      },
      // No tool_result: the transcript ends between the call and its answer.
      {
        type: 'turn_state',
        id: 'c-state',
        turnId: 'turn-cut',
        ts,
        status: 'aborted',
        abortedAt: ts,
        abortSource: 'external_session_snapshot',
        partialOutputRetained: true,
      },
    ];
    const session = await sessions.createImportedSession(
      {
        cwd: '/repo',
        llmConnectionSlug: 'anthropic',
        model: 'claude-opus-5',
        permissionMode: 'ask',
      },
      cutoffMessages,
      { adapterId: 'claude-code', sourceSessionId: 'cut-1' },
    );
    const repair = new RuntimeLedgerRepair({
      runStore: runs,
      runtimeEventStore: runtimeEvents,
      readMessages: (sessionId) => sessions.readMessages(sessionId),
      appendMessage: (sessionId, message) => sessions.appendMessage(sessionId, message),
      appendTurnState: async () => undefined,
      newId,
      now: () => 100,
    });

    await repair.materializeTranscriptLedger(session);

    const [run] = await runs.listSessionRuns(session.id);
    assert.ok(run);
    // `cancelled`, not `failed`: the Ledger accepted the recorded abort. Before
    // the adapter emitted one, this same transcript materialized as
    // `failed / missing_terminal_event`.
    assert.equal(run.status, 'cancelled');
    assert.notEqual(run.failureClass, 'missing_terminal_event');
  } finally {
    await runtimeEvents.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('an imported turn with no terminal state is repaired to failed', async () => {
  // The behaviour the adapter now avoids, pinned so the reason for emitting a
  // cutoff cannot quietly stop being true.
  const root = await mkdtemp(join(tmpdir(), 'maka-missing-terminal-'));
  const sessions = createSessionStore(root);
  const runs = createSqliteAgentRunStore(root);
  const runtimeEvents = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
  let sequence = 0;
  const newId = () => `missing-${++sequence}`;

  try {
    const ts = Date.now() + 86_400_000;
    const session = await sessions.createImportedSession(
      {
        cwd: '/repo',
        llmConnectionSlug: 'anthropic',
        model: 'claude-opus-5',
        permissionMode: 'ask',
      },
      [
        { type: 'user', id: 'm-user', turnId: 'turn-missing', ts, text: 'read the file' },
        {
          type: 'assistant',
          id: 'm-assistant',
          turnId: 'turn-missing',
          ts,
          text: 'Reading it now.',
          contentOrder: ['text'],
          modelId: 'claude-opus-5',
        },
      ],
      { adapterId: 'claude-code', sourceSessionId: 'missing-1' },
    );
    const repair = new RuntimeLedgerRepair({
      runStore: runs,
      runtimeEventStore: runtimeEvents,
      readMessages: (sessionId) => sessions.readMessages(sessionId),
      appendMessage: (sessionId, message) => sessions.appendMessage(sessionId, message),
      appendTurnState: async () => undefined,
      newId,
      now: () => 100,
    });

    await repair.materializeTranscriptLedger(session);

    const [run] = await runs.listSessionRuns(session.id);
    assert.ok(run);
    assert.equal(run.status, 'failed');
    assert.equal(run.failureClass, 'missing_terminal_event');
  } finally {
    await runtimeEvents.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
