'use strict';

const $ = selector => document.querySelector(selector);
const STORAGE = { reservations: 'pratosalvo.reservations', manageKeys: 'pratosalvo.manageKeys', customer: 'pratosalvo.customer' };
const CATEGORY_EMOJI = { Padaria: '🥖', Refeição: '🥗', Doces: '🧁', Outros: '🥡' };
const STATUS_LABEL = { active: 'Ativa', redeemed: 'Retirada', cancelled: 'Cancelada', expired: 'Expirada' };
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
const REFRESH_MS = 60_000;

const state = {
  offers: [],
  category: 'Tudo',
  rules: { maxUnitsPerCustomer: 5, holdMinutes: 90 },
  reservations: [],
  loading: false,
  offerError: null,
};
let toastTimer;

// ---------- utilitários ----------

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  } catch {
    // fetch só rejeita em falha de rede.
    throw new Error(navigator.onLine ? 'Não foi possível falar com o servidor. Tente de novo.' : 'Você está offline.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Não foi possível concluir a ação.'), { status: response.status, data });
  return data;
}

const post = (url, body) => api(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const money = cents => currency.format(cents / 100);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const options = max => Array.from({ length: max }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');

// localStorage pode lançar (modo privado, cota); falha vira valor padrão.
function readStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* sem persistência: segue funcionando nesta sessão */
  }
}
const storedList = key => readStorage(key, []).filter(v => typeof v === 'string');
const remember = (key, value) => writeStorage(key, [value, ...storedList(key).filter(v => v !== value)].slice(0, 50));

const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "hoje 18:30", "amanhã 09:00" ou "sex., 31/10 18:30". */
function when(iso) {
  const date = new Date(iso);
  const days = Math.round((startOfDay(date) - startOfDay(new Date())) / 86_400_000);
  const time = timeFmt.format(date);
  if (days === 0) return `hoje ${time}`;
  if (days === 1) return `amanhã ${time}`;
  return `${dayFmt.format(date)} ${time}`;
}

function remaining(iso) {
  const minutes = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

// <input type="datetime-local"> trabalha com hora local sem fuso.
const toLocalInput = date => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

// Só pré-visualização; o servidor faz a conversão autoritativa.
function previewCents(value) {
  const text = String(value)
    .trim()
    .replace(/^R\$\s*/i, '');
  const normalized = /,\d{1,2}$/.test(text) ? text.replace(/\./g, '').replace(',', '.') : text;
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) : null;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
}

/** Desabilita o botão durante o envio (evita envio duplo) e restaura o texto depois. */
async function withBusy(button, busyText, task) {
  if (button.disabled) return;
  const label = button.innerHTML;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = busyText;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.innerHTML = label;
  }
}

function openDialog(dialog) {
  dialog.querySelector('.form-error')?.replaceChildren();
  if (!dialog.open) dialog.showModal();
}

// ---------- vitrine ----------

async function loadOffers() {
  try {
    state.offers = await api('/api/offers?include=sold_out');
    state.offerError = null;
  } catch (error) {
    state.offerError = error.message;
  }
  $('#offer-grid').setAttribute('aria-busy', 'false');
  renderFilters();
  renderOffers();
}

function renderFilters() {
  const categories = ['Tudo', ...new Set(state.offers.map(o => o.category))];
  if (!categories.includes(state.category)) state.category = 'Tudo';
  $('#filters').innerHTML = categories
    .map(
      c =>
        `<button type="button" class="filter" data-filter="${escapeHtml(c)}" aria-pressed="${c === state.category}">${escapeHtml(c)}</button>`,
    )
    .join('');
}

function stockLabel(offer) {
  if (offer.soldOut) return 'Esgotado';
  if (offer.quantity === 1) return 'Última unidade';
  if (offer.quantity === 2) return 'Últimas 2 unidades';
  return plural(offer.quantity, 'disponível', 'disponíveis');
}

function windowLabel(offer) {
  return new Date(offer.pickupFrom) > new Date()
    ? `Retirada de ${when(offer.pickupFrom)} a ${timeFmt.format(new Date(offer.expiresAt))}`
    : `Retire até ${when(offer.expiresAt)} · faltam ${remaining(offer.expiresAt)}`;
}

function offerCard(offer) {
  const emoji = CATEGORY_EMOJI[offer.category] || CATEGORY_EMOJI.Outros;
  return `<article class="offer-card${offer.soldOut ? ' sold-out' : ''}" aria-labelledby="offer-${offer.id}">
    <div class="offer-art" data-category="${escapeHtml(offer.category)}">
      <span class="offer-emoji" aria-hidden="true">${emoji}</span>
      <span class="discount">−${offer.discountPercent}%<span class="visually-hidden"> de desconto</span></span>
      ${offer.soldOut ? '<span class="sold-badge">Esgotado</span>' : ''}
    </div>
    <div class="offer-body">
      <span class="offer-restaurant">${escapeHtml(offer.restaurant)}</span>
      <h3 id="offer-${offer.id}">${escapeHtml(offer.title)}</h3>
      <p class="offer-description">${escapeHtml(offer.description)}</p>
      <div class="offer-bottom">
        <div class="price">
          <strong>${money(offer.priceCents)}</strong>
          <del><span class="visually-hidden">de </span>${money(offer.originalCents)}</del>
        </div>
        <span class="stock${offer.quantity <= 2 ? ' low' : ''}">${stockLabel(offer)}</span>
      </div>
      <p class="pickup-window">${escapeHtml(windowLabel(offer))}</p>
      <button type="button" class="button reserve" data-reserve="${offer.id}"${offer.soldOut ? ' disabled' : ''}>${
        offer.soldOut ? 'Esgotado por enquanto' : 'Quero reservar <span aria-hidden="true">→</span>'
      }</button>
    </div>
  </article>`;
}

function renderOffers() {
  const grid = $('#offer-grid');
  if (state.offerError && !state.offers.length) {
    grid.innerHTML = `<div class="state-box error-state" role="alert"><p>${escapeHtml(state.offerError)}</p>
      <button type="button" class="button secondary" data-retry>Tentar de novo</button></div>`;
    return;
  }
  const rows = state.category === 'Tudo' ? state.offers : state.offers.filter(o => o.category === state.category);
  grid.innerHTML = rows.length
    ? rows.map(offerCard).join('')
    : `<div class="state-box"><p>${
        state.offers.length
          ? 'Não há ofertas nesta categoria agora. Que tal conferir as outras?'
          : 'Nenhuma oferta no momento. Os restaurantes publicam excedentes ao longo do dia — volte mais tarde!'
      }</p></div>`;
}

function renderSkeleton() {
  const card =
    '<div class="offer-card skeleton" aria-hidden="true"><div class="offer-art"></div><div class="offer-body"><i></i><i></i><i></i></div></div>';
  $('#offer-grid').innerHTML = card.repeat(4);
}

// ---------- reserva ----------

let reserving = null;

function openReserve(offer) {
  reserving = offer;
  const form = $('#reserve-form');
  form.reset();
  $('#reserve-summary').innerHTML = `<strong>${escapeHtml(offer.title)}</strong>
    <span>${escapeHtml(offer.restaurant)} · ${escapeHtml(windowLabel(offer))}</span>`;
  $('#reserve-quantity').innerHTML = options(Math.min(offer.quantity, state.rules.maxUnitsPerCustomer, 10));
  $('#reserve-customer').value = readStorage(STORAGE.customer, '') || '';
  $('#reserve-rules').textContent =
    `Até ${state.rules.maxUnitsPerCustomer} unidades por pessoa. Você paga no balcão; a reserva fica guardada ` +
    `por até ${state.rules.holdMinutes} min a partir do início da retirada.`;
  form.querySelector('.submit').disabled = false;
  updateTotal();
  openDialog($('#reserve-dialog'));
  if (!$('#reserve-customer').value) $('#reserve-customer').focus();
}

function updateTotal() {
  if (!reserving) return;
  const quantity = Number($('#reserve-quantity').value) || 1;
  $('#reserve-total').innerHTML = `Total na retirada: <strong>${money(reserving.priceCents * quantity)}</strong>
    <del><span class="visually-hidden">de </span>${money(reserving.originalCents * quantity)}</del>`;
}

async function submitReserve(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = form.querySelector('.form-error');
  const customer = $('#reserve-customer').value.trim();
  errorBox.textContent = '';
  if (customer.length < 2) {
    errorBox.textContent = 'Informe seu nome (pelo menos 2 letras).';
    $('#reserve-customer').focus();
    return;
  }
  const submit = form.querySelector('.submit');
  await withBusy(submit, 'Reservando…', async () => {
    try {
      const reservation = await post(`/api/offers/${reserving.id}/reservations`, {
        customer,
        quantity: Number($('#reserve-quantity').value),
      });
      writeStorage(STORAGE.customer, customer);
      remember(STORAGE.reservations, reservation.id);
      $('#reserve-dialog').close();
      showTicket(reservation);
      loadOffers();
      loadReservations();
    } catch (error) {
      errorBox.textContent = error.message;
      if (error.data?.code === 'sold_out' || error.data?.code === 'offer_closed') await refreshReserving();
    }
  });
  if (reserving && (reserving.soldOut || reserving.closed)) submit.disabled = true;
}

// Estoque mudou enquanto o diálogo estava aberto: ajusta as opções ou mostra esgotado.
async function refreshReserving() {
  await loadOffers();
  const fresh = state.offers.find(o => o.id === reserving.id);
  const left = fresh ? fresh.quantity : 0;
  reserving = { ...reserving, quantity: left, soldOut: left === 0, closed: !fresh };
  $('#reserve-quantity').innerHTML = options(Math.min(left, state.rules.maxUnitsPerCustomer, 10));
  updateTotal();
}

const spelled = code => code.replace(/-/g, '').split('').join(' ');

function showTicket(reservation) {
  const code = $('#ticket-code');
  code.textContent = reservation.code;
  code.setAttribute('aria-label', `Código ${spelled(reservation.code)}`);
  $('#ticket-details').innerHTML = `${escapeHtml(plural(reservation.quantity, 'unidade', 'unidades'))} de
    <strong>${escapeHtml(reservation.title)}</strong> em ${escapeHtml(reservation.restaurant)}.<br />
    Pague ${money(reservation.totalCents)} no balcão. Retire até <strong>${escapeHtml(when(reservation.expiresAt))}</strong>.`;
  $('#ticket-copy').dataset.code = reservation.code;
  openDialog($('#ticket-dialog'));
}

// ---------- minhas reservas ----------

async function loadReservations() {
  const ids = storedList(STORAGE.reservations);
  if (!ids.length) {
    state.reservations = [];
    renderReservations();
    return;
  }
  try {
    state.reservations = await api(`/api/reservations?ids=${ids.map(encodeURIComponent).join(',')}`);
    renderReservations();
  } catch (error) {
    if (!state.reservations.length) {
      $('#reservation-list').innerHTML = `<div class="state-box error-state" role="alert"><p>${escapeHtml(error.message)}</p></div>`;
    }
  }
}

function reservationDeadline(r) {
  if (r.status === 'redeemed') return `Retirada ${when(r.redeemedAt)}`;
  if (r.status === 'cancelled') return 'Reserva cancelada';
  if (r.status === 'expired') return 'O prazo de retirada terminou';
  if (new Date(r.pickupFrom) > new Date()) return `Retirada de ${when(r.pickupFrom)} a ${timeFmt.format(new Date(r.expiresAt))}`;
  return `Retire até ${when(r.expiresAt)} · faltam ${remaining(r.expiresAt)}`;
}

function reservationCard(r) {
  const active = r.status === 'active';
  return `<article class="ticket-card status-${escapeHtml(r.status)}">
    <div class="ticket-main">
      <span class="status-pill">${escapeHtml(STATUS_LABEL[r.status] || r.status)}</span>
      <p class="ticket-code small" aria-label="Código ${escapeHtml(spelled(r.code))}">${escapeHtml(r.code)}</p>
      <h3>${escapeHtml(r.title)}</h3>
      <p>${escapeHtml(r.restaurant)} · ${escapeHtml(plural(r.quantity, 'unidade', 'unidades'))} · ${money(r.totalCents)}</p>
      <p class="ticket-deadline">${escapeHtml(reservationDeadline(r))}</p>
    </div>
    ${active ? `<button type="button" class="button ghost" data-cancel="${escapeHtml(r.id)}">Cancelar</button>` : ''}
  </article>`;
}

function renderReservations() {
  const rows = state.reservations;
  const active = rows.filter(r => r.status === 'active').length;
  const counter = $('#tab-count');
  counter.hidden = !active;
  counter.textContent = active ? String(active) : '';
  $('#reservation-list').innerHTML = rows.length
    ? rows.map(reservationCard).join('')
    : '<div class="state-box"><p>Você ainda não tem reservas. Escolha um achadinho acima e garanta o seu.</p></div>';
}

function confirmCancel() {
  const dialog = $('#confirm-dialog');
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true }));
}

async function cancelReservation(button) {
  if (!(await confirmCancel())) return;
  await withBusy(button, 'Cancelando…', async () => {
    try {
      await post(`/api/reservations/${encodeURIComponent(button.dataset.cancel)}/cancel`);
      toast('Reserva cancelada; as unidades voltaram para a vitrine.');
    } catch (error) {
      toast(error.message);
    }
  });
  await Promise.all([loadOffers(), loadReservations()]);
}

// ---------- área do restaurante ----------

function managedItem(o) {
  return `<div class="managed-item${o.closed ? ' closed' : ''}">
    <div><strong>${escapeHtml(o.title)}</strong><span>${escapeHtml(o.closed ? 'Encerrada' : windowLabel(o))}</span></div>
    <dl>
      <div><dt>Na vitrine</dt><dd>${o.quantity}</dd></div>
      <div><dt>A retirar</dt><dd>${o.reservedUnits}</dd></div>
      <div><dt>Retiradas</dt><dd>${o.redeemedUnits}</dd></div>
    </dl>
  </div>`;
}

async function loadManaged() {
  const keys = storedList(STORAGE.manageKeys);
  const list = $('#managed-list');
  if (!keys.length) {
    list.innerHTML = '<div class="state-box"><p>Publique uma oferta neste aparelho para acompanhar reservas e validar códigos.</p></div>';
    return;
  }
  try {
    const offers = await post('/api/offers/manage', { manageKeys: keys });
    list.innerHTML = offers.length
      ? offers.map(managedItem).join('')
      : '<div class="state-box"><p>Nenhuma oferta encontrada para este aparelho.</p></div>';
  } catch (error) {
    list.innerHTML = `<div class="state-box error-state" role="alert"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

async function submitRedeem(event) {
  event.preventDefault();
  const input = $('#redeem-code');
  const result = $('#redeem-result');
  const code = input.value.trim();
  result.className = 'redeem-result';
  result.replaceChildren();
  if (!code) {
    result.textContent = 'Digite o código que o cliente mostrar.';
    input.focus();
    return;
  }
  await withBusy(event.currentTarget.querySelector('button[type="submit"]'), 'Validando…', async () => {
    try {
      const r = await post('/api/redemptions', { code, manageKeys: storedList(STORAGE.manageKeys) });
      result.classList.add('success');
      result.innerHTML = `<strong>Retirada confirmada · ${escapeHtml(r.code)}</strong>
        <span>${escapeHtml(r.customer)} · ${escapeHtml(plural(r.quantity, 'unidade', 'unidades'))} de ${escapeHtml(r.title)}</span>
        <span>Cobrar <strong>${money(r.totalCents)}</strong></span>`;
      input.value = '';
      loadManaged();
    } catch (error) {
      result.classList.add('failure');
      const who = error.data?.reservation?.customer;
      result.innerHTML = `<strong>${escapeHtml(error.message)}</strong>${who ? `<span>Reserva de ${escapeHtml(who)}</span>` : ''}`;
      input.select();
    }
  });
}

// ---------- publicar oferta ----------

function openPublish() {
  const form = $('#publish-form');
  form.reset();
  const now = new Date();
  now.setSeconds(0, 0);
  $('#pub-from').value = toLocalInput(now);
  $('#pub-until').value = toLocalInput(new Date(now.getTime() + 3 * 3_600_000));
  $('#pub-discount').textContent = '';
  openDialog($('#publish-dialog'));
}

function updateDiscount() {
  const price = previewCents($('#pub-price').value);
  const original = previewCents($('#pub-original').value);
  const hint = $('#pub-discount');
  if (!price || !original) hint.textContent = '';
  else if (price >= original) hint.textContent = 'O preço promocional precisa ser menor que o original.';
  else hint.textContent = `Desconto para o cliente: ${Math.floor(((original - price) * 100) / original)}%`;
}

function localToIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

async function submitPublish(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const errorBox = form.querySelector('.form-error');
  errorBox.textContent = '';
  const invalid = [...form.elements].find(el => el.willValidate && !el.checkValidity());
  if (invalid) {
    const label = form.querySelector(`label[for="${invalid.id}"]`)?.textContent || invalid.name;
    errorBox.textContent = `Confira o campo “${label}”.`;
    invalid.focus();
    return;
  }
  const body = Object.fromEntries(new FormData(form));
  // Envia o instante em UTC: o servidor não precisa adivinhar o fuso do aparelho.
  body.pickupFrom = localToIso(body.pickupFrom);
  body.expiresAt = localToIso(body.expiresAt);
  await withBusy(form.querySelector('.submit'), 'Publicando…', async () => {
    try {
      const created = await post('/api/offers', body);
      remember(STORAGE.manageKeys, created.manageKey);
      $('#publish-dialog').close();
      toast('Oferta publicada! Valide os códigos na Área do restaurante.');
      await Promise.all([loadOffers(), loadManaged()]);
    } catch (error) {
      errorBox.textContent = error.message;
    }
  });
}

// ---------- eventos ----------

async function loadAll() {
  if (state.loading) return;
  state.loading = true;
  try {
    await Promise.all([loadOffers(), loadReservations(), loadManaged()]);
  } finally {
    state.loading = false;
  }
}

async function copyCode(event) {
  try {
    await navigator.clipboard.writeText(event.currentTarget.dataset.code);
    toast('Código copiado.');
  } catch {
    toast('Não foi possível copiar; anote o código.');
  }
}

function bindEvents() {
  $('#filters').addEventListener('click', event => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.category = button.dataset.filter;
    renderFilters();
    renderOffers();
  });
  $('#offer-grid').addEventListener('click', event => {
    if (event.target.closest('[data-retry]')) {
      renderSkeleton();
      loadOffers();
      return;
    }
    const button = event.target.closest('[data-reserve]');
    const offer = button && state.offers.find(o => o.id === Number(button.dataset.reserve));
    if (offer && !offer.soldOut) openReserve(offer);
  });
  $('#reservation-list').addEventListener('click', event => {
    const button = event.target.closest('[data-cancel]');
    if (button && !button.disabled) cancelReservation(button);
  });
  $('#reserve-quantity').addEventListener('change', updateTotal);
  $('#reserve-form').addEventListener('submit', submitReserve);
  $('#publish-open').addEventListener('click', openPublish);
  $('#publish-form').addEventListener('submit', submitPublish);
  $('#pub-price').addEventListener('input', updateDiscount);
  $('#pub-original').addEventListener('input', updateDiscount);
  $('#redeem-form').addEventListener('submit', submitRedeem);
  $('#ticket-copy').addEventListener('click', copyCode);

  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', event => {
      // Clique no fundo (fora do cartão) ou em [data-close] fecha.
      if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadAll();
  });
}

async function init() {
  bindEvents();
  renderSkeleton();
  try {
    state.rules = { ...state.rules, ...(await api('/api/rules')) };
  } catch {
    /* usa os padrões; o servidor valida de qualquer forma */
  }
  await loadAll();
  setInterval(() => {
    if (document.visibilityState === 'visible') loadAll();
  }, REFRESH_MS);
}

init();
