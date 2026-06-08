import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

// ── Config ────────────────────────────────────────────────────────────────────
const PRODUCTION_APP_URL = 'https://services-booking-kappa.vercel.app';
const CA_GRAPHQL = 'shopify://customer-account/api/2026-04/graphql.json';

function getAppUrl() {
  try {
    return String(globalThis.shopify?.settings?.value?.app_url || PRODUCTION_APP_URL).replace(/\/$/, '');
  } catch {
    return PRODUCTION_APP_URL;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const PT_MONTHS = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

function pad(n) { return String(n).padStart(2, '0'); }
function toDateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function formatDate(s) {
  if (!s) return '';
  const d = new Date(s + 'T12:00:00');
  return `${d.getDate()} ${PT_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// ── Booking Modal ─────────────────────────────────────────────────────────────
function BookingModal({ pkg, shop, customer, appUrl, onBooked }) {
  const modalId = `book-${pkg.id}`;
  const [step, setStep]           = useState(1);
  const [selDate, setSelDate]     = useState('');
  const [slots, setSlots]         = useState([]);
  const [loadingSlots, setLoading]= useState(false);
  const [selTime, setSelTime]     = useState('');
  const [booking, setBooking]     = useState(false);
  const [error, setError]         = useState('');
  const dateRef = useRef(null);

  // Today + 1 year allowed range
  const today    = new Date();
  const todayStr = toDateStr(today);
  const endDate  = new Date(today); endDate.setFullYear(today.getFullYear() + 1);
  const allowRange = `${todayStr}--${toDateStr(endDate)}`;

  // Wire up the date-picker change event via ref (custom element event)
  useEffect(() => {
    const el = dateRef.current;
    if (!el) return;
    const onDateChange = (e) => {
      const val = e.target?.value ?? e.currentTarget?.value ?? '';
      if (!val) return;
      setSelDate(val);
      setSelTime('');
      setSlots([]);
      setError('');
      setLoading(true);
      fetch(`${appUrl}/storefront/availability?shop=${encodeURIComponent(shop)}&productId=${encodeURIComponent(pkg.serviceProductId)}&date=${encodeURIComponent(val)}`)
        .then(r => r.json())
        .then(d => setSlots(d.slots ?? []))
        .catch(() => setSlots([]))
        .finally(() => setLoading(false));
    };
    el.addEventListener('change', onDateChange);
    return () => el.removeEventListener('change', onDateChange);
  });

  function resetModal() {
    setStep(1); setSelDate(''); setSlots([]); setSelTime('');
    setBooking(false); setError('');
  }

  async function confirmBooking() {
    setBooking(true); setError('');
    try {
      const r = await fetch(`${appUrl}/customer-api/packages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop, customerId: customer.numericId,
          packageId: pkg.id, date: selDate, time: selTime,
          customerName: customer.name, customerEmail: customer.email,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? 'Erro ao criar marcação');
      setStep(3);
      onBooked?.();
    } catch (e) {
      setError(e.message ?? 'Erro ao criar marcação');
    }
    setBooking(false);
  }

  const availableSlots = slots.filter(s => s.available);
  const canNext = selDate && selTime;

  return (
    <s-modal id={modalId} heading="Marcar consulta" size="base">

      {/* ── Step 1: Pick date + time ── */}
      {step === 1 && (
        <s-stack direction="block" gap="base">
          <s-text>{pkg.serviceTitle} · {pkg.creditsRemaining} crédito{pkg.creditsRemaining !== 1 ? 's' : ''} restante{pkg.creditsRemaining !== 1 ? 's' : ''}</s-text>

          <s-stack direction="block" gap="small-200">
            <s-text type="strong">Escolhe um dia</s-text>
            <s-date-picker
              ref={dateRef}
              type="single"
              allow={allowRange}
            />
          </s-stack>

          {selDate && (
            <s-stack direction="block" gap="small-200">
              <s-text type="strong">Horários para {formatDate(selDate)}</s-text>
              {loadingSlots && <s-spinner accessibilityLabel="A carregar horários..." />}
              {!loadingSlots && slots.length > 0 && availableSlots.length === 0 && (
                <s-banner tone="warning">Sem horários disponíveis para este dia. Escolhe outro dia.</s-banner>
              )}
              {!loadingSlots && availableSlots.length > 0 && (
                <s-select
                  name="time"
                  label="Horário"
                  value={selTime}
                  onChange={(e) => setSelTime(e.target.value)}
                >
                  <option value="">-- Escolhe um horário --</option>
                  {availableSlots.map(slot => (
                    <option key={slot.time} value={slot.time}>{slot.time}</option>
                  ))}
                </s-select>
              )}
            </s-stack>
          )}

          {error && <s-banner tone="critical">{error}</s-banner>}
        </s-stack>
      )}

      {/* ── Step 2: Confirm ── */}
      {step === 2 && (
        <s-stack direction="block" gap="base">
          <s-stack direction="block" gap="small-100">
            <s-stack direction="inline" gap="base">
              <s-text type="strong">Serviço:</s-text>
              <s-text>{pkg.serviceTitle}</s-text>
            </s-stack>
            <s-stack direction="inline" gap="base">
              <s-text type="strong">Data:</s-text>
              <s-text>{formatDate(selDate)}</s-text>
            </s-stack>
            <s-stack direction="inline" gap="base">
              <s-text type="strong">Hora:</s-text>
              <s-text>{selTime}</s-text>
            </s-stack>
            <s-stack direction="inline" gap="base">
              <s-text type="strong">Custo:</s-text>
              <s-text>1 crédito de pacote (sem custo adicional)</s-text>
            </s-stack>
          </s-stack>
          {error && <s-banner tone="critical">{error}</s-banner>}
        </s-stack>
      )}

      {/* ── Step 3: Success ── */}
      {step === 3 && (
        <s-stack direction="block" gap="base">
          <s-banner tone="success">Marcação confirmada! A tua consulta foi marcada para {formatDate(selDate)} às {selTime}.</s-banner>
        </s-stack>
      )}

      {/* ── Footer actions ── */}
      {step === 1 && (
        <>
          <s-button slot="secondary-actions" command="--hide" commandFor={modalId}>Cancelar</s-button>
          <s-button
            slot="primary-action"
            variant="primary"
            disabled={!canNext || undefined}
            onClick={() => { setError(''); setStep(2); }}
          >Confirmar →</s-button>
        </>
      )}
      {step === 2 && (
        <>
          <s-button slot="secondary-actions" onClick={() => { setStep(1); setError(''); }}>← Voltar</s-button>
          <s-button
            slot="primary-action"
            variant="primary"
            disabled={booking || undefined}
            onClick={confirmBooking}
          >{booking ? 'A marcar...' : '✓ Confirmar marcação'}</s-button>
        </>
      )}
      {step === 3 && (
        <>
          <s-button slot="secondary-actions" onClick={resetModal} commandFor={modalId} command="--hide">Fechar</s-button>
        </>
      )}
    </s-modal>
  );
}

// ── Package Card ──────────────────────────────────────────────────────────────
function PackageCard({ pkg, shop, customer, appUrl, onBooked }) {
  const [expanded, setExpanded] = useState(false);
  const modalId = `book-${pkg.id}`;

  const pct = pkg.creditsTotal > 0 ? Math.round((pkg.creditsUsed / pkg.creditsTotal) * 100) : 0;
  const statusLabel = pkg.status === 'active' ? 'Activo' : pkg.status === 'exhausted' ? 'Esgotado' : 'Cancelado';
  const statusTone  = pkg.status === 'active' ? 'success' : pkg.status === 'exhausted' ? 'critical' : 'neutral';

  return (
    <s-section>
      <s-stack direction="block" gap="base">
        {/* Header */}
        <s-stack direction="inline" justifyContent="space-between" alignItems="center">
          <s-heading level={3}>{pkg.serviceTitle}</s-heading>
          <s-badge tone={statusTone}>{statusLabel}</s-badge>
        </s-stack>

        {/* Credits */}
        <s-text>{pkg.creditsUsed} de {pkg.creditsTotal} consultas usadas · {pkg.creditsRemaining} restante{pkg.creditsRemaining !== 1 ? 's' : ''}</s-text>
        <s-progress value={pct} />

        {/* Meta */}
        <s-text>Comprado em {formatDate(pkg.createdAt)} · {pkg.orderName}</s-text>

        {/* Actions */}
        <s-stack direction="inline" gap="small-200">
          {pkg.status === 'active' && pkg.creditsRemaining > 0 && (
            <s-button variant="primary" commandFor={modalId} command="--show">+ Marcar consulta</s-button>
          )}
          {pkg.bookings?.length > 0 && (
            <s-button variant="secondary" onClick={() => setExpanded(e => !e)}>
              {expanded ? '▲' : '▼'} {pkg.bookings.length} marcaç{pkg.bookings.length !== 1 ? 'ões' : 'ão'}
            </s-button>
          )}
        </s-stack>

        {/* Bookings list */}
        {expanded && pkg.bookings?.length > 0 && (
          <s-stack direction="block" gap="small-200">
            <s-divider />
            {pkg.bookings.map(b => {
              const isPast = b.date < new Date().toISOString().slice(0, 10);
              const bStatusLabel = b.status === 'confirmed' ? 'Confirmada' : b.status === 'cancelled' ? 'Cancelada' : 'Pendente';
              const bStatusTone  = b.status === 'confirmed' ? 'success' : b.status === 'cancelled' ? 'critical' : 'warning';
              return (
                <s-stack key={b.id} direction="inline" justifyContent="space-between" alignItems="center">
                  <s-stack direction="block" gap="none">
                    <s-text type="strong">{formatDate(b.date)} às {b.time}</s-text>
                    <s-text>{b.productTitle}</s-text>
                  </s-stack>
                  <s-badge tone={bStatusTone}>{bStatusLabel}</s-badge>
                </s-stack>
              );
            })}
          </s-stack>
        )}
      </s-stack>

      <BookingModal pkg={pkg} shop={shop} customer={customer} appUrl={appUrl} onBooked={onBooked} />
    </s-section>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
function PackagesPage() {
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [packages, setPackages] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [shop, setShop]         = useState('');
  const appUrl = getAppUrl();

  const fetchPackages = useCallback(async (shopDomain, numericId) => {
    const r = await fetch(`${appUrl}/customer-api/packages?shop=${encodeURIComponent(shopDomain)}&customerId=${encodeURIComponent(numericId)}`);
    const d = await r.json();
    setPackages(d.packages ?? []);
  }, [appUrl]);

  useEffect(() => {
    async function init() {
      try {
        const shopifyGlobal = globalThis.shopify;

        // Shop domain from session token JWT (dest claim)
        const token   = await shopifyGlobal.sessionToken.get();
        const payload = JSON.parse(atob(token.split('.')[1]));
        const shopDomain = String(payload.dest ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '');
        if (!shopDomain) throw new Error('Não foi possível determinar a loja.');
        setShop(shopDomain);

        // Customer id from Customer Account GraphQL API (auto-authenticated)
        // Only request `id` — name/email require protected data scopes we don't need
        // (backend already stores name/email from the order webhook)
        const r = await fetch(CA_GRAPHQL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: '{ customer { id } }' }),
        });
        const data = await r.json();
        const c = data?.data?.customer;
        if (!c?.id) throw new Error('Não foi possível identificar o cliente. Certifica-te que estás autenticado.');

        const numericId = c.id.split('/').pop();
        const cust = {
          numericId,
          name:  '',
          email: '',
        };
        setCustomer(cust);

        await fetchPackages(shopDomain, numericId);
      } catch (e) {
        setError(e?.message ?? 'Erro ao carregar pacotes');
      }
      setLoading(false);
    }
    init();
  }, []);

  function handleBooked() {
    if (customer && shop) fetchPackages(shop, customer.numericId).catch(() => {});
  }

  return (
    <s-page>
      <s-stack direction="block" gap="large">
        <s-stack direction="block" gap="small-200">
          <s-heading level={1}>Os Meus Pacotes</s-heading>
          <s-text>Consulta os teus pacotes de marcações e agenda novas consultas.</s-text>
        </s-stack>

        {loading && (
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-spinner accessibilityLabel="A carregar pacotes..." />
            <s-text>A carregar...</s-text>
          </s-stack>
        )}

        {!loading && error && (
          <s-banner tone="critical">{error}</s-banner>
        )}

        {!loading && !error && packages !== null && packages.length === 0 && (
          <s-banner tone="info">Quando comprares um pacote de consultas ele aparecerá aqui.</s-banner>
        )}

        {!loading && !error && packages?.map(pkg => (
          <PackageCard
            key={pkg.id}
            pkg={pkg}
            shop={shop}
            customer={customer}
            appUrl={appUrl}
            onBooked={handleBooked}
          />
        ))}
      </s-stack>
    </s-page>
  );
}

export default () => {
  render(<PackagesPage />, document.body);
};
