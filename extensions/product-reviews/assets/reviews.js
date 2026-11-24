(() => {
  const root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
  const endpoint = `${root}apps/reviews/reviews`;

  const h = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const starsEl = (value) => {
    const s = h('span', 'pr-stars');
    s.style.setProperty('--pr-fill', `${(value / 5) * 100}%`);
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', `${value} / 5`);
    return s;
  };

  function init(el) {
    if (el.dataset.prReady) return;
    el.dataset.prReady = '1';
    const productId = el.dataset.productId;
    const perPage = Number(el.dataset.perPage) || 5;
    const t = JSON.parse(el.querySelector('.pr-i18n').textContent);
    const summaryEl = el.querySelector('.pr-summary');
    const list = el.querySelector('.pr-list');
    const more = el.querySelector('.pr-more');
    let page = 0;

    function renderSummary(s) {
      summaryEl.replaceChildren();
      if (!s.count) { summaryEl.append(h('p', 'pr-muted', t.none)); return; }
      const left = h('div');
      left.append(h('div', 'pr-avg', s.average.toFixed(1)), starsEl(s.average),
        h('div', 'pr-muted', t.basedOn.replace('__COUNT__', s.count)));
      const bars = h('div', 'pr-bars');
      for (let i = 5; i >= 1; i--) {
        const n = s.distribution[i] || 0;
        const row = h('div', 'pr-bar');
        const track = h('span'); const fill = h('i');
        fill.style.width = `${(n / s.count) * 100}%`;
        track.append(fill);
        row.append(h('span', null, `${i} ★`), track, h('span', 'pr-muted', String(n)));
        bars.append(row);
      }
      summaryEl.append(left, bars);
    }

    function renderReview(r) {
      const li = h('li', 'pr-item');
      li.append(starsEl(r.rating));
      if (r.title) li.append(h('h3', null, r.title));
      const date = new Date(`${r.created_at.replace(' ', 'T')}Z`).toLocaleDateString();
      li.append(h('div', 'pr-muted', `${r.author} · ${date}`), h('p', null, r.body));
      return li;
    }

    async function loadPage() {
      page += 1;
      more.disabled = true;
      try {
        const qs = new URLSearchParams({ product_id: productId, page, per_page: perPage });
        const res = await fetch(`${endpoint}?${qs}`, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        if (page === 1) renderSummary(data.summary);
        data.reviews.forEach((r) => list.append(renderReview(r)));
        more.hidden = page * perPage >= data.total;
      } catch (e) {
        page -= 1;
        if (page === 0) summaryEl.replaceChildren(h('p', 'pr-muted', t.error));
      } finally {
        more.disabled = false;
      }
    }
    more.addEventListener('click', loadPage);

    const form = el.querySelector('.pr-form');
    const toggle = el.querySelector('.pr-toggle');
    if (form && toggle) {
      toggle.addEventListener('click', () => { form.hidden = !form.hidden; toggle.setAttribute('aria-expanded', String(!form.hidden)); });
      const msg = form.querySelector('.pr-msg');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        msg.textContent = ''; msg.classList.remove('is-error');
        if (!form.checkValidity()) { form.reportValidity(); return; }
        const btn = form.querySelector('[type=submit]');
        btn.disabled = true;
        const payload = Object.fromEntries(new FormData(form));
        payload.product_id = productId;
        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const detail = data.errors ? Object.values(data.errors).join(' ') : data.error;
            throw new Error(detail || t.error);
          }
          form.reset();
          form.hidden = true;
          if (data.status === 'approved') {
            msg.textContent = t.published;
            list.replaceChildren(); page = 0; loadPage();
          } else {
            msg.textContent = t.pending;
          }
          toggle.after(msg);
        } catch (err) {
          msg.textContent = err.message || t.error;
          msg.classList.add('is-error');
        } finally {
          btn.disabled = false;
        }
      });
    }

    loadPage();
  }

  const boot = () => document.querySelectorAll('.pr-reviews[data-product-id]').forEach(init);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  document.addEventListener('shopify:section:load', boot); // theme editor
})();
