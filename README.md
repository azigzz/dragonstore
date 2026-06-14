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
```

Nunca coloque token real no codigo.

## Comandos

```txt
npm run deploy
npm start
```

No Discord:

```txt
/configds
!configds
/setup-atendimento
!atendimento
/configpix
!configpix
/setup-ticket
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

Depois de mudar slash commands em `deploy-commands.js`, rode `npm run deploy` ou redeploy no Render. As melhorias atuais usam comandos ja existentes, mas ainda e recomendado redeployar para subir o codigo novo.

Se `/configpix` nao aparecer ou disser que falta permissao, use `!configpix`: o bot manda um botao que abre o mesmo formulario. Rode `npm run deploy` de novo quando quiser corrigir os slash commands. Os comandos slash ficam visiveis no Discord, mas o bot so deixa usar quem tem Administrator ou o cargo ADM configurado em `config.json`.

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
  "categories": {
    "cartOpen": "1515799366760141033",
    "closed": "1515813300862980268",
    "ticketOpen": "1515799366760141033"
  },
  "ticketPanel": {
    "channelId": "1515799364574904531"
  }
}
```

## Persistencia

Os dados ficam em JSON dentro da pasta `data`:

- `data/panels.json`
- `data/orders.json`
- `data/staff.json`

Em hospedagem gratis, esses arquivos podem sumir em redeploy/restart dependendo da plataforma. Para loja em producao, o proximo passo recomendado e migrar esses dados para Neon/PostgreSQL.

Quando o painel publicado ainda existe no chat, o bot tenta recuperar automaticamente o embed e as opcoes do menu ao abrir `!configds` no mesmo canal ou quando um cliente clica no menu antigo. Se a mensagem estiver mais antiga, use **Vincular painel** no configurador e cole o link ou ID da mensagem publicada.

A recuperacao pelo Discord preserva titulo, descricao, cor, banner, thumbnail, nome, preco, descricao curta e estoque que aparecem no menu publicado. Fotos individuais de produto e regras internas de caixa surpresa dependem do JSON/DB original.

## Como testar no Discord

1. Rode `npm run deploy`.
2. Rode `npm start`.
3. Use `/configds` em dois canais diferentes e confirme que cada canal tem produtos/config separada.
4. Confirme que o `configds` novo abre vazio, aplique o preset TFT, publique o painel e abra um carrinho como cliente.
5. Clique em **Editar compra**, confira as perguntas, publique a mensagem e teste o botao **Comprar**.
6. Use **Remover produto**, selecione mais de um item e confirme a remocao.
7. Use `/setup-atendimento`, configure Pix com `/configpix` e fique ON.
8. Abra outro carrinho e confirme se o Pix vai automaticamente quando houver um unico ADM ON.
9. Adicione uma caixa surpresa, compre e finalize como ADM para verificar o sorteio.
10. Use `/status-loja` no canal desejado para conferir o resumo daquele painel.
