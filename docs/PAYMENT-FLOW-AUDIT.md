# Auditoria funcional do fluxo de pagamentos

Data: 19/07/2026

Esta revisao avaliou o bot como dono da loja e como cliente. O sistema de
auditoria existente nao foi reformulado, expandido ou substituido.

## Critico

- **Comprovante confiava no tipo visual do Discord.** Um arquivo renomeado
  podia passar por uma checagem superficial. Corrigido com validacao conjunta
  de MIME, extensao, tamanho e assinatura real de PNG, JPEG, WEBP ou PDF.
- **Aprovacao e entrega podiam ficar confusas em cliques concorrentes.**
  Mantidas as travas existentes e a atualizacao condicional no Postgres; o novo
  fluxo manual so libera aprovacao depois do estado de analise.

## Alto

- **PIX manual tinha prazo curto.** Corrigido. Ele agora termina apenas por
  pagamento, cancelamento ou 16 horas sem atividade humana.
- **Carrinhos e tickets abandonados sobreviviam a reinicios.** Corrigido com
  `lastInteractionAt` persistido, recuperacao de registros antigos e varredura
  periodica.
- **Metodo de pagamento nao era uma escolha clara.** Corrigido com opcoes
  explicitas. O automatico fica indisponivel abaixo de R$ 1,00.
- **Falha do ntfy podia deixar o operador sem contexto.** O comprovante continua
  no Discord, o carrinho nao e aprovado e um atendente pode repetir o envio.

## Medio

- **Assumir uma compra exigia PIX do atendente mesmo no automatico.** Corrigido.
- **Comprovante de outra pessoa podia ser confundido com o do cliente.**
  Corrigido: somente anexos do dono do carrinho sao considerados.
- **Reenvios podiam gerar notificacoes repetidas.** Corrigido com estado
  persistente por carrinho, cooldown por usuario e chave separada para Mercado
  Pago.
- **Registro legado sem `guildId` ou atividade podia ficar preso.** Corrigido
  com migracao em memoria e busca limitada das mensagens humanas mais recentes.
- **Um registro defeituoso podia interromper uma rodada de limpeza.** Corrigido
  com isolamento de erro por carrinho e por ticket.

## Baixo

- Mensagens de comprovante mencionavam apenas print/imagem. Agora informam
  imagem ou PDF e apresentam formatos/limite quando a validacao falha.
- Botoes manuais permaneciam disponiveis fora de ordem. Agora refletem o estado
  do pedido e ficam desabilitados depois da notificacao.

## Recomendacoes

- Manter uma unica instancia ativa do bot. Para escalar horizontalmente, criar
  uma trava distribuida tambem para o envio manual ao ntfy.
- Usar topico ntfy protegido ou servidor proprio, com politica de retencao
  adequada para comprovantes.
- Monitorar tecnicamente falhas repetidas de Discord CDN, ntfy e webhooks sem
  registrar CPF, arquivos ou credenciais.
- Fazer um teste de ponta a ponta em servidor de homologacao depois do deploy:
  cliente, atendente, Mercado Pago Sandbox, ntfy no celular e reinicio do bot.
