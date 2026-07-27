/**
 * Tests for ExpiredSessionsSweeper
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { ExpiredSessionsSweeper, sweepExpiredSessions } from './expiredSessionsSweeper.js'
import type { Queryable } from '../db/repositories/queryable.js'

function createMockQueryable(rows: any[] = []): Queryable {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  } as unknown as Queryable
}

describe('ExpiredSessionsSweeper', () => {
  let mockDb: Queryable
  let logger: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockDb = createMockQueryable()
    logger = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('run', () => {
    it('should count and delete expired session rows', async () => {
      const mockQuery = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ count: '42' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 10 })

      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new ExpiredSessionsSweeper(mockDb, { logger })
      const result = await sweeper.run()

      expect(result.expiredCount).toBe(42)
      expect(result.deletedCount).toBe(10)
      expect(result.dryRun).toBe(false)
      expect(mockQuery).toHaveBeenCalledTimes(2)
    })

    it('should not delete in dry-run mode', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '10' }] })
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new ExpiredSessionsSweeper(mockDb, { dryRun: true, logger })
      const result = await sweeper.run()

      expect(result.expiredCount).toBe(10)
      expect(result.deletedCount).toBe(0)
      expect(result.dryRun).toBe(true)
      expect(mockQuery).toHaveBeenCalledTimes(1)
    })

    it('should delete in batches', async () => {
      const mockQuery = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ count: '15000' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 5000 })
        .mockResolvedValueOnce({ rows: [], rowCount: 5000 })
        .mockResolvedValueOnce({ rows: [], rowCount: 5000 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })

      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new ExpiredSessionsSweeper(mockDb, { batchSize: 5000, logger })
      const result = await sweeper.run()

      expect(result.expiredCount).toBe(15000)
      expect(result.deletedCount).toBe(15000)
    })

    it('should handle no expired rows', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '0' }] })
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new ExpiredSessionsSweeper(mockDb, { logger })
      const result = await sweeper.run()

      expect(result.expiredCount).toBe(0)
      expect(result.deletedCount).toBe(0)
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Found 0 expired session rows'),
      )
    })

    it('should log progress', async () => {
      const mockQuery = vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ count: '100' }] })
        .mockResolvedValueOnce({ rows: [], rowCount: 100 })

      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new ExpiredSessionsSweeper(mockDb, { logger })
      await sweeper.run()

      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Found 100 expired session rows'),
      )
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Deleted batch of 100 rows'),
      )
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Completed: expired=100 deleted=100'),
      )
    })

    it('should track duration', async () => {
      const sweeper = new ExpiredSessionsSweeper(mockDb, { logger })
      const result = await sweeper.run()

      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('should prevent concurrent runs', async () => {
      const mockQuery = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ rows: [{ count: '0' }] }), 100),
          ),
      )
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new ExpiredSessionsSweeper(mockDb, { logger })

      const [result1, result2] = await Promise.all([
        sweeper.run(),
        sweeper.run(),
      ])

      expect(result1.expiredCount).toBe(0)
      expect(result2.expiredCount).toBe(0)
      expect(result2.durationMs).toBe(0)
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Already running, skipping'),
      )
    })

    it('should log dry-run in count output', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '5' }] })
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new ExpiredSessionsSweeper(mockDb, { dryRun: true, logger })
      await sweeper.run()

      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('(dry-run)'),
      )
    })
  })

  describe('start/stop', () => {
    it('should start periodic cleanup', async () => {
      vi.useFakeTimers()

      const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '0' }] })
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new ExpiredSessionsSweeper(mockDb, {
        intervalMs: 1000,
        logger,
      })

      sweeper.start()

      await vi.advanceTimersByTimeAsync(1000)

      expect(mockQuery).toHaveBeenCalled()
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Starting periodic cleanup'),
      )

      sweeper.stop()
      vi.useRealTimers()
    })

    it('should not start twice', async () => {
      const sweeper = new ExpiredSessionsSweeper(mockDb, { logger })

      sweeper.start()
      sweeper.start()

      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Already running'),
      )

      sweeper.stop()
    })

    it('should stop periodic cleanup', async () => {
      const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '0' }] })
      mockDb = { query: mockQuery } as unknown as Queryable
      const sweeper = new ExpiredSessionsSweeper(mockDb, { logger })

      sweeper.start()
      await Promise.resolve()
      await Promise.resolve()
      expect(sweeper.isRunning()).toBe(false)

      sweeper.stop()
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining('Stopped'),
      )
    })
  })

  describe('isRunning', () => {
    it('should return a boolean', async () => {
      const mockQuery = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ rows: [{ count: '0' }] }), 50),
          ),
      )
      mockDb = { query: mockQuery } as unknown as Queryable

      const sweeper = new ExpiredSessionsSweeper(mockDb, { logger })

      const runPromise = sweeper.run()
      expect(typeof sweeper.isRunning()).toBe('boolean')
      await runPromise
    })
  })
})

describe('sweepExpiredSessions', () => {
  it('should run a single cleanup cycle', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [{ count: '5' }] })
    const mockDb = { query: mockQuery } as unknown as Queryable

    const result = await sweepExpiredSessions(mockDb, { dryRun: true })

    expect(result.expiredCount).toBe(5)
    expect(result.dryRun).toBe(true)
  })
})
