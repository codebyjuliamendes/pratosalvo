'use strict';

const HOUR = 3_600_000;

// Ofertas fictícias para demonstração. As chaves de gestão não são guardadas: ninguém valida retiradas delas.
const DEMO_OFFERS = [
  ['Pão & Prosa', 'Kit de pães artesanais', 'Pães do dia, assados fresquinhos pela manhã.', 'Padaria', 1290, 2600, 5, 3],
  ['Verde Vivo', 'Bowl da horta', 'Bowl colorido com grãos, legumes e molho da casa.', 'Refeição', 1890, 3500, 3, 3],
  ['Doce Encontro', 'Caixa de brigadeiros', 'Seis brigadeiros artesanais sortidos.', 'Doces', 990, 2100, 4, 5],
  ['Cantina da Praça', 'Marmita caseira', 'Arroz, feijão, legumes e prato do dia.', 'Refeição', 1690, 3200, 2, 5],
];

/** Popula um banco vazio; não faz nada se já houver ofertas. Retorna quantas criou. */
function seedDemoOffers(store, now = new Date()) {
  if (store.countOffers() > 0) return 0;
  for (const [restaurant, title, description, category, priceCents, originalCents, quantity, hours] of DEMO_OFFERS) {
    store.createOffer(
      {
        restaurant,
        title,
        description,
        category,
        priceCents,
        originalCents,
        quantity,
        pickupFrom: now,
        pickupUntil: new Date(+now + hours * HOUR),
      },
      now,
    );
  }
  return DEMO_OFFERS.length;
}

module.exports = { seedDemoOffers };
