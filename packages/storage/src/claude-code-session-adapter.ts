import type { Dirent } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type { AssistantStepContentKind, StoredMessage } from '@maka/core/session';
import {
  type ClaudeTitleCandidates,
  type ClaudeTranscriptMeta,
  claudeUserMessageText,
  collectClaudeMeta,
  collectClaudeTitle,
  isClaudeInterruptNotice,
  parseForeignJsonLine,
  pickClaudeTitle,
  sanitizeForeignTitle,
} from '@maka/core/foreign-session';
import type {
  ExternalMakaSession,
  ExternalSessionAdapter,
  ExternalSessionQuery,
  ExternalSessionSummary,
} from '@maka/core/external-session';
import { isClaudeCodeImportEnabled } from './foreign-session-store.js';

export const CLAUDE_CODE_SESSION_ADAPTER_ID = 'claude-code';
export const CLAUDE_CODE_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * First catalog probe. Claude Code writes UI-state records (`mode`,
 * `permission-mode`) before the first record that carries `cwd`, and a pasted
 * file or a long first prompt can push that record past a small window, so the
 * probe grows once to CLAUDE_CODE_HEAD_MAX_BYTES before the file is skipped.
 */
const CLAUDE_CODE_HEAD_BYTES = 256 * 1024;
const CLAUDE_CODE_HEAD_MAX_BYTES = 4 * 1024 * 1024;
const CLAUDE_CODE_TITLE_TAIL_BYTES = 64 * 1024;
const CLAUDE_CODE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CLAUDE_CODE_UNSAFE_PATH_CHARS =
  /[\u0000-\u001F\u007F\u0080-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

export interface ClaudeCodeSessionAdapterOptions {
  /** Claude Code's state root. Defaults to `$CLAUDE_CONFIG_DIR`, then `~/.claude`. */
  claudeHome?: string;
  /** Test/host override for the bounded transcript read. */
  maxTranscriptBytes?: number;
  /** Environment consulted for the shared Claude Code read switch. */
  env?: Record<string, string | undefined>;
}

interface ClaudeCatalogEntry extends ExternalSessionSummary {
  transcriptPath: string;
}

interface TranscriptCandidate {
  path: string;
  mtimeMs: number;
  size: number;
}

type JsonRecord = Record<string, unknown>;

/**
 * Read-only adapter for Claude Code transcripts under `~/.claude/projects`.
 *
 * One model response is written as SEVERAL JSONL records — one per content
 * block (thinking, text, tool_use) — that share `message.id`. Consecutive
 * records with the same id are therefore folded back into one Maka assistant
 * step so a single answer does not import as three separate rows.
 *
 * Sub-agent transcripts are whole files flagged `isSidechain`, not records
 * interleaved into their parent, so they are excluded during cataloging and
 * never reach conversion.
 */
export class ClaudeCodeSessionAdapter implements ExternalSessionAdapter {
  readonly id = CLAUDE_CODE_SESSION_ADAPTER_ID;

  private readonly projectsRoot: string;
  private readonly maxTranscriptBytes: number;
  private readonly env: Record<string, string | undefined>;

  constructor(options: ClaudeCodeSessionAdapterOptions = {}) {
    const claudeHome = resolve(
      options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
    );
    this.projectsRoot = join(claudeHome, 'projects');
    this.maxTranscriptBytes = options.maxTranscriptBytes ?? CLAUDE_CODE_TRANSCRIPT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxTranscriptBytes) || this.maxTranscriptBytes <= 0) {
      throw new Error('Claude Code transcript byte limit must be a positive safe integer');
    }
    this.env = options.env ?? process.env;
  }

  async detect(): Promise<boolean> {
    // Honours the same kill switch as the foreign-session handoff scanner: a
    // user who turned Claude Code reads off gets no import source either.
    if (!isClaudeCodeImportEnabled(this.env)) return false;
    return isDirectory(this.projectsRoot);
  }

  async listSessions(query: ExternalSessionQuery = {}): Promise<readonly ExternalSessionSummary[]> {
    const entries = await this.listCatalog(query);
    return entries.map(({ transcriptPath: _transcriptPath, ...summary }) => summary);
  }

  async readSession(sessionId: string): Promise<ExternalMakaSession> {
    assertSafeClaudeSessionId(sessionId);
    const entry = await this.findCatalogEntry(sessionId);
    if (!entry) throw new Error(`Claude Code Session not found: ${sessionId}`);

    const text = await readWholeTranscript(entry.transcriptPath, this.maxTranscriptBytes);
    return convertClaudeCodeTranscript(text, sessionId, entry.name, entry.cwd);
  }

  private async listCatalog(query: ExternalSessionQuery): Promise<ClaudeCatalogEntry[]> {
    const candidates = await walkTranscriptFiles(this.projectsRoot);
    const entries: ClaudeCatalogEntry[] = [];
    for (const candidate of candidates) {
      // Reading it would throw, so offering it in a picker only produces a
      // failed import. `readSession` still reports the bound explicitly for
      // callers that name the Session directly.
      if (candidate.size > this.maxTranscriptBytes) continue;
      const entry = await this.catalogEntry(candidate);
      if (entry && matchesQuery(entry, query)) entries.push(entry);
    }
    return entries.sort(compareCatalogEntries);
  }

  private async findCatalogEntry(sessionId: string): Promise<ClaudeCatalogEntry | undefined> {
    for (const candidate of await walkTranscriptFiles(this.projectsRoot)) {
      if (basename(candidate.path) !== `${sessionId}.jsonl`) continue;
      const entry = await this.catalogEntry(candidate);
      if (entry) return entry;
    }
    return undefined;
  }

  private async catalogEntry(
    candidate: TranscriptCandidate,
  ): Promise<ClaudeCatalogEntry | undefined> {
    const id = basename(candidate.path, '.jsonl');
    if (!isSafeClaudeSessionId(id)) return undefined;
    const transcriptPath = await this.resolveTranscriptPath(candidate.path, id);
    if (!transcriptPath) return undefined;

    const meta: ClaudeTranscriptMeta = {};
    const titles: ClaudeTitleCandidates = {};
    let createdAt: number | undefined;

    for (const windowBytes of [CLAUDE_CODE_HEAD_BYTES, CLAUDE_CODE_HEAD_MAX_BYTES]) {
      const head = await readUtf8Window(transcriptPath, windowBytes, 'head').catch(() => undefined);
      if (head === undefined) return undefined;
      for (const { value: record } of parseClaudeRecords(head)) {
        collectClaudeMeta(record, meta);
        collectClaudeTitle(record, titles);
        createdAt ??= claudeTimestampMs(record.timestamp);
      }
      if (meta.cwd !== undefined) break;
      if (Buffer.byteLength(head, 'utf8') < windowBytes) break;
    }

    // A sub-agent transcript is not a root conversation; its parent already
    // owns the work. `cwd` is the file's only trustworthy project identity —
    // the directory name mangles path separators and cannot be reversed.
    if (meta.isSidechain === true) return undefined;
    if (meta.cwd === undefined) return undefined;

    const tail = await readUtf8Window(transcriptPath, CLAUDE_CODE_TITLE_TAIL_BYTES, 'tail').catch(
      () => undefined,
    );
    if (tail !== undefined) {
      // Meta as well as titles: `timestampMs` is a running maximum, so a head
      // window alone would date a long conversation by its opening records.
      for (const { value: record } of parseClaudeRecords(tail)) {
        collectClaudeTitle(record, titles);
        collectClaudeMeta(record, meta);
      }
    }

    return {
      id,
      name: pickClaudeTitle(titles) || id,
      cwd: safeClaudeCwd(meta.cwd),
      ...(createdAt === undefined ? {} : { createdAt }),
      updatedAt: meta.timestampMs ?? candidate.mtimeMs,
      transcriptPath,
    };
  }

  private async resolveTranscriptPath(
    candidatePath: string,
    expectedId: string,
  ): Promise<string | undefined> {
    try {
      const root = await realpath(this.projectsRoot);
      const candidate = await realpath(resolve(candidatePath));
      if (!candidate.startsWith(root + sep)) return undefined;
      if (basename(candidate) !== `${expectedId}.jsonl`) return undefined;
      if (!(await stat(candidate)).isFile()) return undefined;
      return candidate;
    } catch {
      return undefined;
    }
  }
}

interface ClaudeThinkingPart {
  text: string;
  signature?: string;
}

interface ClaudeToolCall {
  id: string;
  name: string;
  input: unknown;
  ts: number;
}

/** One model response, reassembled from the records that share its message id. */
interface ClaudeAssistantStep {
  messageId: string;
  turnId: string;
  ts: number;
  modelId: string;
  texts: string[];
  thinking: ClaudeThinkingPart[];
  order: AssistantStepContentKind[];
  tools: ClaudeToolCall[];
}

interface ParsedClaudeRecord {
  line: number;
  value: JsonRecord;
}

export function convertClaudeCodeTranscript(
  text: string,
  sessionId: string,
  fallbackName: string,
  fallbackCwd: string,
): ExternalMakaSession {
  const records = parseClaudeRecords(text);
  const messages: StoredMessage[] = [];
  const meta: ClaudeTranscriptMeta = {};
  const titles: ClaudeTitleCandidates = {};
  const usedIds = new Set<string>();
  let activeTurnId: string | undefined;
  let lastTurnId: string | undefined;
  // One model response, keyed by `message.id`, can reach the transcript as
  // several records with a `tool_result` between them — 378 of 383 such
  // continuations in a 1236-file local store carry only `tool_use`. Folding
  // consecutive records alone would import those as a second assistant row.
  const stepIdByMessageId = new Map<string, string>();
  let lastTimestamp = 0;
  let step: ClaudeAssistantStep | undefined;

  const uniqueId = (base: string): string => {
    if (!usedIds.has(base)) {
      usedIds.add(base);
      return base;
    }
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${base}-${suffix}`;
      if (!usedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
      }
    }
  };

  const timestampFor = (record: ParsedClaudeRecord): number => {
    const parsed = claudeTimestampMs(record.value.timestamp);
    if (parsed !== undefined) {
      lastTimestamp = Math.max(lastTimestamp, parsed);
      return parsed;
    }
    lastTimestamp += 1;
    return lastTimestamp;
  };

  // Turn ids live in their own namespace: the line number makes them unique by
  // construction, so record uuids stay available as message ids.
  const ensureTurnId = (line: number): string => {
    activeTurnId ??= generatedClaudeId(sessionId, 'turn', line);
    lastTurnId = activeTurnId;
    return activeTurnId;
  };

  /**
   * Record a terminal `turn_state` the transcript actually carries.
   *
   * Only two facts qualify: Claude Code's interrupt notice, and a record it
   * flagged `isApiErrorMessage`. Everything else — including "the Turn ended
   * because another one began" — is an inference, and `deriveTurnRecords`
   * makes it, labelled `inferred`. Asserting `recorded` here would have told
   * `isTrustworthyRecoveredTerminal` that a killed process finished normally.
   */
  const recordTurnState = (line: number, status: 'aborted' | 'failed', turnId: string): void => {
    messages.push({
      type: 'turn_state',
      id: uniqueId(generatedClaudeId(sessionId, 'turn-state', line)),
      turnId,
      ts: lastTimestamp,
      status,
      ...(status === 'failed' ? { errorClass: 'claude_code_error' } : {}),
      ...(status === 'aborted'
        ? { abortedAt: lastTimestamp, abortSource: 'claude_code.user_interrupt' }
        : {}),
      partialOutputRetained: true,
    });
  };

  const flushStep = (): void => {
    if (!step) return;
    const current = step;
    step = undefined;

    const body = current.texts.join('\n');
    const continues = stepIdByMessageId.get(current.messageId);
    let assistantId: string | undefined = continues;
    // A continuation that carries no new prose contributes only its calls, and
    // they point back at the row the response already has.
    if (continues === undefined && (body.length > 0 || current.thinking.length > 0)) {
      assistantId = uniqueId(current.messageId);
      stepIdByMessageId.set(current.messageId, assistantId);
      messages.push({
        type: 'assistant',
        id: assistantId,
        turnId: current.turnId,
        ts: current.ts,
        text: body,
        ...(current.thinking.length > 0 ? { thinking: buildThinking(current.thinking) } : {}),
        contentOrder: current.order,
        modelId: current.modelId,
      });
    } else if (continues !== undefined && (body.length > 0 || current.thinking.length > 0)) {
      // The rare continuation that does carry prose stays visible as its own
      // row rather than being silently dropped.
      assistantId = uniqueId(current.messageId);
      messages.push({
        type: 'assistant',
        id: assistantId,
        turnId: current.turnId,
        ts: current.ts,
        text: body,
        ...(current.thinking.length > 0 ? { thinking: buildThinking(current.thinking) } : {}),
        contentOrder: current.order,
        modelId: current.modelId,
      });
    }

    for (const tool of current.tools) {
      // A repeated `tool_use` id would otherwise emit a second `tool_call`
      // with a duplicate message id; `usedIds` is the same answer the rest of
      // the conversion uses.
      if (usedIds.has(tool.id)) continue;
      usedIds.add(tool.id);
      messages.push({
        type: 'tool_call',
        id: tool.id,
        turnId: current.turnId,
        ts: tool.ts,
        toolName: tool.name,
        args: tool.input,
        ...(assistantId === undefined ? {} : { stepId: assistantId }),
      });
    }
  };

  for (const record of records) {
    const value = record.value;
    collectClaudeMeta(value, meta);
    collectClaudeTitle(value, titles);

    if (value.type === 'assistant') {
      const message = asRecord(value.message);
      if (!message) continue;

      // Claude Code renders provider failures in the assistant lane. They are
      // not model output, so they enter Maka as session notes.
      if (value.isApiErrorMessage === true) {
        flushStep();
        messages.push({
          type: 'system_note',
          id: uniqueId(recordId(value, sessionId, 'error', record.line)),
          ...(activeTurnId === undefined ? {} : { turnId: activeTurnId }),
          ts: timestampFor(record),
          kind: 'error',
          data: { text: claudeUserText(value) },
        });
        if (activeTurnId !== undefined) recordTurnState(record.line, 'failed', activeTurnId);
        continue;
      }

      const messageId =
        stringField(message, 'id') ?? generatedClaudeId(sessionId, 'assistant', record.line);
      if (step && step.messageId !== messageId) flushStep();
      const ts = timestampFor(record);
      if (!step) {
        step = {
          messageId,
          turnId: ensureTurnId(record.line),
          ts,
          modelId: stringField(message, 'model') ?? CLAUDE_CODE_SESSION_ADAPTER_ID,
          texts: [],
          thinking: [],
          order: [],
          tools: [],
        };
      }
      appendAssistantBlocks(step, contentBlocks(message), ts);
      continue;
    }

    flushStep();
    if (value.type !== 'user') continue;
    const message = asRecord(value.message);
    if (!message) continue;

    const blocks = contentBlocks(message);
    const toolResults = blocks.filter((block) => stringField(block, 'type') === 'tool_result');
    if (toolResults.length > 0) {
      // The harness replying to the model, not the human speaking. Sibling text
      // blocks in the same record are Claude Code's own framing, so the record
      // converts to tool results only.
      //
      // A tool result never opens a Turn: its `toolUseId` points into a
      // `tool_call` that belongs to one already, and two real transcripts start
      // with a result before any prompt. With no Turn to attach to it is a
      // fragment of a conversation that is not in this file, and dropping it is
      // more faithful than inventing a Turn to hold it.
      const turnId = activeTurnId ?? lastTurnId;
      if (turnId === undefined) continue;
      for (const block of toolResults) {
        const toolUseId = stringField(block, 'tool_use_id');
        if (!toolUseId) continue;
        const text = claudeToolResultText(block.content);
        messages.push({
          type: 'tool_result',
          id: uniqueId(recordId(value, sessionId, 'tool-result', record.line)),
          turnId,
          ts: timestampFor(record),
          toolUseId,
          isError: block.is_error === true,
          content: { kind: 'text', text },
        });
        // The user answering "no" at the approval prompt. Claude Code writes it
        // as an errored tool result, sometimes with no interrupt notice after
        // it, so without this the cancelled Turn reads as an ordinary one.
        if (block.is_error === true && isClaudeToolRejection(text)) {
          messages.push({
            type: 'system_note',
            id: uniqueId(recordId(value, sessionId, 'tool-rejected', record.line)),
            turnId,
            ts: lastTimestamp,
            kind: 'abort',
          });
        }
      }
      continue;
    }

    if (value.isCompactSummary === true) {
      messages.push({
        type: 'system_note',
        id: uniqueId(recordId(value, sessionId, 'compact', record.line)),
        ...(activeTurnId === undefined ? {} : { turnId: activeTurnId }),
        ts: timestampFor(record),
        kind: 'context_compacted',
      });
      continue;
    }

    // `isMeta` marks context Claude Code injected on the user's behalf; it was
    // never typed by the human and must not import as a user Turn.
    if (value.isMeta === true) continue;

    const userText = claudeUserText(value);
    if (userText.length === 0) continue;

    // An interrupt notice ends the Turn the user stopped; it is not a new
    // request. Treating it as one would open a Turn holding only that notice.
    if (isClaudeInterruptNotice(userText)) {
      timestampFor(record);
      if (activeTurnId !== undefined) recordTurnState(record.line, 'aborted', activeTurnId);
      activeTurnId = undefined;
      continue;
    }

    activeTurnId = generatedClaudeId(sessionId, 'turn', record.line);
    lastTurnId = activeTurnId;
    stepIdByMessageId.clear();
    messages.push({
      type: 'user',
      id: uniqueId(recordId(value, sessionId, 'user', record.line)),
      turnId: activeTurnId,
      ts: timestampFor(record),
      text: userText,
    });
  }
  flushStep();

  const name = sanitizeForeignTitle(fallbackName) || pickClaudeTitle(titles) || sessionId;
  return {
    sourceSessionId: sessionId,
    metadata: { name, cwd: safeClaudeCwd(meta.cwd) || safeClaudeCwd(fallbackCwd) },
    messages,
  };
}

function appendAssistantBlocks(
  step: ClaudeAssistantStep,
  blocks: readonly JsonRecord[],
  ts: number,
): void {
  for (const block of blocks) {
    const kind = stringField(block, 'type');
    if (kind === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (text.length === 0) continue;
      step.texts.push(text);
      noteContentOrder(step.order, 'text');
      continue;
    }
    if (kind === 'thinking') {
      const thinking = typeof block.thinking === 'string' ? block.thinking : '';
      if (thinking.length === 0) continue;
      const signature = stringField(block, 'signature');
      step.thinking.push({ text: thinking, ...(signature === undefined ? {} : { signature }) });
      noteContentOrder(step.order, 'thinking');
      continue;
    }
    if (kind === 'tool_use') {
      const id = stringField(block, 'id');
      const name = stringField(block, 'name');
      if (!id || !name) continue;
      step.tools.push({ id, name, input: block.input ?? {}, ts });
      noteContentOrder(step.order, 'tools');
    }
  }
}

function buildThinking(parts: readonly ClaudeThinkingPart[]): {
  text: string;
  signature?: string;
  parts?: ClaudeThinkingPart[];
} {
  const first = parts[0]!;
  if (parts.length === 1) {
    return {
      text: first.text,
      ...(first.signature === undefined ? {} : { signature: first.signature }),
    };
  }
  return { text: parts.map((part) => part.text).join('\n'), parts: [...parts] };
}

function noteContentOrder(order: AssistantStepContentKind[], kind: AssistantStepContentKind): void {
  if (!order.includes(kind)) order.push(kind);
}

function parseClaudeRecords(text: string): ParsedClaudeRecord[] {
  const records: ParsedClaudeRecord[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const value = parseForeignJsonLine(lines[index]!);
    if (value) records.push({ line: index + 1, value });
  }
  return records;
}

function contentBlocks(message: JsonRecord): JsonRecord[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is JsonRecord => isRecord(block));
}

/** User-visible text of a `user` record; media-only prompts keep a placeholder. */
/**
 * User-authored text for one record, on core's reading of it — the scanner and
 * the importer must not disagree about what the human said. The image fallback
 * is the adapter's own: a Turn whose prompt was a pasted screenshot has no text
 * to carry, and an empty user message would drop the Turn entirely.
 */
function claudeUserText(record: JsonRecord): string {
  const text = claudeUserMessageText(record);
  if (text !== undefined) return text;
  const message = asRecord(record.message);
  const blocks = message ? contentBlocks(message) : [];
  return blocks.some((block) => stringField(block, 'type') === 'image') ? '[Image]' : '';
}

/**
 * Claude Code's fixed text for "the user declined this tool call". Matched on
 * the sentence rather than on `is_error` alone: an ordinary tool failure is
 * also an errored result and is not an abort.
 */
function isClaudeToolRejection(text: string): boolean {
  return text.includes("The user doesn't want to proceed with this tool use");
}

function claudeToolResultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const texts = value.flatMap((item) => {
      const record = asRecord(item);
      return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
    });
    if (texts.length > 0) return texts.join('\n');
  }
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

async function walkTranscriptFiles(root: string): Promise<TranscriptCandidate[]> {
  const files: TranscriptCandidate[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const metadata = await stat(path);
          files.push({ path, mtimeMs: metadata.mtimeMs, size: metadata.size });
        } catch {
          // The external store may change while it is being scanned.
        }
      }
    }
  };
  await visit(root);
  return files;
}

/**
 * Read at most `maxBytes` from one end of the file. Every read of the external
 * store is bounded: it is not ours to trust with our memory.
 */
async function readUtf8Window(
  path: string,
  maxBytes: number,
  anchor: 'head' | 'tail',
): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('Claude Code transcript is not a regular file');
    const length = Math.min(maxBytes, metadata.size);
    const buffer = Buffer.allocUnsafe(length);
    const position = anchor === 'head' ? 0 : metadata.size - length;
    // A single `read` may return short. The truncated tail would be a half
    // line, `parseClaudeRecords` skips malformed lines in silence, and the
    // import would report success on a transcript missing its end.
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * The whole transcript, refusing anything past the configured bound.
 *
 * The bound is checked against the handle the read uses, not against a separate
 * `stat`: a file that grows between the two would otherwise pass the check and
 * then be silently truncated to the older size.
 */
async function readWholeTranscript(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('Claude Code transcript is not a regular file');
    if (metadata.size > maxBytes) {
      throw new Error(`Claude Code transcript exceeds ${maxBytes} bytes`);
    }
    const buffer = Buffer.allocUnsafe(metadata.size);
    let filled = 0;
    while (filled < metadata.size) {
      const { bytesRead } = await handle.read(buffer, filled, metadata.size - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled).toString('utf8');
  } finally {
    await handle.close();
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: JsonRecord | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isSafeClaudeSessionId(value: unknown): value is string {
  return typeof value === 'string' && CLAUDE_CODE_SESSION_ID_PATTERN.test(value);
}

function assertSafeClaudeSessionId(value: string): void {
  if (!isSafeClaudeSessionId(value)) throw new Error(`Invalid Claude Code Session id: ${value}`);
}

function safeClaudeCwd(value: unknown): string {
  return typeof value === 'string' && !CLAUDE_CODE_UNSAFE_PATH_CHARS.test(value) ? value : '';
}

function claudeTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function generatedClaudeId(sessionId: string, kind: string, line: number): string {
  return `claude-code-${sessionId}-${kind}-${line}`;
}

/** Record uuids are stable across re-imports; the line number only breaks ties. */
function recordId(value: JsonRecord, sessionId: string, kind: string, line: number): string {
  return stringField(value, 'uuid') ?? generatedClaudeId(sessionId, kind, line);
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function matchesQuery(entry: ExternalSessionSummary, query: ExternalSessionQuery): boolean {
  return query.cwd === undefined || normalizePath(entry.cwd) === normalizePath(query.cwd);
}

function compareCatalogEntries(a: ClaudeCatalogEntry, b: ClaudeCatalogEntry): number {
  return (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
