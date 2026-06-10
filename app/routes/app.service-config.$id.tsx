import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import prisma from "../db.server";
import { useEffect, useState, useRef } from "react";
import { DAY_ORDER, DAY_LABELS } from "../utils/days";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Interval = { start: string; end: string };
type DaySchedule = Record<string, Interval[]>; // dayKey → intervals
type StaffMember = { id: string; name: string };

const SLOT_DURATIONS = [
  { value: "15", label: "15 minutos" },
  { value: "30", label: "30 minutos" },
  { value: "45", label: "45 minutos" },
  { value: "60", label: "1 hora" },
  { value: "90", label: "1h 30min" },
  { value: "120", label: "2 horas" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const numericId = params.id!;
  const productGid = `gid://shopify/Product/${numericId}`;

  const [productRes, metaobjectsRes] = await Promise.all([
    admin.graphql(`#graphql
      query getProduct($id: ID!) {
        product(id: $id) { id title status }
      }
    `, { variables: { id: productGid } }),
    admin.graphql(`#graphql
      query getProfissionalCards {
        metaobjects(type: "profissional_card", first: 50) {
          edges { node { id fields { key value } } }
        }
      }
    `),
  ]);

  const productJson = await productRes.json();
  const metaobjectsJson = await metaobjectsRes.json();

  const product = productJson.data?.product;
  if (!product) throw redirect("/app/services");

  type MetaField = { key: string; value: string };
  type MetaNode = { id: string; fields: MetaField[] };
  const staff: StaffMember[] = (metaobjectsJson.data?.metaobjects?.edges ?? []).map(
    (e: { node: MetaNode }) => {
      const fields = e.node.fields;
      const get = (k: string) => fields.find((f: MetaField) => f.key === k)?.value ?? "";
      return { id: e.node.id, name: get("nome"), cargo: get("cargo") };
    },
  );

  const config = await prisma.serviceConfig.findUnique({
    where: { shop_productId: { shop, productId: numericId } },
  });

  // Parse new-format schedule; fall back to legacy fields for existing configs
  let schedule: DaySchedule = {};
  if (config) {
    const raw = (config as any).schedule as string | undefined;
    const parsed: DaySchedule = raw ? JSON.parse(raw) : {};
    if (Object.keys(parsed).length > 0) {
      schedule = parsed;
    } else if (config.availableDays) {
      // Migrate from legacy: one interval per active day
      const activeDays: string[] = JSON.parse(config.availableDays);
      for (const day of activeDays) {
        schedule[day] = [{ start: config.startTime, end: config.endTime }];
      }
    }
  }

  // Parse staffList; fall back to legacy single staff
  let staffList: StaffMember[] = [];
  if (config) {
    const raw = (config as any).staffList as string | undefined;
    staffList = raw ? JSON.parse(raw) : [];
    if (staffList.length === 0 && config.staffId) {
      staffList = [{ id: config.staffId, name: config.staffName ?? "" }];
    }
  }

  return {
    product: { id: productGid, numericId, title: product.title as string },
    staff: staff as (StaffMember & { cargo?: string })[],
    config: config
      ? {
          schedule,
          staffList,
          slotDuration: config.slotDuration,
          color: (config as any).color ?? "#2c6ecb",
        }
      : null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Action
// ─────────────────────────────────────────────────────────────────────────────

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const numericId = params.id!;
  const productGid = `gid://shopify/Product/${numericId}`;

  const fd = await request.formData();
  const schedule = (fd.get("schedule") as string) || "{}";
  const staffListRaw = (fd.get("staffList") as string) || "[]";
  const slotDuration = parseInt(fd.get("slotDuration") as string, 10) || 30;
  const color = (fd.get("color") as string) || "#2c6ecb";

  const staffList: StaffMember[] = JSON.parse(staffListRaw);

  // Derive legacy fields from new schedule for backwards-compat metafields
  const parsedSchedule: DaySchedule = JSON.parse(schedule);
  const activeDays = Object.entries(parsedSchedule)
    .filter(([, intervals]) => intervals.length > 0)
    .map(([day]) => day);
  const firstInterval = Object.values(parsedSchedule).find(iv => iv.length > 0)?.[0];
  const startTime = firstInterval?.start ?? "09:00";
  const endTime = firstInterval?.end ?? "18:00";

  const productRes = await admin.graphql(`#graphql
    query getProductTitle($id: ID!) { product(id: $id) { title } }
  `, { variables: { id: productGid } });
  const productJson = await productRes.json();
  const productTitle = productJson.data?.product?.title ?? "";

  const primaryStaff = staffList[0] ?? null;

  await (prisma as any).serviceConfig.upsert({
    where: { shop_productId: { shop, productId: numericId } },
    create: {
      shop,
      productId: numericId,
      productTitle,
      staffId: primaryStaff?.id ?? null,
      staffName: primaryStaff?.name ?? null,
      availableDays: JSON.stringify(activeDays),
      startTime,
      endTime,
      slotDuration,
      color,
      schedule,
      staffList: staffListRaw,
    },
    update: {
      productTitle,
      staffId: primaryStaff?.id ?? null,
      staffName: primaryStaff?.name ?? null,
      availableDays: JSON.stringify(activeDays),
      startTime,
      endTime,
      slotDuration,
      color,
      schedule,
      staffList: staffListRaw,
    },
  });

  // Sync metafields to the product
  const metafields = [
    { ownerId: productGid, namespace: "booking", key: "schedule", type: "json", value: schedule },
    { ownerId: productGid, namespace: "booking", key: "available_days", type: "json", value: JSON.stringify(activeDays) },
    { ownerId: productGid, namespace: "booking", key: "start_time", type: "single_line_text_field", value: startTime },
    { ownerId: productGid, namespace: "booking", key: "end_time", type: "single_line_text_field", value: endTime },
    { ownerId: productGid, namespace: "booking", key: "slot_duration", type: "number_integer", value: String(slotDuration) },
  ];
  if (primaryStaff) {
    metafields.push(
      { ownerId: productGid, namespace: "booking", key: "staff_id", type: "single_line_text_field", value: primaryStaff.id },
      { ownerId: productGid, namespace: "booking", key: "staff_name", type: "single_line_text_field", value: primaryStaff.name },
    );
  }

  await admin.graphql(`#graphql
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }
  `, { variables: { metafields } });

  return { success: true, message: "Configuração guardada com sucesso!" };
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const PALETTE = [
  "#2c6ecb","#008060","#d82c0d","#b98900",
  "#8b5cf6","#ec4899","#0891b2","#ea580c",
  "#0f766e","#be185d","#7c3aed","#15803d",
];

function getInitials(name: string) {
  return name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}
function luminance(hex: string) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return (0.299*r + 0.587*g + 0.114*b) / 255;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function ServiceConfigPage() {
  const { product, staff, config } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const colorInputRef = useRef<HTMLInputElement>(null);

  const isSaving = fetcher.state === "submitting";

  const [selectedColor, setSelectedColor] = useState(config?.color ?? "#2c6ecb");
  const [schedule, setSchedule] = useState<DaySchedule>(config?.schedule ?? {});
  const [selectedStaffIds, setSelectedStaffIds] = useState<string[]>(
    config?.staffList?.map((s: StaffMember) => s.id) ?? []
  );
  const [slotDuration, setSlotDuration] = useState(String(config?.slotDuration ?? 30));

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(fetcher.data.message, { duration: 3000 });
    }
  }, [fetcher.data, shopify]);

  const textOnColor = luminance(selectedColor) > 0.55 ? "#1a1a1a" : "#ffffff";

  // ── Schedule helpers ──────────────────────────────────────────────────────
  const isDayActive = (day: string) => (schedule[day]?.length ?? 0) > 0;

  function toggleDay(day: string) {
    setSchedule(s => {
      if (isDayActive(day)) return { ...s, [day]: [] };
      return { ...s, [day]: [{ start: "09:00", end: "18:00" }] };
    });
  }

  function addInterval(day: string) {
    setSchedule(s => ({ ...s, [day]: [...(s[day] ?? []), { start: "09:00", end: "18:00" }] }));
  }

  function removeInterval(day: string, idx: number) {
    setSchedule(s => {
      const intervals = (s[day] ?? []).filter((_, i) => i !== idx);
      return { ...s, [day]: intervals };
    });
  }

  function updateInterval(day: string, idx: number, field: "start" | "end", value: string) {
    setSchedule(s => {
      const intervals = [...(s[day] ?? [])];
      intervals[idx] = { ...intervals[idx], [field]: value };
      return { ...s, [day]: intervals };
    });
  }

  // ── Staff helpers ─────────────────────────────────────────────────────────
  function toggleStaff(id: string) {
    setSelectedStaffIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  }

  const selectedStaffObjects = staff
    .filter(s => selectedStaffIds.includes(s.id))
    .map(s => ({ id: s.id, name: s.name }));

  // ── Styles ────────────────────────────────────────────────────────────────
  const card: React.CSSProperties = {
    background: "#fff", border: "1px solid #e1e3e5",
    borderRadius: "12px", padding: "24px", marginBottom: "20px",
  };
  const sectionTitle: React.CSSProperties = {
    fontSize: "15px", fontWeight: 700, color: "#1a1a1a", marginBottom: "4px", marginTop: 0,
  };
  const sectionDesc: React.CSSProperties = {
    fontSize: "13px", color: "#6d7175", marginTop: 0, marginBottom: "20px",
  };
  const fieldLabel: React.CSSProperties = {
    display: "block", fontSize: "13px", fontWeight: 600, color: "#3d4045", marginBottom: "6px",
  };
  const inputBase: React.CSSProperties = {
    padding: "7px 10px", border: "1px solid #c9cccf", borderRadius: "6px",
    fontSize: "13px", background: "#fafbfb", outline: "none",
  };

  const activeDaysCount = DAY_ORDER.filter(isDayActive).length;

  return (
    <s-page heading="Editar serviço">
      <s-button slot="primary-action" href="/app/services" variant="tertiary">
        ← Voltar
      </s-button>

      <fetcher.Form method="post">
        {/* Serialized fields */}
        <input type="hidden" name="schedule" value={JSON.stringify(schedule)} />
        <input type="hidden" name="staffList" value={JSON.stringify(selectedStaffObjects)} />
        <input type="hidden" name="slotDuration" value={slotDuration} />
        <input type="hidden" name="color" value={selectedColor} />

        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: "24px", alignItems: "start" }}>

          {/* ── LEFT: preview ── */}
          <div>
            <div style={{ background: "#fff", border: "1px solid #e1e3e5", borderRadius: "12px", overflow: "hidden", marginBottom: "16px" }}>
              <div style={{ background: selectedColor, padding: "20px 20px 16px" }}>
                <span style={{ display: "block", fontSize: "11px", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: textOnColor, opacity: 0.75, marginBottom: "6px" }}>Serviço</span>
                <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: textOnColor, lineHeight: 1.3 }}>{product.title}</h2>
              </div>

              {/* Staff preview */}
              <div style={{ padding: "16px 20px" }}>
                <div style={{ fontSize: "11px", fontWeight: 600, color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "10px" }}>
                  {selectedStaffIds.length > 1 ? `${selectedStaffIds.length} Profissionais` : "Profissional"}
                </div>
                {selectedStaffObjects.length === 0 ? (
                  <div style={{ fontSize: "13px", color: "#6d7175", fontStyle: "italic" }}>Sem profissional</div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                    {selectedStaffObjects.map(s => (
                      <div key={s.id} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <div style={{ width: "32px", height: "32px", borderRadius: "50%", background: selectedColor, color: textOnColor, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "12px" }}>
                          {getInitials(s.name)}
                        </div>
                        <span style={{ fontSize: "13px", fontWeight: 600, color: "#1a1a1a" }}>{s.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Schedule preview */}
              <div style={{ padding: "0 20px 20px" }}>
                <div style={{ fontSize: "11px", fontWeight: 600, color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "10px" }}>
                  {activeDaysCount} dia{activeDaysCount !== 1 ? "s" : ""} activo{activeDaysCount !== 1 ? "s" : ""}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
                  {DAY_ORDER.map(day => {
                    const on = isDayActive(day);
                    return (
                      <span key={day} style={{ padding: "2px 8px", borderRadius: "20px", fontSize: "11px", fontWeight: 600, background: on ? selectedColor : "#e1e3e5", color: on ? textOnColor : "#8c9196" }}>
                        {DAY_LABELS[day].slice(0,3)}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Calendar pill */}
            <div style={{ background: "#f6f6f7", borderRadius: "10px", padding: "14px 16px" }}>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "10px" }}>Calendário</div>
              <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: selectedColor + "22", border: `1.5px solid ${selectedColor}`, borderLeft: `4px solid ${selectedColor}`, borderRadius: "6px", padding: "6px 10px", fontSize: "12px", fontWeight: 600, color: selectedColor, maxWidth: "100%" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: selectedColor, flexShrink: 0 }} />
                {product.title}
              </div>
            </div>
          </div>

          {/* ── RIGHT: form ── */}
          <div>

            {/* ── Section 1: Staff ── */}
            <div style={card}>
              <p style={sectionTitle}>👤 Profissionais</p>
              <p style={sectionDesc}>Seleciona os profissionais que realizam este serviço. Com múltiplos profissionais, o mesmo horário pode ser marcado por vários clientes em simultâneo.</p>

              {staff.length === 0 ? (
                <div style={{ background: "#fff4e5", border: "1px solid #f1c672", borderRadius: "8px", padding: "14px 16px", fontSize: "13px", color: "#7d5c00" }}>
                  Nenhum profissional encontrado. Cria primeiro um metaobject do tipo <code>profissional_card</code> no Shopify.
                </div>
              ) : (
                <div style={{ display: "grid", gap: "8px" }}>
                  {staff.map((s) => {
                    const isSelected = selectedStaffIds.includes(s.id);
                    return (
                      <label key={s.id} style={{ display: "flex", alignItems: "center", gap: "14px", padding: "12px 16px", border: `2px solid ${isSelected ? selectedColor : "#e1e3e5"}`, borderRadius: "10px", cursor: "pointer", background: isSelected ? selectedColor + "0d" : "#fff", transition: "all .15s" }}>
                        <input type="checkbox" checked={isSelected} onChange={() => toggleStaff(s.id)} style={{ display: "none" }} />
                        <div style={{ width: "40px", height: "40px", borderRadius: "50%", background: isSelected ? selectedColor : "#e1e3e5", color: isSelected ? textOnColor : "#6d7175", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "14px", flexShrink: 0 }}>
                          {getInitials(s.name)}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "14px", color: "#1a1a1a" }}>{s.name}</div>
                          {(s as any).cargo && <div style={{ fontSize: "12px", color: "#6d7175" }}>{(s as any).cargo}</div>}
                        </div>
                        {isSelected && <div style={{ marginLeft: "auto", color: selectedColor, fontSize: "18px" }}>✓</div>}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Section 2: Schedule ── */}
            <div style={card}>
              <p style={sectionTitle}>📅 Disponibilidade</p>
              <p style={sectionDesc}>Activa os dias e define os intervalos de horário. Podes ter vários intervalos por dia (ex: 9h-13h e 14h-19h).</p>

              {/* Slot duration */}
              <div style={{ marginBottom: "20px" }}>
                <span style={fieldLabel}>Duração de cada slot</span>
                <select value={slotDuration} onChange={e => setSlotDuration(e.target.value)} style={{ ...inputBase, minWidth: "160px" }}>
                  {SLOT_DURATIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
              </div>

              {/* Per-day schedule rows */}
              <div style={{ border: "1px solid #e1e3e5", borderRadius: "10px", overflow: "hidden" }}>
                {DAY_ORDER.map((day, i) => {
                  const active = isDayActive(day);
                  const intervals = schedule[day] ?? [];
                  const isLast = i === DAY_ORDER.length - 1;
                  return (
                    <div
                      key={day}
                      style={{ borderBottom: isLast ? "none" : "1px solid #f1f2f3", padding: "14px 16px", background: active ? "#fafffe" : "#fff" }}
                    >
                      {/* Day header row */}
                      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: active ? "12px" : 0 }}>
                        {/* Toggle */}
                        <button
                          type="button"
                          onClick={() => toggleDay(day)}
                          style={{
                            width: "38px", height: "22px", borderRadius: "11px", border: "none", cursor: "pointer",
                            background: active ? selectedColor : "#e1e3e5", position: "relative", flexShrink: 0,
                            transition: "background .2s",
                          }}
                        >
                          <span style={{
                            position: "absolute", top: "3px", left: active ? "19px" : "3px",
                            width: "16px", height: "16px", borderRadius: "50%", background: "#fff",
                            transition: "left .2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                          }} />
                        </button>
                        <span style={{ fontWeight: 600, fontSize: "14px", color: active ? "#1a1a1a" : "#8c9196", minWidth: "120px" }}>
                          {DAY_LABELS[day]}
                        </span>
                        {!active && <span style={{ fontSize: "12px", color: "#c4cdd5" }}>Sem disponibilidade</span>}
                      </div>

                      {/* Intervals */}
                      {active && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "8px", paddingLeft: "50px" }}>
                          {intervals.map((iv, idx) => (
                            <div key={idx} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                              <input
                                type="time"
                                value={iv.start}
                                onChange={e => updateInterval(day, idx, "start", e.target.value)}
                                style={{ ...inputBase, width: "110px" }}
                              />
                              <span style={{ color: "#6d7175", fontSize: "13px" }}>→</span>
                              <input
                                type="time"
                                value={iv.end}
                                onChange={e => updateInterval(day, idx, "end", e.target.value)}
                                style={{ ...inputBase, width: "110px" }}
                              />
                              {intervals.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => removeInterval(day, idx)}
                                  style={{ background: "none", border: "none", cursor: "pointer", color: "#8c9196", fontSize: "16px", padding: "0 4px", lineHeight: 1 }}
                                  title="Remover intervalo"
                                >✕</button>
                              )}
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => addInterval(day)}
                            style={{ alignSelf: "flex-start", background: "none", border: `1px dashed ${selectedColor}`, color: selectedColor, borderRadius: "6px", padding: "4px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
                          >
                            + Adicionar intervalo
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── Section 3: Color ── */}
            <div style={card}>
              <p style={sectionTitle}>🎨 Cor do serviço</p>
              <p style={sectionDesc}>Identificação visual no calendário e em relatórios.</p>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "16px" }}>
                {PALETTE.map((hex) => (
                  <button key={hex} type="button" onClick={() => { setSelectedColor(hex); if (colorInputRef.current) colorInputRef.current.value = hex; }} title={hex}
                    style={{ width: "36px", height: "36px", borderRadius: "50%", background: hex, border: selectedColor === hex ? "3px solid #1a1a1a" : "3px solid transparent", boxShadow: selectedColor === hex ? `0 0 0 2px ${hex}` : "none", cursor: "pointer", transition: "all .15s", flexShrink: 0, outline: "none" }}
                  />
                ))}
                <label title="Cor personalizada" style={{ width: "36px", height: "36px", borderRadius: "50%", border: "2px dashed #c9cccf", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: "18px", color: "#6d7175", flexShrink: 0 }}>
                  +
                  <input ref={colorInputRef} type="color" defaultValue={config?.color ?? "#2c6ecb"} onChange={(e) => setSelectedColor(e.target.value)} style={{ position: "absolute", opacity: 0, width: 0, height: 0, pointerEvents: "none" }} />
                </label>
              </div>
              <div style={{ fontSize: "12px", color: "#6d7175" }}>
                Cor actual: <code style={{ background: "#f1f2f3", padding: "2px 6px", borderRadius: "4px" }}>{selectedColor}</code>
              </div>
            </div>

            {/* ── Save bar ── */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#fff", border: "1px solid #e1e3e5", borderRadius: "12px", padding: "16px 24px", position: "sticky", bottom: "16px", boxShadow: "0 4px 20px rgba(0,0,0,0.08)" }}>
              <div style={{ fontSize: "13px", color: "#6d7175" }}>
                {isSaving ? "⏳ A guardar…" : fetcher.data?.success ? "✅ Guardado com sucesso" : "Guarda as alterações antes de sair."}
              </div>
              <button
                type="submit"
                disabled={isSaving}
                style={{ padding: "10px 28px", background: isSaving ? "#c4cdd5" : "#008060", color: "#fff", border: "none", borderRadius: "8px", fontSize: "14px", fontWeight: 700, cursor: isSaving ? "not-allowed" : "pointer" }}
              >
                {isSaving ? "A guardar…" : "Guardar configuração"}
              </button>
            </div>

          </div>
        </div>
      </fetcher.Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
