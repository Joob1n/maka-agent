import type { StoredMessage } from './session.js';

/** Stable identifier for one external Agent integration, for example `codex`. */
export type ExternalAgentId = string;

/** A search term longer than this is refused rather than matched. */
export const EXTERNAL_SESSION_QUERY_TEXT_MAX_CHARS = 200;

export interface ExternalSessionQuery {
  cwd?: string;
  includeArchived?: boolean;
  /**
   * Free text matched against a summary's title and cwd.
   *
   * Applied by the adapter, before paging. Filtering an assembled page would
   * search only the rows already fetched, which on a 1128-session source is
   * worse than offering no search at all.
   */
  text?: string;
}

/** Lightweight source-native identity used by session pickers and import commands. */
export interface ExternalSessionSummary {
  id: string;
  name: string;
  cwd: string;
  createdAt?: number;
  updatedAt?: number;
  archived?: boolean;
}

/**
 * Whether one summary answers a query.
 *
 * Shared by every adapter on purpose. The catalog is one surface over several
 * sources, so a filter that quietly worked for Codex and not for Claude Code
 * would be worse than no filter — the user cannot see which source dropped
 * their term. Keeping the decision here means a new adapter inherits the
 * behaviour instead of reimplementing it.
 */
export function externalSessionMatchesQuery(
  summary: ExternalSessionSummary,
  query: ExternalSessionQuery = {},
): boolean {
  if (!query.includeArchived && summary.archived) return false;
  if (query.cwd !== undefined && !sameExternalSessionPath(summary.cwd, query.cwd)) return false;
  const text = normalizeExternalSessionQueryText(query.text);
  if (text === undefined) return true;
  // Title and path, because those are the two things a user remembers about a
  // conversation they are looking for. Both already sit on the summary, so
  // matching costs no extra reads. Message content is deliberately excluded:
  // it would mean opening every transcript on every keystroke.
  return summary.name.toLowerCase().includes(text) || summary.cwd.toLowerCase().includes(text);
}

/**
 * The comparable form of a search term, or `undefined` when it selects
 * nothing — an empty or whitespace-only box is not a filter, and treating it
 * as one would hide every session behind a stray space.
 */
export function normalizeExternalSessionQueryText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().slice(0, EXTERNAL_SESSION_QUERY_TEXT_MAX_CHARS);
  return trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
}

/**
 * Path equality across the shapes different sources record.
 *
 * Codex normalizes separators and lowercases a Windows drive prefix before
 * comparing; the Claude Code adapter compared raw strings, so the same project
 * reached through a different separator answered "no such project". One rule
 * for both.
 */
export function sameExternalSessionPath(left: string, right: string): boolean {
  return normalizeExternalSessionPath(left) === normalizeExternalSessionPath(right);
}

function normalizeExternalSessionPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/u, '');
  return /^[A-Za-z]:\//u.test(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * An external session after its source-specific format has been converted to
 * Maka's existing raw Session representation.
 *
 * There is intentionally no intermediate external-message model here. Each
 * adapter owns its source format and emits canonical Maka StoredMessages.
 */
export interface ExternalMakaSession {
  sourceSessionId: string;
  metadata: {
    name: string;
    cwd: string;
  };
  messages: readonly StoredMessage[];
}

/** Read-only, source-specific conversion boundary for one external Agent. */
export interface ExternalSessionAdapter {
  readonly id: ExternalAgentId;

  detect(): Promise<boolean>;

  listSessions(query?: ExternalSessionQuery): Promise<readonly ExternalSessionSummary[]>;

  readSession(sessionId: string): Promise<ExternalMakaSession>;
}

export class ExternalSessionAdapterRegistry {
  private readonly adapters = new Map<ExternalAgentId, ExternalSessionAdapter>();

  constructor(adapters: readonly ExternalSessionAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ExternalSessionAdapter): void {
    if (adapter.id.trim().length === 0) {
      throw new Error('External Session adapter id must not be empty');
    }
    if (this.adapters.has(adapter.id)) {
      throw new Error(`External Session adapter is already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(adapterId: ExternalAgentId): ExternalSessionAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  require(adapterId: ExternalAgentId): ExternalSessionAdapter {
    const adapter = this.get(adapterId);
    if (!adapter) throw new Error(`External Session adapter is not registered: ${adapterId}`);
    return adapter;
  }

  list(): readonly ExternalSessionAdapter[] {
    return [...this.adapters.values()];
  }
}
