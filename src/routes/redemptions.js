'use strict';

const express = require('express');
const { parseRedemptionInput } = require('../http/validation');

/** Validação do código no balcão: marca a reserva como retirada uma única vez. */
function redemptionRoutes(store, { clock, limiter }) {
  const router = express.Router();

  router.post('/', limiter, (req, res) => {
    const { codeKeys, manageKeys } = parseRedemptionInput(req.body);
    const reservation = store.redeem(codeKeys, manageKeys, clock());
    req.log.info('reservation_redeemed', { offerId: reservation.offerId, quantity: reservation.quantity });
    res.json(reservation);
  });

  return router;
}

module.exports = { redemptionRoutes };
