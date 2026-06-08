import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_PAID") {
    return new Response("Unhandled topic", { status: 400 });
  }

  type LineItemProperty = { name: string; value: string };
  type LineItem = {
    product_id: number | null;
    title: string;
    quantity: number;
    properties: LineItemProperty[];
    tags?: string; // not always present on line items
  };
  type OrderPayload = {
    id: number;
    name: string; // e.g. "#1042"
    order_number: number;
    customer?: {
      id: number;
      email: string;
      first_name: string;
      last_name: string;
      phone?: string;
    };
    line_items: LineItem[];
  };

  const order = payload as OrderPayload;
  const orderId = String(order.id);
  const orderName = order.name ?? `#${order.order_number}`;
  const customerId = order.customer ? String(order.customer.id) : null;
  const customerEmail = order.customer?.email ?? null;
  const customerName = order.customer
    ? `${order.customer.first_name ?? ""} ${order.customer.last_name ?? ""}`.trim()
    : null;

  // Guard: already fully processed this order (check bookings)
  const existingBooking = await (prisma as any).booking.findUnique({ where: { orderId } });
  const existingPackage = await (prisma as any).customerPackage.findFirst({ where: { shop, orderId } });
  if (existingBooking && existingPackage) {
    return new Response("Already processed", { status: 200 });
  }

  const bookingsToCreate: any[] = [];
  const packagesToCreate: any[] = [];

  for (const item of order.line_items) {
    if (!item.product_id) continue;
    const productId = String(item.product_id);
    const variantId = String((item as any).variant_id ?? "");
    const getProperty = (name: string) =>
      item.properties.find((p) => p.name === name)?.value ?? null;

    // ── Package product — look up PackageConfig by variant ─────────────────
    // Prefer DB config; fall back to legacy line-item properties for old orders.
    let pkgServiceId: string | null = null;
    let pkgCredits: number | null = null;
    let pkgServiceTitle: string = item.title;

    if (variantId && customerId) {
      const pkgCfg = await (prisma as any).packageConfig.findUnique({
        where: { shop_variantId: { shop, variantId } },
      });
      if (pkgCfg) {
        pkgServiceId  = pkgCfg.serviceProductId;
        pkgCredits    = pkgCfg.creditsTotal;
        pkgServiceTitle = pkgCfg.serviceTitle;
      }
    }
    // Legacy fallback: line-item properties
    if (!pkgServiceId) {
      pkgServiceId  = getProperty("_package_service_id");
      const raw     = getProperty("_package_credits");
      pkgCredits    = raw ? parseInt(raw, 10) : null;
      pkgServiceTitle = getProperty("_package_service_title") ?? item.title;
    }

    if (pkgServiceId && pkgCredits && pkgCredits > 0 && customerId) {
      for (let q = 0; q < (item.quantity ?? 1); q++) {
        packagesToCreate.push({
          shop,
          shopifyCustomerId: customerId,
          customerEmail,
          customerName,
          orderId: q === 0 ? orderId : `${orderId}_pkg_${q}`,
          orderName,
          serviceProductId: pkgServiceId,
          serviceTitle: pkgServiceTitle,
          creditsTotal: pkgCredits,
          creditsUsed: 0,
          status: "active",
        });
      }
      console.log(`[orders/paid] Package detected: ${pkgServiceTitle} x${item.quantity} (${pkgCredits} credits each)`);
      continue;
    }

    // ── Regular booking product ────────────────────────────────────────────
    const bookingDate = getProperty("Data da marcação") ?? getProperty("_booking_date");
    const bookingTime = getProperty("Hora da marcação") ?? getProperty("_booking_time");
    if (!bookingDate || !bookingTime) continue;

    const config = await (prisma as any).serviceConfig.findFirst({ where: { shop, productId } });
    bookingsToCreate.push({
      shop,
      orderId: bookingsToCreate.length === 0 ? orderId : `${orderId}_${bookingsToCreate.length}`,
      productId,
      productTitle: item.title,
      date: bookingDate,
      time: bookingTime,
      staffId: config?.staffId ?? null,
      staffName: config?.staffName ?? null,
      customerName,
      customerEmail,
      customerPhone: order.customer?.phone ?? null,
      status: "confirmed",
    });
  }

  if (bookingsToCreate.length > 0) {
    await (prisma as any).booking.createMany({ data: bookingsToCreate });
    console.log(`[orders/paid] Created ${bookingsToCreate.length} booking(s) for order ${orderId}`);
  }

  if (packagesToCreate.length > 0) {
    await (prisma as any).customerPackage.createMany({ data: packagesToCreate });
    console.log(`[orders/paid] Created ${packagesToCreate.length} package(s) for order ${orderId}`);
  }

  return new Response("OK", { status: 200 });
};
