import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

export const headers: HeadersFunction = (args) => boundary.headers(args);

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Fetch all products with their variants
  type Variant = { id: string; title: string; price: string };
  type Product = { id: string; title: string; variants: Variant[]; numericId: string };

  async function fetchProductsWithVariants(tag: string) {
    const results: Product[] = [];
    let cursor: string | null = null;
    let hasNext = true;
    while (hasNext) {
      const res = await admin.graphql(
        `#graphql
        query GetProducts($q: String!, $after: String) {
          products(first: 50, query: $q, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id title
                variants(first: 20) {
                  edges { node { id title price } }
                }
              }
            }
          }
        }`,
        { variables: { q: tag, after: cursor } }
      );
      const json: any = await res.json();
      const page: any = json.data?.products;
      for (const e of (page?.edges ?? [])) {
        const p = e.node as any;
        results.push({
          id: p.id,
          numericId: p.id.split("/").pop()!,
          title: p.title,
          variants: (p.variants?.edges ?? []).map((ve: any) => ({
            id: ve.node.id.split("/").pop()!,
            title: ve.node.title,
            price: ve.node.price,
          })),
        });
      }
      hasNext = Boolean(page?.pageInfo?.hasNextPage);
      cursor = (page?.pageInfo?.endCursor as string) ?? null;
    }
    return results;
  }

  const [packageProducts, services, configs, serviceConfigs] = await Promise.all([
    fetchProductsWithVariants("-tag:servico"),
    fetchProductsWithVariants("tag:servico"),
    (prisma as any).packageConfig.findMany({ where: { shop }, orderBy: { createdAt: "asc" } }),
    (prisma as any).serviceConfig.findMany({ where: { shop } }),
  ]);

  return { packageProducts, services, configs, serviceConfigs };
};

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();
  const intent = fd.get("intent") as string;

  if (intent === "create") {
    const variantId       = fd.get("variantId") as string;
    const variantTitle    = fd.get("variantTitle") as string;
    const productId       = fd.get("productId") as string;
    const productTitle    = fd.get("productTitle") as string;
    const serviceProductId = fd.get("serviceProductId") as string;
    const serviceTitle    = fd.get("serviceTitle") as string;
    const creditsTotal    = parseInt(fd.get("creditsTotal") as string, 10);

    if (!variantId || !serviceProductId || !creditsTotal || creditsTotal < 1) {
      return { ok: false, error: "Preenche todos os campos." };
    }

    await (prisma as any).packageConfig.upsert({
      where: { shop_variantId: { shop, variantId } },
      create: { shop, variantId, variantTitle, productId, productTitle, serviceProductId, serviceTitle, creditsTotal },
      update: { variantTitle, productId, productTitle, serviceProductId, serviceTitle, creditsTotal },
    });
    return { ok: true };
  }

  if (intent === "delete") {
    const id = fd.get("id") as string;
    await (prisma as any).packageConfig.delete({ where: { id } });
    return { ok: true };
  }

  if (intent === "set_limit") {
    const serviceProductId = fd.get("serviceProductId") as string;
    const maxPerCustomer   = fd.get("maxPerCustomer") as string;
    const max = maxPerCustomer === "" ? null : parseInt(maxPerCustomer, 10);
    await (prisma as any).serviceConfig.updateMany({
      where: { shop, productId: serviceProductId },
      data: { maxPerCustomer: max },
    });
    return { ok: true };
  }

  return { ok: false };
};

// ── Types ─────────────────────────────────────────────────────────────────────
type Variant = { id: string; title: string; price: string };
type Product = { id: string; numericId: string; title: string; variants: Variant[] };
type PackageConfig = {
  id: string; variantId: string; variantTitle: string;
  productTitle: string; serviceTitle: string; serviceProductId: string; creditsTotal: number;
};
type ServiceConfig = { productId: string; maxPerCustomer: number | null };
type Service = { id: string; numericId: string; title: string };

// ── Component ─────────────────────────────────────────────────────────────────
export default function PackageConfigsPage() {
  const { packageProducts, services, configs, serviceConfigs } = useLoaderData<typeof loader>() as {
    packageProducts: Product[];
    services: Service[];
    configs: PackageConfig[];
    serviceConfigs: ServiceConfig[];
  };
  const fetcher = useFetcher();
  const [selProductId, setSelProductId] = useState("");
  const [selVariantId, setSelVariantId] = useState("");
  const [selServiceId, setSelServiceId] = useState("");
  const [credits, setCredits] = useState("5");

  const selProduct = packageProducts.find(p => p.numericId === selProductId);
  const selVariant = selProduct?.variants.find(v => v.id === selVariantId);
  const selService = services.find(s => s.numericId === selServiceId);

  const serviceConfigMap = new Map(serviceConfigs.map((sc: ServiceConfig) => [sc.productId, sc.maxPerCustomer]));

  function handleProductChange(id: string) {
    setSelProductId(id);
    setSelVariantId("");
  }

  function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!selVariant || !selService) return;
    const fd = new FormData();
    fd.set("intent", "create");
    fd.set("variantId", selVariant.id);
    fd.set("variantTitle", `${selProduct!.title}${selVariant.title !== "Default Title" ? " — " + selVariant.title : ""}`);
    fd.set("productId", selProduct!.numericId);
    fd.set("productTitle", selProduct!.title);
    fd.set("serviceProductId", selService.numericId);
    fd.set("serviceTitle", selService.title);
    fd.set("creditsTotal", credits);
    fetcher.submit(fd, { method: "post" });
    setSelProductId(""); setSelVariantId(""); setSelServiceId(""); setCredits("5");
  }

  const busy = fetcher.state !== "idle";

  return (
    <div style={{ fontFamily: "var(--p-font-family-sans)", maxWidth: 820, margin: "0 auto", padding: "24px 20px" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Configuração de Pacotes</h1>
      <p style={{ color: "#6d7175", marginBottom: 32, fontSize: 14 }}>
        Define quantas consultas cada variante representa e os limites de marcação por cliente.
      </p>

      {/* ── Section 1: Variant → Package mapping ── */}
      <section style={{ marginBottom: 40 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Variantes configuradas como pacotes</h2>

        {configs.length === 0 && (
          <p style={{ color: "#8c9196", fontSize: 14, marginBottom: 16 }}>Nenhuma variante configurada ainda.</p>
        )}

        {configs.length > 0 && (
          <div style={{ border: "1px solid #e1e3e5", borderRadius: 10, overflow: "hidden", marginBottom: 24 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ background: "#f6f6f7", borderBottom: "1px solid #e1e3e5" }}>
                  <th style={{ padding: "10px 16px", textAlign: "left", fontWeight: 600, color: "#3d4045" }}>Produto / Variante</th>
                  <th style={{ padding: "10px 16px", textAlign: "left", fontWeight: 600, color: "#3d4045" }}>Serviço</th>
                  <th style={{ padding: "10px 16px", textAlign: "center", fontWeight: 600, color: "#3d4045" }}>Créditos</th>
                  <th style={{ padding: "10px 16px" }} />
                </tr>
              </thead>
              <tbody>
                {configs.map((cfg, i) => (
                  <tr key={cfg.id} style={{ borderBottom: i < configs.length - 1 ? "1px solid #f1f2f3" : "none" }}>
                    <td style={{ padding: "12px 16px" }}>
                      <div style={{ fontWeight: 600 }}>{cfg.variantTitle}</div>
                      <div style={{ fontSize: 12, color: "#8c9196" }}>ID variante: {cfg.variantId}</div>
                    </td>
                    <td style={{ padding: "12px 16px", color: "#3d4045" }}>{cfg.serviceTitle}</td>
                    <td style={{ padding: "12px 16px", textAlign: "center" }}>
                      <span style={{ background: "#e3f1ec", color: "#008060", fontWeight: 700, padding: "2px 10px", borderRadius: 20, fontSize: 13 }}>
                        {cfg.creditsTotal}
                      </span>
                    </td>
                    <td style={{ padding: "12px 16px", textAlign: "right" }}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          const fd = new FormData();
                          fd.set("intent", "delete");
                          fd.set("id", cfg.id);
                          fetcher.submit(fd, { method: "post" });
                        }}
                        style={{ background: "none", border: "none", color: "#d82c0d", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
                      >
                        Remover
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Add form */}
        <form onSubmit={submitCreate}>
          <div style={{ border: "1px solid #e1e3e5", borderRadius: 10, padding: 20, background: "#fafafa" }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 16, marginTop: 0 }}>Adicionar configuração</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
              {/* Product */}
              <div>
                <label style={labelStyle}>Produto (pacote)</label>
                <select
                  value={selProductId}
                  onChange={e => handleProductChange(e.target.value)}
                  style={selectStyle}
                  required
                >
                  <option value="">-- Escolhe um produto --</option>
                  {packageProducts.map(p => (
                    <option key={p.numericId} value={p.numericId}>{p.title}</option>
                  ))}
                </select>
              </div>
              {/* Variant */}
              <div>
                <label style={labelStyle}>Variante</label>
                <select
                  value={selVariantId}
                  onChange={e => setSelVariantId(e.target.value)}
                  style={selectStyle}
                  required
                  disabled={!selProduct}
                >
                  <option value="">-- Escolhe uma variante --</option>
                  {(selProduct?.variants ?? []).map(v => (
                    <option key={v.id} value={v.id}>
                      {v.title === "Default Title" ? selProduct!.title : v.title} ({v.price}€)
                    </option>
                  ))}
                </select>
              </div>
              {/* Service */}
              <div>
                <label style={labelStyle}>Serviço a marcar</label>
                <select
                  value={selServiceId}
                  onChange={e => setSelServiceId(e.target.value)}
                  style={selectStyle}
                  required
                >
                  <option value="">-- Escolhe um serviço --</option>
                  {services.map(s => (
                    <option key={s.numericId} value={s.numericId}>{s.title}</option>
                  ))}
                </select>
              </div>
              {/* Credits */}
              <div>
                <label style={labelStyle}>Nº de consultas (créditos)</label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={credits}
                  onChange={e => setCredits(e.target.value)}
                  style={{ ...selectStyle, width: "100%", boxSizing: "border-box" }}
                  required
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={busy || !selVariantId || !selServiceId}
              style={{
                background: (!selVariantId || !selServiceId || busy) ? "#c4cdd5" : "#008060",
                color: "#fff", border: "none", borderRadius: 8,
                padding: "10px 24px", fontSize: 14, fontWeight: 700, cursor: "pointer",
              }}
            >
              {busy ? "A guardar..." : "Guardar configuração"}
            </button>
          </div>
        </form>
      </section>

      {/* ── Section 2: Per-customer limits ── */}
      <section>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Limites de marcação por cliente</h2>
        <p style={{ color: "#6d7175", fontSize: 14, marginBottom: 16 }}>
          Define o máximo de marcações que um cliente pode ter em cada serviço.
          Útil para consultas de avaliação gratuitas (limite 1 por pessoa).
        </p>

        {services.length === 0 && (
          <p style={{ color: "#8c9196", fontSize: 14 }}>Nenhum serviço configurado. Adiciona produtos com a tag <code>servico</code>.</p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {services.map(svc => {
            const currentLimit = serviceConfigMap.get(svc.numericId) ?? null;
            return (
              <LimitRow
                key={svc.numericId}
                service={svc}
                currentLimit={currentLimit}
                busy={busy}
                onSave={(max) => {
                  const fd = new FormData();
                  fd.set("intent", "set_limit");
                  fd.set("serviceProductId", svc.numericId);
                  fd.set("maxPerCustomer", max === null ? "" : String(max));
                  fetcher.submit(fd, { method: "post" });
                }}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}

function LimitRow({ service, currentLimit, busy, onSave }: {
  service: Service;
  currentLimit: number | null;
  busy: boolean;
  onSave: (max: number | null) => void;
}) {
  const [value, setValue] = useState(currentLimit !== null ? String(currentLimit) : "");
  const [saved, setSaved] = useState(false);

  function handleSave() {
    const max = value === "" ? null : parseInt(value, 10);
    onSave(max);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div style={{ border: "1px solid #e1e3e5", borderRadius: 10, padding: "16px 20px", background: "#fff", display: "flex", alignItems: "center", gap: 16, justifyContent: "space-between" }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{service.title}</div>
        <div style={{ fontSize: 12, color: "#8c9196" }}>
          {currentLimit !== null ? `Limite actual: ${currentLimit} marcação${currentLimit !== 1 ? 'ões' : ''} por cliente` : "Sem limite (ilimitado)"}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <input
          type="number"
          min="1"
          placeholder="Sem limite"
          value={value}
          onChange={e => setValue(e.target.value)}
          style={{ width: 120, padding: "8px 10px", border: "1px solid #c9cccf", borderRadius: 8, fontSize: 14 }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={handleSave}
          style={{ padding: "8px 18px", background: saved ? "#008060" : "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", minWidth: 80 }}
        >
          {saved ? "✓ Guardado" : "Guardar"}
        </button>
        {value !== "" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => { setValue(""); onSave(null); }}
            style={{ padding: "8px 12px", background: "none", border: "1px solid #c9cccf", borderRadius: 8, fontSize: 12, cursor: "pointer", color: "#6d7175" }}
          >
            Remover limite
          </button>
        )}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 13, fontWeight: 600, color: "#3d4045", marginBottom: 6,
};
const selectStyle: React.CSSProperties = {
  width: "100%", padding: "9px 12px", border: "1px solid #c9cccf", borderRadius: 8,
  fontSize: 14, background: "#fff", boxSizing: "border-box",
};
