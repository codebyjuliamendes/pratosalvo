'use strict';

const express = require('express');
const { notFound } = require('../http/errors');
const { parseToken, parseTokens } = require('../http/validation');

function reservationRoutes(store, { clock }) {
  const router = express.Router();

  // Sem listagem global: o cliente informa os ids (secretos) das reservas que fez neste aparelho.
  router.get('/', (req, res) => res.json(store.reservationsByIds(parseTokens(req.query.ids), clock())));

  router.get('/:id', (req, res) => {
    const id = parseToken(req.params.id);
    const reservation = id && store.getReservation(id, clock());
    if (!reservation) throw notFound('Reserva não encontrada.');
    res.json(reservation);
  });

  router.post('/:id/cancel', (req, res) => {
    const id = parseToken(req.params.id);
    if (!id) throw notFound('Reserva não encontrada.');
    const result = store.cancelReservation(id, clock());
    req.log.info('reservation_cancelled', { restocked: result.restocked });
    res.json(result);
  });

  return router;
}

module.exports = { reservationRoutes };
