import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveConnectionSlug,
  validateConnectionBaseUrl,
  validateSlug,
  type ProviderType,
} from '../llm-connections.js';
import {
  CATALOG_PROVIDER_TYPES,
  PROVIDER_REGISTRY,
  isRetiredProvider,
  isWiredOAuthProvider,
} from '../provider-registry.js';
import { deriveProviderAuthContract } from '../provider-auth.js';

describe('provider connection slug derivation contract', () => {
  it('continues through dense collisions until it finds an unused slug', () => {
    const base = deriveConnectionSlug('openai');
    const existing = [base, ...Array.from({ length: 98 }, (_, index) => `${base}-${index + 2}`)];
    const derived = deriveConnectionSlug('openai', existing);

    assert.equal(derived, 'openai-100');
    assert.ok(!existing.includes(derived));
    assert.equal(validateSlug(derived), null);
  });
});

describe('provider catalog contract — structural invariants over CATALOG_PROVIDER_TYPES', () => {
  it('exposes an endpoint source that passes the production baseUrl gate', () => {
    for (const type of CATALOG_PROVIDER_TYPES) {
      const def = PROVIDER_REGISTRY[type];
      if (def.baseUrl.trim() !== '') {
        assert.equal(
          validateConnectionBaseUrl(def.baseUrl),
          null,
          `${type} baseUrl ${def.baseUrl} must pass validateConnectionBaseUrl`,
        );
        continue;
      }
      if (def.baseUrlTemplate !== undefined) {
        const resolved = def.baseUrlTemplate.replace(/\$\{[^}]+\}/g, 'placeholder');
        assert.ok(
          resolved.trim() !== '',
          `${type} baseUrlTemplate must resolve to a non-blank URL once its placeholders are filled`,
        );
        assert.equal(
          validateConnectionBaseUrl(resolved),
          null,
          `${type} baseUrlTemplate ${def.baseUrlTemplate} must pass validateConnectionBaseUrl once its placeholders are filled`,
        );
        continue;
      }
      const isCustomConnection = def.category === 'custom';
      assert.ok(
        isCustomConnection,
        `${type} has no baseUrl, no baseUrlTemplate, and is not a custom connection — it cannot source an endpoint`,
      );
    }
  });
});

describe('retired provider contract', () => {
  // Retirement is carried by three lines that no other test reads. Each one was
  // separately revertible with the whole suite staying green, so a retired
  // provider could be made sendable again by accident.
  it('keeps a retired provider registered, unwired, and unsignable', () => {
    const allTypes = Object.keys(PROVIDER_REGISTRY) as ProviderType[];
    const retired = allTypes.filter((type) => isRetiredProvider(type));
    assert.ok(retired.length > 0, 'expected at least one retired provider to pin');

    for (const type of retired) {
      const def = PROVIDER_REGISTRY[type];
      assert.equal(
        def.runtimeAdapter.kind,
        'unavailable',
        `${type} is retired, so no Runtime adapter may claim it`,
      );
      assert.equal(
        isWiredOAuthProvider(type),
        false,
        `${type} is retired, so it must not read as a wired OAuth provider`,
      );

      // The credential outlives retirement, so this is the state a user who
      // enrolled before actually lands in.
      const contract = deriveProviderAuthContract({ providerType: type, hasSecret: true });
      assert.equal(contract.setupMode, 'oauth_retired', `${type} must not present a setup path`);
      assert.equal(contract.state, 'retired', `${type} must not read as a preview provider`);
      assert.equal(contract.actionAvailability.start_oauth, 'hidden');
      assert.equal(contract.actionAvailability.refresh_oauth, 'hidden');
    }
  });

  it('keeps the retired entry decodable but out of the add-connection catalog', () => {
    assert.equal(isRetiredProvider('claude-subscription'), true);
    assert.ok(
      PROVIDER_REGISTRY['claude-subscription'] !== undefined,
      'a stored connection must still decode',
    );
    assert.equal(
      CATALOG_PROVIDER_TYPES.includes('claude-subscription'),
      false,
      'a retired provider must not be offerable as a new connection',
    );
  });
});
