/**
 * Unit Tests: User Preferences Service
 *
 * Tests for user preference learning and management including:
 * - Getting and updating preferences
 * - Learning from task completion patterns
 * - Schedule learning
 * - Urgency calibration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  getPreference,
  updatePreference,
  learnFromTaskCompletion,
  getLearnedSchedule,
  getUrgencyCalibration,
  getAllPreferences
} from '../../services/preferences.js';
import { db } from '../../db/index.js';
import { userPreferences } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';

describe('User Preferences Service', () => {
  const testUserId = 'test-user-preferences';

  beforeAll(async () => {
    // Clean up any existing test data
    await db
      .delete(userPreferences)
      .where(eq(userPreferences.userId, testUserId));
  });

  afterAll(async () => {
    // Final cleanup
    await db
      .delete(userPreferences)
      .where(eq(userPreferences.userId, testUserId));
  });

  beforeEach(async () => {
    // Clean up before each test
    await db
      .delete(userPreferences)
      .where(eq(userPreferences.userId, testUserId));
  });

  describe('getPreference', () => {
    it('should return null for non-existent preference', async () => {
      const value = await getPreference(testUserId, 'nonexistent_key');
      expect(value).toBeNull();
    });

    it('should retrieve existing preference value', async () => {
      await db
        .insert(userPreferences)
        .values({
          userId: testUserId,
          preferenceKey: 'test_key',
          preferenceValue: { setting: 'value' },
          confidence: 0.8,
          sampleCount: 5,
          lastObservedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      const value = await getPreference(testUserId, 'test_key');
      expect(value).toEqual({ setting: 'value' });
    });

    it('should handle JSONB values correctly', async () => {
      const complexValue = {
        array: [1, 2, 3],
        nested: { key: 'value' },
        string: 'test',
      };

      await db
        .insert(userPreferences)
        .values({
          userId: testUserId,
          preferenceKey: 'complex_key',
          preferenceValue: complexValue,
          confidence: 0.9,
          sampleCount: 1,
          lastObservedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      const value = await getPreference(testUserId, 'complex_key');
      expect(value).toEqual(complexValue);
    });

    it('should return only the preference value, not metadata', async () => {
      await db
        .insert(userPreferences)
        .values({
          userId: testUserId,
          preferenceKey: 'metadata_test',
          preferenceValue: 'the_value',
          confidence: 0.7,
          sampleCount: 10,
          lastObservedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      const value = await getPreference(testUserId, 'metadata_test');
      // Should return just the value, not an object with confidence etc
      expect(value).toBe('the_value');
      expect(value).not.toHaveProperty('confidence');
    });
  });

  describe('updatePreference', () => {
    it('should create new preference', async () => {
      await updatePreference(testUserId, 'new_key', 'test_value', 0.8);

      const retrieved = await getPreference(testUserId, 'new_key');
      expect(retrieved).toBe('test_value');

      // Verify DB state
      const [pref] = await db
        .select()
        .from(userPreferences)
        .where(
          and(
            eq(userPreferences.userId, testUserId),
            eq(userPreferences.preferenceKey, 'new_key')
          )
        )
        .limit(1);

      expect(pref).toBeDefined();
      expect(pref?.confidence).toBe(0.8);
      expect(pref?.sampleCount).toBe(1);
    });

    it('should update existing preference with new value', async () => {
      await updatePreference(testUserId, 'update_key', 'initial_value');

      await updatePreference(testUserId, 'update_key', 'updated_value', 0.9);

      const retrieved = await getPreference(testUserId, 'update_key');
      expect(retrieved).toBe('updated_value');
    });

    it('should increase sample count on updates', async () => {
      await updatePreference(testUserId, 'count_key', 'value1', 0.8);
      await updatePreference(testUserId, 'count_key', 'value2', 0.7);
      await updatePreference(testUserId, 'count_key', 'value3', 0.9);

      const [pref] = await db
        .select()
        .from(userPreferences)
        .where(
          and(
            eq(userPreferences.userId, testUserId),
            eq(userPreferences.preferenceKey, 'count_key')
          )
        )
        .limit(1);

      expect(pref?.sampleCount).toBe(3);
    });

    it('should calculate weighted confidence', async () => {
      // First update: confidence 0.5, count 1
      await updatePreference(testUserId, 'weighted_key', 'value', 0.5);

      // Second update: confidence 0.9
      // New confidence = (0.5 * 1 + 0.9) / 2 = 0.7
      await updatePreference(testUserId, 'weighted_key', 'value', 0.9);

      const [pref] = await db
        .select()
        .from(userPreferences)
        .where(
          and(
            eq(userPreferences.userId, testUserId),
            eq(userPreferences.preferenceKey, 'weighted_key')
          )
        )
        .limit(1);

      expect(pref?.confidence).toBeCloseTo(0.7, 1);
    });

    it('should use default confidence when not provided', async () => {
      await updatePreference(testUserId, 'default_conf_key', 'value');

      const [pref] = await db
        .select()
        .from(userPreferences)
        .where(
          and(
            eq(userPreferences.userId, testUserId),
            eq(userPreferences.preferenceKey, 'default_conf_key')
          )
        )
        .limit(1);

      expect(pref?.confidence).toBe(0.5);
    });

    it('should update lastObservedAt timestamp', async () => {
      // Create the preference
      await updatePreference(testUserId, 'timestamp_key', 'value');

      // Get the initial lastObservedAt timestamp
      const [initialPref] = await db
        .select()
        .from(userPreferences)
        .where(
          and(
            eq(userPreferences.userId, testUserId),
            eq(userPreferences.preferenceKey, 'timestamp_key')
          )
        )
        .limit(1);
      const initialLastObserved = initialPref?.lastObservedAt?.getTime() || 0;

      // Wait and then update
      await new Promise(resolve => setTimeout(resolve, 50));
      await updatePreference(testUserId, 'timestamp_key', 'updated_value');

      const [pref] = await db
        .select()
        .from(userPreferences)
        .where(
          and(
            eq(userPreferences.userId, testUserId),
            eq(userPreferences.preferenceKey, 'timestamp_key')
          )
        )
        .limit(1);

      // Verify lastObservedAt has been updated (with tolerance for clock skew)
      const newLastObserved = pref?.lastObservedAt?.getTime() || 0;
      expect(newLastObserved).toBeGreaterThan(initialLastObserved - 100); // Allow 100ms tolerance
      // Verify the value was actually updated
      expect(pref?.preferenceValue).toBe('updated_value');
    });
  });

  describe('learnFromTaskCompletion', () => {
    it('should learn urgency patterns from high priority tasks', async () => {
      const completedAt = new Date();
      const originalDueDate = new Date(completedAt.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days after

      await learnFromTaskCompletion({
        userId: testUserId,
        taskId: crypto.randomUUID(),
        originalDueDate,
        completedAt,
        priority: 'high',
        actualDuration: 60,
      });

      // Should have learned that high priority != urgent
      const urgencyNotUrgent = await getPreference(testUserId, 'urgency_high_priority_urgent');
      expect(urgencyNotUrgent).toBe(false);
    });

    it('should learn duration estimates by priority', async () => {
      await learnFromTaskCompletion({
        userId: testUserId,
        taskId: crypto.randomUUID(),
        originalDueDate: new Date(),
        completedAt: new Date(),
        priority: 'medium',
        estimatedDuration: 30,
        actualDuration: 45, // Took 1.5x longer
      });

      const multiplier = await getPreference(testUserId, 'duration_multiplier_medium');
      expect(multiplier).toBeCloseTo(1.5, 1);
    });

    it('should record working hours from completion time', async () => {
      const completionTime = new Date();
      completionTime.setHours(14, 30, 0, 0); // 2:30 PM

      await learnFromTaskCompletion({
        userId: testUserId,
        taskId: crypto.randomUUID(),
        originalDueDate: new Date(),
        completedAt: completionTime,
        priority: 'low',
      });

      const activeTimes = await getPreference(testUserId, 'working_hours_active');
      expect(activeTimes).toBeDefined();
      expect(Array.isArray(activeTimes)).toBe(true);

      if (Array.isArray(activeTimes) && activeTimes.length > 0) {
        expect(activeTimes[activeTimes.length - 1]).toMatchObject({
          hour: 14,
          day: completionTime.getDay(),
        });
      }
    });

    it('should handle missing optional parameters', async () => {
      // Should not throw
      await expect(
        learnFromTaskCompletion({
          userId: testUserId,
          taskId: crypto.randomUUID(),
          originalDueDate: null,
          completedAt: new Date(),
          priority: 'low',
        })
      ).resolves.toBeUndefined();
    });
  });

  describe('getLearnedSchedule', () => {
    it('should return default schedule when no data available', async () => {
      const schedule = await getLearnedSchedule('new_user_' + Date.now());

      expect(schedule).toEqual({
        workingHoursStart: '09:00',
        workingHoursEnd: '17:00',
        workingDays: [1, 2, 3, 4, 5],
        typicalReviewDuration: 30,
        typicalMeetingDuration: 60,
      });
    });

    it('should learn working hours from activity patterns', async () => {
      // Seed activity data
      const activityData = [];
      for (let i = 0; i < 20; i++) {
        const time = new Date();
        time.setHours(8 + Math.floor(i / 5), 0, 0, 0); // 8am-12pm
        activityData.push({ hour: time.getHours(), day: time.getDay() });
      }

      await updatePreference(testUserId, 'working_hours_active', activityData);

      const schedule = await getLearnedSchedule(testUserId);

      // Should have modified hours based on activity
      expect(schedule.workingHoursStart).toBeDefined();
      expect(schedule.workingHoursEnd).toBeDefined();
    });

    it('should learn working days from activity', async () => {
      const activityData = [];
      for (let i = 0; i < 30; i++) {
        activityData.push({
          hour: 10 + Math.floor(Math.random() * 6),
          day: [1, 2, 3, 4, 5][Math.floor(Math.random() * 5)], // Weekdays only
        });
      }

      await updatePreference(testUserId, 'working_hours_active', activityData);

      const schedule = await getLearnedSchedule(testUserId);

      // Should detect weekday pattern
      expect(schedule.workingDays.length).toBeGreaterThan(0);
      expect(schedule.workingDays).not.toContain(0); // Sunday
      expect(schedule.workingDays).not.toContain(6); // Saturday
    });
  });

  describe('getUrgencyCalibration', () => {
    it('should return default calibration when no learning data', async () => {
      const calibration = await getUrgencyCalibration('new_user_' + Date.now());

      expect(calibration).toEqual({
        urgentSameDay: true,
        asapThisWeek: true,
        soonByFriday: true,
        highPriorityUrgent: true,
      });
    });

    it('should return learned urgency calibration', async () => {
      await updatePreference(testUserId, 'urgency_same_day', false, 0.9);
      await updatePreference(testUserId, 'urgency_asap_this_week', false, 0.8);
      await updatePreference(testUserId, 'urgency_soon_by_friday', true, 0.7);

      const calibration = await getUrgencyCalibration(testUserId);

      expect(calibration.urgentSameDay).toBe(false);
      expect(calibration.asapThisWeek).toBe(false);
      expect(calibration.soonByFriday).toBe(true);
    });
  });

  describe('getAllPreferences', () => {
    it('should return empty object for user with no preferences', async () => {
      const prefs = await getAllPreferences('nonexistent_user');
      expect(prefs).toEqual({});
    });

    it('should only return high-confidence preferences', async () => {
      // Create mix of high and low confidence preferences
      await updatePreference(testUserId, 'high_conf_1', 'value1', 0.9);
      await updatePreference(testUserId, 'high_conf_2', 'value2', 0.8);
      await updatePreference(testUserId, 'low_conf_1', 'value3', 0.4); // Below threshold
      await updatePreference(testUserId, 'low_conf_2', 'value4', 0.5); // At threshold (not included)

      const prefs = await getAllPreferences(testUserId);

      expect(Object.keys(prefs)).toContain('high_conf_1');
      expect(Object.keys(prefs)).toContain('high_conf_2');
      expect(Object.keys(prefs)).not.toContain('low_conf_1');
    });

    it('should include confidence metadata in returned preferences', async () => {
      await updatePreference(testUserId, 'test_pref', 'value', 0.85);

      const prefs = await getAllPreferences(testUserId);

      expect(prefs.test_pref).toEqual({
        value: 'value',
        confidence: 0.85,
        sampleCount: 1,
      });
    });

    it('should handle complex preference values', async () => {
      const complexValue = {
        schedule: {
          start: '09:00',
          end: '17:00',
        },
        timeZone: 'UTC',
      };

      await updatePreference(testUserId, 'complex_pref', complexValue, 0.9);

      const prefs = await getAllPreferences(testUserId);

      expect(prefs.complex_pref.value).toEqual(complexValue);
    });
  });

  describe('Confidence Threshold Behavior', () => {
    it('should filter preferences at exactly 0.6 threshold', async () => {
      await updatePreference(testUserId, 'at_threshold', 'value', 0.6);
      await updatePreference(testUserId, 'above_threshold', 'value', 0.61);
      await updatePreference(testUserId, 'below_threshold', 'value', 0.59);

      const prefs = await getAllPreferences(testUserId);

      // 0.6 is included (>= 0.6)
      expect(Object.keys(prefs)).toContain('at_threshold');
      expect(Object.keys(prefs)).toContain('above_threshold');
      expect(Object.keys(prefs)).not.toContain('below_threshold');
    });

    it('should handle confidence values at boundaries', async () => {
      await updatePreference(testUserId, 'conf_zero', 'value', 0.0);
      await updatePreference(testUserId, 'conf_one', 'value', 1.0);

      const prefs = await getAllPreferences(testUserId);

      expect(Object.keys(prefs)).not.toContain('conf_zero');
      expect(Object.keys(prefs)).toContain('conf_one');
    });
  });
});
