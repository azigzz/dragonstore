# Dragon Store - Bot de vendas para Discord

Bot em Node.js com `discord.js v14` para loja digital com painel configuravel pelo Discord, carrinho privado, atendimento manual por ADM, Pix individual por atendente, tickets e caixa surpresa de brindes digitais.

## Recursos

- Painel de loja com embed, banner, thumbnail, cor e menu de produtos.
- Configurador por `/configds` ou `!configds`, com uma configuracao independente por canal.
- Configurador novo com painel vazio por padrao, sem produtos fake.
- Recuperacao de painel ja publicado quando o JSON local some em redeploy.
- Presets prontos: Vazio, TFT Sets, Steam Keys e SMM.
- Produto com nome, preco, descricao, estoque e foto individual.
- Remocao de produtos em lote com selecao e botao de confirmacao.
- Upload de imagem pelo Discord, sem precisar colar URL manualmente.
- Mensagem estilo **Compre aqui** com botao Comprar e formulario editavel.
- Edicao de produto existente sem precisar remover e recriar.
- Carrinho privado por cliente com ID aleatorio de 7 digitos.
- Snapshot do produto dentro do pedido, preservando nome/preco mesmo se o produto for editado depois.
- Resumo de carrinho com quantidade, subtotal e total estimado.
- Atendimento ON/OFF por ADM.
- Pix, QR Code e mensagem extra por atendente.
- Assumir compra, reenviar Pix e finalizar compra.
- DM segura para cliente na abertura do carrinho e na finalizacao.
- Caixa surpresa de brindes digitais com pesos/chances, sorteada somente ao finalizar a compra.
- Ticket de suporte privado.
- `/status-loja` com produtos, carrinhos abertos, vendas fechadas, faturamento estimado e ADMs online.
- `/setupsucess` para definir o canal publico de vendas entregues, com nome do cliente mascarado.
- `/avaliacao` e `!avaliação` para finalizar carrinho pedindo avaliacao ao cliente.
- `/ranking-gastos` com ranking paginado de gastos por dia, semana, mes e ano.
- Cancelamento de compra pelo cliente ou ADM bloqueando/movendo o carrinho para historico e apagando automaticamente depois.

## Instalar

```bash
npm install
```

## Variaveis de ambiente

Crie as variaveis no Render ou no `.env` local:

```env
DISCORD_TOKEN=token_do_bot
CLIENT_ID=id_da_aplicacao
GUILD_ID=id_do_servidor
PUBLIC_STORE_API_TOKEN=gere_um_token_grande_e_dificil
DISCORD_INVITE_URL=https://discord.gg/ZyxwUekHWh
# opcional/preparado para migracao transacional
DATABASE_URL=postgres://usuario:senha@host/db
# opcionais para escolher/recuperar painel antigo
PUBLIC_STORE_PANEL_SCOPE=id_do_canal_do_configds
PUBLIC_STORE_CHANNEL_ID=id_do_canal_do_painel_publicado
PUBLIC_STORE_MESSAGE_ID=id_da_mensagem_do_painel_publicado
PUBLIC_STORE_SCAN_CHANNELS=true
PUBLIC_STORE_SCAN_CHANNEL_LIMIT=80
PUBLIC_STORE_SCAN_MESSAGE_LIMIT=75
```

Nunca coloque token real no codigo.

## Comandos

```txt
npm run deploy
npm start
```

No Discord:

```txt
/help
!help
/configds
!configds
!painel
!loja
!setup
/setup-atendimento
!atendimento
/configpix
!configpix
!pix
!concluircompra
!cancelarcompra
/setup-ticket
/setupsucess
!setupsucess
/avaliacao
!avaliação
!avaliacao
/ranking-gastos
!ranking-gastos
/rankinggastos
/saldogasto
/vendas
/vendasreset
/gastos-add
/gastos-remover
/gastos-reset
/status-loja
!status-loja
```

Para `!configds`, `!atendimento` e `!status-loja`, ative no Discord Developer Portal:

```txt
Application -> Bot -> Privileged Gateway Intents -> Message Content Intent
```

## Render

Build Command:

```bash
npm install && npm run deploy
```

Start Command:

```bash
npm start
```

Depois de mudar slash commands em `deploy-commands.js`, rode `npm run deploy` ou redeploy no Render. Esta versao adiciona comandos novos, entao o deploy dos slash commands e necessario.

Se `/configpix` nao aparecer ou disser que falta permissao, use `!configpix`: o bot manda um botao que abre o mesmo formulario. Rode `npm run deploy` de novo quando quiser corrigir os slash commands. Os comandos slash ficam visiveis no Discord, mas o bot so deixa usar quem tem Administrator ou o cargo ADM configurado em `config.json`.

Antes de subir uma versao nova, rode:

```bash
npm run check
```

Depois do deploy, use `/diagnostico` no servidor para conferir KV, paineis, Pix, atendimento e alertas.

Comandos operacionais uteis:

- `/help` ou `!help`: mostra a lista de comandos; ADMs veem tambem a area administrativa.
- `/salvarpix` ou `!salvarpix`: salva o backup do Pix/painel de atendimento no Discord.
- `/addcar` ou `!addcar [pesquisa]`: dentro de um carrinho, busca produtos de todos os paineis do servidor, deixa pesquisar e pergunta a quantidade antes de adicionar. Ex: `!addcar steam`.
- `/diagnostico` ou `!diagnostico`: mostra KV, paineis, produtos, Pix, atendimento e alertas de configuracao.
- `!pix`: no carrinho atual, assume a compra e envia o Pix do ADM.
- `!concluircompra` e `!cancelarcompra`: finalizam ou cancelam o carrinho atual sem depender dos botoes.
- `/caixapix quantidade:5` ou `!caixapix 5`: sorteia Caixa Pix com o preset padrao, sem mostrar porcentagens ao cliente.
- `/carrinho cliente:@usuario` ou `!carrinho @usuario`: abre um carrinho privado manual para o cliente.
- `/lock`, `/unlock`, `!lock` e `!unlock`: trava/libera o chat atual; em carrinho/ticket mexe direto na permissao do cliente.
- `/rankinggastos`: top 10 publico de quem mais gastou no servidor.
- `/saldogasto`: consulta privada do saldo gasto; ADM pode informar outro usuario.
- `/vendas`: ranking privado de vendas por ADM.
- `/vendasreset`: reseta o saldo de vendas dos ADMs para testes.
- `/gastos-add`, `/gastos-remover`, `/gastos-reset`: comandos de ADM para ajustar/remover saldo gasto de cliente.

O cargo revendedor/premium `1515835494204706938` recebe 10% de desconto automaticamente quando abre carrinho. O total mostrado no carrinho, Pix, DM, ranking e vendas ja considera esse desconto.

## Banco transacional

O bot continua compativel com JSON local + KV/Upstash, mas quando `DATABASE_URL` estiver configurado ele tambem salva e recupera `panels`, `orders` e `staff` no PostgreSQL. Isso evita perder Pix, paineis e carrinhos em deploy com filesystem read-only.

A base profissional para PostgreSQL/Neon/Supabase esta em `database/postgres-schema.sql`. O schema cobre `bot_json_store`, `guilds`, `panels`, `products`, `orders`, `order_items`, `staff`, `payments`, `stock_items`, `audit_logs`, `customer_stats` e `admin_sales`, com status de pedido `open -> processing -> closed/cancelled` para finalizacao idempotente.

Em runtime, quando o Postgres esta ativo, o bot:

- aplica o schema automaticamente no boot;
- grava snapshot dos JSONs em `bot_json_store`;
- espelha paineis, produtos, carrinhos, itens, staff, gastos, vendas e audit logs nas tabelas relacionais;
- usa trava local e banco como trava na finalizacao: apenas uma chamada consegue fazer `open -> processing`; se outro ADM clicar de novo, o bot nao sorteia caixa, nao soma gasto e nao duplica venda.
- registra pagamento manual em `payments` quando o ADM usa **Marcar pago** ou `/pago`; o botao **Enviar comprovante** salva o anexo no pedido e no Postgres como `proof_received` ate um ADM validar o pagamento.
- separa entrega de finalizacao: **Entregar produto**, `/entregar` ou `!entregar` salva a entrega no pedido, manda para o cliente e registra `delivered_at` no Postgres; finalizar direto ainda marca entrega automaticamente para manter o fluxo antigo funcionando.
- gera transcript TXT com resumo do pedido e mensagens recentes do carrinho ao finalizar/cancelar, anexando nos canais de conclusao/cancelamento quando configurados.
- controla estoque simples quando o campo `Estoque` e numerico: bloqueia compra sem quantidade suficiente e baixa estoque uma unica vez na finalizacao. Valores como `infinito`, `sob consulta` e `sob demanda` nao sao decrementados.

Se o bot cair depois de marcar uma compra como `processing` e antes de fechar, pedidos presos por mais de 10 minutos no JSON sao reabertos no boot ou na proxima tentativa de finalizar/cancelar. No Postgres, a trava relacional tambem reabre o pedido preso antes de uma nova tentativa de finalizacao.

Para preparar o banco real, configure `DATABASE_URL` e rode:

```bash
npm run db:init
```

Use `DATABASE_SSL=false` apenas se seu Postgres local nao usar SSL. Neon/Supabase normalmente funcionam com SSL ligado.

Para migrar os dados que ja existem em `data/panels.json`, `data/orders.json` e `data/staff.json`, rode depois:

```bash
npm run db:migrate-json
```

Se `PIX_ENCRYPTION_KEY` estiver configurado, as chaves Pix tambem sao migradas e espelhadas criptografadas na tabela `staff`. Sem essa variavel, o bot continua salvando Pix no snapshot privado usado pela operacao atual, mas nao grava Pix puro nas tabelas relacionais por seguranca.

O painel admin do site tambem registra eventos de seguranca como login aprovado/falho, bloqueio por tentativas, salvar configuracao, sincronizar produtos, testar bot e logout. Se houver Upstash/KV configurado, os eventos ficam em `SITE_ADMIN_AUDIT_KV_KEY`; sem KV, ficam em `/tmp/dragon-store-admin-audit.json` durante a vida da instancia.

## Site da Dragon Store

O projeto do site fica em `site/`. Ele e separado do bot para publicar facil na Vercel.

O bot agora tambem expoe:

```txt
GET /api/public-store
Authorization: Bearer PUBLIC_STORE_API_TOKEN
```

Esse endpoint retorna apenas dados publicos da loja: titulo, descricao, cor, imagens, link do Discord, categorias e produtos. Cada painel publicado vira uma categoria do site com descricao, imagem e menor preco. Ele nao retorna pedidos, Pix, tokens ou dados internos.

Se o JSON local perdeu os produtos, mas a mensagem publicada ainda existe no Discord, configure `PUBLIC_STORE_CHANNEL_ID` e `PUBLIC_STORE_MESSAGE_ID` no Render para o bot recuperar esse painel quando a API do site for chamada.

Para testar:

```bash
curl -H "Authorization: Bearer SEU_TOKEN" https://seu-bot.onrender.com/api/public-store
```

No site, configure `BOT_PUBLIC_STORE_API_URL` e `BOT_PUBLIC_STORE_API_TOKEN` na Vercel. Mais detalhes estao em `site/README.md`.

## Fluxo do dono da loja

1. Use `/configds` ou `!configds` no canal que vai guardar aquela configuracao.
2. Configure titulo, descricao, banner, thumbnail, cor e canal.
3. Clique em **Adicionar produto** para cadastrar nome, preco, descricao, estoque e foto.
4. Clique em **Editar produto** para trocar nome, preco, estoque, foto ou brindes.
5. Use **Enviar imagem do painel** para mandar banner/thumbnail como anexo no Discord.
6. Use **Enviar foto de produto** para escolher um produto e mandar a foto como anexo.
7. Use **Presets** para aplicar Vazio, TFT Sets, Steam Keys ou SMM naquele canal.
8. Clique em **Adicionar caixa surpresa** para cadastrar uma caixa de brindes digitais.
9. Use **Preview** para conferir.
10. Use **Publicar painel** para publicar ou reutilizar a mensagem salva quando possivel.
11. Use **Atualizar publicado** para editar manualmente o painel que ja esta no chat.
12. Use **Vincular painel** e cole o link/ID da mensagem se o Render perdeu o JSON e o bot nao encontrou o painel sozinho.

Ao enviar imagem por arquivo, o bot salva uma copia da imagem em uma mensagem dele no Discord e grava a URL dessa copia no JSON.

Cada canal tem seu proprio painel. Exemplo: `!configds` no canal 1 nao altera os produtos/config do canal 2.

## Presets

No configurador, clique em **Presets** e escolha:

- **TFT Sets**: cria os sets da lista TFT e ignora os textos `(xxx em estoque)`.
- **Steam Keys**: cria Steam Key Black Premium, Ruby e 3x aleatorias.
- **SMM**: cria seguidores, curtidas e visualizacoes.
- **Vazio**: limpa os produtos e deixa o painel pronto para configurar do zero.

Aplicar preset substitui os produtos do painel daquele canal. Banner, thumbnail e canal de publicacao sao preservados.

## Mensagem Compre Aqui

No configurador:

1. Clique em **Editar compra** para editar titulo, texto do painel, texto do botao e as duas perguntas do formulario.
2. Por padrao, as perguntas sao `Nick no roblox` e `Nome do Set que voce deseja comprar`.
3. Clique em **Publicar compra** para enviar uma mensagem com botao **Comprar**.
4. Quando o cliente clica em **Comprar**, o bot abre o formulario e cria um carrinho privado com as respostas.

O banner usado nessa mensagem e o mesmo do painel principal; use **Enviar imagem do painel** para trocar sem colar link.

## Fluxo de atendimento

1. Um ADM usa `/setup-atendimento` no canal da equipe.
2. Cada ADM usa `!configpix`, `/configpix` ou o botao **Configurar meu Pix**.
3. O ADM salva nome de exibicao, chave Pix, QR Code opcional e mensagem extra.
4. O ADM clica em **Ficar ON** quando puder receber vendas.
5. Se houver um unico ADM ON, o bot assume a compra automaticamente para ele.
6. Se houver dois ou mais ADMs ON, o primeiro que clicar em **Assumir compra** fica responsavel.
7. Depois de assumida, o bot libera **Reenviar Pix**.

## Vendas concluidas e ranking

1. Crie ou escolha um canal publico para mostrar compras entregues.
2. Use `/setupsucess` nesse canal. Se quiser, informe o cargo cliente na opcao `cargo-cliente`.
3. Quando um ADM clicar em **Finalizar compra**, o bot manda uma mensagem no canal com o nome do cliente mascarado, adiciona o cargo cliente e salva o gasto.
4. Use `/ranking-gastos` para ver o ranking por dia, semana, mes ou ano, com 10 clientes por pagina.
5. Se o slash command ainda nao aparecer, use `!setupsucess` e `!ranking-gastos`.

Carrinhos finalizados ou cancelados ficam visiveis para historico por 3 dias e depois sao apagados automaticamente. Para mudar o tempo, altere `settings.deleteClosedCartAfterSeconds` no `config.json` ou use a variavel `CLOSED_CART_DELETE_SECONDS`.

## Pedido de avaliacao

Use `/avaliacao` dentro do canal do carrinho para finalizar a compra e pedir avaliacao ao cliente. O Discord nao aceita acento no nome do slash command, entao o slash e sem acento; por prefixo, `!avaliação` e `!avaliacao` funcionam.

O comando faz o mesmo fechamento de **Finalizar compra**: bloqueia o chat para o cliente, registra gasto, tenta dar o cargo cliente, manda feed de venda e agenda a limpeza do carrinho. Alem disso, ele marca o cliente com a mensagem configurada e pinga o cliente no canal de avaliacoes, apagando esse ping depois de 10 segundos.

Formas de usar:

```txt
/avaliacao
/avaliacao canal:#avaliacoes
/avaliacao canal:#avaliacoes mensagem:Obrigado pela compra! Se possivel, deixe uma avaliacao no chat {channel}.
!avaliação
!avaliação 123456789012345678
!avaliação 123456789012345678 Obrigado pela compra! Se possivel, deixe uma avaliacao no chat {channel}.
```

Configure o padrao no `config.json` em `review.channelId`, `review.message`, `review.channelPingMessage` e `review.deletePingAfterSeconds`. Use `{channel}` ou `{canal}` para mencionar o canal de avaliacoes na mensagem.

## Caixa surpresa

A caixa surpresa e apenas para brinde digital, produto, pack ou cupom. Nao use Pix, saldo real, dinheiro real ou premio financeiro.

Formato dos brindes:

```txt
Nome do brinde | peso | descricao
Mini Pack | 70 | 10 cortes aleatorios
Pack Lifestyle | 20 | 20 videos lifestyle
Pack Premium | 8 | brinde premium de edicao
Pack Raro | 2 | brinde raro de conteudo digital
```

O sorteio acontece quando o ADM clica em **Finalizar compra**. O resultado fica salvo no pedido e aparece no carrinho e na DM do cliente.

## IDs configuraveis

Os IDs ficam em `config.json`:

```json
{
  "adminRoleId": "1515799363149103142",
  "customerRoleId": "cargo_cliente_opcional",
  "categories": {
    "cartOpen": "1515799366760141033",
    "closed": "1515813300862980268",
    "ticketOpen": "1515799366760141033"
  },
  "ticketPanel": {
    "channelId": "1515799364574904531"
  },
  "review": {
    "channelId": "1515799364155478138",
    "message": "Obrigado pela compra! Se possivel, deixe uma avaliacao no chat {channel}.",
    "channelPingMessage": "Obrigado pela compra! Deixe sua avaliacao aqui quando puder.",
    "deletePingAfterSeconds": 10
  },
  "settings": {
    "deleteClosedCartAfterSeconds": 259200
  }
}
```

## Persistencia

Os dados ficam em JSON dentro da pasta `data`:

- `data/panels.json`
- `data/orders.json`
- `data/staff.json`

Em hospedagem gratis, esses arquivos podem sumir em redeploy/restart dependendo da plataforma. Para loja em producao, o proximo passo recomendado e migrar esses dados para Neon/PostgreSQL.

Quando o painel publicado ainda existe no chat, o bot tenta recuperar automaticamente o embed e as opcoes do menu ao abrir `!configds` no mesmo canal, quando um cliente clica no menu antigo e quando o site chama a API publica. Se o JSON sumir no redeploy, a API varre mensagens recentes do proprio bot nos canais do servidor e salva de novo os paineis encontrados. Essa varredura vem ligada por padrao; use `PUBLIC_STORE_SCAN_CHANNELS=false` se precisar desligar. Se a mensagem estiver muito antiga, use **Vincular painel** no configurador e cole o link ou ID da mensagem publicada.

A recuperacao pelo Discord preserva titulo, descricao, cor, banner, thumbnail, nome, preco, descricao curta e estoque que aparecem no menu publicado. O site usa a imagem/banner do painel recuperado para a categoria. Fotos individuais de produto e regras internas de caixa surpresa dependem do JSON/DB original.

## Como testar no Discord

1. Rode `npm run deploy`.
2. Rode `npm start`.
3. Use `/configds` em dois canais diferentes e confirme que cada canal tem produtos/config separada.
4. Confirme que o `configds` novo abre vazio, aplique o preset TFT, publique o painel e abra um carrinho como cliente.
5. Clique em **Editar compra**, confira as perguntas, publique a mensagem e teste o botao **Comprar**.
6. Use **Remover produto**, selecione mais de um item e confirme a remocao.
7. Use `/setup-atendimento`, configure Pix com `/configpix` e fique ON.
8. Abra outro carrinho e confirme se o Pix vai automaticamente quando houver um unico ADM ON.
9. Clique em **Enviar comprovante**, envie uma imagem como cliente e confirme que o carrinho mostra `Comprovante recebido` antes do ADM marcar pago.
10. Use **Marcar pago** e depois **Entregar produto** ou `/entregar`; confira se o checklist muda para pagamento recebido e produto entregue antes da finalizacao.
9. Adicione uma caixa surpresa, compre e finalize como ADM para verificar o sorteio.
10. Use `/status-loja` no canal desejado para conferir o resumo daquele painel.
