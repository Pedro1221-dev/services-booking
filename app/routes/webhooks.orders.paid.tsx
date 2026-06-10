import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/** Picks the first staff member from the service's staffList who isn't already booked at the given slot. */
async function pickAvailableStaff(
  db: typeof prisma,
  config: any,
  shop: string,
  productId: string,
  date: string,
  time: string,
): Promise<{ staffId: string | null; staffName: string | null }> {
  const staffList: { id: string; name: string }[] = config?.staffList
    ? JSON.parse(config.staffList)
    : [];
  if (staffList.length === 0) {
    return { staffId: config?.staffId ?? null, staffName: config?.staffName ?? null };
  }
  const booked = await (db as any).booking.findMany({
    where: { shop, productId, date, time, status: { not: "cancelled" } },
    select: { staffId: true },
  });
  const busyIds = new Set(booked.map((b: any) => b.staffId));
  const available = staffList.find((s) => !busyIds.has(s.id)) ?? staffList[0];
  return { staffId: available.id, staffName: available.name };
}

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
  // Packages that need an initial booking linked (bought with date+time at checkout)
  type InitialPkgBooking = {
    packageOrderId: string;
    shop: string;
    serviceProductId: string;
    serviceTitle: string;
    date: string;
    time: string;
    customerName: string | null;
    customerEmail: string | null;
    customerPhone: string | null;
  };
  const initialPkgBookings: InitialPkgBooking[] = [];

  for (const item of order.line_items) {
    if (!item.product_id) continue;
    const productId = String(item.product_id);
    const variantId = String((item as any).variant_id ?? "");
    const getProperty = (name: string) =>
      item.properties.find((p) => p.name === name)?.value ?? null;

    // ── Package product — look up PackageConfig by variant ─────────────────
    if (variantId && customerId) {
      const pkgCfg = await (prisma as any).packageConfig.findUnique({
        where: { shop_variantId: { shop, variantId } },
      });
      if (pkgCfg) {
        // Check per-customer limit before creating the package
        if (pkgCfg.maxPerCustomer != null) {
          const existing = await (prisma as any).customerPackage.count({
            where: { shop, shopifyCustomerId: customerId, serviceProductId: pkgCfg.serviceProductId },
          });
          if (existing >= pkgCfg.maxPerCustomer) {
            console.log(`[orders/paid] Customer ${customerId} hit maxPerCustomer (${pkgCfg.maxPerCustomer}) for variant ${variantId} — skipping`);
            continue;
          }
        }

        // If the line item also has booking date+time, the first package will
        // consume 1 credit immediately for that checkout booking.
        const initDate = getProperty("Data da marcação") ?? getProperty("_booking_date");
        const initTime = getProperty("Hora da marcação") ?? getProperty("_booking_time");
        const hasInitBooking = !!(initDate && initTime);

        const qty = (item as any).quantity ?? 1;
        for (let q = 0; q < qty; q++) {
          const pkgOrderId = q === 0 ? orderId : `${orderId}_pkg_${q}`;
          const isFirst = q === 0;
          const creditsUsed = isFirst && hasInitBooking ? 1 : 0;
          packagesToCreate.push({
            shop,
            shopifyCustomerId: customerId,
            customerEmail,
            customerName,
            orderId: pkgOrderId,
            orderName,
            serviceProductId: pkgCfg.serviceProductId,
            serviceTitle: pkgCfg.serviceTitle,
            creditsTotal: pkgCfg.creditsTotal,
            creditsUsed,
            status: creditsUsed >= pkgCfg.creditsTotal ? "exhausted" : "active",
          });
          if (isFirst && hasInitBooking) {
            initialPkgBookings.push({
              packageOrderId: pkgOrderId,
              shop,
              serviceProductId: pkgCfg.serviceProductId,
              serviceTitle: pkgCfg.serviceTitle,
              date: initDate!,
              time: initTime!,
              customerName,
              customerEmail,
              customerPhone: order.customer?.phone ?? null,
            });
          }
        }
        console.log(`[orders/paid] Package: ${pkgCfg.serviceTitle} x${qty} (${pkgCfg.creditsTotal} credits)${hasInitBooking ? ` + init booking ${initDate} ${initTime}` : ""}`);
        continue;
      }
    }

    // ── Regular booking product ────────────────────────────────────────────
    const bookingDate = getProperty("Data da marcação") ?? getProperty("_booking_date");
    const bookingTime = getProperty("Hora da marcação") ?? getProperty("_booking_time");
    if (!bookingDate || !bookingTime) continue;

    const config = await (prisma as any).serviceConfig.findFirst({ where: { shop, productId } });
    const { staffId, staffName } = await pickAvailableStaff(prisma, config, shop, productId, bookingDate, bookingTime);
    bookingsToCreate.push({
      shop,
      orderId: bookingsToCreate.length === 0 ? orderId : `${orderId}_${bookingsToCreate.length}`,
      productId,
      productTitle: item.title,
      date: bookingDate,
      time: bookingTime,
      staffId,
      staffName,
      customerName,
      customerEmail,
      customerPhone: order.customer?.phone ?? null,
      status: "confirmed",
    });
  }

  if (bookingsToCreate.length > 0) {
    // skipDuplicates: if the unique slot index fires (race condition between two simultaneous orders),
    // the later booking is silently skipped rather than crashing the webhook.
    await (prisma as any).booking.createMany({ data: bookingsToCreate, skipDuplicates: true });
    console.log(`[orders/paid] Created ${bookingsToCreate.length} booking(s) for order ${orderId}`);
  }

  if (packagesToCreate.length > 0) {
    await (prisma as any).customerPackage.createMany({ data: packagesToCreate });
    console.log(`[orders/paid] Created ${packagesToCreate.length} package(s) for order ${orderId}`);
  }

  // Create bookings that were selected at checkout and link them to their package
  for (const ib of initialPkgBookings) {
    const pkg = await (prisma as any).customerPackage.findFirst({
      where: { shop: ib.shop, orderId: ib.packageOrderId },
    });
    if (!pkg) continue;
    const config = await (prisma as any).serviceConfig.findFirst({
      where: { shop: ib.shop, productId: ib.serviceProductId },
    });
    const { staffId, staffName } = await pickAvailableStaff(prisma, config, ib.shop, ib.serviceProductId, ib.date, ib.time);
    await (prisma as any).booking.create({
      data: {
        shop: ib.shop,
        orderId: `${ib.packageOrderId}_init`,
        productId: ib.serviceProductId,
        productTitle: ib.serviceTitle,
        date: ib.date,
        time: ib.time,
        staffId,
        staffName,
        customerName: ib.customerName,
        customerEmail: ib.customerEmail,
        customerPhone: ib.customerPhone,
        status: "confirmed",
        packageId: pkg.id,
      },
    });
    console.log(`[orders/paid] Linked init booking ${ib.date} ${ib.time} to package ${pkg.id}`);
  }

  return new Response("OK", { status: 200 });
};
