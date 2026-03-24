/**
 * User Preferences Service
 *
 * Manages learned user preferences for personalized task management:
 * - Urgency calibration (what "urgent" means for this user)
 * - Working hours patterns
 * - Typical task durations by type
 * - Communication style preferences
 *
 * Phase 5: Task Processing Pipeline Enhancements
 */

import { db } from '../db/index.js';
import { userPreferences } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

export interface UserPreference {
  id: string;
  userId: string;
  preferenceKey: string;
  preferenceValue: any;
  confidence: number;
  lastObservedAt: Date;
  sampleCount: number;
}

export interface LearnedSchedule {
  workingHoursStart: string;  // "09:00"
  workingHoursEnd: string;    // "17:00"
  workingDays: number[];      // [1,2,3,4,5] for Mon-Fri
  typicalReviewDuration: number; // minutes
  typicalMeetingDuration: number; // minutes
}

export interface UrgencyCalibration {
  urgentSameDay: boolean;      // "urgent" means today?
  asapThisWeek: boolean;       // "asap" means this week?
  soonByFriday: boolean;       // "soon" means by Friday?
  highPriorityUrgent: boolean; // "high priority" = urgent?
}

/**
 * Get a user preference
 */
export async function getPreference(
  userId: string,
  preferenceKey: string
): Promise<any> {
  const pref = await db
    .select()
    .from(userPreferences)
    .where(
      and(
        eq(userPreferences.userId, userId),
        eq(userPreferences.preferenceKey, preferenceKey)
      )
    )
    .limit(1)
    .then(rows => rows[0]);

  return pref?.preferenceValue ?? null;
}

/**
 * Update a user preference with learning
 * Uses exponential moving average for confidence
 */
export async function updatePreference(
  userId: string,
  preferenceKey: string,
  value: any,
  confidence?: number
): Promise<void> {
  const existing = await db
    .select()
    .from(userPreferences)
    .where(
      and(
        eq(userPreferences.userId, userId),
        eq(userPreferences.preferenceKey, preferenceKey)
      )
    )
    .limit(1)
    .then(rows => rows[0]);

  if (existing) {
    // Update with exponential moving average for confidence
    const newConfidence = confidence ?? 0.5;
    const oldConfidence = existing.confidence ?? 0.5;
    const prevSamples = existing.sampleCount ?? 1;
    const sampleCount = prevSamples + 1;
    const combinedConfidence = (oldConfidence * prevSamples + newConfidence) / sampleCount;

    await db
      .update(userPreferences)
      .set({
        preferenceValue: value,
        confidence: combinedConfidence,
        sampleCount,
        lastObservedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(userPreferences.id, existing.id));
  } else {
    await db
      .insert(userPreferences)
      .values({
        userId,
        preferenceKey,
        preferenceValue: value,
        confidence: confidence ?? 0.5,
        sampleCount: 1,
        lastObservedAt: new Date(),
      });
  }
}

/**
 * Learn from user behavior (task completion patterns)
 */
export async function learnFromTaskCompletion(params: {
  userId: string;
  taskId: string;
  originalDueDate: Date | null;
  completedAt: Date;
  priority: string;
  estimatedDuration?: number;
  actualDuration?: number; // calculated from creation to completion
}): Promise<void> {
  const { userId, originalDueDate, completedAt, priority, estimatedDuration, actualDuration } = params;

  // Learn about urgency calibration
  if (originalDueDate && priority === 'high') {
    const daysDiff = Math.abs(completedAt.getTime() - originalDueDate.getTime()) / (1000 * 60 * 60 * 24);

    // If user completed "high priority" task more than a day from deadline,
    // learn that "high priority" != "urgent" for this user
    if (daysDiff > 1) {
      await updatePreference(userId, 'urgency_high_priority_urgent', false, 0.7);
    }
  }

  // Learn about task duration estimates
  if (estimatedDuration && actualDuration) {
    const ratio = actualDuration / estimatedDuration;
    const taskTypeKey = `duration_multiplier_${priority}`; // Could be more specific
    await updatePreference(userId, taskTypeKey, ratio, 0.6);
  }

  // Learn about working hours
  const hourOfDay = completedAt.getHours();
  const dayOfWeek = completedAt.getDay();

  // Store individual observations (will be aggregated later)
  const existingObservations = await getPreference(userId, 'working_hours_active') || [];
  existingObservations.push({ hour: hourOfDay, day: dayOfWeek, timestamp: completedAt });

  // Keep only last 100 observations
  if (existingObservations.length > 100) {
    existingObservations.splice(0, existingObservations.length - 100);
  }

  await updatePreference(userId, 'working_hours_active', existingObservations, 0.3);
}

/**
 * Get learned schedule for user
 */
export async function getLearnedSchedule(userId: string): Promise<LearnedSchedule> {
  const defaults: LearnedSchedule = {
    workingHoursStart: '09:00',
    workingHoursEnd: '17:00',
    workingDays: [1, 2, 3, 4, 5],
    typicalReviewDuration: 30,
    typicalMeetingDuration: 60,
  };

  const activeTimes = await getPreference(userId, 'working_hours_active');

  if (!activeTimes || !Array.isArray(activeTimes)) {
    return defaults;
  }

  // Analyze active times to find patterns
  const hourCounts = new Map<number, number>();
  const dayCounts = new Map<number, number>();

  for (const entry of activeTimes.slice(-100)) { // Last 100 observations
    hourCounts.set(entry.hour, (hourCounts.get(entry.hour) || 0) + 1);
    dayCounts.set(entry.day, (dayCounts.get(entry.day) || 0) + 1);
  }

  // Find most common hours (start/end of work day)
  const sortedHours = Array.from(hourCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0])
    .filter(h => hourCounts.get(h)! > 2); // At least 3 observations

  if (sortedHours.length >= 2) {
    const minHour = Math.min(...sortedHours);
    const maxHour = Math.max(...sortedHours);
    defaults.workingHoursStart = `${String(minHour).padStart(2, '0')}:00`;
    defaults.workingHoursEnd = `${String(maxHour + 1).padStart(2, '0')}:00`;
  }

  // Find working days
  const workingDays = Array.from(dayCounts.entries())
    .filter(([_, count]) => count > 5) // At least 5 tasks on this day
    .map(([day, _]) => day)
    .sort();

  if (workingDays.length > 0) {
    defaults.workingDays = workingDays;
  }

  // Get typical durations
  const reviewDuration = await getPreference(userId, 'typical_review_duration');
  if (reviewDuration) defaults.typicalReviewDuration = reviewDuration;

  const meetingDuration = await getPreference(userId, 'typical_meeting_duration');
  if (meetingDuration) defaults.typicalMeetingDuration = meetingDuration;

  return defaults;
}

/**
 * Get urgency calibration for user
 */
export async function getUrgencyCalibration(userId: string): Promise<UrgencyCalibration> {
  return {
    urgentSameDay: await getPreference(userId, 'urgency_same_day') ?? true,
    asapThisWeek: await getPreference(userId, 'urgency_asap_this_week') ?? true,
    soonByFriday: await getPreference(userId, 'urgency_soon_by_friday') ?? true,
    highPriorityUrgent: await getPreference(userId, 'urgency_high_priority_urgent') ?? true,
  };
}

