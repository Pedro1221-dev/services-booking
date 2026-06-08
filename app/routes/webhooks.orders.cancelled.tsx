import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CANCELLED") {
    return new Response("Unhandled topic", { status: 400 });
  }

  const order = payload as { id: number };
  const orderId = String(order.id);

  // Cancel the CustomerPackage associated with this order (and any _pkg_N variants)
  const packages = await (prisma as any).customerPackage.findMany({
    where: {
      shop,
      OR: [
        { orderId },
        { orderId: { startsWith: `${orderId}_pkg_` } },
      ],
      status: { not: "cancelled" },
    },
    select: { id: true },
  });

  if (packages.length === 0) {
    return new Response("No packages found", { status: 200 });
  }

  const packageIds = packages.map((p: any) => p.id);

  // Cancel future bookings linked to these packages (past bookings stay as-is)
  const today = new Date().toISOString().slice(0, 10);
  await (prisma as any).booking.updateMany({
    where: {
      packageId: { in: packageIds },
      date: { gte: today },
      status: { not: "cancelled" },
    },
    data: { status: "cancelled" },
  });

  // Cancel the packages themselves
  await (prisma as any).customerPackage.updateMany({
    where: { id: { in: packageIds } },
    data: { status: "cancelled" },
  });

  console.log(`[orders/cancelled] Cancelled ${packages.length} package(s) for order ${orderId}`);
  return new Response("OK", { status: 200 });
};
