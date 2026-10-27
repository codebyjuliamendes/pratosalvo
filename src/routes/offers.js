'use strict';

const express = require('express');
const { notFound } = require('../http/errors');
const { parseId, parseOfferInput, parseReservationInput, parseManageKeys } = require('../http/validation');

function offerRoutes(store, { clock, timeZone }) {
  const router = express.Router();

  // Padrão: só ofertas reserváveis. ?include=sold_out traz também as esgotadas ainda na janela.
  router.get('/', (req, res) => res.json(store.listOffers(clock(), { includeSoldOut: req.query.include === 'sold_out' })));

  // A resposta traz `manageKey` uma única vez: é a credencial do restaurante para validar retiradas.
  router.post('/', (req, res) => {
    const now = clock();
    const created = store.createOffer(parseOfferInput(req.body, { now, timeZone }), now);
    req.log.info('offer_created', { offerId: created.id });
    res.status(201).json(created);
  });

  // POST (não GET) para que as chaves de gestão não fiquem em URLs e logs de proxy.
  router.post('/manage', (req, res) => res.json(store.managedOffers(parseManageKeys(req.body), clock())));

  router.post('/:id/reservations', (req, res) => {
    const offerId = parseId(req.params.id);
    if (!offerId) throw notFound('Oferta não encontrada.');
    const reservation = store.reserve(offerId, parseReservationInput(req.body), clock());
    req.log.info('reservation_created', { offerId, quantity: reservation.quantity });
    res.status(201).json(reservation);
  });

  return router;
}

module.exports = { offerRoutes };
