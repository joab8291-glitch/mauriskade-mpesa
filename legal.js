// Fills in the current year and, if the backend has contact details configured,
// appends them after every [data-contact] placeholder. Pages read fine without this script.
(async () => {
  'use strict';
  const year = String(new Date().getFullYear());
  document.querySelectorAll('[data-year]').forEach((n) => { n.textContent = year; });

  try {
    const r = await fetch('/api/config', { credentials: 'same-origin' });
    if (!r.ok) return;
    const c = await r.json();
    if (c.businessName) document.querySelectorAll('[data-biz]').forEach((n) => { n.textContent = c.businessName; });

    const parts = [];
    if (c.contactEmail) {
      const a = document.createElement('a');
      a.href = 'mailto:' + c.contactEmail;
      a.textContent = c.contactEmail;
      parts.push(['email ', a]);
    }
    if (c.contactPhone) {
      const a = document.createElement('a');
      a.href = 'tel:' + String(c.contactPhone).replace(/[^\d+]/g, '');
      a.textContent = c.contactPhone;
      parts.push(['phone ', a]);
    }
    if (!parts.length) return;
    document.querySelectorAll('[data-contact]').forEach((n) => {
      n.append(' (');
      parts.forEach(([label, link], i) => {
        if (i) n.append(', ');
        n.append(label, link.cloneNode(true));
      });
      n.append(')');
    });
  } catch { /* offline or no backend: the plain wording stays */ }
})();
