import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { generateSlots, isDayAvailable } from "../utils/availability.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const productId = url.searchParams.get("productId");
  const date = url.searchParams.get("date");

  if (!shop || !productId || !date) {
    return Response.json(
      { slots: [], error: "Missing parameters" },
      { headers: CORS },
    );
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ slots: [], error: "Invalid date" }, { headers: CORS });
  }

  // Load service config from DB
  const config = await prisma.serviceConfig.findFirst({
    where: { shop, productId: productId.toString() },
  });

  if (!config) {
    return Response.json(
      { slots: [], error: "Service not configured" },
      { headers: CORS },
    );
  }

  // Check if the requested day is available
  const availableDays: string[] = JSON.parse(config.availableDays);
  if (!isDayAvailable(date, availableDays)) {
    return Response.json(
      { slots: [], unavailableDay: true },
      { headers: CORS },
    );
  }

  // Get already-booked times for this product + date
  const existingBookings = await prisma.booking.findMany({
    where: {
      shop,
      productId: productId.toString(),
      date,
      status: { not: "cancelled" },
    },
    select: { time: true },
  });

  const bookedTimes = existingBookings.map((b) => b.time);

  // If the requested date is today (in Europe/Lisbon), block slots within the next 60 minutes
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
    const totalMin =
      nowLisbon.getHours() * 60 + nowLisbon.getMinutes() + BUFFER_MINUTES;
    const hh = Math.floor(totalMin / 60).toString().padStart(2, "0");
    const mm = (totalMin % 60).toString().padStart(2, "0");
    minTime = `${hh}:${mm}`;
  }

  const slots = generateSlots(
    config.startTime,
    config.endTime,
    config.slotDuration,
    bookedTimes,
    minTime,
  );

  return Response.json({ slots }, { headers: CORS });
};

// Also handle OPTIONS via action (some browsers send OPTIONS as non-GET)
export const action = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  return Response.json({ error: "Method not allowed" }, { status: 405, headers: CORS });
};
