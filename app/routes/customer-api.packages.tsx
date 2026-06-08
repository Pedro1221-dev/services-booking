/**
 * GET /customer-api/packages?shop=xxx&customerId=yyy
 *
 * Called by the Customer Account UI Extension to list packages + bookings.
 * Also handles POST to create a booking using a package credit.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ── GET — list packages for a customer ───────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const customerId = url.searchParams.get("customerId"); // numeric Shopify customer ID

  if (!shop || !customerId) {
    return Response.json({ error: "Missing shop or customerId" }, { status: 400, headers: CORS });
  }

  const packages = await (prisma as any).customerPackage.findMany({
    where: { shop, shopifyCustomerId: customerId },
    orderBy: { createdAt: "desc" },
    include: {
      bookings: {
        where: { status: { not: "cancelled" } },
        orderBy: { date: "asc" },
        select: { id: true, date: true, time: true, productTitle: true, status: true },
      },
    },
  });

  const result = packages.map((pkg: any) => ({
    id: pkg.id,
    serviceProductId: pkg.serviceProductId,
    serviceTitle: pkg.serviceTitle,
    orderName: pkg.orderName,
    creditsTotal: pkg.creditsTotal,
    creditsUsed: pkg.creditsUsed,
    creditsRemaining: pkg.creditsTotal - pkg.creditsUsed,
    status: pkg.status,
    createdAt: pkg.createdAt,
    bookings: pkg.bookings,
  }));

  return Response.json({ packages: result }, { headers: CORS });
};

// ── POST — create a booking using a package credit ────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const body = await request.json() as {
    shop: string;
    customerId: string;
    packageId: string;
    date: string;
    time: string;
    customerName?: string;
    customerEmail?: string;
  };

  const { shop, customerId, packageId, date, time, customerName, customerEmail } = body;
  if (!shop || !customerId || !packageId || !date || !time) {
    return Response.json({ error: "Missing required fields" }, { status: 400, headers: CORS });
  }

  // Validate package belongs to this customer and has credits
  const pkg = await (prisma as any).customerPackage.findFirst({
    where: { id: packageId, shop, shopifyCustomerId: customerId, status: "active" },
  });

  if (!pkg) {
    return Response.json({ error: "Package not found or not active" }, { status: 404, headers: CORS });
  }

  if (pkg.creditsUsed >= pkg.creditsTotal) {
    return Response.json({ error: "No credits remaining" }, { status: 400, headers: CORS });
  }

  // Check slot is not already booked
  const conflict = await (prisma as any).booking.findFirst({
    where: { shop, productId: pkg.serviceProductId, date, time, status: { not: "cancelled" } },
  });
  if (conflict) {
    return Response.json({ error: "Slot already booked" }, { status: 409, headers: CORS });
  }

  // Get staff from service config
  const config = await (prisma as any).serviceConfig.findFirst({
    where: { shop, productId: pkg.serviceProductId },
  });

  // Create booking + consume credit atomically
  let booking: any;
  try {
    [booking] = await (prisma as any).$transaction([
      (prisma as any).booking.create({
        data: {
          shop,
          productId: pkg.serviceProductId,
          productTitle: pkg.serviceTitle,
          date,
          time,
          staffId: config?.staffId ?? null,
          staffName: config?.staffName ?? null,
          customerName: customerName ?? pkg.customerName ?? null,
          customerEmail: customerEmail ?? pkg.customerEmail ?? null,
          status: "confirmed",
          packageId: pkg.id,
        },
      }),
      (prisma as any).customerPackage.update({
        where: { id: pkg.id },
        data: {
          creditsUsed: { increment: 1 },
          status: pkg.creditsUsed + 1 >= pkg.creditsTotal ? "exhausted" : "active",
        },
      }),
    ]);
  } catch (e: any) {
    if (e?.code === "P2002") {
      return Response.json({ error: "Slot already booked" }, { status: 409, headers: CORS });
    }
    throw e;
  }

  return Response.json({ ok: true, bookingId: booking.id }, { headers: CORS });
};
