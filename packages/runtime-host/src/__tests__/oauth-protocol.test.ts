import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeClientFrame,
  decodeHostFrame,
  decodeOAuthLoginProjection,
  decodeOAuthPresentationRequest,
  decodeOAuthPresentationResult,
  OAUTH_PRESENTATION_AUTHORIZATION_CODE_MAX_LENGTH,
} from '../protocol/index.js';

test('OAuth login protocol binds attempt identity and closes terminal projections', () => {
  assert.deepEqual(
    decodeClientFrame({
      requestId: 'request',
      operation: 'oauth.login.start',
      input: { attemptId: 'attempt', connectionId: 'connection' },
    }),
    {
      requestId: 'request',
      operation: 'oauth.login.start',
      input: { attemptId: 'attempt', connectionId: 'connection' },
    },
  );
  assert.deepEqual(
    decodeHostFrame({
      requestId: 'request',
      operation: 'oauth.login.start',
      ok: true,
      result: {
        attemptId: 'attempt',
        connectionId: 'connection',
        provider: 'openai-codex',
        phase: 'failed',
        failure: 'provider_rejected',
      },
    }),
    {
      requestId: 'request',
      operation: 'oauth.login.start',
      ok: true,
      result: {
        attemptId: 'attempt',
        connectionId: 'connection',
        provider: 'openai-codex',
        phase: 'failed',
        failure: 'provider_rejected',
      },
    },
  );
  assert.throws(
    () =>
      decodeHostFrame({
        requestId: 'request',
        operation: 'oauth.login.start',
        ok: true,
        result: {
          attemptId: 'attempt',
          connectionId: 'connection',
          provider: 'openai-codex',
          phase: 'authenticated',
          failure: 'internal_failure',
        },
      }),
    (error: unknown) => error instanceof RuntimeHostProtocolError,
  );
});

test('OAuth account usage is no longer an operation on the wire', () => {
  // Reporting subscription usage required the retired provider's own client
  // identity, so the operation went with it rather than staying as a call that
  // always answers "unavailable".
  assert.throws(
    () =>
      decodeHostFrame({
        requestId: 'request',
        operation: 'oauth.account.usage.fetch',
        ok: true,
        result: { kind: 'unavailable', reason: 'unsupported_provider' },
      }),
    RuntimeHostProtocolError,
  );
});

test('OAuth presentation methods share one closed request and result contract', () => {
  assert.deepEqual(
    decodeOAuthPresentationRequest('open_external', {
      url: 'https://auth.example/authorize',
      stateHint: 'ABCD-1234',
    }),
    {
      method: 'open_external',
      url: 'https://auth.example/authorize',
      stateHint: 'ABCD-1234',
    },
  );
  assert.deepEqual(
    decodeOAuthPresentationResult('request_authorization_code', {
      kind: 'authorization_code',
      authorizationCode: 'code#state',
    }),
    { kind: 'authorization_code', authorizationCode: 'code#state' },
  );
  assert.throws(
    () =>
      decodeOAuthPresentationRequest('request_authorization_code', {
        url: 'https://auth.example/authorize',
      }),
    (error: unknown) => error instanceof RuntimeHostProtocolError,
  );
  assert.throws(
    () =>
      decodeOAuthPresentationResult('request_authorization_code', {
        kind: 'authorization_code',
        authorizationCode: 'x'.repeat(OAUTH_PRESENTATION_AUTHORIZATION_CODE_MAX_LENGTH + 1),
      }),
    (error: unknown) => error instanceof RuntimeHostProtocolError,
  );
});

test('OAuth login projections refuse a retired provider on the wire', () => {
  // A Host on an older build can still emit this provider. Accepting it would
  // let a login the Client can no longer drive reach the projection.
  assert.throws(
    () =>
      decodeOAuthLoginProjection({
        attemptId: 'attempt',
        connectionId: 'connection',
        provider: 'claude-subscription',
        phase: 'awaiting_authorization',
      }),
    RuntimeHostProtocolError,
  );
  assert.deepEqual(
    decodeOAuthLoginProjection({
      attemptId: 'attempt',
      connectionId: 'connection',
      provider: 'openai-codex',
      phase: 'awaiting_authorization',
    }),
    {
      attemptId: 'attempt',
      connectionId: 'connection',
      provider: 'openai-codex',
      phase: 'awaiting_authorization',
    },
  );
});
