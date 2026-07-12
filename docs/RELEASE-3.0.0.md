# Release 3.0.0

## Pagamentos

- Politica central em centavos: abaixo de R$ 1 usa Pix manual; a partir de R$ 1 usa PagBank.
- Pix e QR Code aparecem sempre no ticket privado.
- Integracao Order API com Bearer token, idempotencia e expiracao de 15 minutos.
- Webhook com corpo bruto, SHA-256 e comparacao timing-safe.
- Aprovacao/recusa manual exclusiva de `BOT_OWNER_IDS`.
- Carrinho congelado depois da cobranca e valor recalculado no servidor.

## Estoque

- Estoque secreto administrado em `/configds` e no configurador aberto por `/configds2`.
- AES-256-GCM por item, IV aleatorio, authentication tag e fingerprint HMAC.
- Reserva atomica PostgreSQL com `FOR UPDATE SKIP LOCKED`.
- Entrega por DM e fallback apenas em ticket comprovadamente privado.
- Reenvio usa a mesma reserva; falha nao consome outra unidade.
- Expiracao e cancelamento liberam reservas persistentes.

## Migration

`database/migrations/002_pagbank_stock.sql` adiciona os campos de pagamento, modo de estoque e cofre criptografado. O schema principal tambem e idempotente e roda automaticamente na inicializacao quando `DATABASE_URL` esta configurada.

## Deploy

Configure no Render: `PAGBANK_TOKEN`, `PAGBANK_ENV`, `PAGBANK_WEBHOOK_URL`, `BOT_OWNER_IDS`, `STOCK_ENCRYPTION_KEY`, `MANUAL_PIX_RESERVATION_MINUTES` e `DATABASE_URL`.
