export interface TimeSlot {
  time: string;
  available: boolean;
}

const DAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export { DAY_LABELS, DAY_ORDER } from "./days";

/** Given a YYYY-MM-DD date string, returns the lowercase day name (e.g. "monday") */
export function getDayName(date: string): string {
  const d = new Date(date + "T00:00:00");
  return DAYS[d.getDay()];
}

/** Returns true if the given date falls on one of the available days (legacy format) */
export function isDayAvailable(date: string, availableDays: string[]): boolean {
  const dayName = getDayName(date);
  return availableDays.includes(dayName);
}

/**
 * Generates all time slots between startTime and endTime with the given duration.
 * Marks slots as unavailable if they appear in bookedTimes.
 * Pass minTime (HH:MM) to hide slots that are too soon (e.g. today + buffer).
 */
export function generateSlots(
  startTime: string,
  endTime: string,
  durationMinutes: number,
  bookedTimes: string[],
  minTime?: string,
): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);
  const minMinutes = minTime
    ? Number(minTime.split(":")[0]) * 60 + Number(minTime.split(":")[1])
    : null;

  let current = startH * 60 + startM;
  const end = endH * 60 + endM;

  while (current + durationMinutes <= end) {
    const h = Math.floor(current / 60).toString().padStart(2, "0");
    const m = (current % 60).toString().padStart(2, "0");
    const time = `${h}:${m}`;
    const tooSoon = minMinutes !== null && current < minMinutes;
    slots.push({
      time,
      available: !tooSoon && !bookedTimes.includes(time),
    });
    current += durationMinutes;
  }

  return slots;
}

// ── New schedule-based types & helpers ────────────────────────────────────────

export type DayIntervals = { start: string; end: string }[];
export type WeekSchedule = Partial<Record<string, DayIntervals>>;

/** Returns true if the date falls on an active day in the new schedule format */
export function isDayAvailableInSchedule(date: string, schedule: WeekSchedule): boolean {
  return (schedule[getDayName(date)]?.length ?? 0) > 0;
}

/**
 * Generates slots from a WeekSchedule for a given date.
 *
 * staffCount > 1: a time slot is only "full" when bookings at that time >= staffCount,
 * allowing multiple simultaneous bookings (one per staff member).
 */
export function generateSlotsFromSchedule(
  date: string,
  schedule: WeekSchedule,
  durationMinutes: number,
  bookedTimes: string[],
  staffCount: number,
  minTime?: string,
): TimeSlot[] {
  const intervals = schedule[getDayName(date)] ?? [];
  if (intervals.length === 0) return [];

  // With multiple staff, a slot is blocked only when all staff are booked
  let blockedTimes: string[];
  if (staffCount > 1) {
    const counts = new Map<string, number>();
    for (const t of bookedTimes) counts.set(t, (counts.get(t) ?? 0) + 1);
    blockedTimes = [...counts.entries()]
      .filter(([, n]) => n >= staffCount)
      .map(([t]) => t);
  } else {
    blockedTimes = bookedTimes;
  }

  const all: TimeSlot[] = [];
  for (const { start, end } of intervals) {
    all.push(...generateSlots(start, end, durationMinutes, blockedTimes, minTime));
  }
  return all.sort((a, b) => a.time.localeCompare(b.time));
}
