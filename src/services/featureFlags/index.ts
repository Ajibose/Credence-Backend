/**
 * Feature flag evaluation service with in-process TTL cache.
 *
 * Cache semantics:
 * - Keys are tenant-scoped: `${tenantId}:${flagKey}[:${userId}]`
 * - Never shares entries across tenants (cross-tenant leakage prevention)
 * - Entries expire after `ttlMs` milliseconds (default 30 s)
 * - Any flag or override mutation invalidates all affected keys before returning
 *
 * Invalidation bus integration:
 * Call `service.bustFlag(flagKey, tenantId)` from the external invalidation bus
 * (e.g. src/cache/invalidationBus.ts) to evict all cached evaluations for a
 * (flagKey, tenantId) pair without requiring a full cache flush.
 */

import client from 'prom-client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeatureFlag {
  key: string
  enabled: boolean
  description?: string
  tenantId: string
}

export interface FlagOverride {
  flagKey: string
  tenantId: string
  userId: string
  enabled: boolean
}

export interface UpdateFlagInput {
  enabled?: boolean
  description?: string
}

export interface FeatureFlagStore {
  getFlag(flagKey: string, tenantId: string): Promise<FeatureFlag | null>
  listFlags(tenantId: string): Promise<FeatureFlag[]>
  updateFlag(flagKey: string, tenantId: string, input: UpdateFlagInput): Promise<FeatureFlag | null>
  listOverrides(flagKey: string, tenantId: string): Promise<FlagOverride[]>
  setOverride(flagKey: string, tenantId: string, userId: string, enabled: boolean): Promise<FlagOverride>
}

export interface FeatureFlagCacheOptions {
  /** Entry TTL in milliseconds. Default: 30_000 (30 s). */
  ttlMs?: number
  /** Maximum number of cache entries. Oldest entries evicted when exceeded. Default: 1_000. */
  maxSize?: number
  /** Set to true to disable caching entirely (useful in tests). Default: false. */
  disabled?: boolean
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const featureFlagCacheHits = new client.Counter({
  name: 'feature_flag_cache_hits_total',
  help: 'Total number of feature flag evaluation cache hits',
  labelNames: ['tenant_id', 'flag_key'],
})

export const featureFlagCacheMisses = new client.Counter({
  name: 'feature_flag_cache_misses_total',
  help: 'Total number of feature flag evaluation cache misses',
  labelNames: ['tenant_id', 'flag_key'],
})

export const featureFlagCacheInvalidations = new client.Counter({
  name: 'feature_flag_cache_invalidations_total',
  help: 'Total number of feature flag cache invalidation events',
  labelNames: ['tenant_id', 'flag_key'],
})

// ---------------------------------------------------------------------------
// Internal TTL cache (Map-based, no external dependencies)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>()
  private readonly maxSize: number

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T, ttlMs: number): void {
    // Evict oldest entry when at capacity
    if (this.store.size >= this.maxSize && !this.store.has(key)) {
      const oldest = this.store.keys().next().value
      if (oldest !== undefined) this.store.delete(oldest)
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs })
  }

  /** Delete all keys that match a prefix. */
  deleteByPrefix(prefix: string): number {
    let count = 0
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key)
        count++
      }
    }
    return count
  }

  delete(key: string): boolean {
    return this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }

  get size(): number {
    return this.store.size
  }
}

// ---------------------------------------------------------------------------
// FeatureFlagService
// ---------------------------------------------------------------------------

export class FeatureFlagService {
  private readonly cache: TtlCache<boolean>
  private readonly ttlMs: number
  private readonly cacheDisabled: boolean

  constructor(
    private readonly store: FeatureFlagStore,
    options: FeatureFlagCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 30_000
    this.cacheDisabled = options.disabled ?? false
    this.cache = new TtlCache<boolean>(options.maxSize ?? 1_000)
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Check whether a feature flag is enabled for a given tenant/user context.
   *
   * Evaluation order:
   * 1. User-level override (if userId provided)
   * 2. Flag default for the tenant
   *
   * Results are cached per (tenantId, flagKey, userId?) for `ttlMs` ms.
   */
  async isEnabled(flagKey: string, tenantId: string, userId?: string): Promise<boolean> {
    const cacheKey = this._evalKey(flagKey, tenantId, userId)

    if (!this.cacheDisabled) {
      const cached = this.cache.get(cacheKey)
      if (cached !== undefined) {
        featureFlagCacheHits.inc({ tenant_id: tenantId, flag_key: flagKey })
        return cached
      }
    }

    featureFlagCacheMisses.inc({ tenant_id: tenantId, flag_key: flagKey })

    const result = await this._evaluate(flagKey, tenantId, userId)

    if (!this.cacheDisabled) {
      this.cache.set(cacheKey, result, this.ttlMs)
    }

    return result
  }

  /**
   * Retrieve a single flag definition for a tenant (uncached — admin read).
   */
  async getFlag(flagKey: string, tenantId: string): Promise<FeatureFlag | null> {
    return this.store.getFlag(flagKey, tenantId)
  }

  /**
   * List all flag definitions for a tenant (uncached — admin read).
   */
  async listFlags(tenantId: string): Promise<FeatureFlag[]> {
    return this.store.listFlags(tenantId)
  }

  /**
   * Update a flag and invalidate all cached evaluations for that flag/tenant
   * before returning so callers immediately see the new state.
   */
  async updateFlag(
    flagKey: string,
    tenantId: string,
    input: UpdateFlagInput,
  ): Promise<FeatureFlag | null> {
    const result = await this.store.updateFlag(flagKey, tenantId, input)
    this.bustFlag(flagKey, tenantId)
    return result
  }

  /**
   * List all overrides for a flag/tenant combination (uncached — admin read).
   */
  async listFlagsWithOverrides(
    flagKey: string,
    tenantId: string,
  ): Promise<{ flag: FeatureFlag | null; overrides: FlagOverride[] }> {
    const [flag, overrides] = await Promise.all([
      this.store.getFlag(flagKey, tenantId),
      this.store.listOverrides(flagKey, tenantId),
    ])
    return { flag, overrides }
  }

  /**
   * Set a per-user override and invalidate the cached evaluation for that
   * specific (tenantId, flagKey, userId) triple before returning.
   */
  async setOverride(
    flagKey: string,
    tenantId: string,
    userId: string,
    enabled: boolean,
  ): Promise<FlagOverride> {
    const result = await this.store.setOverride(flagKey, tenantId, userId, enabled)
    // Invalidate the specific user-scoped entry
    this.cache.delete(this._evalKey(flagKey, tenantId, userId))
    featureFlagCacheInvalidations.inc({ tenant_id: tenantId, flag_key: flagKey })
    return result
  }

  /**
   * Evict all cached evaluations for a (flagKey, tenantId) pair.
   *
   * Called by updateFlag / override mutations and can also be triggered
   * externally by the invalidation bus (src/cache/invalidationBus.ts).
   */
  bustFlag(flagKey: string, tenantId: string): void {
    const prefix = this._tenantFlagPrefix(flagKey, tenantId)
    const evicted = this.cache.deleteByPrefix(prefix)
    if (evicted > 0) {
      featureFlagCacheInvalidations.inc({ tenant_id: tenantId, flag_key: flagKey })
    }
  }

  /** Flush the entire cache (e.g., on graceful shutdown or testing). */
  clearCache(): void {
    this.cache.clear()
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _evaluate(
    flagKey: string,
    tenantId: string,
    userId?: string,
  ): Promise<boolean> {
    if (userId) {
      const overrides = await this.store.listOverrides(flagKey, tenantId)
      const override = overrides.find(o => o.userId === userId)
      if (override !== undefined) return override.enabled
    }
    const flag = await this.store.getFlag(flagKey, tenantId)
    return flag?.enabled ?? false
  }

  /** Cache key for an isEnabled evaluation. Tenant-scoped. */
  private _evalKey(flagKey: string, tenantId: string, userId?: string): string {
    return userId
      ? `${tenantId}:${flagKey}:${userId}`
      : `${tenantId}:${flagKey}`
  }

  /** Prefix shared by all evaluations for a (flagKey, tenantId) pair. */
  private _tenantFlagPrefix(flagKey: string, tenantId: string): string {
    return `${tenantId}:${flagKey}`
  }
}
