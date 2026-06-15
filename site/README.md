# Dragon Store Site

Site profissional em Next.js para divulgar as categorias e produtos digitais da Dragon Store e finalizar pedidos pelo Discord.

O site tenta buscar produtos do bot em `GET /api/public-store`. Se o bot estiver offline ou sem token correto, usa `data/fallback-store.json` e a config local.

## Instalar localmente

```bash
cd site
npm install
```

## Criar `.env.local`

Copie `.env.example` para `.env.local`:

```bash
cp .env.example .env.local
```

No Windows PowerShell:

```powershell
Copy-Item .env.example .env.local
```

## Variaveis de ambiente

```env
ADMIN_ROUTE_SECRET=troque-por-uma-rota-grande-aleatoria
ADMIN_PASSWORD=troque-por-uma-senha-forte

BOT_PUBLIC_STORE_API_URL=https://seu-bot.onrender.com/api/public-store
BOT_PUBLIC_STORE_API_TOKEN=mesmo-token-do-bot

NEXT_PUBLIC_SITE_URL=https://sua-loja.vercel.app
DRAGON_STORE_NAME=Dragon Store
STORE_SUBTITLE=Loja digital pelo Discord
STORE_HERO_TITLE=Produtos digitais com compra rapida pelo Discord
STORE_HERO_TEXT=Escolha seus produtos, monte seu carrinho e finalize a compra abrindo um ticket no nosso servidor.
DISCORD_INVITE_URL=https://discord.gg/ZyxwUekHWh
PRIMARY_COLOR=#28f6a1
```

Nunca use `NEXT_PUBLIC_` no token da API do bot.

## Gerar segredo e senha forte

Rode:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Use um valor para `ADMIN_ROUTE_SECRET` e outro para `ADMIN_PASSWORD`.

## Rodar local

```bash
npm run dev
```

Abra:

```txt
http://localhost:3000
```

O painel admin fica em:

```txt
http://localhost:3000/SEU_ADMIN_ROUTE_SECRET
```

Nao existe rota `/admin`.

## Deploy na Vercel

1. Crie um projeto na Vercel apontando para a pasta `site`.
2. Framework preset: Next.js.
3. Build command: `npm run build`.
4. Output: padrao da Vercel.
5. Configure todas as variaveis do `.env.example`.

## Conectar com o bot

No Render do bot, configure:

```env
PUBLIC_STORE_API_TOKEN=o-mesmo-token-usado-no-site
DISCORD_INVITE_URL=https://discord.gg/ZyxwUekHWh
PUBLIC_STORE_NAME=Dragon Store
PUBLIC_STORE_PANEL_SCOPE=id_do_canal_do_configds
PUBLIC_STORE_CHANNEL_ID=id_do_canal_do_painel_publicado
PUBLIC_STORE_MESSAGE_ID=id_da_mensagem_do_painel_publicado
```

Depois redeploye o bot.

O endpoint do bot junta os produtos dos paineis salvos e devolve cada painel como uma categoria do site. Se o bot perdeu `data/panels.json` no redeploy, mas o painel antigo ainda esta publicado no Discord, preencha `PUBLIC_STORE_CHANNEL_ID` e `PUBLIC_STORE_MESSAGE_ID` para recuperar os produtos existentes a partir da mensagem.

No site/Vercel, configure:

```env
BOT_PUBLIC_STORE_API_URL=https://seu-bot.onrender.com/api/public-store
BOT_PUBLIC_STORE_API_TOKEN=o-mesmo-token-usado-no-bot
```

## Testar API do bot

```bash
curl -H "Authorization: Bearer SEU_TOKEN" https://seu-bot.onrender.com/api/public-store
```

Resposta esperada:

```json
{
  "storeName": "Dragon Store",
  "title": "Titulo do painel",
  "categories": [],
  "products": []
}
```

## Usar painel admin

1. Acesse `https://site.vercel.app/ADMIN_ROUTE_SECRET`.
2. Entre com `ADMIN_PASSWORD`.
3. Configure textos, links, API do bot, cor, imagem e fallback.
4. Clique em **Testar bot** para validar a conexao.
5. Clique em **Sincronizar** para salvar categorias e produtos do bot como fallback runtime.
6. Clique em **Salvar** para persistir a config no ambiente atual.

## Atualizar produtos

O fluxo principal continua no Discord:

1. Use `!configds` ou `/configds`.
2. Edite produtos, preco, estoque e imagens no bot.
3. Publique/atualize o painel.
4. O site mostra cada painel como uma categoria clicavel, com imagem, descricao e menor preco.
5. A pagina da categoria lista todos os produtos daquela secao.

Se o bot estiver offline, o site mostra os produtos fallback.

## Limitacoes atuais

- Sem pagamento automatico.
- O carrinho finaliza pelo Discord.
- O resumo do pedido e copiado para o cliente enviar no ticket.
- Se o bot estiver offline, usa fallback.
- A Vercel nao salva arquivo local de forma persistente em producao.
- O painel admin salva em `data/site-config.runtime.json`, util em dev e em runtime, mas para producao permanente prefira variaveis de ambiente ou banco futuro.

## Seguranca

- Nao coloque `DISCORD_TOKEN` no site.
- Nao exponha `BOT_PUBLIC_STORE_API_TOKEN` no frontend.
- `ADMIN_PASSWORD` fica apenas em variavel de ambiente.
- `ADMIN_ROUTE_SECRET` fica apenas em variavel de ambiente.
- Login admin usa cookie httpOnly.
- `.env.local` nao deve ser commitado.
