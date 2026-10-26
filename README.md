# PratoSalvo

Marketplace local de refeições com desconto. Restaurantes publicam excedentes com prazo de retirada; clientes reservam uma quantidade e recebem um código para apresentar no balcão.

## Rodar localmente

Requer Node.js 20 ou superior.

```bash
npm install
npm start
```

Abra <http://localhost:3001>. Quatro ofertas fictícias são criadas na primeira execução. O banco local fica em `data/pratosalvo.sqlite` e está ignorado pelo Git.

## Funcionalidades

- Vitrine por categoria, desconto, quantidade e horário para retirada.
- Cadastro de ofertas por restaurantes.
- Reserva pelo nome do cliente e geração de código para retirada.
- Atualização atômica do estoque para impedir reservas acima da quantidade disponível.
- Histórico recente de reservas e atualização automática da vitrine.
- Cancelamento antes do prazo de retirada, com devolução atômica das unidades ao estoque e proteção contra cancelamento duplicado.

## Stack e decisões

- Express e SQLite; o frontend usa HTML, CSS e JavaScript sem framework.
- Preços são salvos em centavos inteiros.
- A reserva decrementa a quantidade disponível dentro de uma transação e só confirma quando há estoque. Requisições simultâneas não vendem a mesma unidade duas vezes.
- Anúncios e pessoas são demonstração sem autenticação. Não use para transações ou dados reais.

## API

- `GET /api/offers` — ofertas disponíveis.
- `POST /api/offers` — publica uma oferta.
- `POST /api/offers/:id/reservations` — reserva unidades.
- `GET /api/reservations` — últimas reservas.
- `POST /api/reservations/:id/cancel` — cancela uma reserva ainda válida e restaura a quantidade da oferta.

## Próximas melhorias

Autenticação de restaurantes, busca por localização, cancelamento de reserva com reposição de estoque e notificações de retirada.
