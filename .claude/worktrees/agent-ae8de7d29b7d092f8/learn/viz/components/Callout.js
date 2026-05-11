// Callout: styled box with variant icon + colour. Children render below the title.
// Variants: info (accent/blue), warning (yellow), insight (purple-ish accent), takeaway (green).
(function(){
  const { h } = window;

  const VARIANTS = {
    info:     { color: 'var(--accent)', bg: 'rgba(99,102,241,0.08)', border: 'rgba(99,102,241,0.4)', icon: 'i', label: 'Info' },
    warning:  { color: 'var(--yellow)', bg: 'rgba(234,179,8,0.08)',  border: 'rgba(234,179,8,0.4)',  icon: '!', label: 'Warning' },
    insight:  { color: 'var(--accent)', bg: 'rgba(99,102,241,0.12)', border: 'rgba(99,102,241,0.5)', icon: '*', label: 'Insight' },
    takeaway: { color: 'var(--green)',  bg: 'rgba(34,197,94,0.08)',  border: 'rgba(34,197,94,0.4)',  icon: 'OK', label: 'Takeaway' },
  };

  function Callout(props) {
    const variant = props && props.variant ? props.variant : 'info';
    const v = VARIANTS[variant] || VARIANTS.info;
    const title = props && props.title ? props.title : null;
    const children = props && props.children;

    const wrapStyle = {
      background: v.bg,
      border: '1px solid ' + v.border,
      borderRadius: 'var(--radius)',
      padding: '14px 18px',
      margin: '12px 0',
      lineHeight: '1.55',
    };
    const headStyle = {
      display: 'flex', alignItems: 'center', gap: '8px',
      color: v.color, fontWeight: '600', marginBottom: title ? '8px' : '0',
      fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.5px',
    };
    const iconStyle = {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: '20px', height: '20px', borderRadius: '50%',
      background: v.color, color: '#0f1117', fontSize: '11px', fontWeight: '700',
    };
    const bodyStyle = { color: 'var(--text)' };

    return h`
      <div class="callout callout-${variant}" style=${wrapStyle}>
        <div style=${headStyle}>
          <span style=${iconStyle}>${v.icon}</span>
          <span>${title || v.label}</span>
        </div>
        <div class="callout-body" style=${bodyStyle}>${children}</div>
      </div>
    `;
  }

  window.LearnComponents = window.LearnComponents || {};
  window.LearnComponents.Callout = Callout;
})();
