import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  FeatureFlagService,
  FeatureFlagStore,
  FeatureFlag,
  FlagOverride,
  featureFlagCacheHits,
  featureFlagCacheMisses,
  featureFlagCacheInvalidations,
} from './index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(overrides: Partial<FeatureFlagStore> = {}): FeatureFlagStore {
  return {
    getFlag: vi.fn(),
    listFlags: vi.fn(),
    updateFlag: vi.fn(),
    listOverrides: vi.fn().mockResolvedValue([]),
    setOverride: vi.fn(),
    ...overrides,
  }
}

function makeFlag(partial: Partial<FeatureFlag> = {}): FeatureFlag {
  return {
    key: 'my-flag',
    enabled: true,
    tenantId: 'tenant-a',
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeatureFlagService', () => {
  let store: FeatureFlagStore
  let service: FeatureFlagService

  beforeEach(() => {
    store = makeStore()
    service = new FeatureFlagService(store, { ttlMs: 5_000, maxSize: 100 })
    vi.spyOn(featureFlagCacheHits, 'inc')
    vi.spyOn(featureFlagCacheMisses, 'inc')
    vi.spyOn(featureFlagCacheInvalidations, 'inc')
  })

  // -------------------------------------------------------------------------
  // isEnabled — cache miss / hit
  // -------------------------------------------------------------------------

  describe('isEnabled – cache miss then hit', () => {
    it('fetches from store on first call (cache miss) and returns flag value', async () => {
      vi.mocked(store.getFlag).mockResolvedValue(makeFlag({ enabled: true }))

      const result = await service.isEnabled('my-flag', 'tenant-a')

      expect(result).toBe(true)
      expect(store.getFlag).toHaveBeenCalledOnce()
      expect(featureFlagCacheMisses.inc).toHaveBeenCalledWith({
        tenant_id: 'tenant-a',
        flag_key: 'my-flag',
      })
    })

    it('returns cached value on second call (cache hit) without re-querying store', async () => {
      vi.mocked(store.getFlag).mockResolvedValue(makeFlag({ enabled: false }))

      await service.isEnabled('my-flag', 'tenant-a')
      const result = await service.isEnabled('my-flag', 'tenant-a')

      expect(result).toBe(false)
      expect(store.getFlag).toHaveBeenCalledOnce() // only on first call
      expect(featureFlagCacheHits.inc).toHaveBeenCalledWith({
        tenant_id: 'tenant-a',
        flag_key: 'my-flag',
      })
    })

    it('returns false when flag does not exist', async () => {
      vi.mocked(store.getFlag).mockResolvedValue(null)

      const result = await service.isEnabled('missing-flag', 'tenant-a')

      expect(result).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('caches separately for different tenants with the same flag key', async () => {
      vi.mocked(store.getFlag)
        .mockResolvedValueOnce(makeFlag({ tenantId: 'tenant-a', enabled: true }))
        .mockResolvedValueOnce(makeFlag({ tenantId: 'tenant-b', enabled: false }))

      const a = await service.isEnabled('my-flag', 'tenant-a')
      const b = await service.isEnabled('my-flag', 'tenant-b')

      expect(a).toBe(true)
      expect(b).toBe(false)
      expect(store.getFlag).toHaveBeenCalledTimes(2)
    })

    it('invalidating one tenant does not affect another', async () => {
      vi.mocked(store.getFlag)
        .mockResolvedValue(makeFlag({ enabled: true }))
      vi.mocked(store.updateFlag).mockResolvedValue(makeFlag({ enabled: false }))

      await service.isEnabled('my-flag', 'tenant-a')
      await service.isEnabled('my-flag', 'tenant-b')

      service.bustFlag('my-flag', 'tenant-a')

      // tenant-b still cached → store should not be called again
      await service.isEnabled('my-flag', 'tenant-b')
      expect(store.getFlag).toHaveBeenCalledTimes(2) // once per tenant initial fetch
    })
  })

  // -------------------------------------------------------------------------
  // TTL expiry
  // -------------------------------------------------------------------------

  describe('TTL expiry', () => {
    it('re-fetches from store after TTL expires', async () => {
      vi.useFakeTimers()
      const shortTtlService = new FeatureFlagService(store, { ttlMs: 100 })

      vi.mocked(store.getFlag)
        .mockResolvedValueOnce(makeFlag({ enabled: true }))
        .mockResolvedValueOnce(makeFlag({ enabled: false }))
      vi.mocked(store.listOverrides).mockResolvedValue([])

      await shortTtlService.isEnabled('my-flag', 'tenant-a') // miss, caches true

      vi.advanceTimersByTime(101) // expire

      const result = await shortTtlService.isEnabled('my-flag', 'tenant-a') // miss again
      expect(result).toBe(false)
      expect(store.getFlag).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
    })

    it('serves cached value before TTL boundary', async () => {
      vi.useFakeTimers()
      const shortTtlService = new FeatureFlagService(store, { ttlMs: 200 })

      vi.mocked(store.getFlag).mockResolvedValue(makeFlag({ enabled: true }))
      vi.mocked(store.listOverrides).mockResolvedValue([])

      await shortTtlService.isEnabled('my-flag', 'tenant-a')

      vi.advanceTimersByTime(100) // still within TTL

      await shortTtlService.isEnabled('my-flag', 'tenant-a')
      expect(store.getFlag).toHaveBeenCalledOnce() // still cached

      vi.useRealTimers()
    })
  })

  // -------------------------------------------------------------------------
  // updateFlag — invalidation
  // -------------------------------------------------------------------------

  describe('updateFlag – cache invalidation', () => {
    it('invalidates cached evaluations for the flag/tenant after update', async () => {
      vi.mocked(store.getFlag).mockResolvedValue(makeFlag({ enabled: true }))
      vi.mocked(store.updateFlag).mockResolvedValue(makeFlag({ enabled: false }))

      await service.isEnabled('my-flag', 'tenant-a') // cache entry created

      await service.updateFlag('my-flag', 'tenant-a', { enabled: false })

      // Next isEnabled must go to store (cache was busted)
      vi.mocked(store.getFlag).mockResolvedValue(makeFlag({ enabled: false }))
      const result = await service.isEnabled('my-flag', 'tenant-a')

      expect(result).toBe(false)
      expect(store.getFlag).toHaveBeenCalledTimes(2) // first + post-invalidation
      expect(featureFlagCacheInvalidations.inc).toHaveBeenCalledWith({
        tenant_id: 'tenant-a',
        flag_key: 'my-flag',
      })
    })

    it('invalidates user-scoped evaluation entries on flag update', async () => {
      vi.mocked(store.getFlag).mockResolvedValue(makeFlag({ enabled: true }))
      vi.mocked(store.listOverrides).mockResolvedValue([])
      vi.mocked(store.updateFlag).mockResolvedValue(makeFlag({ enabled: false }))

      await service.isEnabled('my-flag', 'tenant-a', 'user-1') // user-scoped cache

      await service.updateFlag('my-flag', 'tenant-a', { enabled: false })

      vi.mocked(store.listOverrides).mockResolvedValue([])
      vi.mocked(store.getFlag).mockResolvedValue(makeFlag({ enabled: false }))

      const result = await service.isEnabled('my-flag', 'tenant-a', 'user-1')
      expect(result).toBe(false)
      expect(store.getFlag).toHaveBeenCalledTimes(2)
    })
  })

  // -------------------------------------------------------------------------
  // setOverride — invalidation
  // -------------------------------------------------------------------------

  describe('setOverride – cache invalidation', () => {
    it('invalidates user-scoped entry on override change', async () => {
      vi.mocked(store.getFlag).mockResolvedValue(makeFlag({ enabled: false }))
      vi.mocked(store.listOverrides).mockResolvedValue([])

      const override: FlagOverride = {
        flagKey: 'my-flag',
        tenantId: 'tenant-a',
        userId: 'user-1',
        enabled: true,
      }
      vi.mocked(store.setOverride).mockResolvedValue(override)

      await service.isEnabled('my-flag', 'tenant-a', 'user-1') // cache false

      await service.setOverride('my-flag', 'tenant-a', 'user-1', true)

      // Post-override the cache entry is gone; next call goes to store
      vi.mocked(store.listOverrides).mockResolvedValue([override])
      const result = await service.isEnabled('my-flag', 'tenant-a', 'user-1')

      expect(result).toBe(true)
      expect(featureFlagCacheInvalidations.inc).toHaveBeenCalledWith({
        tenant_id: 'tenant-a',
        flag_key: 'my-flag',
      })
    })

    it('override added after a cached miss is honoured on next isEnabled call', async () => {
      vi.mocked(store.getFlag).mockResolvedValue(makeFlag({ enabled: false }))
      vi.mocked(store.listOverrides).mockResolvedValue([])

      // First call: no override → false is cached
      const before = await service.isEnabled('my-flag', 'tenant-a', 'user-42')
      expect(before).toBe(false)

      const override: FlagOverride = {
        flagKey: 'my-flag',
        tenantId: 'tenant-a',
        userId: 'user-42',
        enabled: true,
      }
      vi.mocked(store.setOverride).mockResolvedValue(override)

      // Add override — must bust the user-42 cache entry
      await service.setOverride('my-flag', 'tenant-a', 'user-42', true)

      vi.mocked(store.listOverrides).mockResolvedValue([override])
      const after = await service.isEnabled('my-flag', 'tenant-a', 'user-42')
      expect(after).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // bustFlag
  // -------------------------------------------------------------------------

  describe('bustFlag', () => {
    it('evicts all tenant-scoped entries for a flag key', async () => {
      vi.mocked(store.getFlag).mockResolvedValue(makeFlag({ enabled: true }))
      vi.mocked(store.listOverrides).mockResolvedValue([])

      // Populate multiple entries: base + two user-scoped
      await service.isEnabled('my-flag', 'tenant-a')
      await service.isEnabled('my-flag', 'tenant-a', 'user-1')
      await service.isEnabled('my-flag', 'tenant-a', 'user-2')

      service.bustFlag('my-flag', 'tenant-a')

      // All three should miss and go to store again
      vi.mocked(store.getFlag).mockResolvedValue(makeFlag({ enabled: false }))
      vi.mocked(store.listOverrides).mockResolvedValue([])

      await service.isEnabled('my-flag', 'tenant-a')
      await service.isEnabled('my-flag', 'tenant-a', 'user-1')
      await service.isEnabled('my-flag', 'tenant-a', 'user-2')

      // 3 initial misses + 3 post-bust misses = 6 total getFlag calls
      // (listOverrides is called for user-scoped evaluations)
      expect(store.getFlag).toHaveBeenCalledTimes(6)
    })

    it('does not emit invalidation metric when no entries were evicted', async () => {
      service.bustFlag('nonexistent-flag', 'tenant-a')
      expect(featureFlagCacheInvalidations.inc).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // User-level overrides
  // -------------------------------------------------------------------------

  describe('user-level override evaluation', () => {
    it('uses override value when a matching override exists', async () => {
      const override: FlagOverride = {
        flagKey: 'my-flag',
        tenantId: 'tenant-a',
        userId: 'user-1',
        enabled: false,
      }
      vi.mocked(store.listOverrides).mockResolvedValue([override])

      const result = await service.isEnabled('my-flag', 'tenant-a', 'user-1')
      expect(result).toBe(false)
      expect(store.getFlag).not.toHaveBeenCalled() // override short-circuits
    })

    it('falls back to flag default when no override matches the user', async () => {
      vi.mocked(store.listOverrides).mockResolvedValue([])
      vi.mocked(store.getFlag).mockResolvedValue(makeFlag({ enabled: true }))

      const result = await service.isEnabled('my-flag', 'tenant-a', 'user-99')
      expect(result).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Disabled cache mode
  // -------------------------------------------------------------------------

  describe('disabled cache', () => {
    it('always fetches from store when cache is disabled', async () => {
      const noCache = new FeatureFlagService(store, { disabled: true })
      vi.mocked(store.getFlag).mockResolvedValue(makeFlag({ enabled: true }))

      await noCache.isEnabled('my-flag', 'tenant-a')
      await noCache.isEnabled('my-flag', 'tenant-a')

      expect(store.getFlag).toHaveBeenCalledTimes(2)
    })
  })

  // -------------------------------------------------------------------------
  // Pass-through admin methods
  // -------------------------------------------------------------------------

  describe('getFlag / listFlags / listFlagsWithOverrides', () => {
    it('getFlag delegates directly to the store', async () => {
      const flag = makeFlag()
      vi.mocked(store.getFlag).mockResolvedValue(flag)

      const result = await service.getFlag('my-flag', 'tenant-a')
      expect(result).toEqual(flag)
      expect(store.getFlag).toHaveBeenCalledWith('my-flag', 'tenant-a')
    })

    it('listFlags delegates directly to the store', async () => {
      const flags = [makeFlag()]
      vi.mocked(store.listFlags).mockResolvedValue(flags)

      const result = await service.listFlags('tenant-a')
      expect(result).toEqual(flags)
    })

    it('listFlagsWithOverrides returns flag + overrides together', async () => {
      const flag = makeFlag()
      const overrides: FlagOverride[] = [
        { flagKey: 'my-flag', tenantId: 'tenant-a', userId: 'u1', enabled: false },
      ]
      vi.mocked(store.getFlag).mockResolvedValue(flag)
      vi.mocked(store.listOverrides).mockResolvedValue(overrides)

      const result = await service.listFlagsWithOverrides('my-flag', 'tenant-a')
      expect(result).toEqual({ flag, overrides })
    })
  })

  // -------------------------------------------------------------------------
  // maxSize eviction
  // -------------------------------------------------------------------------

  describe('maxSize eviction', () => {
    it('evicts oldest entry when cache is full', async () => {
      const tiny = new FeatureFlagService(store, { ttlMs: 60_000, maxSize: 2 })
      vi.mocked(store.getFlag).mockResolvedValue(makeFlag({ enabled: true }))
      vi.mocked(store.listOverrides).mockResolvedValue([])

      // Fill the cache to max
      await tiny.isEnabled('flag-1', 'tenant-a')
      await tiny.isEnabled('flag-2', 'tenant-a')

      // Adding a third should evict flag-1
      await tiny.isEnabled('flag-3', 'tenant-a')

      // flag-1 should be a miss again
      const callsBefore = vi.mocked(store.getFlag).mock.calls.length
      await tiny.isEnabled('flag-1', 'tenant-a')
      expect(vi.mocked(store.getFlag).mock.calls.length).toBe(callsBefore + 1)
    })
  })
})
