/**
 * Tests for ProcessedEventTracker
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ProcessedEventTracker } from '../src/core/ProcessedEventTracker';

describe('ProcessedEventTracker', () => {
  let tracker: ProcessedEventTracker;

  beforeEach(() => {
    tracker = new ProcessedEventTracker({
      maxEvents: 5,
      storageKey: 'test_processed_events',
    });
  });

  describe('has', () => {
    it('should return false for unknown event', () => {
      expect(tracker.has('event1')).toBe(false);
    });

    it('should return true for tracked event', async () => {
      await tracker.add('event1');
      expect(tracker.has('event1')).toBe(true);
    });
  });

  describe('add', () => {
    it('should add event to tracker', async () => {
      await tracker.add('event1');
      expect(tracker.has('event1')).toBe(true);
      expect(tracker.size).toBe(1);
    });

    it('should not add duplicate events', async () => {
      await tracker.add('event1');
      await tracker.add('event1');
      expect(tracker.size).toBe(1);
    });

    it('should respect maxEvents limit (LRU)', async () => {
      // Add 6 events when max is 5
      for (let i = 1; i <= 6; i++) {
        await tracker.add(`event${i}`);
      }

      // First event should be evicted
      expect(tracker.has('event1')).toBe(false);
      // Others should exist
      expect(tracker.has('event2')).toBe(true);
      expect(tracker.has('event6')).toBe(true);
      expect(tracker.size).toBe(5);
    });
  });

  describe('clear', () => {
    it('should clear all tracked events', async () => {
      await tracker.add('event1');
      await tracker.add('event2');
      await tracker.clear();

      expect(tracker.size).toBe(0);
      expect(tracker.has('event1')).toBe(false);
      expect(tracker.has('event2')).toBe(false);
    });
  });

  describe('getAll', () => {
    it('should return all tracked event IDs', async () => {
      await tracker.add('event1');
      await tracker.add('event2');
      await tracker.add('event3');

      const all = tracker.getAll();
      expect(all).toHaveLength(3);
      expect(all).toContain('event1');
      expect(all).toContain('event2');
      expect(all).toContain('event3');
    });

    it('should return events in order added', async () => {
      await tracker.add('event1');
      await tracker.add('event2');
      await tracker.add('event3');

      const all = tracker.getAll();
      expect(all).toEqual(['event1', 'event2', 'event3']);
    });
  });
});
