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

  // Fetch all SERVICE products (tag:servico) with their variants
  type Variant = { id: string; numericId: string; title: string; price: string };
  type Service = { id: string; numericId: string; title: string; variants: Variant[] };

  const services: Service[] = [];
  let cursor: string | null = null;
  let hasNext = true;
  while (hasNext) {
    const res = await admin.graphql(
      `#graphql
      query GetServices($after: String) {
        products(first: 50, query: "tag:servico", after: $after) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id title
              variants(first: 30) {
                edges { node { id title price } }
              }
            }
          }
        }
      }`,
      { variables: { after: cursor } }
    );
    const json: any = await res.json();
    const page: any = json.data?.products;
    for (const e of (page?.edges ?? [])) {
      const p = e.node as any;
      services.push({
        id: p.id,
        numericId: p.id.split("/").pop()!,
        title: p.title,
        variants: (p.variants?.edges ?? []).map((ve: any) => ({
          id: ve.node.id,
          numericId: ve.node.id.split("/").pop()!,
          title: ve.node.title,
          price: ve.node.price,
        })),
      });
    }
    hasNext = Boolean(page?.pageInfo?.hasNextPage);
    cursor = (page?.pageInfo?.endCursor as string) ?? null;
  }

  const configs = await (prisma as any).packageConfig.findMany({
    where: { shop },
    orderBy: { createdAt: "asc" },
  });

  return { services, configs };
};

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();
  const intent = fd.get("intent") as string;

  // Save all variant configs for a service at once
  if (intent === "save_service") {
    const serviceProductId = fd.get("serviceProductId") as string;
    const serviceTitle     = fd.get("serviceTitle") as string;
    const variantIds       = fd.getAll("variantId") as string[];

    for (const variantId of variantIds) {
      const creditsRaw = fd.get(`credits_${variantId}`) as string;
      const maxRaw     = fd.get(`max_${variantId}`) as string;
      const variantTitle = fd.get(`variantTitle_${variantId}`) as string;

      const credits = creditsRaw ? parseInt(creditsRaw, 10) : null;
      const max     = maxRaw     ? parseInt(maxRaw, 10)     : null;

      if (credits && credits > 0) {
        await (prisma as any).packageConfig.upsert({
          where: { shop_variantId: { shop, variantId } },
          create: {
            shop, variantId, variantTitle, serviceProductId, serviceTitle,
            creditsTotal: credits, maxPerCustomer: max,
          },
          update: { variantTitle, serviceProductId, serviceTitle, creditsTotal: credits, maxPerCustomer: max },
        });
      } else {
        // Empty credits = remove config for this variant
        await (prisma as any).packageConfig.deleteMany({ where: { shop, variantId } });
      }
    }
    return { ok: true };
  }

  return { ok: false };
};

// ── Types ─────────────────────────────────────────────────────────────────────
type Variant  = { id: string; numericId: string; title: string; price: string };
type Service  = { id: string; numericId: string; title: string; variants: Variant[] };
type PkgCfg   = { id: string; variantId: string; creditsTotal: number; maxPerCustomer: number | null };

// ── Page ──────────────────────────────────────────────────────────────────────
export default function PackageConfigsPage() {
  const { services, configs } = useLoaderData<typeof loader>() as {
    services: Service[];
    configs: PkgCfg[];
  };
  const fetcher = useFetcher();
  const [selServiceId, setSelServiceId] = useState<string>("");
  const [saved, setSaved] = useState(false);

  const cfgMap = new Map(configs.map(c => [c.variantId, c]));
  const selService = services.find(s => s.numericId === selServiceId) ?? null;
  const busy = fetcher.state !== "idle";

  // Local state for the form rows: variantId → { credits, max }
  const [rows, setRows] = useState<Record<string, { credits: string; max: string }>>({});

  function selectService(id: string) {
    setSelServiceId(id);
    setSaved(false);
    // Pre-fill rows from existing DB configs
    const svc = services.find(s => s.numericId === id);
    if (!svc) return;
    const init: Record<string, { credits: string; max: string }> = {};
    for (const v of svc.variants) {
      const cfg = cfgMap.get(v.numericId);
      init[v.numericId] = {
        credits: cfg ? String(cfg.creditsTotal) : "",
        max:     cfg?.maxPerCustomer != null ? String(cfg.maxPerCustomer) : "",
      };
    }
    setRows(init);
  }

  function setRow(variantId: string, field: "credits" | "max", value: string) {
    setRows(r => ({ ...r, [variantId]: { ...r[variantId], [field]: value } }));
  }

  function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selService) return;
    const fd = new FormData();
    fd.set("intent", "save_service");
    fd.set("serviceProductId", selService.numericId);
    fd.set("serviceTitle", selService.title);
    for (const v of selService.variants) {
      fd.append("variantId", v.numericId);
      fd.set(`variantTitle_${v.numericId}`, v.title === "Default Title" ? selService.title : v.title);
      fd.set(`credits_${v.numericId}`, rows[v.numericId]?.credits ?? "");
      fd.set(`max_${v.numericId}`, rows[v.numericId]?.max ?? "");
    }
    fetcher.submit(fd, { method: "post" });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  // Summary of all configured variants across services
  const configured = configs.map(cfg => {
    const svc = services.find(s =>
      s.variants.some(v => v.numericId === cfg.variantId)
    );
    const variant = svc?.variants.find(v => v.numericId === cfg.variantId);
    return { cfg, svcTitle: svc?.title ?? "—", variantTitle: variant?.title ?? cfg.variantId };
  });

  return (
    <div style={{ fontFamily: "var(--p-font-family-sans)", maxWidth: 860, margin: "0 auto", padding: "24px 20px" }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Configuração de Pacotes</h1>
      <p style={{ color: "#6d7175", marginBottom: 32, fontSize: 14 }}>
        Para cada serviço, define quantas consultas cada variante representa e o limite de marcações por cliente.
      </p>

      {/* ── Service selector ── */}
      <div style={{ marginBottom: 28 }}>
        <label style={labelStyle}>Seleccionar serviço</label>
        <select
          value={selServiceId}
          onChange={e => selectService(e.target.value)}
          style={{ ...inputStyle, maxWidth: 420 }}
        >
          <option value="">-- Escolhe um serviço --</option>
          {services.map(s => (
            <option key={s.numericId} value={s.numericId}>{s.title}</option>
          ))}
        </select>
        {services.length === 0 && (
          <p style={{ color: "#d82c0d", fontSize: 13, marginTop: 8 }}>
            Nenhum serviço encontrado. Adiciona produtos com a tag <code>servico</code> na página Serviços.
          </p>
        )}
      </div>

      {/* ── Variant config form ── */}
      {selService && (
        <form onSubmit={handleSave}>
          <div style={{ border: "1px solid #e1e3e5", borderRadius: 12, overflow: "hidden", marginBottom: 20 }}>
            {/* Header */}
            <div style={{ background: "#f6f6f7", padding: "12px 20px", borderBottom: "1px solid #e1e3e5", display: "grid", gridTemplateColumns: "1fr 160px 160px", gap: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#3d4045" }}>Variante</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#3d4045" }}>Nº de consultas</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#3d4045" }}>Limite por cliente</span>
            </div>

            {/* Variant rows */}
            {selService.variants.map((v, i) => {
              const row = rows[v.numericId] ?? { credits: "", max: "" };
              const isLast = i === selService.variants.length - 1;
              const isConfigured = cfgMap.has(v.numericId);
              return (
                <div
                  key={v.numericId}
                  style={{
                    padding: "16px 20px",
                    borderBottom: isLast ? "none" : "1px solid #f1f2f3",
                    display: "grid",
                    gridTemplateColumns: "1fr 160px 160px",
                    gap: 12,
                    alignItems: "center",
                    background: isConfigured ? "#fafffe" : "#fff",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {v.title === "Default Title" ? selService.title : v.title}
                      {isConfigured && (
                        <span style={{ marginLeft: 8, background: "#e3f1ec", color: "#008060", fontSize: 11, fontWeight: 700, padding: "2px 7px", borderRadius: 20 }}>configurado</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: "#8c9196" }}>{v.price}€</div>
                  </div>
                  <div>
                    <input
                      type="number"
                      min="1"
                      max="200"
                      placeholder="—"
                      value={row.credits}
                      onChange={e => setRow(v.numericId, "credits", e.target.value)}
                      style={inputStyle}
                      title="Número de consultas incluídas neste pacote"
                    />
                    {!row.credits && <div style={{ fontSize: 11, color: "#8c9196", marginTop: 3 }}>vazio = não é pacote</div>}
                  </div>
                  <div>
                    <input
                      type="number"
                      min="1"
                      placeholder="Sem limite"
                      value={row.max}
                      onChange={e => setRow(v.numericId, "max", e.target.value)}
                      style={inputStyle}
                      title="Máximo de marcações que um cliente pode ter para este serviço através desta variante"
                    />
                    {row.max === "1" && <div style={{ fontSize: 11, color: "#916a00", marginTop: 3 }}>⚠ só 1 por cliente</div>}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              type="submit"
              disabled={busy}
              style={{ background: busy ? "#c4cdd5" : "#008060", color: "#fff", border: "none", borderRadius: 8, padding: "10px 28px", fontSize: 14, fontWeight: 700, cursor: busy ? "default" : "pointer" }}
            >
              {busy ? "A guardar..." : "Guardar configuração"}
            </button>
            {saved && !busy && (
              <span style={{ color: "#008060", fontSize: 14, fontWeight: 600 }}>✓ Guardado com sucesso</span>
            )}
          </div>

          <p style={{ fontSize: 12, color: "#8c9196", marginTop: 12 }}>
            Deixa "Nº de consultas" vazio para que a variante não seja tratada como pacote.
            "Limite por cliente" restringe quantas vezes um cliente pode usar este pacote (ex: 1 para avaliação gratuita).
          </p>
        </form>
      )}

      {/* ── Summary of all configs ── */}
      {configured.length > 0 && (
        <div style={{ marginTop: 40 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Resumo de todas as configurações</h2>
          <div style={{ border: "1px solid #e1e3e5", borderRadius: 10, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f6f6f7", borderBottom: "1px solid #e1e3e5" }}>
                  <th style={thStyle}>Serviço</th>
                  <th style={thStyle}>Variante</th>
                  <th style={{ ...thStyle, textAlign: "center" }}>Consultas</th>
                  <th style={{ ...thStyle, textAlign: "center" }}>Limite/cliente</th>
                </tr>
              </thead>
              <tbody>
                {configured.map(({ cfg, svcTitle, variantTitle }, i) => (
                  <tr key={cfg.id} style={{ borderBottom: i < configured.length - 1 ? "1px solid #f1f2f3" : "none" }}>
                    <td style={tdStyle}>{svcTitle}</td>
                    <td style={tdStyle}>{variantTitle === "Default Title" ? svcTitle : variantTitle}</td>
                    <td style={{ ...tdStyle, textAlign: "center" }}>
                      <span style={{ background: "#e3f1ec", color: "#008060", fontWeight: 700, padding: "2px 9px", borderRadius: 20 }}>{cfg.creditsTotal}</span>
                    </td>
                    <td style={{ ...tdStyle, textAlign: "center" }}>
                      {cfg.maxPerCustomer != null
                        ? <span style={{ background: "#fff3cd", color: "#916a00", fontWeight: 700, padding: "2px 9px", borderRadius: 20 }}>{cfg.maxPerCustomer}</span>
                        : <span style={{ color: "#8c9196" }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 600, color: "#3d4045", marginBottom: 6 };
const inputStyle: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #c9cccf", borderRadius: 8, fontSize: 14, boxSizing: "border-box" };
const thStyle: React.CSSProperties = { padding: "10px 16px", textAlign: "left", fontWeight: 600, color: "#3d4045" };
const tdStyle: React.CSSProperties = { padding: "11px 16px", color: "#3d4045" };
