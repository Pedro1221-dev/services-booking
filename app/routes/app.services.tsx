import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs, ShouldRevalidateFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

// ── Loader ───────────────────────────────────────────────────────────────────
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // Helper: fetch ALL pages of a product query (handles > 250 products)
  async function fetchAllProducts(queryStr: string) {
    type GP = { id: string; title: string; status: string; featuredMedia: { preview: { image: { url: string } } } | null };
    const results: GP[] = [];
    let cursor: string | null = null;
    let hasNext = true;
    while (hasNext) {
      const res = await admin.graphql(
        `#graphql
        query GetProducts($q: String!, $after: String) {
          products(first: 250, query: $q, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges { node { id title status featuredMedia { preview { image { url } } } } }
          }
        }`,
        { variables: { q: queryStr, after: cursor } }
      );
      const json: any = await res.json();
      const page: any = json.data?.products;
      for (const e of (page?.edges ?? [])) results.push(e.node as GP);
      hasNext = Boolean(page?.pageInfo?.hasNextPage);
      cursor = (page?.pageInfo?.endCursor as string) ?? null;
    }
    return results;
  }

  const [serviceNodes, otherNodes] = await Promise.all([
    fetchAllProducts("tag:servico"),
    fetchAllProducts("-tag:servico"),
  ]);

  const map = (nodes: Array<{ id: string; title: string; status: string; featuredMedia: { preview: { image: { url: string } } } | null }>) =>
    nodes.map((node) => ({
      id: node.id,
      title: node.title,
      status: node.status,
      numericId: node.id.split("/").pop()!,
      imageUrl: node.featuredMedia?.preview?.image?.url ?? null,
    }));

  const services = map(serviceNodes);
  const allProducts = map(otherNodes);
  const numericIds = services.map((p) => p.numericId);
  const configs: any[] = numericIds.length
    ? await (prisma as any).serviceConfig.findMany({ where: { shop, productId: { in: numericIds } } })
    : [];
  const configMap = new Map(configs.map((c) => [c.productId, c]));
  const enrichedServices = services.map((p) => {
    const c = configMap.get(p.numericId) as any;
    return {
      ...p,
      staffName: c?.staffName ?? null,
      missingStaff: !c?.staffId,
      missingDays: !c || JSON.parse(c.availableDays ?? "[]").length === 0,
    };
  });
  return { services: enrichedServices, allProducts };
};

// ── Action ───────────────────────────────────────────────────────────────────
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const fd = await request.formData();
  const intent = fd.get("intent") as string;
  if (intent === "add") {
    const ids = fd.getAll("productId") as string[];
    if (!ids.length) return { ok: true };
    await Promise.all(
      ids.map((gid) =>
        admin.graphql(
          `#graphql
          mutation addTag($id: ID!, $tags: [String!]!) {
            tagsAdd(id: $id, tags: $tags) { userErrors { message } }
          }`,
          { variables: { id: gid, tags: ["servico"] } },
        ),
      ),
    );
    return { ok: true };
  }
  if (intent === "remove") {
    const gid = fd.get("productId") as string;
    await admin.graphql(
      `#graphql
      mutation removeTag($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) { userErrors { message } }
      }`,
      { variables: { id: gid, tags: ["servico"] } },
    );
    return { ok: true };
  }
  return { ok: false };
};

// ── Types ────────────────────────────────────────────────────────────────────
type Service = {
  id: string;
  title: string;
  numericId: string;
  imageUrl: string | null;
  status: string;
  staffName: string | null;
  missingStaff: boolean;
  missingDays: boolean;
};
type Product = {
  id: string;
  title: string;
  numericId: string;
  imageUrl: string | null;
  status: string;
};

// ── Icons ────────────────────────────────────────────────────────────────────
function IconPlus() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function IconSettings() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" /><path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}
function IconX() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
function IconUser() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
    </svg>
  );
}
function IconWarn() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function IconImg() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#c4cdd5" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
    </svg>
  );
}
function IconAlertCircle() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#d82c0d" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

// ── ServiceCard ──────────────────────────────────────────────────────────────
function ServiceCard({
  service,
  onRemoveClick,
}: {
  service: Service;
  onRemoveClick: (id: string, title: string) => void;
}) {
  const warns: string[] = [];
  if (service.missingStaff) warns.push("Sem staff");
  if (service.missingDays) warns.push("Sem horario");
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e1e3e5",
        borderRadius: "12px",
        overflow: "hidden",
        position: "relative",
        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Action buttons */}
      <div style={{ position: "absolute", top: "10px", right: "10px", zIndex: 2, display: "flex", gap: "6px" }}>
        <Link
          to={`/app/service-config/${service.numericId}`}
          title="Configurar"
          style={{ width: "30px", height: "30px", background: "rgba(255,255,255,0.95)", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", color: "#6d7175", border: "1px solid #e1e3e5", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" }}
        >
          <IconSettings />
        </Link>
        <button
          type="button"
          title="Remover servico"
          onClick={() => onRemoveClick(service.id, service.title)}
          style={{ width: "30px", height: "30px", background: "rgba(255,255,255,0.95)", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "#d82c0d", border: "1px solid #f9c4be", cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,0.1)" }}
        >
          <IconTrash />
        </button>
      </div>

      {/* Image */}
      {service.imageUrl ? (
        <img src={service.imageUrl} alt={service.title} style={{ width: "100%", height: "148px", objectFit: "cover", display: "block" }} />
      ) : (
        <div style={{ width: "100%", height: "148px", background: "linear-gradient(135deg,#f4f6f8,#e8eaed)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <IconImg />
        </div>
      )}

      {/* Body */}
      <div style={{ padding: "14px 16px 16px", flexGrow: 1, display: "flex", flexDirection: "column", gap: "8px" }}>
        {warns.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
            {warns.map((w) => (
              <span key={w} style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "3px 8px", borderRadius: "20px", fontSize: "11px", fontWeight: 600, background: "#fff8e6", color: "#b98900", border: "1px solid #fce5a2" }}>
                <IconWarn /> {w}
              </span>
            ))}
          </div>
        )}
        <div style={{ fontWeight: 700, fontSize: "15px", lineHeight: "1.35", color: "#1a1a1a" }}>{service.title}</div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: service.staffName ? "#3d4045" : "#9ca3af", marginTop: "auto" }}>
          <span style={{ color: service.staffName ? "#6d7175" : "#c4cdd5" }}>
            <IconUser />
          </span>
          {service.staffName ?? "Sem staff atribuido"}
        </div>
      </div>

      {/* Footer link */}
      <Link
        to={`/app/service-config/${service.numericId}`}
        style={{ display: "block", padding: "10px 16px", borderTop: "1px solid #f1f2f3", textDecoration: "none", fontSize: "13px", fontWeight: 600, color: "#2c6ecb", textAlign: "center", background: "#f9fafb" }}
      >
        Configurar servico
      </Link>
    </div>
  );
}

// ── ConfirmModal ─────────────────────────────────────────────────────────────
function ConfirmModal({
  title,
  onConfirm,
  onCancel,
}: {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div style={{ background: "#fff", borderRadius: "14px", width: "min(420px, 92vw)", boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden" }}>
        <div style={{ padding: "28px 28px 20px", display: "flex", flexDirection: "column", alignItems: "center", gap: "14px", textAlign: "center" }}>
          <div style={{ width: "56px", height: "56px", borderRadius: "50%", background: "#fff2f0", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <IconAlertCircle />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: "16px", color: "#1a1a1a", marginBottom: "8px" }}>
              Remover servico?
            </div>
            <div style={{ fontSize: "14px", color: "#6d7175", lineHeight: "1.5" }}>
              Tens a certeza que queres remover <strong>"{title}"</strong> dos servicos?
              <br />
              <span style={{ fontSize: "12px" }}>O produto nao sera eliminado, apenas deixa de ser servico.</span>
            </div>
          </div>
        </div>
        <div style={{ padding: "0 28px 24px", display: "flex", gap: "10px" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{ flex: 1, padding: "10px 20px", background: "#fff", border: "1px solid #c9cccf", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: 500, color: "#3d4045" }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{ flex: 1, padding: "10px 20px", background: "#d82c0d", border: "none", borderRadius: "8px", cursor: "pointer", fontSize: "14px", fontWeight: 600, color: "#fff" }}
          >
            Remover
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function ServicesPage() {
  const loaderData = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  // ── Local state — UI source of truth (instant updates, no revalidation) ──
  const [servicesList, setServicesList] = useState<Service[]>(
    () => loaderData.services as Service[],
  );
  const [availableProducts, setAvailableProducts] = useState<Product[]>(
    () => loaderData.allProducts as Product[],
  );

  // Sync if user navigates away and back (loader runs again)
  useEffect(() => {
    setServicesList(loaderData.services as Service[]);
    setAvailableProducts(loaderData.allProducts as Product[]);
  }, [loaderData]);

  // ── Add modal ──
  const [modalOpen, setModalOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  // ── Confirm remove modal ──
  const [confirmTarget, setConfirmTarget] = useState<{ id: string; title: string } | null>(null);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const filtered = availableProducts.filter((p) =>
    p.title.toLowerCase().includes(search.toLowerCase()),
  );

  // ── Add: update arrays immediately, fire tagsAdd in background ──
  const handleAdd = () => {
    if (!selected.size) return;
    const toAdd = availableProducts.filter((p) => selected.has(p.id));
    const newServices: Service[] = toAdd.map((p) => ({
      ...p,
      staffName: null,
      missingStaff: true,
      missingDays: true,
    }));
    setServicesList((prev) => [...prev, ...newServices]);
    setAvailableProducts((prev) => prev.filter((p) => !selected.has(p.id)));
    setModalOpen(false);
    setSelected(new Set());
    setSearch("");
    // Background mutation — does not affect UI state
    const fd = new FormData();
    fd.append("intent", "add");
    toAdd.forEach((p) => fd.append("productId", p.id));
    fetcher.submit(fd, { method: "post" });
  };

  // ── Remove: open confirm modal ──
  const handleRemoveClick = (id: string, title: string) => {
    setConfirmTarget({ id, title });
  };

  // ── Remove confirmed: update arrays immediately, fire tagsRemove in background ──
  const handleRemoveConfirm = () => {
    if (!confirmTarget) return;
    const { id } = confirmTarget;
    const removed = servicesList.find((s) => s.id === id);
    setServicesList((prev) => prev.filter((s) => s.id !== id));
    if (removed) {
      setAvailableProducts((prev) => [
        {
          id: removed.id,
          title: removed.title,
          numericId: removed.numericId,
          imageUrl: removed.imageUrl,
          status: removed.status,
        },
        ...prev,
      ]);
    }
    setConfirmTarget(null);
    // Background mutation — does not affect UI state
    const fd = new FormData();
    fd.append("intent", "remove");
    fd.append("productId", id);
    fetcher.submit(fd, { method: "post" });
  };

  const isAdding =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "add";

  return (
    <>
      <s-page heading="Servicos">
        <s-section heading="">
          {/* Header row */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
            <div style={{ fontSize: "14px", color: "#6d7175" }}>
              {servicesList.length} {servicesList.length === 1 ? "servico" : "servicos"}
            </div>
            <button
              onClick={() => setModalOpen(true)}
              style={{ display: "inline-flex", alignItems: "center", gap: "7px", padding: "9px 18px", background: "#008060", color: "#fff", border: "none", borderRadius: "7px", cursor: "pointer", fontSize: "14px", fontWeight: 600 }}
            >
              <IconPlus /> Adicionar servicos
            </button>
          </div>

          {/* Grid or empty state */}
          {servicesList.length === 0 ? (
            <div style={{ padding: "56px 24px", textAlign: "center", background: "#f9fafb", borderRadius: "10px", border: "1px dashed #e1e3e5" }}>
              <div style={{ fontWeight: 700, fontSize: "15px", color: "#3d4045", marginBottom: "6px" }}>
                Nenhum servico adicionado
              </div>
              <div style={{ fontSize: "13px", color: "#9ca3af" }}>
                Clica em "Adicionar servicos" para selecionar produtos da loja.
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "20px" }}>
              {servicesList.map((s) => (
                <ServiceCard key={s.id} service={s} onRemoveClick={handleRemoveClick} />
              ))}
            </div>
          )}
        </s-section>
      </s-page>

      {/* ── Add Modal ─────────────────────────────────────────────────── */}
      {modalOpen && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setModalOpen(false);
              setSelected(new Set());
              setSearch("");
            }
          }}
        >
          <div style={{ background: "#fff", borderRadius: "12px", width: "min(600px, 96vw)", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            {/* Header */}
            <div style={{ padding: "20px 24px", borderBottom: "1px solid #e1e3e5", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: "17px", color: "#1a1a1a" }}>Adicionar servicos</div>
                <div style={{ fontSize: "13px", color: "#6d7175", marginTop: "2px" }}>
                  Seleciona os produtos que queres marcar como servico
                </div>
              </div>
              <button
                type="button"
                onClick={() => { setModalOpen(false); setSelected(new Set()); setSearch(""); }}
                style={{ background: "none", border: "none", cursor: "pointer", color: "#6d7175", padding: "4px", display: "flex" }}
              >
                <IconX />
              </button>
            </div>

            {/* Search */}
            <div style={{ padding: "16px 24px 0", flexShrink: 0 }}>
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)" }}>
                  <IconSearch />
                </span>
                <input
                  type="text"
                  placeholder="Pesquisar produtos..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ width: "100%", padding: "9px 12px 9px 36px", border: "1px solid #c9cccf", borderRadius: "7px", fontSize: "14px", boxSizing: "border-box", outline: "none" }}
                />
              </div>
            </div>

            {/* Product list */}
            <div style={{ overflowY: "auto", padding: "12px 24px", flexGrow: 1 }}>
              {filtered.length === 0 ? (
                <div style={{ padding: "32px", textAlign: "center", color: "#9ca3af", fontSize: "14px" }}>
                  {search ? "Nenhum produto encontrado." : "Todos os produtos ja sao servicos."}
                </div>
              ) : (
                filtered.map((p) => {
                  const checked = selected.has(p.id);
                  return (
                    <div
                      key={p.id}
                      onClick={() => toggle(p.id)}
                      style={{ display: "flex", alignItems: "center", gap: "12px", padding: "10px 12px", borderRadius: "8px", cursor: "pointer", marginBottom: "4px", background: checked ? "#f0faf5" : "transparent", border: checked ? "1px solid #b7dfce" : "1px solid transparent" }}
                    >
                      {/* Custom checkbox */}
                      <div style={{ width: "18px", height: "18px", borderRadius: "4px", border: `2px solid ${checked ? "#008060" : "#c9cccf"}`, background: checked ? "#008060" : "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        {checked && (
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                            <polyline points="2 6 5 9 10 3" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </div>
                      {/* Thumbnail */}
                      {p.imageUrl ? (
                        <img src={p.imageUrl} alt={p.title} style={{ width: "40px", height: "40px", borderRadius: "6px", objectFit: "cover", flexShrink: 0, border: "1px solid #e1e3e5" }} />
                      ) : (
                        <div style={{ width: "40px", height: "40px", borderRadius: "6px", background: "#f4f6f8", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid #e1e3e5" }}>
                          <IconImg />
                        </div>
                      )}
                      {/* Info */}
                      <div style={{ flexGrow: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: "14px", color: "#1a1a1a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {p.title}
                        </div>
                        <span style={{ padding: "1px 6px", borderRadius: "8px", background: p.status === "ACTIVE" ? "#e3f1ec" : "#f4f6f8", color: p.status === "ACTIVE" ? "#008060" : "#6d7175", fontSize: "11px", fontWeight: 600 }}>
                          {p.status === "ACTIVE" ? "Ativo" : "Rascunho"}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: "16px 24px", borderTop: "1px solid #e1e3e5", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <span style={{ fontSize: "13px", color: "#6d7175" }}>
                {selected.size > 0
                  ? `${selected.size} selecionado${selected.size > 1 ? "s" : ""}`
                  : "Nenhum selecionado"}
              </span>
              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  type="button"
                  onClick={() => { setModalOpen(false); setSelected(new Set()); setSearch(""); }}
                  style={{ padding: "8px 18px", background: "#fff", border: "1px solid #c9cccf", borderRadius: "7px", cursor: "pointer", fontSize: "14px", fontWeight: 500 }}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={!selected.size || isAdding}
                  onClick={handleAdd}
                  style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "8px 20px", background: selected.size ? "#008060" : "#c4cdd5", color: "#fff", border: "none", borderRadius: "7px", cursor: selected.size ? "pointer" : "not-allowed", fontSize: "14px", fontWeight: 600 }}
                >
                  {isAdding ? "A adicionar..." : `Adicionar${selected.size ? ` (${selected.size})` : ""}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm Remove Modal ──────────────────────────────────────── */}
      {confirmTarget && (
        <ConfirmModal
          title={confirmTarget.title}
          onConfirm={handleRemoveConfirm}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

// Impede revalidação do loader após as nossas mutations (add/remove)
// A UI já está atualizada localmente — revalidar causaria reset prematuro
// porque a tag do Shopify ainda pode não ter propagado.
// Revalida normalmente em navegações (ex: utilizador volta à página).
export function shouldRevalidate({ formAction, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formAction === "/app/services") return false;
  return defaultShouldRevalidate;
}
