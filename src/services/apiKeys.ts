import { randomBytes, createHash } from 'crypto'
import { ApiKeysRepository } from '../db/repositories/apiKeysRepository.js'
import { pool } from '../db/pool.js'

export type KeyScope = 'read' | 'full' | string   // extended to accept granular scope strings
export enum ApiKeyScope {
  BOND_READ = 'bond:read',
  BOND_WRITE = 'bond:write',
  TRUST_READ = 'trust:read',
  TRUST_WRITE = 'trust:write',
  ATTESTATION_WRITE = 'attestation:write',
}
export type SubscriptionTier = 'free' | 'pro' | 'enterprise'

export interface StoredApiKey {
  id: string
  /** SHA-256 hash of the raw key */
  hashedKey: string
  /** First 8 chars after the "cr_" prefix — used for fast lookup */
  prefix: string
  /**
   * Granted scopes for this key.
   *
   * Legacy keys carry a single-element array with 'read' or 'full'.
   * Granular keys carry one or more scope strings from ApiScope.
   *
   * The `scope` field (singular) is kept for backward compatibility and
   * reflects the primary / most-privileged scope in the array.
   */
  scopes: string[]
  /** @deprecated Use `scopes` instead. Kept for backward compatibility. */
  scope: KeyScope
  tier: SubscriptionTier
  ownerId: string
  createdAt: Date
  lastUsedAt: Date | null
  active: boolean
}

export interface CreateApiKeyResult {
  id: string
  /** Raw key — only returned once at creation/rotation. Store securely. */
  key: string
  prefix: string
  /** @deprecated Use `scopes` instead. */
  scope: KeyScope
  scopes: string[]
  tier: SubscriptionTier
  createdAt: Date
}

// Repository for database operations
const repository = new ApiKeysRepository(pool)

// In-memory fallback for testing when DB is not available
const inMemoryStore = new Map<string, StoredApiKey>()
let useInMemory = process.env.NODE_ENV === 'test' && !process.env.TEST_WITH_DB

function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex')
}

/** Returns the 8-char lookup prefix (chars 3–11 of the raw key, after "cr_") */
function extractPrefix(rawKey: string): string {
  return rawKey.slice(3, 11)
}

/**
 * Generate and store a new API key.
 *
 * @param ownerId  Identifier of the key owner (user/org ID)
 * @param scopeOrScopes Primary scope or array of scopes.
 * @param tier     Subscription tier controlling rate limits (default: 'free')
 * @returns        Key metadata including the raw key (shown once only)
 */
export async function generateApiKey(
  ownerId: string,
  scopeOrScopes: KeyScope | KeyScope[] = [],
  tier: SubscriptionTier = 'free',
): Promise<CreateApiKeyResult> {
  const random = randomBytes(32).toString('hex') // 64 hex chars
  const rawKey = `cr_${random}` // 67 chars total
  const prefix = extractPrefix(rawKey)
  const id = randomBytes(8).toString('hex')

  const grantedScopes: string[] = Array.isArray(scopeOrScopes)
    ? scopeOrScopes
    : [scopeOrScopes]
  const primaryScope = (grantedScopes[0] ?? 'read') as KeyScope

  const stored: StoredApiKey = {
    id,
    hashedKey: hashKey(rawKey),
    prefix,
    scope: primaryScope,
    scopes: grantedScopes,
    tier,
    ownerId,
    createdAt: new Date(),
    lastUsedAt: null,
    active: true,
  }

  if (useInMemory) {
    inMemoryStore.set(id, stored)
  } else {
    const dbKey = await repository.createApiKey(stored)
    stored.id = dbKey.id
  }

  return {
    id: stored.id,
    key: rawKey,
    prefix,
    scope: primaryScope,
    scopes: grantedScopes,
    tier,
    createdAt: stored.createdAt,
  }
}

/**
 * Validate a raw API key.
 *
 * @param rawKey  The key supplied by the caller
 * @returns       The stored key record (with lastUsedAt updated) or null if invalid/revoked
 */
export async function validateApiKey(rawKey: string): Promise<StoredApiKey | null> {
  if (!/^cr_[0-9a-f]{64}$/.test(rawKey)) return null

  const prefix = extractPrefix(rawKey)
  const hashed = hashKey(rawKey)

  if (useInMemory) {
    for (const key of inMemoryStore.values()) {
      if (key.prefix === prefix && key.hashedKey === hashed) {
        if (!key.active) return null
        key.lastUsedAt = new Date()
        return key
      }
    }
    return null
  } else {
    const apiKey = await repository.findByHashAndPrefix(hashed, prefix)
    if (apiKey) {
      await repository.updateLastUsedAt(apiKey.id)
      apiKey.lastUsedAt = new Date()
    }
    return apiKey
  }
}

/**
 * Revoke an API key by ID.
 *
 * @returns true if the key was found and deactivated, false if not found
 */
export async function revokeApiKey(id: string): Promise<boolean> {
  if (useInMemory) {
    const key = inMemoryStore.get(id)
    if (!key) return false
    key.active = false
    return true
  } else {
    return await repository.revokeApiKey(id)
  }
}

/**
 * Rotate an API key: revokes the existing key and issues a new one with the same
 * scopes, tier, and owner. Returns null if the key doesn't exist or is already revoked.
 */
export async function rotateApiKey(id: string): Promise<CreateApiKeyResult | null> {
  const existing = inMemoryStore.get(id)
  if (!existing || !existing.active) return null

  existing.active = false
  return await generateApiKey(existing.ownerId, existing.scopes, existing.tier)
}

/**
 * Retrieve a single key record by its ID without exposing the hash.
 *
 * @returns Key metadata (minus `hashedKey`), or null if not found.
 */
export function findApiKeyById(id: string): Omit<StoredApiKey, 'hashedKey'> | null {
  const key = inMemoryStore.get(id)
  if (!key) return null
  const { hashedKey: _h, ...rest } = key
  return rest
}

/**
 * List all keys for an owner. The `hashedKey` field is omitted.
 */
export async function listApiKeys(ownerId: string): Promise<Omit<StoredApiKey, 'hashedKey'>[]> {
  if (useInMemory) {
    return [...inMemoryStore.values()]
      .filter((k) => k.ownerId === ownerId)
      .map(({ hashedKey: _h, ...rest }) => rest)
  } else {
    return await repository.listByOwner(ownerId)
  }
}

/** Reset the in-memory store. Intended for use in tests only. */
export function _resetStore(): void {
  inMemoryStore.clear()
  if (!useInMemory) {
    // In DB mode, we'd need to truncate the table
    // For now, this is only used in tests which use in-memory mode
  }
}

/** Force use of in-memory store (for testing) */
export function _setUseInMemory(value: boolean): void {
  useInMemory = value
}
