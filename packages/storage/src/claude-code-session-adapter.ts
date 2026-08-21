// Claude Code transcripts as Maka Sessions.
//
// Transcripts live at `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, one
// JSON object per line, discriminated by `type`. The parsing primitives are
// shared with the CLI's foreign-session handoff (`@maka/core/foreign-session`)
// rather than reimplemented: a scanner and an importer that disagreed about
// "what did the user actually say" would be a real defect, not a cosmetic one.
//
// The directory name cannot answer which session belongs to which project —
// it encodes the cwd by replacing separators, so `-Users-a-b` is ambiguous
// between `/Users/a/b` and `/Users/a-b`. Every record carries its own `cwd`,
// and that is what a project-scoped query reads.
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  claudeAssistantText,
  claudeUserAuthoredText,
  isSyntheticClaudeUserText,
  pickClaudeTitle,
  sanitizeForeignTitle,
} from '@maka/core/foreign-session';
import type {
  ExternalMakaSession,
  ExternalSessionAdapter,
  ExternalSessionQuery,
  ExternalSessionSummary,
} from '@maka/core/external-session';
import type { StoredMessage } from '@maka/core/session';

export const CLAUDE_CODE_SESSION_ADAPTER_ID = 'claude-code';

/** A transcript larger than this is not read. Bounded for the same reason the
 *  Codex rollout cap exists: a single hostile or runaway file must not be able
 *  to exhaust the Host's memory during an import the user asked for. */
export const CLAUDE_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;

/** Session ids are the transcript's filename stem, and reach the filesystem.
 *  A uuid is what Claude Code writes; anything else is refused rather than
 *  joined onto a path. */
const SESSION_ID_PATTERN = /^[0-9a-fA-F-]{1,128}$/u;

export interface ClaudeCodeSessionAdapterOptions {
  /** Overrides `~/.claude`. */
  claudeHome?: string;
  maxTranscriptBytes?: number;
}

type TranscriptRecord = Record<string, unknown>;

interface ParsedTranscript {
  readonly records: readonly TranscriptRecord[];
  readonly cwd: string;
  readonly title: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly isSidechain: boolean;
}

export class ClaudeCodeSessionAdapter implements ExternalSessionAdapter {
  readonly id = CLAUDE_CODE_SESSION_ADAPTER_ID;
  readonly #home: string;
  readonly #maxBytes: number;

  constructor(options: ClaudeCodeSessionAdapterOptions = {}) {
    this.#home = options.claudeHome ?? join(homedir(), '.claude');
    this.#maxBytes = options.maxTranscriptBytes ?? CLAUDE_TRANSCRIPT_MAX_BYTES;
  }

  async detect(): Promise<boolean> {
    return existsSync(this.#projectsRoot());
  }

  async listSessions(query?: ExternalSessionQuery): Promise<readonly ExternalSessionSummary[]> {
    const summaries: ExternalSessionSummary[] = [];
    for (const file of await this.#transcriptFiles()) {
      const parsed = await this.#parse(file.path, file.sessionId);
      if (!parsed) continue;
      // Sub-agent transcripts are whole files, never records interleaved into
      // a parent — so exclusion is per file. Importing one would present a
      // fragment of a conversation as a conversation.
      if (parsed.isSidechain) continue;
      if (query?.cwd !== undefined && parsed.cwd !== query.cwd) continue;
      summaries.push({
        id: file.sessionId,
        name: parsed.title || file.sessionId,
        cwd: parsed.cwd,
        ...(parsed.createdAt !== undefined ? { createdAt: parsed.createdAt } : {}),
        ...(parsed.updatedAt !== undefined ? { updatedAt: parsed.updatedAt } : {}),
      });
    }
    summaries.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    return summaries;
  }

  async readSession(sessionId: string): Promise<ExternalMakaSession> {
    assertSafeSessionId(sessionId);
    const file = (await this.#transcriptFiles()).find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (!file) throw new Error(`Claude Code transcript not found: ${sessionId}`);
    const parsed = await this.#parse(file.path, sessionId);
    if (!parsed) throw new Error(`Claude Code transcript could not be read: ${sessionId}`);
    if (parsed.isSidechain) {
      throw new Error(`Claude Code transcript is a sub-agent sidechain: ${sessionId}`);
    }
    return {
      sourceSessionId: sessionId,
      metadata: { name: parsed.title || sessionId, cwd: parsed.cwd },
      messages: convertTranscript(sessionId, parsed.records),
    };
  }

  #projectsRoot(): string {
    return join(this.#home, 'projects');
  }

  async #transcriptFiles(): Promise<ReadonlyArray<{ path: string; sessionId: string }>> {
    const root = this.#projectsRoot();
    let projects: string[];
    try {
      projects = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const files: Array<{ path: string; sessionId: string }> = [];
    for (const project of projects) {
      let entries: string[];
      try {
        entries = (await readdir(join(root, project), { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
          .map((entry) => entry.name);
      } catch {
        continue;
      }
      for (const name of entries) {
        const sessionId = name.slice(0, -'.jsonl'.length);
        if (!SESSION_ID_PATTERN.test(sessionId)) continue;
        const path = join(root, project, name);
        // The id reaches a path join, so the resolved file must still be under
        // the projects root — a crafted id must not read outside it.
        if (!resolve(path).startsWith(resolve(root))) continue;
        files.push({ path, sessionId });
      }
    }
    return files;
  }

  async #parse(path: string, sessionId: string): Promise<ParsedTranscript | undefined> {
    try {
      const info = await stat(path);
      if (info.size > this.#maxBytes) return undefined;
    } catch {
      return undefined;
    }

    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return undefined;
    }

    const records: TranscriptRecord[] = [];
    let cwd = '';
    let isSidechain = false;
    let createdAt: number | undefined;
    let updatedAt: number | undefined;
    const titles: {
      customTitle?: string;
      aiTitle?: string;
      summary?: string;
      lastPrompt?: string;
      firstUserMessage?: string;
    } = {};

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: unknown;
      try {
        record = JSON.parse(trimmed);
      } catch {
        // A torn final line is what an interrupted write leaves behind, and a
        // corrupt interior line is not worth failing an otherwise readable
        // transcript over. Skipping is what the scanner already does.
        continue;
      }
      if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
      const typed = record as TranscriptRecord;
      records.push(typed);

      if (typed.isSidechain === true) isSidechain = true;
      if (typeof typed.cwd === 'string' && typed.cwd && !cwd) cwd = typed.cwd;
      const ts = timestampMs(typed);
      if (ts !== undefined) {
        createdAt ??= ts;
        updatedAt = ts;
      }
      collectTitle(typed, titles);
      if (titles.firstUserMessage === undefined && typed.type === 'user') {
        const text = claudeUserAuthoredText(typed);
        if (text) titles.firstUserMessage = text;
      }
    }

    if (records.length === 0) return undefined;
    return {
      records,
      cwd,
      title: pickClaudeTitle(titles),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      isSidechain,
    };
  }
}

function assertSafeSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Claude Code session id is not a transcript name');
  }
}

function collectTitle(
  record: TranscriptRecord,
  titles: { customTitle?: string; aiTitle?: string; summary?: string; lastPrompt?: string },
): void {
  const take = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? sanitizeForeignTitle(value) : undefined;
  switch (record.type) {
    case 'ai-title':
      titles.aiTitle = take(record.aiTitle ?? record.title) ?? titles.aiTitle;
      return;
    case 'last-prompt':
      titles.lastPrompt = take(record.lastPrompt ?? record.prompt) ?? titles.lastPrompt;
      return;
    case 'summary':
      titles.summary = take(record.summary) ?? titles.summary;
      return;
    default:
      return;
  }
}

function timestampMs(record: TranscriptRecord): number | undefined {
  const value = record.timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export default ClaudeCodeSessionAdapter;

/* ------------------------------------------------------------------ *
 * Transcript -> StoredMessage[]
 * ------------------------------------------------------------------ */

/** `stop_reason` values that mean the model finished its turn rather than
 *  pausing for a tool. This is the recorded evidence a terminal `turn_state`
 *  needs: the Ledger refuses a reconstructed terminal that no record
 *  corroborates (`runtime-ledger-repair.ts`), and rightly so — a transcript
 *  that was killed mid-answer must not import as one that completed. */
const TERMINAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens']);

interface TurnAccumulator {
  turnId: string;
  lastTs: number;
  /** Set when a terminal `stop_reason` is seen; the turn ends `completed`. */
  terminalStop?: string;
  /** Set by `isApiErrorMessage`; the turn ends `failed`. */
  failed?: boolean;
  /** Set by an interrupt notice; the turn ends `aborted`. */
  aborted?: boolean;
}

export function convertTranscript(
  sessionId: string,
  records: readonly TranscriptRecord[],
): readonly StoredMessage[] {
  const messages: StoredMessage[] = [];
  let turn: TurnAccumulator | undefined;
  let sequence = 0;
  const id = (kind: string): string => `claude-code:${sessionId}:${kind}:${sequence++}`;

  const closeTurn = (): void => {
    if (!turn) return;
    // No terminal `turn_state` is emitted for a turn nothing corroborates.
    // Measured across 1130 local transcripts, 13.9% of turns end this way —
    // no assistant reply at all, or stopped at `tool_use` with the result
    // never arriving. Those are genuinely unfinished: a killed process, a
    // crash, or a session still open. Emitting `completed` for them would put
    // a false terminal state on 1 in 7 imported turns.
    if (turn.aborted) {
      messages.push({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'aborted',
        abortedAt: turn.lastTs,
        abortSource: 'claude-code.interrupt',
        partialOutputRetained: true,
      });
    } else if (turn.failed) {
      messages.push({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'failed',
        errorClass: 'claude_code_api_error',
        partialOutputRetained: true,
      });
    } else if (turn.terminalStop) {
      messages.push({
        type: 'turn_state',
        id: id('turn-state'),
        turnId: turn.turnId,
        ts: turn.lastTs,
        status: 'completed',
        partialOutputRetained: true,
      });
    }
    turn = undefined;
  };

  for (const record of records) {
    const ts = timestampMs(record) ?? turn?.lastTs ?? 0;
    if (turn) turn.lastTs = ts;
    const type = record.type;

    if (type === 'user') {
      const message = asMessageRecord(record);
      const toolResults = toolResultBlocks(message);
      if (toolResults.length > 0) {
        // Tool results arrive as `user` records — the harness replying to the
        // model, not the human. Importing them as user Turns would put the
        // model's own tool output in the user's mouth.
        for (const block of toolResults) {
          if (!turn) continue;
          messages.push({
            type: 'tool_result',
            id: id('tool-result'),
            turnId: turn.turnId,
            ts,
            toolUseId: stringOf(block.tool_use_id) ?? id('tool-use'),
            isError: block.is_error === true,
            content: { kind: 'text', text: toolResultText(block.content) },
          });
        }
        continue;
      }

      const text = claudeUserAuthoredText(record);
      if (text === undefined) {
        // Synthetic user text: interrupt notices and command wrappers. The
        // interrupt notice is one of the few terminal facts a transcript
        // carries, so it is read for status even though it is not a message.
        const raw = rawUserText(message);
        if (
          raw &&
          isSyntheticClaudeUserText(raw) &&
          raw.trimStart().startsWith('[Request interrupted')
        ) {
          if (turn) turn.aborted = true;
        }
        continue;
      }

      // A human-authored user record opens a new turn.
      closeTurn();
      turn = { turnId: `claude-code:${sessionId}:turn:${sequence}`, lastTs: ts };
      messages.push({ type: 'user', id: id('user'), turnId: turn.turnId, ts, text });
      continue;
    }

    if (type === 'assistant') {
      if (!turn) {
        // A transcript can open with an assistant record when the session was
        // resumed. Give it a turn rather than dropping the content.
        turn = { turnId: `claude-code:${sessionId}:turn:${sequence}`, lastTs: ts };
      }
      if (record.isApiErrorMessage === true) turn.failed = true;
      const message = asMessageRecord(record);
      // The transcript names the model that produced each step. Carrying the
      // real value keeps an imported turn attributable; a placeholder would
      // put a model the user never ran onto their history.
      const modelId = stringOf(message?.model) ?? 'claude-code';
      const stop = stringOf(message?.stop_reason);
      if (stop && TERMINAL_STOP_REASONS.has(stop)) turn.terminalStop = stop;

      const thinking = thinkingText(message);
      if (thinking) {
        messages.push({
          type: 'assistant',
          id: id('thinking'),
          turnId: turn.turnId,
          ts,
          text: '',
          thinking: { text: thinking },
          contentOrder: ['thinking'],
          modelId,
        });
      }
      const text = claudeAssistantText(record);
      if (text) {
        messages.push({
          type: 'assistant',
          id: id('assistant'),
          turnId: turn.turnId,
          ts,
          text,
          contentOrder: ['text'],
          modelId,
        });
      }
      for (const block of toolUseBlocks(message)) {
        messages.push({
          type: 'tool_call',
          // The id must equal the tool_use id so the result can match it.
          id: stringOf(block.id) ?? id('tool-call'),
          turnId: turn.turnId,
          ts,
          toolName: stringOf(block.name) ?? 'unknown',
          args: block.input ?? {},
        });
      }
      continue;
    }

    if (record.isCompactSummary === true) {
      if (!turn) continue;
      messages.push({
        type: 'system_note',
        id: id('compact'),
        turnId: turn.turnId,
        ts,
        kind: 'context_compacted',
      });
    }
  }

  closeTurn();
  return messages;
}

function asMessageRecord(record: TranscriptRecord): Record<string, unknown> | undefined {
  const message = record.message;
  return typeof message === 'object' && message !== null && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : undefined;
}

function contentBlocks(message: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is Record<string, unknown> =>
      typeof block === 'object' && block !== null && !Array.isArray(block),
  );
}

function toolUseBlocks(message: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return contentBlocks(message).filter((block) => block.type === 'tool_use');
}

function toolResultBlocks(message: Record<string, unknown> | undefined): Record<string, unknown>[] {
  return contentBlocks(message).filter((block) => block.type === 'tool_result');
}

function thinkingText(message: Record<string, unknown> | undefined): string {
  return contentBlocks(message)
    .filter((block) => block.type === 'thinking')
    .map((block) => stringOf(block.thinking) ?? '')
    .filter(Boolean)
    .join('\n\n');
}

function rawUserText(message: Record<string, unknown> | undefined): string | undefined {
  const content = message?.content;
  if (typeof content === 'string') return content;
  const texts = contentBlocks(message)
    .filter((block) => block.type === 'text')
    .map((block) => stringOf(block.text) ?? '');
  return texts.join('\n').trim() || undefined;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === 'object' && block !== null && !Array.isArray(block)
          ? (stringOf((block as Record<string, unknown>).text) ?? '')
          : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
