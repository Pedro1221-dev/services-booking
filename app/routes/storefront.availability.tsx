import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import {
  generateSlots,
  generateSlotsFromSchedule,
  isDayAvailable,
  isDayAvailableInSchedule,
  type WeekSchedule,
} from "../utils/availability.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const productId = url.searchParams.get("productId");
  const date = url.searchParams.get("date");

  if (!shop || !productId || !date) {
    return Response.json({ slots: [], error: "Missing parameters" }, { headers: CORS });
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ slots: [], error: "Invalid date" }, { headers: CORS });
  }

  const config = await prisma.serviceConfig.findFirst({
    where: { shop, productId: productId.toString() },
  });

  if (!config) {
    return Response.json({ slots: [], error: "Service not configured" }, { headers: CORS });
  }

  // Determine schedule format: new (schedule JSON) or legacy (availableDays + startTime/endTime)
  const scheduleRaw = (config as any).schedule as string | undefined;
  const schedule: WeekSchedule = scheduleRaw ? JSON.parse(scheduleRaw) : {};
  const hasNewSchedule = Object.keys(schedule).length > 0;

  // Staff count for capacity calculation
  const staffListRaw = (config as any).staffList as string | undefined;
  const staffList: { id: string; name: string }[] = staffListRaw ? JSON.parse(staffListRaw) : [];
  const staffCount = Math.max(staffList.length, 1);

  // Check if the requested day is available
  if (hasNewSchedule) {
    if (!isDayAvailableInSchedule(date, schedule)) {
      return Response.json({ slots: [], unavailableDay: true }, { headers: CORS });
    }
  } else {
    const availableDays: string[] = JSON.parse(config.availableDays);
    if (!isDayAvailable(date, availableDays)) {
      return Response.json({ slots: [], unavailableDay: true }, { headers: CORS });
    }
  }

  // Get already-booked times for this product + date
  const existingBookings = await prisma.booking.findMany({
    where: { shop, productId: productId.toString(), date, status: { not: "cancelled" } },
    select: { time: true },
  });
  const bookedTimes = existingBookings.map((b) => b.time);

  // Buffer: block slots within 60 min if today
  const BUFFER_MINUTES = 60;
  let minTime: string | undefined;
  const nowLisbon = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Lisbon" }),
  );
  const todayLisbon =
    nowLisbon.getFullYear() +
    "-" +
    String(nowLisbon.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(nowLisbon.getDate()).padStart(2, "0");

  if (date === todayLisbon) {
    const totalMin = nowLisbon.getHours() * 60 + nowLisbon.getMinutes() + BUFFER_MINUTES;
    const hh = Math.floor(totalMin / 60).toString().padStart(2, "0");
    const mm = (totalMin % 60).toString().padStart(2, "0");
    minTime = `${hh}:${mm}`;
  }

  const slots = hasNewSchedule
    ? generateSlotsFromSchedule(date, schedule, config.slotDuration, bookedTimes, staffCount, minTime)
    : generateSlots(config.startTime, config.endTime, config.slotDuration, bookedTimes, minTime);

  return Response.json({ slots }, { headers: CORS });
};

export const action = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  return Response.json({ error: "Method not allowed" }, { status: 405, headers: CORS });
};
