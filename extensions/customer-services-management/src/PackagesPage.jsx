import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';

// ── Config ───────────────────────────────────────────────────────────────────
// The app URL is injected via the extension settings in shopify.extension.toml
// We fall back to reading it from shopify.extension settings at runtime.
const PRODUCTION_APP_URL = 'https://services-booking-kappa.vercel.app';

function getAppUrl() {
  return (shopify.extension?.settings?.app_url || PRODUCTION_APP_URL).replace(/\/$/, '');
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const PT_MONTHS = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const PT_DAYS = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.getDate()} ${PT_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDateTime(dateStr, timeStr) {
  return `${formatDate(dateStr)} às ${timeStr}`;
}

// ── Calendar Modal ────────────────────────────────────────────────────────────
function CalendarModal({ pkg, shop, customerId, customerName, customerEmail, appUrl, onClose, onBooked }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth());
  const [selDate, setSelDate] = useState(null);
  const [slots, setSlots] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selTime, setSelTime] = useState('');
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState(1); // 1=pick, 2=confirm

  const today = new Date(); today.setHours(0,0,0,0);
  const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

  function pad(n) { return String(n).padStart(2,'0'); }
  function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }

  function buildGrid() {
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const days = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < offset; i++) cells.push(null);
    for (let d = 1; d <= days; d++) cells.push(new Date(year, month, d));
    return cells;
  }

  function prevMonth() { if (month === 0) { setYear(y => y-1); setMonth(11); } else setMonth(m => m-1); }
  function nextMonth() { if (month === 11) { setYear(y => y+1); setMonth(0); } else setMonth(m => m+1); }

  async function pickDate(d) {
    setSelDate(d); setSelTime(''); setSlots([]); setError('');
    setLoadingSlots(true);
    try {
      const r = await fetch(`${appUrl}/storefront/availability?shop=${encodeURIComponent(shop)}&productId=${encodeURIComponent(pkg.serviceProductId)}&date=${encodeURIComponent(dateStr(d))}`);
      const data = await r.json();
      setSlots(data.slots ?? []);
    } catch { setSlots([]); }
    setLoadingSlots(false);
  }

  async function confirmBooking() {
    setBooking(true); setError('');
    try {
      const r = await fetch(`${appUrl}/customer-api/packages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shop, customerId, packageId: pkg.id,
          date: dateStr(selDate), time: selTime,
          customerName, customerEmail,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? 'Erro ao criar marcação');
      onBooked();
    } catch (e) {
      setError(e.message);
    }
    setBooking(false);
  }

  const cells = buildGrid();
  const isPrevDisabled = year === today.getFullYear() && month === today.getMonth();

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:9999, display:'flex', alignItems:'center', justifyContent:'center', padding:'16px', boxSizing:'border-box' }}>
      <div style={{ background:'#fff', borderRadius:'16px', width:'min(780px,100%)', maxHeight:'90vh', overflow:'hidden', display:'flex', flexDirection:'column', boxShadow:'0 24px 80px rgba(0,0,0,0.25)', fontFamily:'-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif' }}>
        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'20px 24px', borderBottom:'1px solid #f0f0f0' }}>
          <div>
            <div style={{ fontSize:'17px', fontWeight:700, color:'#111' }}>Marcar consulta</div>
            <div style={{ fontSize:'13px', color:'#888', marginTop:'2px' }}>{pkg.serviceTitle} · {pkg.creditsRemaining} crédito{pkg.creditsRemaining !== 1 ? 's' : ''} restante{pkg.creditsRemaining !== 1 ? 's' : ''}</div>
          </div>
          <button onClick={onClose} style={{ background:'#f4f4f5', border:'none', borderRadius:'50%', width:'32px', height:'32px', cursor:'pointer', fontSize:'16px', display:'flex', alignItems:'center', justifyContent:'center', color:'#555' }}>✕</button>
        </div>

        {step === 1 && (
          <div style={{ display:'flex', flex:1, overflow:'hidden', minHeight:0 }}>
            {/* Calendar panel */}
            <div style={{ width:'280px', flexShrink:0, background:'#1a1f2e', color:'#fff', padding:'24px 20px', display:'flex', flexDirection:'column', gap:'16px' }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <button onClick={prevMonth} disabled={isPrevDisabled} style={{ background:'rgba(255,255,255,0.1)', border:'none', borderRadius:'8px', width:'32px', height:'32px', color:'#fff', cursor:'pointer', fontSize:'18px', opacity: isPrevDisabled ? 0.3 : 1 }}>‹</button>
                <span style={{ fontWeight:700, fontSize:'14px' }}>{MONTHS[month]} <span style={{ color:'#7c8db5', fontWeight:400 }}>{year}</span></span>
                <button onClick={nextMonth} style={{ background:'rgba(255,255,255,0.1)', border:'none', borderRadius:'8px', width:'32px', height:'32px', color:'#fff', cursor:'pointer', fontSize:'18px' }}>›</button>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:'3px' }}>
                {['2ª','3ª','4ª','5ª','6ª','SÁ','DO'].map(d => (
                  <div key={d} style={{ textAlign:'center', fontSize:'10px', fontWeight:700, color:'#7c8db5', padding:'4px 0 8px', textTransform:'uppercase' }}>{d}</div>
                ))}
                {cells.map((d, i) => {
                  if (!d) return <div key={i} />;
                  const isToday = d.getTime() === today.getTime();
                  const isSel = selDate && d.getTime() === selDate.getTime();
                  const isPast = d < today;
                  return (
                    <button key={i} disabled={isPast} onClick={() => pickDate(d)}
                      style={{ aspectRatio:'1', border:'none', borderRadius:'50%', fontSize:'13px', cursor: isPast ? 'default' : 'pointer', background: isSel ? '#fff' : 'transparent', color: isPast ? '#3d4560' : isSel ? '#1a1f2e' : '#fff', fontWeight: isSel ? 700 : 400, position:'relative' }}>
                      {d.getDate()}
                      {isToday && !isSel && <span style={{ position:'absolute', bottom:'2px', left:'50%', transform:'translateX(-50%)', width:'4px', height:'4px', borderRadius:'50%', background:'#6c8ef0' }} />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Slots panel */}
            <div style={{ flex:1, padding:'20px', overflowY:'auto', display:'flex', flexDirection:'column' }}>
              <div style={{ fontWeight:700, fontSize:'15px', color:'#111', marginBottom:'4px' }}>Horário disponível</div>
              <div style={{ fontSize:'12px', color:'#999', marginBottom:'16px' }}>🌍 Europe/Lisbon</div>

              {!selDate && (
                <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', color:'#ccc', fontSize:'13px', textAlign:'center', gap:'10px' }}>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
                  Seleciona um dia no calendário
                </div>
              )}

              {selDate && loadingSlots && (
                <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', color:'#888', fontSize:'13px' }}>A carregar horários...</div>
              )}

              {selDate && !loadingSlots && slots.length === 0 && (
                <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', color:'#999', fontSize:'13px' }}>😔 Sem horários disponíveis para este dia.</div>
              )}

              {selDate && !loadingSlots && slots.length > 0 && (
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'8px' }}>
                  {slots.map(slot => (
                    <button key={slot.time} disabled={!slot.available} onClick={() => setSelTime(slot.time)}
                      style={{ padding:'10px 6px', border: selTime === slot.time ? '2px solid #111' : '1.5px solid #ececec', borderRadius:'8px', background: selTime === slot.time ? '#111' : '#fff', color: !slot.available ? '#ccc' : selTime === slot.time ? '#fff' : '#111', cursor: slot.available ? 'pointer' : 'default', fontSize:'13px', fontWeight:600, display:'flex', flexDirection:'column', alignItems:'center', gap:'3px' }}>
                      {slot.time}
                      <span style={{ fontSize:'10px', fontWeight:500, color: !slot.available ? '#ddd' : selTime === slot.time ? 'rgba(255,255,255,0.7)' : '#888' }}>{slot.available ? 'Disponível' : 'Esgotado'}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ padding:'24px 28px', display:'flex', flexDirection:'column', gap:'16px', overflowY:'auto' }}>
            <div style={{ background:'#f8f8f8', borderRadius:'12px', padding:'20px', display:'flex', flexDirection:'column', gap:'14px' }}>
              {[
                { icon:'🏥', label:'Serviço', val: pkg.serviceTitle },
                { icon:'📅', label:'Data', val: formatDate(dateStr(selDate)) },
                { icon:'🕐', label:'Hora', val: selTime },
                { icon:'🎟', label:'Pacote', val: `${pkg.creditsRemaining} crédito${pkg.creditsRemaining !== 1 ? 's' : ''} restante${pkg.creditsRemaining !== 1 ? 's' : ''} (sem custo adicional)` },
              ].map(row => (
                <div key={row.label} style={{ display:'flex', alignItems:'flex-start', gap:'14px' }}>
                  <div style={{ width:'38px', height:'38px', borderRadius:'9px', background:'#fff', border:'1px solid #eee', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'18px', flexShrink:0 }}>{row.icon}</div>
                  <div>
                    <div style={{ fontSize:'11px', fontWeight:700, color:'#aaa', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:'3px' }}>{row.label}</div>
                    <div style={{ fontSize:'15px', fontWeight:600, color:'#111' }}>{row.val}</div>
                  </div>
                </div>
              ))}
            </div>
            {error && (
              <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:'8px', padding:'12px 14px', fontSize:'13px', color:'#b91c1c' }}>❌ {error}</div>
            )}
          </div>
        )}

        {/* Footer */}
        <div style={{ padding:'16px 24px', borderTop:'1px solid #f0f0f0', display:'flex', justifyContent:'space-between', alignItems:'center', gap:'12px', flexShrink:0 }}>
          {step === 1 ? (
            <>
              <div style={{ fontSize:'13px', color:'#888' }}>
                {selDate && selTime ? `${formatDate(dateStr(selDate))} às ${selTime}` : selDate ? 'Escolhe um horário' : 'Escolhe um dia'}
              </div>
              <button disabled={!selDate || !selTime} onClick={() => setStep(2)}
                style={{ padding:'12px 28px', background: (!selDate || !selTime) ? '#c4cdd5' : '#111', color:'#fff', border:'none', borderRadius:'10px', fontSize:'15px', fontWeight:700, cursor: (!selDate || !selTime) ? 'default' : 'pointer' }}>
                Confirmar →
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setStep(1)} style={{ padding:'12px 20px', background:'none', border:'1.5px solid #ddd', borderRadius:'10px', fontSize:'14px', fontWeight:600, cursor:'pointer', color:'#555' }}>← Voltar</button>
              <button disabled={booking} onClick={confirmBooking}
                style={{ padding:'12px 28px', background: booking ? '#c4cdd5' : '#008060', color:'#fff', border:'none', borderRadius:'10px', fontSize:'15px', fontWeight:700, cursor: booking ? 'default' : 'pointer' }}>
                {booking ? 'A marcar...' : '✓ Confirmar marcação'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Package Card ──────────────────────────────────────────────────────────────
function PackageCard({ pkg, shop, customerId, customerName, customerEmail, appUrl, onRefresh }) {
  const [showModal, setShowModal] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const pct = Math.round((pkg.creditsUsed / pkg.creditsTotal) * 100);
  const remaining = pkg.creditsRemaining;
  const statusColor = pkg.status === 'active' ? '#008060' : pkg.status === 'exhausted' ? '#d82c0d' : '#6d7175';
  const statusLabel = pkg.status === 'active' ? 'Activo' : pkg.status === 'exhausted' ? 'Esgotado' : 'Cancelado';

  function handleBooked() {
    setShowModal(false);
    onRefresh();
  }

  return (
    <>
      <div style={{ background:'#fff', border:'1px solid #e1e3e5', borderRadius:'12px', overflow:'hidden', marginBottom:'12px', fontFamily:'-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif' }}>
        {/* Top accent */}
        <div style={{ height:'4px', background: pkg.status === 'active' ? '#008060' : '#c4cdd5' }} />
        <div style={{ padding:'20px' }}>
          <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:'16px' }}>
            <div>
              <div style={{ fontWeight:700, fontSize:'16px', color:'#1a1a1a' }}>{pkg.serviceTitle}</div>
              <div style={{ fontSize:'12px', color:'#6d7175', marginTop:'3px' }}>Comprado em {formatDate(pkg.createdAt)} · {pkg.orderName}</div>
            </div>
            <span style={{ padding:'4px 10px', borderRadius:'20px', fontSize:'11px', fontWeight:700, background: pkg.status === 'active' ? '#e3f1ec' : '#f1f2f3', color: statusColor, border:`1px solid ${pkg.status === 'active' ? '#b7dfce' : '#e1e3e5'}`, whiteSpace:'nowrap', flexShrink:0, marginLeft:'12px' }}>
              {statusLabel}
            </span>
          </div>

          {/* Progress */}
          <div style={{ marginBottom:'16px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'8px' }}>
              <span style={{ fontSize:'13px', color:'#6d7175' }}>{pkg.creditsUsed} de {pkg.creditsTotal} consultas usadas</span>
              <span style={{ fontSize:'13px', fontWeight:700, color: remaining > 0 ? '#008060' : '#6d7175' }}>{remaining} restante{remaining !== 1 ? 's' : ''}</span>
            </div>
            <div style={{ height:'8px', background:'#f1f2f3', borderRadius:'20px', overflow:'hidden' }}>
              <div style={{ height:'100%', width:`${pct}%`, background: remaining > 0 ? '#008060' : '#c4cdd5', borderRadius:'20px', transition:'width .3s' }} />
            </div>
            {/* Credit dots */}
            <div style={{ display:'flex', gap:'6px', marginTop:'10px', flexWrap:'wrap' }}>
              {Array.from({ length: pkg.creditsTotal }).map((_, i) => (
                <div key={i} style={{ width:'28px', height:'28px', borderRadius:'50%', background: i < pkg.creditsUsed ? '#c4cdd5' : '#008060', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'12px', color:'#fff', fontWeight:700 }}>
                  {i < pkg.creditsUsed ? '✓' : i + 1}
                </div>
              ))}
            </div>
          </div>

          {/* Actions */}
          <div style={{ display:'flex', gap:'8px', alignItems:'center' }}>
            {pkg.status === 'active' && remaining > 0 && (
              <button onClick={() => setShowModal(true)}
                style={{ padding:'10px 20px', background:'#008060', color:'#fff', border:'none', borderRadius:'8px', fontSize:'14px', fontWeight:700, cursor:'pointer' }}>
                + Marcar consulta
              </button>
            )}
            {pkg.bookings.length > 0 && (
              <button onClick={() => setExpanded(e => !e)}
                style={{ padding:'10px 16px', background:'none', border:'1.5px solid #e1e3e5', borderRadius:'8px', fontSize:'13px', fontWeight:600, cursor:'pointer', color:'#3d4045' }}>
                {expanded ? '▲' : '▼'} {pkg.bookings.length} marcação{pkg.bookings.length !== 1 ? 'ões' : ''}
              </button>
            )}
          </div>

          {/* Bookings list */}
          {expanded && pkg.bookings.length > 0 && (
            <div style={{ marginTop:'14px', borderTop:'1px solid #f1f2f3', paddingTop:'14px', display:'flex', flexDirection:'column', gap:'8px' }}>
              {pkg.bookings.map(b => {
                const isPast = b.date < new Date().toISOString().slice(0,10);
                return (
                  <div key={b.id} style={{ display:'flex', alignItems:'center', gap:'12px', padding:'10px 12px', background:'#f9fafb', borderRadius:'8px' }}>
                    <div style={{ width:'36px', height:'36px', borderRadius:'50%', background: isPast ? '#f1f2f3' : '#e3f1ec', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'16px', flexShrink:0 }}>
                      {isPast ? '✓' : '📅'}
                    </div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:600, fontSize:'14px', color:'#1a1a1a' }}>{formatDateTime(b.date, b.time)}</div>
                      <div style={{ fontSize:'12px', color:'#6d7175' }}>{b.productTitle}</div>
                    </div>
                    <span style={{ fontSize:'11px', fontWeight:600, padding:'3px 8px', borderRadius:'20px', background: b.status === 'confirmed' ? '#e3f1ec' : b.status === 'cancelled' ? '#fce8e6' : '#fff8e6', color: b.status === 'confirmed' ? '#008060' : b.status === 'cancelled' ? '#d82c0d' : '#b98900' }}>
                      {b.status === 'confirmed' ? 'Confirmada' : b.status === 'cancelled' ? 'Cancelada' : 'Pendente'}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {showModal && (
        <CalendarModal
          pkg={pkg} shop={shop} customerId={customerId}
          customerName={customerName} customerEmail={customerEmail}
          appUrl={appUrl}
          onClose={() => setShowModal(false)}
          onBooked={handleBooked}
        />
      )}
    </>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
function PackagesPage() {
  const [packages, setPackages] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const appUrl = getAppUrl();

  // Get customer info from Shopify Customer Account API
  const [customer, setCustomer] = useState(null);

  useEffect(() => {
    async function init() {
      try {
        // Query Customer Account API for current customer
        const result = await shopify.customerAccount.query(`
          query {
            customer {
              id
              emailAddress { emailAddress }
              firstName
              lastName
            }
          }
        `);
        const c = result?.data?.customer;
        if (!c) { setError('Não foi possível identificar o cliente.'); setLoading(false); return; }
        // Extract numeric ID from GID
        const numericId = c.id.split('/').pop();
        const shop = shopify.shop ?? '';
        setCustomer({ id: numericId, email: c.emailAddress?.emailAddress ?? '', name: `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() });

        // Fetch packages
        const r = await fetch(`${appUrl}/customer-api/packages?shop=${encodeURIComponent(shop)}&customerId=${encodeURIComponent(numericId)}`);
        const data = await r.json();
        setPackages(data.packages ?? []);
      } catch (e) {
        setError('Erro ao carregar pacotes: ' + e.message);
      }
      setLoading(false);
    }
    init();
  }, []);

  async function refresh() {
    if (!customer) return;
    setLoading(true);
    try {
      const shop = shopify.shop ?? '';
      const r = await fetch(`${appUrl}/customer-api/packages?shop=${encodeURIComponent(shop)}&customerId=${encodeURIComponent(customer.id)}`);
      const data = await r.json();
      setPackages(data.packages ?? []);
    } catch {}
    setLoading(false);
  }

  const shop = shopify.shop ?? '';

  return (
    <div style={{ fontFamily:'-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif', maxWidth:'680px', margin:'0 auto', padding:'24px 16px' }}>
      <div style={{ marginBottom:'24px' }}>
        <h1 style={{ fontSize:'22px', fontWeight:800, color:'#1a1a1a', margin:0 }}>🎟 Os Meus Pacotes</h1>
        <p style={{ fontSize:'14px', color:'#6d7175', marginTop:'6px', marginBottom:0 }}>Consulta os teus pacotes de marcações e agenda novas consultas.</p>
      </div>

      {loading && (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', padding:'60px 0', color:'#6d7175', gap:'12px' }}>
          <div style={{ width:'40px', height:'40px', border:'3px solid #e1e3e5', borderTopColor:'#008060', borderRadius:'50%', animation:'spin 0.7s linear infinite' }} />
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          A carregar...
        </div>
      )}

      {error && (
        <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:'10px', padding:'16px', fontSize:'14px', color:'#b91c1c' }}>
          ❌ {error}
        </div>
      )}

      {!loading && !error && packages !== null && packages.length === 0 && (
        <div style={{ textAlign:'center', padding:'60px 24px', background:'#f9fafb', borderRadius:'12px', border:'1px dashed #e1e3e5' }}>
          <div style={{ fontSize:'40px', marginBottom:'12px' }}>🎟</div>
          <div style={{ fontWeight:600, fontSize:'16px', color:'#3d4045', marginBottom:'6px' }}>Sem pacotes activos</div>
          <div style={{ fontSize:'13px', color:'#9ca3af' }}>Quando comprares um pacote de consultas ele aparecerá aqui.</div>
        </div>
      )}

      {!loading && !error && packages && packages.map(pkg => (
        <PackageCard
          key={pkg.id}
          pkg={pkg}
          shop={shop}
          customerId={customer?.id ?? ''}
          customerName={customer?.name ?? ''}
          customerEmail={customer?.email ?? ''}
          appUrl={appUrl}
          onRefresh={refresh}
        />
      ))}
    </div>
  );
}

export default async () => {
  render(<PackagesPage />, document.body);
};
