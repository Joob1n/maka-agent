import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  PKCE_VERIFIER_LENGTH_BYTES,
  base64urlEncode,
  constantTimeStringEqual,
  parsePastedAuthorization,
  pkceCodeChallenge,
  type Sha256Digest,
} from '../oauth-subscription.js';

const nodeSha256: Sha256Digest = {
  digest(input: string): Uint8Array {
    return new Uint8Array(createHash('sha256').update(input, 'utf8').digest());
  },
};

describe('OAuth subscription helpers', () => {
  it('matches base64url encoding for empty and reserved bytes', () => {
    assert.equal(base64urlEncode(new Uint8Array()), '');
    assert.equal(base64urlEncode(new Uint8Array([0xfb, 0xff, 0xbf])), '-_-_');
  });

  it('produces the RFC PKCE challenge with a safe verifier length', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    assert.equal(
      pkceCodeChallenge(verifier, nodeSha256),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    assert.equal(PKCE_VERIFIER_LENGTH_BYTES, 32);
  });

  it('parses only the strict code-state pasted shape', () => {
    assert.deepEqual(parsePastedAuthorization('abc_123-XYZ#state_value-42'), {
      code: 'abc_123-XYZ',
      state: 'state_value-42',
    });
    assert.deepEqual(parsePastedAuthorization('  \n  abc#xyz  \n'), {
      code: 'abc',
      state: 'xyz',
    });

    const invalid: unknown[] = [
      null,
      '   ',
      'abc',
      '#xyz',
      'abc#',
      'abc!#xyz',
      'abc#xy z',
      'abc#xy#z',
    ];
    for (const value of invalid) assert.equal(parsePastedAuthorization(value), null);
  });

  it('compares equal and unequal strings without widening the contract', () => {
    const cases = [
      ['abc', 'abc', true],
      ['', '', true],
      ['abc', 'abcd', false],
      ['abc', 'abd', false],
    ] as const;
    for (const [left, right, expected] of cases) {
      assert.equal(constantTimeStringEqual(left, right), expected);
    }
  });
});
