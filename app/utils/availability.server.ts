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

export const DAY_LABELS: Record<string, string> = {
  monday: "Segunda-feira",
  tuesday: "Terça-feira",
  wednesday: "Quarta-feira",
  thursday: "Quinta-feira",
  friday: "Sexta-feira",
  saturday: "Sábado",
  sunday: "Domingo",
};

export const DAY_ORDER = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

/** Given a YYYY-MM-DD date string, returns the lowercase day name (e.g. "monday") */
export function getDayName(date: string): string {
  const d = new Date(date + "T00:00:00");
  return DAYS[d.getDay()];
}

/** Returns true if the given date falls on one of the available days */
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
  minTime?: string,   // optional — slots strictly before this are marked unavailable
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
