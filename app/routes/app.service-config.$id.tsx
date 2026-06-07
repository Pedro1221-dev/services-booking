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

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ALL_DAYS = [
  { key: "monday", label: "Segunda-feira" },
  { key: "tuesday", label: "Terca-feira" },
  { key: "wednesday", label: "Quarta-feira" },
  { key: "thursday", label: "Quinta-feira" },
  { key: "friday", label: "Sexta-feira" },
  { key: "saturday", label: "Sabado" },
  { key: "sunday", label: "Domingo" },
];

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

  // Fetch product + profissional_card metaobjects in parallel
  const [productRes, metaobjectsRes] = await Promise.all([
    admin.graphql(`#graphql
      query getProduct($id: ID!) {
        product(id: $id) {
          id
          title
          status
        }
      }
    `, { variables: { id: productGid } }),
    admin.graphql(`#graphql
      query getProfissionalCards {
        metaobjects(type: "profissional_card", first: 50) {
          edges {
            node {
              id
              fields {
                key
                value
              }
            }
          }
        }
      }
    `),
  ]);

  const productJson = await productRes.json();
  const metaobjectsJson = await metaobjectsRes.json();

  const product = productJson.data?.product;
  if (!product) {
    throw redirect("/app/services");
  }

  type MetaField = { key: string; value: string };
  type MetaNode = { id: string; fields: MetaField[] };
  const staff: Array<{ id: string; name: string; cargo: string }> =
    (metaobjectsJson.data?.metaobjects?.edges ?? []).map(
      (e: { node: MetaNode }) => {
        const fields = e.node.fields;
        const get = (k: string) => fields.find((f: MetaField) => f.key === k)?.value ?? "";
        return { id: e.node.id, name: get("nome"), cargo: get("cargo") };
      },
    );

  // Load existing config from DB
  const config = await prisma.serviceConfig.findUnique({
    where: { shop_productId: { shop, productId: numericId } },
  });

  return {
    product: { id: productGid, numericId, title: product.title as string },
    staff,
    config: config
      ? {
          staffId: config.staffId,
          staffName: config.staffName,
          availableDays: JSON.parse(config.availableDays) as string[],
          startTime: config.startTime,
          endTime: config.endTime,
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
  const staffId = fd.get("staffId") as string | null;
  const staffName = fd.get("staffName") as string | null;
  const startTime = (fd.get("startTime") as string) || "09:00";
  const endTime = (fd.get("endTime") as string) || "18:00";
  const slotDuration = parseInt(fd.get("slotDuration") as string, 10) || 30;
  const color = (fd.get("color") as string) || "#2c6ecb";
  const availableDays = ALL_DAYS.map((d) => d.key).filter(
    (k) => fd.get(`day_${k}`) === "on",
  );

  // Fetch product title
  const productRes = await admin.graphql(`#graphql
    query getProductTitle($id: ID!) { product(id: $id) { title } }
  `, { variables: { id: productGid } });
  const productJson = await productRes.json();
  const productTitle = productJson.data?.product?.title ?? "";

  // Upsert ServiceConfig in DB
  await prisma.serviceConfig.upsert({
    where: { shop_productId: { shop, productId: numericId } },
    create: {
      shop,
      productId: numericId,
      productTitle,
      staffId: staffId || null,
      staffName: staffName || null,
      availableDays: JSON.stringify(availableDays),
      startTime,
      endTime,
      slotDuration,
      color,
    } as any,
    update: {
      productTitle,
      staffId: staffId || null,
      staffName: staffName || null,
      availableDays: JSON.stringify(availableDays),
      startTime,
      endTime,
      slotDuration,
      color,
    } as any,
  });

  // Sync key metafields to the product (for theme use)
  if (staffId || availableDays.length) {
    const metafieldsToSet = [];
    if (staffId) {
      metafieldsToSet.push(
        { ownerId: productGid, namespace: "booking", key: "staff_id", type: "single_line_text_field", value: staffId },
        { ownerId: productGid, namespace: "booking", key: "staff_name", type: "single_line_text_field", value: staffName ?? "" },
      );
    }
    metafieldsToSet.push(
      { ownerId: productGid, namespace: "booking", key: "available_days", type: "json", value: JSON.stringify(availableDays) },
      { ownerId: productGid, namespace: "booking", key: "start_time", type: "single_line_text_field", value: startTime },
      { ownerId: productGid, namespace: "booking", key: "end_time", type: "single_line_text_field", value: endTime },
      { ownerId: productGid, namespace: "booking", key: "slot_duration", type: "number_integer", value: String(slotDuration) },
    );

    await admin.graphql(`#graphql
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `, { variables: { metafields: metafieldsToSet } });
  }

  return { success: true, message: "Configuracao guardada com sucesso!" };
};

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

const PALETTE = [
  "#2c6ecb","#008060","#d82c0d","#b98900",
  "#8b5cf6","#ec4899","#0891b2","#ea580c",
  "#0f766e","#be185d","#7c3aed","#15803d",
];

function getInitials(name: string) {
  return name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

function hexToRgb(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

function luminance(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export default function ServiceConfigPage() {
  const { product, staff, config } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const colorInputRef = useRef<HTMLInputElement>(null);

  const isSaving = fetcher.state === "submitting";

  const [selectedStaffId, setSelectedStaffId] = useState(config?.staffId ?? "");
  const [selectedColor, setSelectedColor] = useState(config?.color ?? "#2c6ecb");
  const [activeDays, setActiveDays] = useState<string[]>(config?.availableDays ?? []);

  const selectedStaff = staff.find((s) => s.id === selectedStaffId);

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(fetcher.data.message, { duration: 3000 });
    }
  }, [fetcher.data, shopify]);

  const textOnColor = luminance(selectedColor) > 0.55 ? "#1a1a1a" : "#ffffff";

  // ── Styles ──────────────────────────────────────────────────────────────
  const card: React.CSSProperties = {
    background: "#fff",
    border: "1px solid #e1e3e5",
    borderRadius: "12px",
    padding: "24px",
    marginBottom: "20px",
  };

  const sectionTitle: React.CSSProperties = {
    fontSize: "15px",
    fontWeight: 700,
    color: "#1a1a1a",
    marginBottom: "4px",
    marginTop: 0,
  };

  const sectionDesc: React.CSSProperties = {
    fontSize: "13px",
    color: "#6d7175",
    marginTop: 0,
    marginBottom: "20px",
  };

  const fieldLabel: React.CSSProperties = {
    display: "block",
    fontSize: "13px",
    fontWeight: 600,
    color: "#3d4045",
    marginBottom: "6px",
  };

  const inputBase: React.CSSProperties = {
    width: "100%",
    padding: "9px 12px",
    border: "1px solid #c9cccf",
    borderRadius: "8px",
    fontSize: "14px",
    background: "#fafbfb",
    boxSizing: "border-box",
    outline: "none",
    transition: "border-color .15s",
  };

  return (
    <s-page heading={`Editar serviço`}>
      <s-button slot="primary-action" href="/app/services" variant="tertiary">
        ← Voltar
      </s-button>

      <fetcher.Form method="post">
        {/* hidden staffName */}
        <input type="hidden" name="staffName" value={selectedStaff?.name ?? ""} />

        {/* ══════════════════════════════════════════════════════════════
            LAYOUT: two cols on wide, stack on narrow
        ══════════════════════════════════════════════════════════════ */}
        <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: "24px", alignItems: "start" }}>

          {/* ── LEFT: preview card ── */}
          <div>
            {/* Service preview */}
            <div style={{
              background: "#fff",
              border: "1px solid #e1e3e5",
              borderRadius: "12px",
              overflow: "hidden",
              marginBottom: "16px",
            }}>
              {/* Color band */}
              <div style={{ background: selectedColor, padding: "20px 20px 16px", position: "relative" }}>
                <span style={{
                  display: "inline-block",
                  fontSize: "11px",
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: textOnColor,
                  opacity: 0.75,
                  marginBottom: "6px",
                }}>Serviço</span>
                <h2 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: textOnColor, lineHeight: 1.3 }}>
                  {product.title}
                </h2>
              </div>

              {/* Staff preview */}
              <div style={{ padding: "16px 20px" }}>
                <div style={{ fontSize: "11px", fontWeight: 600, color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "10px" }}>
                  Profissional
                </div>
                {selectedStaff ? (
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <div style={{
                      width: "40px", height: "40px", borderRadius: "50%",
                      background: selectedColor,
                      color: textOnColor,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontWeight: 700, fontSize: "14px", flexShrink: 0,
                    }}>
                      {getInitials(selectedStaff.name)}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "14px", color: "#1a1a1a" }}>{selectedStaff.name}</div>
                      {selectedStaff.cargo && (
                        <div style={{ fontSize: "12px", color: "#6d7175" }}>{selectedStaff.cargo}</div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: "13px", color: "#6d7175", fontStyle: "italic" }}>Sem profissional</div>
                )}
              </div>

              {/* Calendar pill preview */}
              <div style={{ padding: "0 20px 20px" }}>
                <div style={{ fontSize: "11px", fontWeight: 600, color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "10px" }}>
                  Calendário
                </div>
                <div style={{
                  display: "inline-flex", alignItems: "center", gap: "6px",
                  background: selectedColor + "22",
                  border: `1.5px solid ${selectedColor}`,
                  borderLeft: `4px solid ${selectedColor}`,
                  borderRadius: "6px",
                  padding: "6px 10px",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: selectedColor,
                  maxWidth: "100%",
                }}>
                  <span style={{
                    width: "8px", height: "8px", borderRadius: "50%",
                    background: selectedColor, flexShrink: 0,
                  }} />
                  {product.title}
                </div>
              </div>
            </div>

            {/* Days summary */}
            <div style={{ background: "#f6f6f7", borderRadius: "10px", padding: "14px 16px" }}>
              <div style={{ fontSize: "11px", fontWeight: 600, color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "10px" }}>
                Dias activos
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {ALL_DAYS.map((d) => {
                  const on = activeDays.includes(d.key);
                  return (
                    <span key={d.key} style={{
                      padding: "3px 9px",
                      borderRadius: "20px",
                      fontSize: "12px",
                      fontWeight: 600,
                      background: on ? selectedColor : "#e1e3e5",
                      color: on ? textOnColor : "#6d7175",
                      transition: "all .2s",
                    }}>
                      {d.label.slice(0, 3)}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ── RIGHT: form ── */}
          <div>

            {/* ── Section 1: Staff ── */}
            <div style={card}>
              <p style={sectionTitle}>👤 Profissional</p>
              <p style={sectionDesc}>Seleciona o profissional responsável por este serviço.</p>

              {staff.length === 0 ? (
                <div style={{
                  background: "#fff4e5", border: "1px solid #f1c672",
                  borderRadius: "8px", padding: "14px 16px",
                  fontSize: "13px", color: "#7d5c00",
                }}>
                  Nenhum profissional encontrado. Cria primeiro um metaobject do tipo <code>profissional_card</code> no Shopify.
                </div>
              ) : (
                <div style={{ display: "grid", gap: "10px" }}>
                  {/* "None" option */}
                  <label style={{
                    display: "flex", alignItems: "center", gap: "14px",
                    padding: "12px 16px",
                    border: `2px solid ${selectedStaffId === "" ? selectedColor : "#e1e3e5"}`,
                    borderRadius: "10px",
                    cursor: "pointer",
                    background: selectedStaffId === "" ? selectedColor + "0d" : "#fff",
                    transition: "all .15s",
                  }}>
                    <input
                      type="radio"
                      name="staffId"
                      value=""
                      checked={selectedStaffId === ""}
                      onChange={() => setSelectedStaffId("")}
                      style={{ display: "none" }}
                    />
                    <div style={{
                      width: "40px", height: "40px", borderRadius: "50%",
                      background: "#e1e3e5", display: "flex",
                      alignItems: "center", justifyContent: "center",
                      fontSize: "18px", flexShrink: 0,
                    }}>🚫</div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "14px", color: "#3d4045" }}>Sem profissional</div>
                      <div style={{ fontSize: "12px", color: "#8c9196" }}>Nenhum staff atribuído</div>
                    </div>
                    {selectedStaffId === "" && (
                      <div style={{ marginLeft: "auto", color: selectedColor, fontSize: "18px" }}>✓</div>
                    )}
                  </label>

                  {staff.map((s) => {
                    const isSelected = selectedStaffId === s.id;
                    return (
                      <label key={s.id} style={{
                        display: "flex", alignItems: "center", gap: "14px",
                        padding: "12px 16px",
                        border: `2px solid ${isSelected ? selectedColor : "#e1e3e5"}`,
                        borderRadius: "10px",
                        cursor: "pointer",
                        background: isSelected ? selectedColor + "0d" : "#fff",
                        transition: "all .15s",
                      }}>
                        <input
                          type="radio"
                          name="staffId"
                          value={s.id}
                          checked={isSelected}
                          onChange={() => setSelectedStaffId(s.id)}
                          style={{ display: "none" }}
                        />
                        <div style={{
                          width: "40px", height: "40px", borderRadius: "50%",
                          background: selectedColor,
                          color: textOnColor,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontWeight: 700, fontSize: "14px", flexShrink: 0,
                        }}>
                          {getInitials(s.name)}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "14px", color: "#1a1a1a" }}>{s.name}</div>
                          {s.cargo && <div style={{ fontSize: "12px", color: "#6d7175" }}>{s.cargo}</div>}
                        </div>
                        {isSelected && (
                          <div style={{ marginLeft: "auto", color: selectedColor, fontSize: "18px" }}>✓</div>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Section 2: Schedule ── */}
            <div style={card}>
              <p style={sectionTitle}>📅 Disponibilidade</p>
              <p style={sectionDesc}>Define os dias e horário em que este serviço está disponível.</p>

              {/* Day toggles */}
              <div style={{ marginBottom: "24px" }}>
                <span style={fieldLabel}>Dias da semana</span>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                  {ALL_DAYS.map((d) => {
                    const on = activeDays.includes(d.key);
                    return (
                      <button
                        key={d.key}
                        type="button"
                        onClick={() => {
                          setActiveDays((prev) =>
                            on ? prev.filter((x) => x !== d.key) : [...prev, d.key]
                          );
                        }}
                        style={{
                          padding: "8px 14px",
                          borderRadius: "20px",
                          border: `2px solid ${on ? selectedColor : "#e1e3e5"}`,
                          background: on ? selectedColor : "#fff",
                          color: on ? textOnColor : "#3d4045",
                          fontSize: "13px",
                          fontWeight: 600,
                          cursor: "pointer",
                          transition: "all .15s",
                          userSelect: "none",
                        }}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
                {/* Hidden checkboxes for form submission */}
                {ALL_DAYS.map((d) => (
                  <input
                    key={d.key}
                    type="checkbox"
                    name={`day_${d.key}`}
                    checked={activeDays.includes(d.key)}
                    onChange={() => {}}
                    style={{ display: "none" }}
                  />
                ))}
              </div>

              {/* Time + duration */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "16px" }}>
                <div>
                  <label htmlFor="startTime" style={fieldLabel}>Início</label>
                  <input
                    id="startTime"
                    type="time"
                    name="startTime"
                    defaultValue={config?.startTime ?? "09:00"}
                    style={inputBase}
                  />
                </div>
                <div>
                  <label htmlFor="endTime" style={fieldLabel}>Fim</label>
                  <input
                    id="endTime"
                    type="time"
                    name="endTime"
                    defaultValue={config?.endTime ?? "18:00"}
                    style={inputBase}
                  />
                </div>
                <div>
                  <label htmlFor="slotDuration" style={fieldLabel}>Duração / slot</label>
                  <select
                    id="slotDuration"
                    name="slotDuration"
                    defaultValue={String(config?.slotDuration ?? 30)}
                    style={inputBase}
                  >
                    {SLOT_DURATIONS.map((d) => (
                      <option key={d.value} value={d.value}>{d.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* ── Section 3: Color ── */}
            <div style={card}>
              <p style={sectionTitle}>🎨 Cor do serviço</p>
              <p style={sectionDesc}>Identificação visual no calendário e em relatórios.</p>

              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "16px" }}>
                {PALETTE.map((hex) => {
                  const isActive = selectedColor === hex;
                  return (
                    <button
                      key={hex}
                      type="button"
                      onClick={() => {
                        setSelectedColor(hex);
                        if (colorInputRef.current) colorInputRef.current.value = hex;
                      }}
                      title={hex}
                      style={{
                        width: "36px", height: "36px",
                        borderRadius: "50%",
                        background: hex,
                        border: isActive ? `3px solid #1a1a1a` : "3px solid transparent",
                        boxShadow: isActive ? `0 0 0 2px ${hex}` : "none",
                        cursor: "pointer",
                        transition: "all .15s",
                        flexShrink: 0,
                        outline: "none",
                      }}
                    />
                  );
                })}

                {/* Custom picker */}
                <label title="Cor personalizada" style={{
                  width: "36px", height: "36px",
                  borderRadius: "50%",
                  border: "2px dashed #c9cccf",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  cursor: "pointer", fontSize: "18px", color: "#6d7175",
                  flexShrink: 0,
                }}>
                  +
                  <input
                    ref={colorInputRef}
                    type="color"
                    name="color"
                    defaultValue={config?.color ?? "#2c6ecb"}
                    onChange={(e) => setSelectedColor(e.target.value)}
                    style={{ position: "absolute", opacity: 0, width: 0, height: 0, pointerEvents: "none" }}
                  />
                </label>
              </div>

              <div style={{ fontSize: "12px", color: "#6d7175" }}>
                Cor actual: <code style={{ background: "#f1f2f3", padding: "2px 6px", borderRadius: "4px" }}>{selectedColor}</code>
              </div>
            </div>

            {/* ── Save bar ── */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: "#fff", border: "1px solid #e1e3e5",
              borderRadius: "12px", padding: "16px 24px",
              position: "sticky", bottom: "16px",
              boxShadow: "0 4px 20px rgba(0,0,0,0.08)",
            }}>
              <div style={{ fontSize: "13px", color: "#6d7175" }}>
                {isSaving ? "⏳ A guardar alterações…" : fetcher.data?.success ? "✅ Guardado com sucesso" : "Guarda as alterações antes de sair."}
              </div>
              <button
                type="submit"
                disabled={isSaving}
                style={{
                  padding: "10px 28px",
                  background: isSaving ? "#c4cdd5" : "#008060",
                  color: "#fff",
                  border: "none",
                  borderRadius: "8px",
                  fontSize: "14px",
                  fontWeight: 700,
                  cursor: isSaving ? "not-allowed" : "pointer",
                  transition: "background .15s",
                  letterSpacing: "0.02em",
                }}
              >
                {isSaving ? "A guardar…" : "Guardar configuração"}
              </button>
            </div>

          </div>{/* end right col */}
        </div>{/* end grid */}
      </fetcher.Form>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
