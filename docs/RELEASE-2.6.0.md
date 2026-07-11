# Dragon/Savio Store 2.6.0

> Patch 2.6.1: a leitura do catalogo e publica; o token continua obrigatorio para pedidos e analytics.

## Faturamento

- `/setupfaturamento` e `!setupfaturamento` publicam um painel persistente em um canal privado.
- Total geral, hoje, semana, mes, vendas, itens e ticket medio usam somente pedidos finalizados.
- O painel atualiza automaticamente e pode mostrar ou ocultar as 10 vendas mais recentes.
- Cada `STORE_INSTANCE_ID` usa seus proprios pedidos, configuracao e chaves de storage.

## Site Sávio Store

- Identidade visual propria com o novo logo.
- Cada painel do bot vira uma categoria com menor preco e pagina de produtos.
- Carrinho persistente e responsivo.
- O bot valida IDs, quantidades e precos antes de gerar um pedido `SS-...`.
- `/pedido` e `!pedido` consultam pedidos criados no site.
- Analytics de trafego, cliques e pedidos sao persistidos pelo storage isolado do bot.
- Projeto Vercel separado da Dragon Store.

## Seguranca e estabilidade

- O token do bot permanece somente entre os backends.
- Precos enviados pelo navegador nunca sao aceitos como fonte de verdade.
- Criacao de pedidos tem limite por IP, quantidade maxima e idempotencia.
- Interacoes longas sao reconhecidas antes de acessar Discord/Postgres.
- Analytics nao interrompe compras quando o storage do navegador estiver bloqueado.
