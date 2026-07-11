# Sávio Store Site

Vitrine em Next.js sincronizada com os painéis de produtos do bot da Sávio Store.

## Fluxo

- Cada painel publicado pelo `!configds` vira uma categoria.
- A home mostra imagem, descrição, quantidade de opções e menor preço.
- A página da categoria lista os produtos e permite montar o pedido.
- `POST /api/orders` envia IDs e quantidades ao bot; o bot valida preços e devolve um ID `SS-...` persistido.
- A equipe consulta o ID com `/pedido codigo` ou `!pedido codigo`.
- O token da API nunca é enviado ao navegador.

## Desenvolvimento

```bash
cd site
npm install
npm run dev
```

Crie `site/.env.local` com base em `.env.example`. Esse arquivo não deve ser enviado ao Git.

## Vercel

Configure o projeto com **Root Directory** `site` e adicione as variáveis de `.env.example`.

As variáveis essenciais são:

```env
BOT_PUBLIC_STORE_API_URL=https://savio-store.onrender.com/api/public-store
BOT_PUBLIC_STORE_API_TOKEN=mesmo-token-do-PUBLIC_STORE_API_TOKEN-no-Render
NEXT_PUBLIC_SITE_URL=https://seu-projeto.vercel.app
SAVIO_STORE_NAME=Sávio Store
DISCORD_INVITE_URL=https://discord.gg/fQQrUk7c98
```

No Render do bot:

```env
PUBLIC_STORE_API_TOKEN=um-token-aleatorio-forte
PUBLIC_STORE_NAME=Sávio Store
PUBLIC_STORE_GUILD_ID=ID_DO_SERVIDOR_DA_SAVIO_STORE
DISCORD_INVITE_URL=https://discord.gg/fQQrUk7c98
PUBLIC_STORE_SCAN_CHANNELS=true
```

O valor de `BOT_PUBLIC_STORE_API_TOKEN` na Vercel deve ser idêntico ao `PUBLIC_STORE_API_TOKEN` no Render.

## Painel administrativo

O painel fica em `https://seu-site/ADMIN_ROUTE_SECRET`. Em produção, alterações feitas por ele precisam de storage externo compatível com Upstash REST. Use chaves KV exclusivas da Sávio Store para não misturar configuração e analytics com a Dragon Store.

## Segurança

- Nunca coloque `DISCORD_TOKEN` ou credenciais do banco na Vercel.
- Nunca prefixe o token da API com `NEXT_PUBLIC_`.
- O bot recalcula preços; valores enviados pelo navegador não são aceitos como fonte de verdade.
- Pedidos do site expiram para atendimento após 48 horas e não contam como faturamento até a compra ser finalizada no Discord.
