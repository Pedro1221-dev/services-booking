import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

function getWeekBounds() {
  const now = new Date();
  const day = now.getDay();
  const startDiff = day === 0 ? -6 : 1 - day;
  const start = new Date(now);
  start.setDate(now.getDate() + startDiff);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { gte: start.toISOString().slice(0, 10), lte: end.toISOString().slice(0, 10) };
}

function formatDisplayDate(dateStr: string) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("pt-PT", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

type OrderBooking = {
  orderId: string;
  orderName: string;
  productTitle: string;
  date: string;
  time: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  status: string; // from local DB if exists, else "confirmed"
  dbId: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const today = new Date().toISOString().slice(0, 10);
  const week = getWeekBounds();

  // 1) Query Shopify orders from today that may have booking properties
  const ordersRes = await admin.graphql(
    `#graphql
    query GetTodayOrders($query: String!) {
      orders(first: 50, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            name
            displayFinancialStatus
            customer {
              displayName
              defaultEmailAddress { emailAddress }
              defaultPhoneNumber { phoneNumber }
            }
            lineItems(first: 20) {
              edges {
                node {
                  title
                  product { id }
                  customAttributes { key value }
                }
              }
            }
          }
        }
      }
    }`,
    { variables: { query: `created_at:>=${today}T00:00:00` } }
  );
  const ordersJson = await ordersRes.json();
  const orderEdges = ordersJson.data?.orders?.edges ?? [];

  // 2) Filter orders that have booking properties in any line item
  const todayOrderBookings: OrderBooking[] = [];
  for (const { node: order } of orderEdges) {
    const rawId = order.id.replace("gid://shopify/Order/", "");
    for (const { node: item } of order.lineItems.edges) {
      const attrs: Record<string, string> = {};
      for (const a of item.customAttributes) attrs[a.key] = a.value;
      const date = attrs["Data da marcação"] ?? attrs["_booking_date"];
      const time = attrs["Hora da marcação"] ?? attrs["_booking_time"];
      if (!date || !time) continue;

      const productNumericId = item.product?.id?.replace("gid://shopify/Product/", "")
        ?? attrs["_booking_product_id"]
        ?? "";

      // Look up local DB record for status management; create it if missing
      let dbRecord = await prisma.booking.findFirst({
        where: { shop, orderId: rawId },
      });

      if (!dbRecord) {
        // Order came via Shopify (webhook may have failed) — create the record now
        try {
          dbRecord = await prisma.booking.create({
            data: {
              shop,
              orderId: rawId,
              productId: productNumericId,
              productTitle: item.title,
              date,
              time,
              customerName: order.customer?.displayName ?? null,
              customerEmail: order.customer?.defaultEmailAddress?.emailAddress ?? null,
              customerPhone: order.customer?.defaultPhoneNumber?.phoneNumber ?? null,
              status: order.displayFinancialStatus === "PAID" ? "confirmed" : "pending",
            },
          });
        } catch {
          // Unique constraint race — fetch again
          dbRecord = await prisma.booking.findFirst({ where: { shop, orderId: rawId } });
        }
      }

      todayOrderBookings.push({
        orderId: rawId,
        orderName: order.name,
        productTitle: item.title,
        date,
        time,
        customerName: order.customer?.displayName ?? order.customer?.defaultEmailAddress?.emailAddress ?? "—",
        customerEmail: order.customer?.defaultEmailAddress?.emailAddress ?? "—",
        customerPhone: order.customer?.defaultPhoneNumber?.phoneNumber ?? null,
        status: dbRecord?.status ?? (order.displayFinancialStatus === "PAID" ? "confirmed" : "pending"),
        dbId: dbRecord?.id ?? null,
      });
    }
  }

  // Sort by time
  todayOrderBookings.sort((a, b) => a.time.localeCompare(b.time));

  // 3) Stats — query Shopify orders for a wider window and count by booking date
  //    This ensures stats match what the calendar shows (source of truth = Shopify).
  function pad2(n: number) { return String(n).padStart(2, "0"); }
  function addDays(d: Date, n: number) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function ymd(d: Date) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  const windowStart = ymd(addDays(new Date(), -90));
  const windowEnd   = ymd(addDays(new Date(), 60));

  const allOrdersRes = await admin.graphql(
    `#graphql
    query StatsOrders($query: String!) {
      orders(first: 250, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id
            lineItems(first: 20) {
              edges { node { customAttributes { key value } } }
            }
          }
        }
      }
    }`,
    { variables: { query: `created_at:>=${windowStart}T00:00:00 created_at:<=${windowEnd}T23:59:59` } }
  );
  const allOrdersJson = await allOrdersRes.json();
  const allEdges = allOrdersJson.data?.orders?.edges ?? [];

  let weekCount = 0, totalCount = 0;
  const allBookingDates: string[] = [];
  for (const { node: o } of allEdges) {
    for (const { node: li } of o.lineItems.edges) {
      const a: Record<string, string> = {};
      for (const x of li.customAttributes) a[x.key] = x.value;
      const d = a["Data da marcação"] ?? a["_booking_date"];
      if (!d) continue;
      allBookingDates.push(d);
      if (d >= week.gte && d <= week.lte) weekCount++;
      totalCount++;
    }
  }

  // pending = bookings in DB with status pending (still reliable since we upsert above)
  const pendingCount = await prisma.booking.count({ where: { shop, status: "pending" } });

  return {
    today,
    shop,
    todayOrderBookings,
    stats: {
      today: todayOrderBookings.length,
      week: weekCount,
      pending: pendingCount,
      total: totalCount,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const fd = await request.formData();
  const bookingId = fd.get("bookingId") as string | null;
  const status = fd.get("status") as string;
  if (bookingId) {
    await prisma.booking.update({ where: { id: bookingId }, data: { status } });
  }
  return { ok: true };
};

// ── Icons ──────────────────────────────────────────────────────────────────

function IconCalendar({ size = 22, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  );
}

function IconBarChart({ size = 22, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/>
    </svg>
  );
}

function IconClock({ size = 22, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

function IconLayers({ size = 22, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}

function IconXSmall() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { today, todayOrderBookings, shop, stats } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const statusMeta = (s: string) => {
    if (s === "confirmed") return { label: "Confirmado", bg: "#e3f1ec", color: "#008060", border: "#b7dfce" };
    if (s === "cancelled") return { label: "Cancelado", bg: "#fce8e6", color: "#d82c0d", border: "#f9c4be" };
    return { label: "Pendente", bg: "#fff8e6", color: "#b98900", border: "#fce5a2" };
  };

  const statCards = [
    { label: "Hoje", value: stats.today, color: "#2c6ecb", bg: "#eef3ff", icon: <IconCalendar color="#2c6ecb" /> },
    { label: "Esta semana", value: stats.week, color: "#008060", bg: "#e6f5f0", icon: <IconBarChart color="#008060" /> },
    { label: "Pendentes", value: stats.pending, color: "#b98900", bg: "#fef9e5", icon: <IconClock color="#b98900" /> },
    { label: "Total geral", value: stats.total, color: "#6d7175", bg: "#f4f6f8", icon: <IconLayers color="#6d7175" /> },
  ];

  return (
    <s-page heading="Dashboard">

      {/* ── Stat cards ── */}
      <s-section heading="">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px" }}>
          {statCards.map((c) => (
            <div key={c.label} style={{
              position: "relative", background: "#fff", borderRadius: "12px",
              padding: "20px 20px 20px 24px", display: "flex", alignItems: "center", gap: "16px",
              border: "1px solid #e1e3e5", boxShadow: "0 1px 4px rgba(0,0,0,0.05)", overflow: "hidden",
            }}>
              {/* Left accent bar */}
              <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "4px", borderRadius: "12px 0 0 12px", background: c.color }} />
              {/* Icon bubble */}
              <div style={{ width: "46px", height: "46px", borderRadius: "12px", background: c.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {c.icon}
              </div>
              <div>
                <div style={{ fontSize: "30px", fontWeight: 700, color: "#1a1a1a", lineHeight: "1" }}>{c.value}</div>
                <div style={{ fontSize: "13px", color: "#6d7175", marginTop: "4px" }}>{c.label}</div>
              </div>
            </div>
          ))}
        </div>
      </s-section>

      {/* ── Today's bookings ── */}
      <s-section heading={`Marcacoes — ${formatDisplayDate(today)}`}>
        {todayOrderBookings.length === 0 ? (
          <div style={{ padding: "52px 24px", textAlign: "center", background: "#f9fafb", borderRadius: "10px", border: "1px dashed #e1e3e5" }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#c4cdd5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: "12px" }}>
              <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
              <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
            </svg>
            <div style={{ fontWeight: 600, color: "#3d4045", fontSize: "15px", marginBottom: "4px" }}>Sem marcacoes para hoje</div>
            <div style={{ fontSize: "13px", color: "#9ca3af" }}>Quando houver marcacoes vao aparecer aqui.</div>
          </div>
        ) : (
          <div style={{ borderRadius: "10px", border: "1px solid #e1e3e5", overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
              <thead>
                <tr style={{ background: "#f9fafb", borderBottom: "1px solid #e1e3e5" }}>
                  {[
                    { label: "Hora", w: "80px" },
                    { label: "Cliente", w: "auto" },
                    { label: "Servico", w: "auto" },
                    { label: "Staff", w: "120px" },
                    { label: "Estado", w: "110px" },
                    { label: "Acoes", w: "160px" },
                  ].map((h) => (
                    <th key={h.label} style={{ padding: "11px 16px", textAlign: "left", fontWeight: 600, color: "#6d7175", whiteSpace: "nowrap", fontSize: "11.5px", textTransform: "uppercase", letterSpacing: "0.04em", width: h.w }}>
                      {h.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {todayOrderBookings.map((b, i) => {
                  const sm = statusMeta(b.status);
                  const isLast = i === todayOrderBookings.length - 1;
                  return (
                    <tr key={b.orderId} style={{ borderBottom: isLast ? "none" : "1px solid #f1f2f3", background: "#fff" }}>
                      <td style={{ padding: "14px 16px" }}>
                        <span style={{ fontFamily: "monospace", fontWeight: 700, fontSize: "15px", background: "#eef3ff", color: "#2c6ecb", padding: "3px 9px", borderRadius: "6px" }}>
                          {b.time}
                        </span>
                      </td>
                      <td style={{ padding: "14px 16px" }}>
                        <div>
                          <div style={{ fontWeight: 600, color: b.customerName === "—" ? "#bbb" : "#1a1a1a" }}>{b.customerName}</div>
                          <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "2px" }}>{b.customerEmail}</div>
                          {b.customerPhone && <div style={{ fontSize: "12px", color: "#9ca3af" }}>{b.customerPhone}</div>}
                          <a href={`https://${shop}/admin/orders/${b.orderId}`} target="_blank" rel="noreferrer"
                            style={{ fontSize: "11px", color: "#2c6ecb" }}>{b.orderName}</a>
                        </div>
                      </td>
                      <td style={{ padding: "14px 16px", maxWidth: "160px" }}>
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#3d4045" }}>{b.productTitle}</div>
                      </td>
                      <td style={{ padding: "14px 16px", color: "#6d7175", fontSize: "13px" }}>—</td>
                      <td style={{ padding: "14px 16px" }}>
                        <span style={{ display: "inline-block", padding: "4px 10px", borderRadius: "20px", fontSize: "12px", fontWeight: 600, background: sm.bg, color: sm.color, border: `1px solid ${sm.border}`, whiteSpace: "nowrap" }}>
                          {sm.label}
                        </span>
                      </td>
                      <td style={{ padding: "14px 16px" }}>
                        {b.dbId && b.status === "pending" && (
                          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                            <fetcher.Form method="post">
                              <input type="hidden" name="bookingId" value={b.dbId} />
                              <input type="hidden" name="status" value="confirmed" />
                              <button type="submit" style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "6px 13px", background: "#008060", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: 600 }}>
                                <IconCheck /> Confirmar
                              </button>
                            </fetcher.Form>
                            <fetcher.Form method="post">
                              <input type="hidden" name="bookingId" value={b.dbId} />
                              <input type="hidden" name="status" value="cancelled" />
                              <button type="submit" style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "6px 13px", background: "#fff", color: "#d82c0d", border: "1px solid #f9c4be", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: 600 }}>
                                <IconXSmall /> Cancelar
                              </button>
                            </fetcher.Form>
                          </div>
                        )}
                        {b.dbId && b.status === "confirmed" && (
                          <fetcher.Form method="post">
                            <input type="hidden" name="bookingId" value={b.dbId} />
                            <input type="hidden" name="status" value="cancelled" />
                            <button type="submit" style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "6px 13px", background: "#fff", color: "#d82c0d", border: "1px solid #f9c4be", borderRadius: "6px", cursor: "pointer", fontSize: "12px" }}>
                              <IconXSmall /> Cancelar
                            </button>
                          </fetcher.Form>
                        )}
                        {b.status === "cancelled" && (
                          <span style={{ fontSize: "12px", color: "#9ca3af", fontStyle: "italic" }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
