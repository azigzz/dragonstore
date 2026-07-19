# Auditoria de experiencia: comprador e administrador

Data: 19/07/2026

Esta auditoria separa testes automatizados, verificacao estrutural do fluxo e
testes reais externos. O sistema de auditoria do bot nao foi substituido,
expandido nem teve seus canais ou formatos de registro alterados.

## Legenda

- `AUTOMATIZADO`: comportamento executado pela suite local.
- `ESTRUTURAL`: protecao confirmada no fluxo de producao por teste de regressao
  sobre os pontos de entrada, estados, travas e persistencia.
- `REAL EXTERNO`: requisicao enviada a um servico real sem dados pessoais.
- `PENDENTE DISCORD`: exige cliques em um servidor de homologacao.

## Resultado como comprador

- A escolha entre Pix automatico e manual informa valor, provedor, necessidade
  de CPF/CNPJ e envio de imagem/PDF.
- Nome, e-mail e documento sao solicitados em modal privado e nao aparecem no
  canal.
- Pedidos abaixo de R$ 1,00 deixam somente o Pix manual disponivel.
- O carrinho principal possui adicionar produto, pagamento e cancelamento; a
  confirmacao do comprovante fica diretamente abaixo da mensagem Pix.
- PNG, JPEG, WEBP e PDF sao aceitos. Arquivo falso, grande, incompativel ou de
  outro usuario e recusado.
- O comprovante mais recente sempre prevalece, inclusive quando e invalido.
- Clique repetido nao aprova a compra e nao cria uma segunda notificacao.
- Falha do ntfy preserva o comprovante para analise e permite nova tentativa.
- Falha ambigua da API preserva referencia e idempotencia. O cliente recebe
  **Tentar pagamento**, que reutiliza a mesma tentativa em vez de criar outra.
- Cancelamento permanece disponivel enquanto o pagamento nao foi confirmado.
- Carrinho manual inativo e encerrado depois de 16 horas por rotina persistente.

## Resultado como administrador

- A notificacao ntfy inclui pedido, produtos, total, cliente, horario e link
  direto do carrinho.
- Pagamento manual exige pessoa autorizada e bloqueia autoaprovacao do comprador.
- Trava local e atualizacao condicional no Postgres impedem duas aprovacoes ou
  finalizacoes simultaneas.
- Webhook automatico consulta a API oficial, valida pagamento, referencia e
  valor antes de entregar.
- Pedido cancelado, entregue ou em processamento nao e entregue novamente.
- Estoque automatico usa reserva transacional e a entrega pendente reutiliza a
  mesma reserva pelo botao **Entregar**.
- Recusa libera a reserva e exige comprovante novo antes de voltar para analise.
- Reinicio recupera atividade, carrinhos abertos, mensagem Pix e controles.
- Exclusao de canal ausente e tratada como operacao idempotente.

## Problemas encontrados

### Critico

- O comprovante mais novo invalido podia fazer o bot reutilizar um comprovante
  antigo valido. Corrigido: o arquivo mais recente agora e validado e o erro e
  mostrado ao cliente.

### Alto

- Timeout ou falha de rede ao criar Pix apagava a chave de idempotencia. Uma
  cobranca criada pelo provedor podia ficar sem vinculo. Corrigido: falhas
  ambiguas preservam estado, reserva, referencia e idempotencia para recuperacao.
- A prioridade manual `urgent` nao e valida no ntfy. Corrigido para `max`.

### Medio

- A confirmacao manual aparecia no resumo do carrinho, distante do Pix.
  Corrigido: agora fica abaixo da mensagem de pagamento.
- O painel principal tinha acoes repetidas e raras. Foram removidos Assumir,
  Enviar comprovante, Novo comprovante, Reenviar entrega e Chamar ADM.
- Ao remover Reenviar entrega, uma falha de DM poderia ficar sem recuperacao.
  Corrigido: **Entregar** tambem tenta novamente sem consumir outro item.

### Baixo

- Os controles administrativos continuam visiveis ao comprador porque os
  componentes pertencem a uma mensagem compartilhada. Cliques sem permissao
  sao recusados. Esconder completamente exigiria um painel separado da equipe.
- Topico publico do ntfy pode expor comprovantes para quem descobrir o nome.
  Em producao, use topico protegido ou servidor ntfy privado.
- Uma tentativa automatica ambigua que expirar sem obter ID deve ser cancelada
  antes de iniciar outro carrinho. Isso evita duas cobrancas concorrentes.

## Matriz dos 30 cenarios

| # | Cenario | Cobertura | Resultado |
|---|---|---|---|
| 1 | Automatico acima de R$ 1,00 | AUTOMATIZADO | Passou |
| 2 | Manual acima de R$ 1,00 | AUTOMATIZADO | Passou |
| 3 | Abaixo de R$ 1,00 somente manual | AUTOMATIZADO | Passou |
| 4 | CPF invalido | AUTOMATIZADO | Passou |
| 5 | Falha ao criar Pix automatico | AUTOMATIZADO + ESTRUTURAL | Passou |
| 6 | Webhook Mercado Pago valido | AUTOMATIZADO + ESTRUTURAL | Passou |
| 7 | Webhook duplicado | ESTRUTURAL | Protegido por estado, chave e trava |
| 8 | Webhook invalido ou sem assinatura | AUTOMATIZADO + ESTRUTURAL | Passou |
| 9 | Comprovante com imagem valida | AUTOMATIZADO | Passou |
| 10 | Comprovante ausente | AUTOMATIZADO | Passou |
| 11 | Arquivo nao permitido | AUTOMATIZADO | Passou |
| 12 | Cliente clica duas vezes | AUTOMATIZADO + ESTRUTURAL | Bloqueado |
| 13 | Segundo clique no mesmo carrinho | AUTOMATIZADO | Bloqueado |
| 14 | Mesmo usuario em outro carrinho antes de 5 min | AUTOMATIZADO | Bloqueado |
| 15 | Nova tentativa depois de 5 min | AUTOMATIZADO | Liberada |
| 16 | Administrador aprova manual | ESTRUTURAL | Permitido |
| 17 | Usuario comum tenta aprovar | AUTOMATIZADO + ESTRUTURAL | Bloqueado |
| 18 | Dois administradores simultaneos | ESTRUTURAL | Trava unica |
| 19 | Reinicio com carrinho aberto | ESTRUTURAL | Recuperado no boot |
| 20 | Registro antigo sem atividade | AUTOMATIZADO + ESTRUTURAL | Migrado |
| 21 | Inatividade de 15h59 | AUTOMATIZADO | Continua aberto |
| 22 | Inatividade de 16h ou mais | AUTOMATIZADO + ESTRUTURAL | Expira |
| 23 | Mensagem humana renova prazo | AUTOMATIZADO | Passou |
| 24 | Mensagem do bot nao renova prazo | ESTRUTURAL | Ignorada |
| 25 | Produto entregue uma vez | ESTRUTURAL | Idempotente |
| 26 | Estoque reduzido uma vez | AUTOMATIZADO + ESTRUTURAL | Passou |
| 27 | Falha temporaria do ntfy | AUTOMATIZADO | Comprovante preservado |
| 28 | Canal ja apagado na limpeza | ESTRUTURAL | Ignorado sem quebrar rotina |
| 29 | Pedido cancelado nao processado | ESTRUTURAL | Bloqueado |
| 30 | Automatico fora do rate limit manual | AUTOMATIZADO | Passou |

## Matriz dos comprovantes

| Cenario | Cobertura | Resultado |
|---|---|---|
| PNG valido | AUTOMATIZADO | Passou |
| JPEG valido | AUTOMATIZADO | Passou |
| WEBP valido | AUTOMATIZADO | Passou |
| PDF valido | AUTOMATIZADO + REAL EXTERNO | Passou |
| `.pdf` com conteudo falso | AUTOMATIZADO | Recusado |
| PDF acima do limite | AUTOMATIZADO | Recusado |
| Imagem acima do limite | AUTOMATIZADO | Recusada |
| Anexo enviado por outra pessoa | AUTOMATIZADO | Ignorado |
| Mais de um comprovante | AUTOMATIZADO | Mais recente selecionado |
| Falha ao baixar do Discord | AUTOMATIZADO | Erro controlado |
| Falha ao encaminhar ao ntfy | AUTOMATIZADO | Pedido preservado |
| Remocao de arquivos temporarios | AUTOMATIZADO | Passou em sucesso e erro |

## Testes externos

- Texto real enviado ao `ntfy.sh`: HTTP 200 e evento recuperado.
- PDF real de teste enviado ao `ntfy.sh`: HTTP 200, evento recuperado e anexo
  preservado com o nome esperado.
- Nenhum CPF, token, chave Pix ou comprovante real foi usado.

## Pendente no Discord

A tentativa de inspecionar a janela aberta do Discord falhou no ambiente de
automacao com `SetIsBorderRequired failed: Nao ha suporte para esta interface
(0x80004002)`. Por seguranca, nenhum clique ou mensagem foi enviado sem
visibilidade. Permanecem pendentes em servidor de homologacao:

1. Criar um carrinho real como comprador.
2. Gerar Pix manual e confirmar um comprovante de teste.
3. Aprovar, recusar, substituir comprovante e finalizar como administrador.
4. Confirmar visualmente permissoes, DMs, cargos, exclusao e atualizacao dos
   componentes depois do deploy.
