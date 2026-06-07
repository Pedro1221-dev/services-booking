import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

// ── Helpers ────────────────────────────────────────────────────────────────

function pad(n: number) { return String(n).padStart(2, "0"); }
function ymd(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(d: Date, n: number) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

const PT_MONTHS = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const PT_DAYS_SHORT = ["Seg","Ter","Qua","Qui","Sex","Sáb","Dom"];

function buildMonthGrid(year: number, month: number): Date[][] {
  const firstDay = new Date(year, month, 1);
  const startDow = (firstDay.getDay() + 6) % 7;
  const start = addDays(firstDay, -startDow);
  const weeks: Date[][] = [];
  let cur = start;
  while (true) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) { week.push(new Date(cur)); cur = addDays(cur, 1); }
    weeks.push(week);
    if (cur.getMonth() > month || cur.getFullYear() > year) break;
  }
  return weeks;
}

function buildWeekDays(refDate: Date): Date[] {
  const dow = (refDate.getDay() + 6) % 7;
  const monday = addDays(refDate, -dow);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

// ── Types ──────────────────────────────────────────────────────────────────

type CalEvent = {
  date: string; time: string; productTitle: string; productId: string;
  customerName: string; orderName: string; orderId: string; status: string;
};
type ColorMap = Record<string, string>;

// ── Loader ─────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const viewParam = (url.searchParams.get("view") ?? "month") as "month" | "week";
  const yearParam = parseInt(url.searchParams.get("year") ?? String(new Date().getFullYear()), 10);
  const monthParam = parseInt(url.searchParams.get("month") ?? String(new Date().getMonth()), 10);
  const weekRefParam = url.searchParams.get("weekRef") ?? ymd(new Date());

  let rangeStart: string;
  let rangeEnd: string;
  if (viewParam === "month") {
    const first = new Date(yearParam, monthParam, 1);
    const last = new Date(yearParam, monthParam + 1, 0);
    const gridStart = addDays(first, -((first.getDay() + 6) % 7));
    rangeStart = ymd(gridStart);
    rangeEnd = ymd(addDays(last, 7));
  } else {
    const ref = new Date(weekRefParam + "T12:00:00");
    const days = buildWeekDays(ref);
    rangeStart = ymd(days[0]);
    rangeEnd = ymd(days[6]);
  }

  // We query orders from a wider window (past 90 days → next 60 days) and then
  // filter server-side by the *booking date* attribute, not the order creation date.
  const windowStart = ymd(addDays(new Date(), -90));
  const windowEnd   = ymd(addDays(new Date(), 60));

  const ordersRes = await admin.graphql(
    `#graphql
    query CalendarOrders($query: String!) {
      orders(first: 250, query: $query, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            id name
            customer { displayName defaultEmailAddress { emailAddress } }
            lineItems(first: 20) {
              edges { node { title customAttributes { key value } } }
            }
          }
        }
      }
    }`,
    { variables: { query: `created_at:>=${windowStart}T00:00:00 created_at:<=${windowEnd}T23:59:59` } }
  );
  const ordersJson = await ordersRes.json();
  const orderEdges = ordersJson.data?.orders?.edges ?? [];

  // Collect all order IDs that have booking line items in range, then batch-fetch DB records
  type PendingEvent = Omit<CalEvent, "status"> & { orderId: string };
  const pendingEvents: PendingEvent[] = [];
  const orderIdsInRange = new Set<string>();

  for (const { node: order } of orderEdges) {
    const rawId = order.id.replace("gid://shopify/Order/", "");
    for (const { node: item } of order.lineItems.edges) {
      const attrs: Record<string, string> = {};
      for (const a of item.customAttributes) attrs[a.key] = a.value;
      const date = attrs["Data da marcação"] ?? attrs["_booking_date"];
      const time = attrs["Hora da marcação"] ?? attrs["_booking_time"];
      if (!date || !time) continue;
      if (date < rangeStart || date > rangeEnd) continue;
      orderIdsInRange.add(rawId);
      pendingEvents.push({
        date, time, productTitle: item.title,
        productId: attrs["_booking_product_id"] ?? "",
        customerName: order.customer?.displayName ?? order.customer?.defaultEmailAddress?.emailAddress ?? "—",
        orderName: order.name, orderId: rawId,
      });
    }
  }

  // Single batch query instead of one per order
  const dbRecords = orderIdsInRange.size > 0
    ? await prisma.booking.findMany({ where: { shop, orderId: { in: Array.from(orderIdsInRange) } }, select: { orderId: true, status: true } })
    : [];
  const statusByOrderId = new Map(dbRecords.map((r) => [r.orderId, r.status]));

  const events: CalEvent[] = pendingEvents.map((e) => ({
    ...e,
    status: statusByOrderId.get(e.orderId) ?? "confirmed",
  }));

  const configs = await prisma.serviceConfig.findMany({ where: { shop } });
  const colorMap: ColorMap = {};
  for (const c of configs) colorMap[c.productId] = (c as any).color ?? "#2c6ecb";

  return { view: viewParam, year: yearParam, month: monthParam, weekRef: weekRefParam, events, colorMap, shop };
};

// ── EventPill ──────────────────────────────────────────────────────────────

function statusMeta(s: string) {
  if (s === "confirmed") return { label: "Confirmado", bg: "#e3f1ec", color: "#008060" };
  if (s === "cancelled") return { label: "Cancelado", bg: "#fce8e6", color: "#d82c0d" };
  return { label: "Pendente", bg: "#fff8e6", color: "#b98900" };
}
function statusDot(s: string) {
  return s === "cancelled" ? "#d82c0d" : s === "confirmed" ? "#008060" : "#b98900";
}

function EventPill({ ev, colorMap, shop }: { ev: CalEvent; colorMap: ColorMap; shop: string }) {
  const [open, setOpen] = useState(false);
  const bg = colorMap[ev.productId] ?? "#2c6ecb";
  const dot = statusDot(ev.status);
  const sm = statusMeta(ev.status);

  return (
    <div style={{ position: "relative" }}>
      <div
        onClick={() => setOpen((o) => !o)}
        title={`${ev.time} — ${ev.productTitle} — ${ev.customerName}`}
        style={{
          background: bg + "22", borderLeft: `3px solid ${bg}`, borderRadius: "4px",
          padding: "1px 5px", fontSize: "11px", fontWeight: 600, color: bg,
          cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          marginBottom: "2px", userSelect: "none",
        }}
      >
        <span style={{ display: "inline-block", width: "5px", height: "5px", borderRadius: "50%", background: dot, marginRight: "3px", verticalAlign: "middle" }} />
        {ev.time} {ev.productTitle}
      </div>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 99 }} />
          <div
            style={{
              position: "absolute", zIndex: 100, left: 0, top: "100%",
              background: "#fff", border: "1px solid #e1e3e5", borderRadius: "10px",
              boxShadow: "0 8px 32px rgba(0,0,0,0.14)", padding: "14px 16px",
              minWidth: "230px", fontSize: "13px",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => setOpen(false)} style={{ position: "absolute", top: "8px", right: "10px", background: "none", border: "none", cursor: "pointer", color: "#9ca3af", fontSize: "16px", lineHeight: "1" }}>×</button>
            <div style={{ fontWeight: 700, color: "#1a1a1a", marginBottom: "8px", paddingRight: "20px" }}>{ev.productTitle}</div>
            <div style={{ color: "#6d7175", marginBottom: "3px", fontSize: "12px" }}>📅 {ev.date} às {ev.time}</div>
            <div style={{ color: "#6d7175", marginBottom: "8px", fontSize: "12px" }}>👤 {ev.customerName}</div>
            <span style={{ display: "inline-block", padding: "3px 10px", borderRadius: "12px", fontSize: "11px", fontWeight: 600, background: sm.bg, color: sm.color }}>{sm.label}</span>
            <a
              href={`https://${shop}/admin/orders/${ev.orderId}`}
              target="_top"
              style={{ display: "block", marginTop: "10px", color: "#2c6ecb", fontSize: "11px" }}
            >
              Ver encomenda {ev.orderName} ↗
            </a>
          </div>
        </>
      )}
    </div>
  );
}

// ── Shared styles ──────────────────────────────────────────────────────────

const navBtn: React.CSSProperties = {
  width: "30px", height: "30px", borderRadius: "7px", border: "1px solid #e1e3e5",
  background: "#fff", cursor: "pointer", fontSize: "17px", color: "#3d4045",
  display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700, flexShrink: 0,
};

// ── MonthView ──────────────────────────────────────────────────────────────

function MonthView({ year, month, events, colorMap, shop, onPrev, onNext }: {
  year: number; month: number; events: CalEvent[]; colorMap: ColorMap; shop: string;
  onPrev: () => void; onNext: () => void;
}) {
  const today = ymd(new Date());
  const grid = buildMonthGrid(year, month);
  const byDate: Record<string, CalEvent[]> = {};
  for (const e of events) { if (!byDate[e.date]) byDate[e.date] = []; byDate[e.date].push(e); }
  for (const k of Object.keys(byDate)) byDate[k].sort((a, b) => a.time.localeCompare(b.time));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Nav */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px", flexShrink: 0 }}>
        <button onClick={onPrev} style={navBtn}>‹</button>
        <span style={{ fontWeight: 700, fontSize: "17px", color: "#1a1a1a", minWidth: "150px", textAlign: "center" }}>
          {PT_MONTHS[month]} {year}
        </span>
        <button onClick={onNext} style={navBtn}>›</button>
      </div>

      {/* Grid */}
      <div style={{ flex: 1, border: "1px solid #e1e3e5", borderRadius: "10px", overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 0 }}>
        {/* Day headers */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", background: "#f9fafb", borderBottom: "1px solid #e1e3e5", flexShrink: 0 }}>
          {PT_DAYS_SHORT.map((d) => (
            <div key={d} style={{ padding: "7px 0", textAlign: "center", fontSize: "11px", fontWeight: 600, color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.05em" }}>{d}</div>
          ))}
        </div>

        {/* Weeks — each takes equal share of remaining height */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {grid.map((week, wi) => (
            <div key={wi} style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", flex: 1, borderBottom: wi === grid.length - 1 ? "none" : "1px solid #f1f2f3", minHeight: 0 }}>
              {week.map((day, di) => {
                const key = ymd(day);
                const isCurrentMonth = day.getMonth() === month;
                const isToday = key === today;
                const dayEvents = byDate[key] ?? [];
                return (
                  <div key={di} style={{
                    padding: "4px 5px", borderRight: di < 6 ? "1px solid #f1f2f3" : "none",
                    background: isToday ? "#eef3ff" : "#fff",
                    overflow: "hidden", display: "flex", flexDirection: "column",
                  }}>
                    <div style={{
                      fontSize: "12px", fontWeight: isToday ? 700 : 500,
                      width: "22px", height: "22px", lineHeight: "22px", textAlign: "center",
                      borderRadius: "50%", flexShrink: 0, marginBottom: "2px",
                      background: isToday ? "#2c6ecb" : "transparent",
                      color: isToday ? "#fff" : isCurrentMonth ? "#1a1a1a" : "#c4cdd5",
                    }}>
                      {day.getDate()}
                    </div>
                    <div style={{ overflow: "hidden", flex: 1, minHeight: 0 }}>
                      {dayEvents.map((ev, ei) => (
                        <EventPill key={ei} ev={ev} colorMap={colorMap} shop={shop} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── WeekView ───────────────────────────────────────────────────────────────

function WeekView({ weekRef, events, colorMap, shop, onPrev, onNext }: {
  weekRef: string; events: CalEvent[]; colorMap: ColorMap; shop: string;
  onPrev: () => void; onNext: () => void;
}) {
  const today = ymd(new Date());
  const ref = new Date(weekRef + "T12:00:00");
  const days = buildWeekDays(ref);
  const byDate: Record<string, CalEvent[]> = {};
  for (const e of events) { if (!byDate[e.date]) byDate[e.date] = []; byDate[e.date].push(e); }
  for (const k of Object.keys(byDate)) byDate[k].sort((a, b) => a.time.localeCompare(b.time));

  const label = `${days[0].getDate()} ${PT_MONTHS[days[0].getMonth()]} — ${days[6].getDate()} ${PT_MONTHS[days[6].getMonth()]} ${days[6].getFullYear()}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Nav */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px", flexShrink: 0 }}>
        <button onClick={onPrev} style={navBtn}>‹</button>
        <span style={{ fontWeight: 700, fontSize: "15px", color: "#1a1a1a", minWidth: "240px", textAlign: "center" }}>{label}</span>
        <button onClick={onNext} style={navBtn}>›</button>
      </div>

      {/* Grid */}
      <div style={{ flex: 1, border: "1px solid #e1e3e5", borderRadius: "10px", overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 0 }}>
        {/* Day headers */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", background: "#f9fafb", borderBottom: "1px solid #e1e3e5", flexShrink: 0 }}>
          {days.map((d, i) => {
            const key = ymd(d);
            const isToday = key === today;
            return (
              <div key={i} style={{ padding: "8px 6px", textAlign: "center", borderRight: i < 6 ? "1px solid #f1f2f3" : "none" }}>
                <div style={{ fontSize: "10px", fontWeight: 600, color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.05em" }}>{PT_DAYS_SHORT[i]}</div>
                <div style={{
                  fontSize: "20px", fontWeight: 700, color: isToday ? "#fff" : "#1a1a1a",
                  background: isToday ? "#2c6ecb" : "transparent",
                  width: "34px", height: "34px", borderRadius: "50%", lineHeight: "34px",
                  display: "inline-block", textAlign: "center", marginTop: "2px",
                }}>{d.getDate()}</div>
              </div>
            );
          })}
        </div>

        {/* Body */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", flex: 1, minHeight: 0 }}>
          {days.map((d, i) => {
            const key = ymd(d);
            const isToday = key === today;
            const dayEvents = byDate[key] ?? [];
            return (
              <div key={i} style={{
                padding: "6px 5px", borderRight: i < 6 ? "1px solid #f1f2f3" : "none",
                background: isToday ? "#eef3ff" : "#fff", overflowY: "auto",
              }}>
                {dayEvents.length === 0
                  ? <div style={{ fontSize: "11px", color: "#e1e3e5", textAlign: "center", paddingTop: "16px" }}>—</div>
                  : dayEvents.map((ev, ei) => <EventPill key={ei} ev={ev} colorMap={colorMap} shop={shop} />)
                }
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function CalendarPage() {
  const { view, year, month, weekRef, events, colorMap, shop } =
    useLoaderData<typeof loader>();

  const navigate = useNavigate();

  function go(params: Partial<{ view: string; year: number; month: number; weekRef: string }>) {
    const merged = { view, year, month, weekRef, ...params };
    navigate(`/app/calendar?view=${merged.view}&year=${merged.year}&month=${merged.month}&weekRef=${merged.weekRef}`);
  }

  function prevMonth() { const d = new Date(year, month - 1, 1); go({ year: d.getFullYear(), month: d.getMonth() }); }
  function nextMonth() { const d = new Date(year, month + 1, 1); go({ year: d.getFullYear(), month: d.getMonth() }); }
  function prevWeek() { go({ weekRef: ymd(addDays(new Date(weekRef + "T12:00:00"), -7)) }); }
  function nextWeek() { go({ weekRef: ymd(addDays(new Date(weekRef + "T12:00:00"), 7)) }); }

  const seenProducts = new Map<string, { title: string; color: string }>();
  for (const e of events) {
    if (!seenProducts.has(e.productId)) seenProducts.set(e.productId, { title: e.productTitle, color: colorMap[e.productId] ?? "#2c6ecb" });
  }

  return (
    <div style={{ padding: "16px 20px 12px", boxSizing: "border-box", height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", flexShrink: 0, marginBottom: "10px" }}>
        <span style={{ fontWeight: 700, fontSize: "18px", color: "#1a1a1a", marginRight: "6px" }}>Calendário</span>

        <div style={{ display: "flex", background: "#f4f6f8", borderRadius: "8px", padding: "3px", gap: "2px" }}>
          {(["month", "week"] as const).map((v) => (
            <button key={v} onClick={() => go({ view: v })} style={{
              padding: "5px 14px", borderRadius: "6px", border: "none", cursor: "pointer",
              fontSize: "13px", fontWeight: 600,
              background: view === v ? "#fff" : "transparent",
              color: view === v ? "#2c6ecb" : "#6d7175",
              boxShadow: view === v ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
            }}>
              {v === "month" ? "Mês" : "Semana"}
            </button>
          ))}
        </div>

        <button
          onClick={() => { const n = new Date(); go({ year: n.getFullYear(), month: n.getMonth(), weekRef: ymd(n) }); }}
          style={{ padding: "5px 13px", borderRadius: "7px", border: "1px solid #e1e3e5", background: "#fff", cursor: "pointer", fontSize: "13px", fontWeight: 600, color: "#3d4045" }}
        >Hoje</button>

        {seenProducts.size > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginLeft: "4px", flexWrap: "wrap" }}>
            {Array.from(seenProducts.entries()).map(([pid, { title, color }]) => (
              <span key={pid} style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "#6d7175" }}>
                <span style={{ width: "9px", height: "9px", borderRadius: "3px", background: color, display: "inline-block" }} />
                {title}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Calendar — fills remaining height */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {view === "month" ? (
          <MonthView
            year={year} month={month} events={events} colorMap={colorMap} shop={shop}
            onPrev={prevMonth} onNext={nextMonth}
          />
        ) : (
          <WeekView
            weekRef={weekRef} events={events} colorMap={colorMap} shop={shop}
            onPrev={prevWeek} onNext={nextWeek}
          />
        )}
      </div>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
