# PratoSalvo

Marketplace local de refeições com desconto para reduzir desperdício. Restaurantes publicam excedentes do dia com uma janela de retirada; clientes reservam uma quantidade e recebem um código para apresentar no balcão, onde o restaurante valida a retirada.

## Funcionalidades

- Vitrine por categoria com desconto, estoque, janela de retirada e estado "esgotado".
- Publicação de ofertas por restaurantes, com preço promocional, preço original, unidades e janela de retirada.
- Reserva pelo nome do cliente, com limite de unidades por pessoa e código de retirada aleatório.
- "Minhas reservas": as reservas feitas no aparelho, com código em destaque, prazo e cancelamento.
- Área do restaurante: validação do código no balcão (uma única vez) e acompanhamento das próprias ofertas.
- Expiração automática de reservas não retiradas, com devolução das unidades ao estoque.
- Interface responsiva (pensada para celular, 390 px), acessível, em português, com tema claro/escuro automático ou manual.

## Regras de reserva e retirada

| Regra               | Comportamento                                                                                                                                                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preços              | Guardados em centavos inteiros, convertidos a partir do texto (`12.9`, `"12,90"`, `"R$ 1.234,56"`) sem multiplicar floats. Mais de duas casas decimais é rejeitado. Máximo R$ 2.000,00 por unidade.                                                                                      |
| Desconto            | `floor((original − promocional) × 100 / original)`: arredonda para baixo, nunca anuncia desconto maior que o real. Precisa ser de pelo menos 1%.                                                                                                                                         |
| Janela de retirada  | `pickupFrom` (opcional; padrão: agora) até `expiresAt`. Mínimo de 10 minutos, máximo de 7 dias à frente. Horários com fuso (`Z`/`-03:00`) são exatos; sem fuso são lidos em `APP_TIMEZONE` (o frontend sempre envia UTC).                                                                |
| Quando reservar     | Até o fim da janela, inclusive antes do início (reserva antecipada). Oferta vencida sai da vitrine e responde `409 offer_closed`.                                                                                                                                                        |
| Estoque             | Decremento atômico em transação `IMMEDIATE` com `UPDATE … WHERE quantity >= ?`; um trigger impede estoque negativo. Sem unidades suficientes: `409 sold_out` com `available`.                                                                                                            |
| Limite por cliente  | `MAX_UNITS_PER_CUSTOMER` (padrão 5) por oferta, somando reservas ativas e retiradas do mesmo nome (sem diferenciar maiúsculas). Até 10 unidades por reserva.                                                                                                                             |
| Prazo da reserva    | `RESERVATION_HOLD_MINUTES` (padrão 90) a partir do início efetivo da retirada, limitado ao fim da janela. Vencido, a reserva vira `expired` e as unidades voltam ao estoque (varredura em cada operação e a cada minuto).                                                                |
| Código de retirada  | 8 caracteres de `23456789ABCDEFGHJKMNPQRSTVWXYZ` (sem 0/O, 1/I/L, U) sorteados com `crypto.randomInt`, exibidos como `PS-K7MP-3QXA` (~39 bits). Na digitação são tolerados minúsculas, espaços, hífens e O/I/L no lugar de 0/1.                                                          |
| Validação no balcão | Só o restaurante dono da oferta (chave de gestão) valida, e só a partir do início da janela. Código inexistente e código de outro restaurante dão a mesma resposta (`404`). A troca `active → redeemed` é condicional: duas validações simultâneas resultam em uma aprovada e uma `409`. |
| Cancelamento        | Pelo cliente, enquanto a reserva estiver ativa e no prazo; devolve as unidades uma única vez. Reservas retiradas, expiradas ou já canceladas respondem `409`.                                                                                                                            |
| Estados             | `active` → `redeemed` \| `cancelled` \| `expired` (finais; um trigger barra valores inválidos).                                                                                                                                                                                          |

## Acesso e privacidade

Não há contas de usuário. Em vez de IDs sequenciais, o acesso usa segredos aleatórios de 128 bits guardados no aparelho (localStorage):

- **Reserva**: o `id` público da reserva permite consultá-la e cancelá-la. Não existe listagem global; o cliente informa os ids que conhece.
- **Restaurante**: ao publicar uma oferta, a resposta traz uma `manageKey` (exibida uma única vez). O banco guarda apenas o SHA-256 dela. Ela é necessária para validar códigos e ver o painel da oferta e vai no corpo da requisição (nunca na URL).

## API

Erros sempre em JSON: `{ "error": "mensagem", ...detalhes }`. Respostas da API com `Cache-Control: no-store` e `X-Request-Id`.

- `GET /api/health`: verificação de saúde (consulta o banco) e versão.
- `GET /api/rules`: `{ maxUnitsPerCustomer, holdMinutes, timeZone }` para o frontend.
- `GET /api/offers`: ofertas reserváveis (com estoque, dentro da janela). `?include=sold_out` inclui as esgotadas ainda na janela.
  Cada oferta: `id, restaurant, title, description, category, priceCents, originalCents, discountPercent, quantity, soldOut, pickupFrom, expiresAt`.
- `POST /api/offers`: publica; corpo `{ restaurant, title, description, category, price, originalPrice, quantity, pickupFrom?, expiresAt }`. Categorias: `Refeição`, `Padaria`, `Doces`, `Outros`. Resposta `201 { id, manageKey }`.
- `POST /api/offers/manage`: corpo `{ manageKeys: [...] }`; devolve as ofertas dessas chaves com `reservedUnits`, `redeemedUnits` e `closed`.
- `POST /api/offers/:id/reservations`: corpo `{ customer, quantity }`. Resposta `201` com a reserva (`id, code, status, customer, quantity, unitPriceCents, totalCents, createdAt, expiresAt, pickupFrom, pickupUntil, offerId, title, restaurant`).
  Conflitos `409` com `code`: `sold_out` (+`available`), `customer_limit` (+`remaining`), `offer_closed`.
- `GET /api/reservations?ids=a,b`: reservas cujos ids foram informados (até 50). Sem `ids`, lista vazia.
- `GET /api/reservations/:id`: uma reserva.
- `POST /api/reservations/:id/cancel`: cancela e devolve o estoque; `{ ok: true, restocked }`.
- `POST /api/redemptions`: corpo `{ code, manageKeys: [...] }`; valida a retirada e devolve a reserva `redeemed` (com `customer`, `quantity`, `totalCents`). Tem limite de taxa próprio.

## Executar localmente

Requer Node.js 20 ou superior (`.nvmrc` aponta para 22).

```bash
npm install
npm start          # http://localhost:3001
```

Em banco vazio (fora de produção) quatro ofertas fictícias são criadas. Elas não têm chave de gestão conhecida; para testar a validação no balcão, publique uma oferta pelo botão **Sou restaurante**. O banco fica em `data/pratosalvo.sqlite` (ignorado pelo Git).

### Variáveis de ambiente

Validadas no boot (valor inválido derruba o processo com mensagem clara). Modelo em `.env.example`.

| Variável                       | Padrão                    | Descrição                                                   |
| ------------------------------ | ------------------------- | ----------------------------------------------------------- |
| `PORT`                         | `3001`                    | Porta HTTP.                                                 |
| `DATABASE_PATH`                | `data/pratosalvo.sqlite`  | Caminho do banco SQLite.                                    |
| `LOG_LEVEL`                    | `info`                    | `debug`, `info`, `warn`, `error` ou `silent`.               |
| `TRUST_PROXY`                  | `0`                       | Saltos de proxy confiáveis; `1` atrás de Fly/Render/Nginx.  |
| `APP_TIMEZONE`                 | `America/Sao_Paulo`       | Fuso IANA para horários recebidos sem deslocamento.         |
| `RATE_LIMIT_PER_MINUTE`        | `60`                      | Escritas por IP por minuto na API; `0` desativa.            |
| `REDEEM_RATE_LIMIT_PER_MINUTE` | `20`                      | Validações de código por IP por minuto; `0` desativa.       |
| `RESERVATION_HOLD_MINUTES`     | `90`                      | Tolerância da reserva após o início da retirada (5 a 1440). |
| `MAX_UNITS_PER_CUSTOMER`       | `5`                       | Unidades por cliente em cada oferta (1 a 10).               |
| `SEED_DEMO`                    | `true` (`false` em prod.) | Ofertas fictícias em banco vazio.                           |
| `BACKUP_KEEP`                  | `14`                      | Backups mantidos por `npm run backup`.                      |

### Scripts

```bash
npm run dev           # servidor com recarga automática
npm test              # domínio, API, migrações, infra, concorrência entre processos e servidor real (node:test)
npm run lint          # ESLint 9 (flat config)
npm run format        # Prettier
npm run check         # lint + formatação + testes (o mesmo que roda no CI)
npm run backup        # backup online do SQLite com retenção
node scripts/smoke.js http://127.0.0.1:3001   # publica, reserva e valida contra uma instância no ar
```

## Estrutura

```
server.js              # boot: config, logger, banco, seed, HTTP, varredura de expiração e shutdown gracioso
src/
  app.js               # createApp(db, options): composição do Express
  config.js            # variáveis de ambiente validadas
  logger.js            # logger JSON com redação de códigos de retirada
  db.js                # conexão SQLite e migrações versionadas (PRAGMA user_version)
  store.js             # acesso a dados e transações (toda a SQL fica aqui)
  seed.js              # ofertas de demonstração
  domain/              # regras puras, sem I/O
    pricing.js         #   centavos, desconto, limites de preço
    pickup.js          #   fuso, janela de retirada, prazo da reserva
    reservation.js     #   código de retirada, limite por cliente, estados
    errors.js          #   ValidationError (400), NotFoundError (404), ConflictError (409)
  http/                # erros JSON, CSP, request id/log de acesso, rate limit, validação de entrada
  routes/              # offers, reservations, redemptions
public/                # frontend estático: HTML, CSS com tokens claro/escuro, JS sem framework
scripts/               # backup.js (backup online) e smoke.js (teste ponta a ponta)
test/                  # node:test (porta 0, banco :memory:) e teste com processos concorrentes
```

## Arquitetura e decisões

- **Camadas**: rotas só traduzem HTTP; `http/validation.js` normaliza a entrada; `domain/` decide as regras (puro, testável sem banco); `store.js` executa as transações. O relógio é injetável (`createApp(db, { clock })`), o que permite testar janela e expiração sem esperar.
- **Concorrência**: better-sqlite3 é síncrono, então dentro de um processo as requisições já são serializadas. A proteção que importa vale entre processos (várias instâncias no mesmo arquivo, scripts): reserva, cancelamento e validação abrem transação `IMMEDIATE` (trava de escrita desde a leitura) com `busy_timeout` de 5 s, e toda mudança de estado é condicional (`WHERE quantity >= ?`, `WHERE status = 'active'`). `test/concurrency.test.js` dispara 6 processos disputando 12 unidades e confere que exatamente 12 são vendidas. Se a trava não sair a tempo, a API responde `503` com `Retry-After`.
- **Expiração**: a varredura roda em transação própria antes de cada operação (uma reserva recusada não desfaz a devolução de estoque) e periodicamente no servidor.
- **Datas**: tudo em ISO 8601 UTC (`toISOString`); a migração converte datas antigas `AAAA-MM-DD HH:MM:SS`.
- **Migrações**: numeradas em `src/db.js`, aplicadas em ordem, com a versão lida dentro da transação (dois processos subindo juntos não aplicam a mesma). Bancos da versão anterior são atualizados automaticamente: reservas ganham id público, código normalizado (códigos antigos `PS-1A2B3C` continuam válidos), preço congelado e prazo; ofertas ganham janela e uma chave de gestão aleatória (desconhecida, pois a versão anterior não tinha credencial).
- **Segurança**: CSP sem `unsafe-inline` (tema aplicado por `theme.js` externo no `<head>`), `nosniff`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`; todo texto do usuário é escapado no frontend; limite de 24 kB no corpo; rate limit nas escritas e um mais rígido na validação de código; ids de reserva e códigos redigidos nos logs.

## Produção

### Docker

```bash
docker compose up --build    # http://localhost:3001, dados no volume pratosalvo-data
```

Imagem multi-stage `node:22-bookworm-slim`, só dependências de produção, usuário `node` (não root), banco em `/data` (volume) e `HEALTHCHECK` em `/api/health`. Node como PID 1 recebe `SIGTERM` e encerra com shutdown gracioso. Com `NODE_ENV=production` não há dados fictícios, a menos que `SEED_DEMO=true` (o `docker-compose.yml` liga para demonstração).

SQLite exige **uma única instância** com volume persistente. Para escalar horizontalmente, migre para PostgreSQL (a SQL está isolada em `src/store.js`) e troque o rate limit em memória por um store compartilhado.

### Backups

`npm run backup` usa a API de backup online do SQLite: a cópia é consistente mesmo com o app no ar. No container: `docker compose exec app npm run backup`. Agende via cron e copie o diretório para um storage externo.

### Observabilidade

- Logs JSON, uma linha por evento, com `requestId` (propaga `X-Request-Id` válido ou gera UUID, devolvido na resposta).
- Eventos de domínio: `offer_created`, `reservation_created`, `reservation_cancelled`, `reservation_redeemed`, `reservations_expired`.
- Códigos de retirada (`PS-K7…`) e ids de reserva (`/api/reservations/dHhM…`) aparecem redigidos; query strings não são registradas.

### CI/CD

Cada push na `main` e cada PR roda lint, formatação e testes em Node 20 e 22, constrói a imagem Docker e faz smoke test do container (health, usuário não root, fluxo publicar → reservar → validar). O Dependabot abre PRs semanais de npm e mensais de actions e imagem base.

## Limitações

- Sem contas: quem tem o id da reserva pode cancelá-la; quem limpa o navegador ou troca de aparelho perde o acesso às reservas e às chaves de gestão.
- O limite por cliente usa o nome informado; é uma barreira de justiça, não antifraude.
- Pagamento no balcão; sem integração com meios de pagamento, busca por localização ou notificações.
- Instância única (SQLite e rate limit em memória).
