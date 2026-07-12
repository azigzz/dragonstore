# Auditoria de seguranca 3.0.0

## Corrigido

- Preco e metodo de pagamento deixaram de depender de dados da interacao.
- Pagamento manual nao pode ser aprovado por administrador fora de `BOT_OWNER_IDS`.
- Webhook falso, metodo nao Pix, valor divergente e referencia divergente sao rejeitados.
- Aprovacao, recusa, webhook e finalizacao possuem travas idempotentes; no Postgres, transicoes criticas usam update condicional.
- Estoque automatico nao usa JSON, memoria global ou disco do Render.
- Conteudo de estoque nao entra em logs, erros, IDs de componentes, exports ou endpoints publicos.
- Entrega tenta DM primeiro e so usa ticket com `@everyone` sem `ViewChannel` e cliente autorizado.
- Falha de entrega preserva a mesma reserva e cria estado `PAID_DELIVERY_PENDING`.
- Cancelamento e expiracao liberam somente reservas daquele pedido.
- Campos sensiveis sao removidos do payload de auditoria.
- Nenhum token ou chave real foi adicionado ao repositorio.

## Compatibilidade e risco residual

- Pedidos antigos continuam no fluxo legado; somente carrinhos com `paymentFlowVersion: 2` exigem a nova maquina de pagamento.
- Entregas manuais antigas continuam armazenadas no formato historico do pedido. O cofre criptografado cobre todo estoque automatico novo.
- OAuth2 e o site permanecem fora da maquina transacional de estoque e pagamento; nenhum endpoint publico recebeu acesso ao cofre.
