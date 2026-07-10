# Segunda loja isolada

A configuracao recomendada e manter o mesmo repositorio, mas executar uma instalacao separada por loja.
Cada loja deve ter seu proprio bot, servico no Render, banco e credenciais de pagamento.

## O que criar

1. No Discord Developer Portal, crie outra Application e outro Bot.
2. No Discord, use um Server Template da loja atual para copiar canais, cargos e permissoes. Os IDs da copia serao novos.
3. No Render, crie outro Web Service apontando para este mesmo repositorio.
4. Crie outro Postgres, ou use o mesmo Postgres somente com um `STORE_INSTANCE_ID` e `BOT_DB_PREFIX` exclusivos.
5. Registre os comandos da segunda aplicacao com `npm run deploy` usando o `CLIENT_ID`, `DISCORD_TOKEN` e `GUILD_ID` novos.
6. Se a loja nova tiver site, crie outro projeto na Vercel e aponte `BOT_PUBLIC_STORE_API_URL` para o Render novo, usando o mesmo `PUBLIC_STORE_API_TOKEN` somente entre esse par bot/site.

Usar outro banco e a opcao mais segura para separar dinheiro, pedidos e clientes. O prefixo por instancia e uma segunda barreira, nao substitui backups e credenciais separadas.

## Variaveis essenciais da loja nova

```env
STORE_INSTANCE_ID=savio-store
STRICT_GUILD_ISOLATION=true
CEO_USER_ID=seu_id_do_discord
DISCORD_TOKEN=token_do_bot_novo
CLIENT_ID=client_id_do_bot_novo
CLIENT_SECRET=secret_do_bot_novo
GUILD_ID=id_do_servidor_novo
MAIN_GUILD_ID=id_do_servidor_novo
DATABASE_URL=postgres_da_loja_nova
REDIRECT_URI=https://servico-novo.onrender.com/auth/discord/callback
PUBLIC_STORE_API_TOKEN=token_publico_exclusivo_da_loja_nova
```

Nao reutilize entre as lojas:

- `DISCORD_TOKEN`, `CLIENT_SECRET` ou tokens OAuth;
- `DATABASE_URL`, KV ou credenciais de pagamento;
- `PUBLIC_STORE_API_TOKEN`;
- URL de callback OAuth ou servico no Render;
- credenciais futuras do Mercado Pago.

As variaveis de IDs de cargos/categorias podem ser preenchidas no Render ou pelo `/configserver` dentro do novo servidor.

## Copiar catalogo sem copiar dados privados

1. Na loja principal, use `/exportarloja` ou `!exportarloja`.
2. Baixe o JSON enviado pelo bot.
3. Na loja nova, entre no canal que deve receber o primeiro painel.
4. Use `/importarloja arquivo:catalogo.json painel:1`.
5. Repita em cada canal, escolhendo o numero ou titulo do painel desejado.
6. Abra `/configds` no canal, revise e publique.

O arquivo leva apenas o visual do painel, perguntas de compra, produtos, precos, estoque, imagens e sorteios. Ele nao leva Pix, equipe, clientes, ranking, pedidos, carrinhos, vendas, tokens, IDs de canais ou mensagens publicadas.

## Clonar o servidor inteiro

Para copiar tambem cargos, categorias, canais, permissoes, emojis e paineis publicados:

1. Na loja principal, use `/backup` ou `!backup`.
2. Crie o servidor novo e convide a segunda instalacao do bot com `Administrador`.
3. Configure no Render novo o `GUILD_ID` do servidor novo e rode `npm run deploy`.
4. No servidor novo, envie o JSON usando `/restaurar` ou `!restaurar` e confirme no botao.
5. O bot cria um cargo `CEO` com Administrador e entrega ao dono/`CEO_USER_ID` que confirmou.

A restauracao nao apaga canais ou cargos existentes. Ela reaproveita itens compativeis e cria os ausentes, portanto pode ser executada novamente se uma falha de permissao interromper o processo.

O clone completo inclui a interface e o catalogo, mas nao copia historico de mensagens, membros, carrinhos temporarios, tickets em andamento, Pix, pedidos, vendas, clientes, tokens ou credenciais. As imagens incorporadas ao arquivo sao restauradas no canal privado `dragon-assets`.

## Mercado Pago

Integre o Mercado Pago somente no segundo servico. Use uma aplicacao e um webhook proprios da sua conta, com uma URL de callback do servico novo. Antes da integracao, defina como o pagamento deve ser associado ao pedido e qual evento confirma a venda; nunca finalize pela pagina de retorno do cliente, apenas por webhook validado e idempotente.

## Checklist antes de abrir

- Rode `/configserver` e configure cargo ADM, cargo cliente, premium, categorias, canais e call.
- Em servidor vazio, use `/setup-loja` para criar somente a estrutura que estiver faltando.
- Rode `/diagnostico` e corrija todos os alertas.
- Configure o Pix apenas dos ADMs da loja nova.
- Abra um carrinho de teste, pague, entregue, finalize e cancele outro.
- Confirme que ranking, feed de vendas e site mostram somente a loja nova.
- Confira no log se aparece a instancia `savio-store` e o `GUILD_ID` correto.
