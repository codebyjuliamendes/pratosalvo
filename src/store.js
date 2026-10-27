'use strict';

const crypto = require('node:crypto');
const { NotFoundError, ConflictError } = require('./domain/errors');
const { discountPercent, totalCents } = require('./domain/pricing');
const { isOpenForReservation, reservationDeadline, redemptionState } = require('./domain/pickup');
const { STATUS, STATUS_CONFLICT, generateCodeKey, formatCode, assertCustomerLimit } = require('./domain/reservation');

// 128 bits em base64url: inviável de adivinhar ou enumerar.
const newToken = () => crypto.randomBytes(16).toString('base64url');
// A chave de gestão é credencial: só o hash fica no banco.
const hashKey = key => crypto.createHash('sha256').update(key).digest('hex');
const iso = date => date.toISOString();
const MAX_CODE_ATTEMPTS = 5;

const OFFER_COLUMNS = `o.id, o.restaurant, o.title, o.description, o.category, o.price_cents AS priceCents,
  o.original_cents AS originalCents, o.quantity, o.pickup_from AS pickupFrom, o.expires_at AS expiresAt`;
const RESERVATION_COLUMNS = `r.id AS rowId, r.public_id AS id, r.code, r.status, r.customer, r.quantity,
  r.unit_price_cents AS unitPriceCents, r.created_at AS createdAt, r.expires_at AS expiresAt, r.cancelled_at AS cancelledAt,
  r.redeemed_at AS redeemedAt, r.offer_id AS offerId, o.title, o.restaurant, o.pickup_from AS pickupFrom, o.expires_at AS pickupUntil`;

const publicOffer = row => ({
  ...row,
  discountPercent: discountPercent(row.priceCents, row.originalCents),
  soldOut: row.quantity === 0,
});

// rowId é interno; a API expõe só o public_id como `id`.
const publicReservation = ({ rowId: _rowId, ...row }) => ({ ...row, totalCents: totalCents(row.unitPriceCents, row.quantity) });

/**
 * Acesso a dados. Toda SQL fica aqui; escritas que dependem de leitura rodam em
 * transação IMMEDIATE (trava de escrita desde o início), então a checagem e o
 * decremento do estoque são atômicos mesmo com vários processos no mesmo arquivo.
 */
function createStore(db, { holdMinutes = 90, maxUnitsPerCustomer = 5, newCodeKey = generateCodeKey } = {}) {
  const sql = {
    hasStale: db.prepare("SELECT 1 FROM reservations WHERE status = 'active' AND expires_at <= ? LIMIT 1").pluck(),
    restockStale: db.prepare(`UPDATE offers SET quantity = quantity + (
        SELECT SUM(r.quantity) FROM reservations r WHERE r.offer_id = offers.id AND r.status = 'active' AND r.expires_at <= @now)
      WHERE id IN (SELECT offer_id FROM reservations WHERE status = 'active' AND expires_at <= @now)`),
    markStale: db.prepare("UPDATE reservations SET status = 'expired' WHERE status = 'active' AND expires_at <= @now"),

    listOffers: db.prepare(`SELECT ${OFFER_COLUMNS} FROM offers o
      WHERE o.expires_at > @now AND (o.quantity > 0 OR @includeSoldOut) ORDER BY o.quantity = 0, o.expires_at, o.id`),
    offerById: db.prepare(`SELECT ${OFFER_COLUMNS} FROM offers o WHERE o.id = ?`),
    countOffers: db.prepare('SELECT COUNT(*) FROM offers').pluck(),
    insertOffer: db.prepare(`INSERT INTO offers (restaurant, title, description, category, price_cents, original_cents, quantity,
        pickup_from, expires_at, manage_key_hash, created_at)
      VALUES (@restaurant, @title, @description, @category, @priceCents, @originalCents, @quantity, @pickupFrom, @expiresAt, @keyHash, @now)`),
    managedOffers: db.prepare(`SELECT ${OFFER_COLUMNS},
        COALESCE((SELECT SUM(quantity) FROM reservations WHERE offer_id = o.id AND status = 'active'), 0) AS reservedUnits,
        COALESCE((SELECT SUM(quantity) FROM reservations WHERE offer_id = o.id AND status = 'redeemed'), 0) AS redeemedUnits
      FROM offers o WHERE o.manage_key_hash IN (SELECT value FROM json_each(?)) ORDER BY o.expires_at DESC, o.id DESC LIMIT 100`),

    customerUnits: db
      .prepare(
        `SELECT COALESCE(SUM(quantity), 0) FROM reservations
      WHERE offer_id = ? AND customer_key = ? AND status IN ('active', 'redeemed')`,
      )
      .pluck(),
    // A condição no WHERE é a garantia final: sem estoque suficiente, nada muda.
    takeStock: db.prepare(
      'UPDATE offers SET quantity = quantity - @quantity WHERE id = @offerId AND quantity >= @quantity AND expires_at > @now',
    ),
    giveBackStock: db.prepare('UPDATE offers SET quantity = quantity + ? WHERE id = ?'),
    insertReservation: db.prepare(`INSERT INTO reservations (offer_id, customer, customer_key, quantity, unit_price_cents, code, code_key,
        public_id, status, created_at, expires_at)
      VALUES (@offerId, @customer, @customerKey, @quantity, @unitPriceCents, @code, @codeKey, @publicId, 'active', @now, @expiresAt)`),
    reservationById: db.prepare(
      `SELECT ${RESERVATION_COLUMNS} FROM reservations r JOIN offers o ON o.id = r.offer_id WHERE r.public_id = ?`,
    ),
    reservationsByIds: db.prepare(`SELECT ${RESERVATION_COLUMNS} FROM reservations r JOIN offers o ON o.id = r.offer_id
      WHERE r.public_id IN (SELECT value FROM json_each(?)) ORDER BY r.id DESC`),
    reservationForRedemption: db.prepare(`SELECT ${RESERVATION_COLUMNS} FROM reservations r JOIN offers o ON o.id = r.offer_id
      WHERE r.code_key IN (SELECT value FROM json_each(?)) AND o.manage_key_hash IN (SELECT value FROM json_each(?)) LIMIT 1`),
    cancel: db.prepare("UPDATE reservations SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'active'"),
    redeem: db.prepare("UPDATE reservations SET status = 'redeemed', redeemed_at = ? WHERE id = ? AND status = 'active'"),
  };

  /**
   * Reservas vencidas viram 'expired' e devolvem as unidades. Roda em transação própria antes
   * das operações (um erro na operação não desfaz a devolução). Leitura barata primeiro:
   * só abre transação de escrita quando há o que expirar.
   */
  const expireStale = db.transaction(now => {
    const params = { now: iso(now) };
    if (!sql.hasStale.get(params.now)) return 0;
    sql.restockStale.run(params);
    return sql.markStale.run(params).changes;
  });
  const sweep = now => (sql.hasStale.get(iso(now)) ? expireStale.immediate(now) : 0);
  const afterSweep =
    tx =>
    (...args) => {
      sweep(args[args.length - 1]);
      return tx.immediate(...args);
    };

  const createOffer = (offer, now) => {
    const manageKey = newToken();
    const { lastInsertRowid } = sql.insertOffer.run({
      ...offer,
      pickupFrom: iso(offer.pickupFrom),
      expiresAt: iso(offer.pickupUntil),
      keyHash: hashKey(manageKey),
      now: iso(now),
    });
    return { id: Number(lastInsertRowid), manageKey };
  };

  const insertWithUniqueCode = row => {
    for (let attempt = 1; ; attempt++) {
      const codeKey = newCodeKey();
      try {
        sql.insertReservation.run({ ...row, codeKey, code: formatCode(codeKey) });
        return;
      } catch (err) {
        // Colisão de código (improvável): sorteia de novo.
        if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE' || attempt >= MAX_CODE_ATTEMPTS) throw err;
      }
    }
  };

  const reserve = db.transaction((offerId, { customer, customerKey, quantity }, now) => {
    const offer = sql.offerById.get(offerId);
    if (!offer) throw new NotFoundError('Oferta não encontrada.');
    if (!isOpenForReservation(new Date(offer.expiresAt), now)) {
      throw new ConflictError('O horário de retirada desta oferta já terminou.', { code: 'offer_closed' });
    }
    assertCustomerLimit({ alreadyReserved: sql.customerUnits.get(offerId, customerKey), requested: quantity, limit: maxUnitsPerCustomer });
    if (!sql.takeStock.run({ offerId, quantity, now: iso(now) }).changes) {
      throw new ConflictError(
        offer.quantity === 0
          ? 'Esta oferta acabou de esgotar.'
          : `Restam só ${offer.quantity} ${offer.quantity === 1 ? 'unidade' : 'unidades'}. Escolha uma quantidade menor.`,
        { code: 'sold_out', available: offer.quantity },
      );
    }
    const publicId = newToken();
    const expiresAt = reservationDeadline({
      now,
      pickupFrom: new Date(offer.pickupFrom),
      pickupUntil: new Date(offer.expiresAt),
      holdMinutes,
    });
    insertWithUniqueCode({
      offerId,
      customer,
      customerKey,
      quantity,
      unitPriceCents: offer.priceCents,
      publicId,
      now: iso(now),
      expiresAt: iso(expiresAt),
    });
    return publicReservation(sql.reservationById.get(publicId));
  });

  const cancelReservation = db.transaction((publicId, now) => {
    const item = sql.reservationById.get(publicId);
    if (!item) throw new NotFoundError('Reserva não encontrada.');
    if (item.status === STATUS.EXPIRED || (item.status === STATUS.ACTIVE && item.expiresAt <= iso(now))) {
      throw new ConflictError('O prazo de retirada terminou; esta reserva não pode mais ser cancelada.', { status: item.status });
    }
    if (item.status !== STATUS.ACTIVE || !sql.cancel.run(iso(now), item.rowId).changes) {
      throw new ConflictError(STATUS_CONFLICT[item.status] ?? STATUS_CONFLICT.cancelled, { status: item.status });
    }
    sql.giveBackStock.run(item.quantity, item.offerId);
    return { ok: true, restocked: item.quantity };
  });

  const redeem = db.transaction((codeKeys, manageKeys, now) => {
    const item = sql.reservationForRedemption.get(JSON.stringify(codeKeys), JSON.stringify(manageKeys.map(hashKey)));
    // Mesma resposta para código inexistente e código de outro restaurante: nada a enumerar.
    if (!item) throw new NotFoundError('Código não encontrado entre as suas ofertas. Confira as letras e números.');
    const view = publicReservation(item);
    if (item.status !== STATUS.ACTIVE) throw new ConflictError(STATUS_CONFLICT[item.status], { status: item.status, reservation: view });
    const state = redemptionState({ now, pickupFrom: new Date(item.pickupFrom), deadline: new Date(item.expiresAt) });
    if (state === 'too_early') {
      throw new ConflictError('A janela de retirada desta oferta ainda não começou.', { status: item.status, reservation: view });
    }
    // Prazo pode ter vencido entre a varredura e esta transação.
    if (state === 'expired' || !sql.redeem.run(iso(now), item.rowId).changes) {
      throw new ConflictError(STATUS_CONFLICT.expired, { status: STATUS.EXPIRED });
    }
    return publicReservation(sql.reservationById.get(item.id));
  });

  return {
    sweep,
    listOffers: (now, { includeSoldOut = false } = {}) => {
      sweep(now);
      return sql.listOffers.all({ now: iso(now), includeSoldOut: includeSoldOut ? 1 : 0 }).map(publicOffer);
    },
    countOffers: () => sql.countOffers.get(),
    createOffer,
    managedOffers: (manageKeys, now) => {
      sweep(now);
      return sql.managedOffers.all(JSON.stringify(manageKeys.map(hashKey))).map(row => ({
        ...publicOffer(row),
        closed: row.expiresAt <= iso(now),
      }));
    },
    reserve: afterSweep(reserve),
    reservationsByIds: (ids, now) => {
      sweep(now);
      return sql.reservationsByIds.all(JSON.stringify(ids)).map(publicReservation);
    },
    getReservation: (id, now) => {
      sweep(now);
      const row = sql.reservationById.get(id);
      return row && publicReservation(row);
    },
    cancelReservation: afterSweep(cancelReservation),
    redeem: afterSweep(redeem),
  };
}

module.exports = { createStore, hashKey };
