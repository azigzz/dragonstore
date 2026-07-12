# Dragon/Savio Store 2.7.0

## Carrinho limpo

- Uma unica mensagem resume itens, total e andamento da compra.
- Alteracoes de produto, pagamento, comprovante e entrega atualizam essa mensagem.
- Checklist, embeds duplicados e seletor publico de produtos foram removidos.

## Produtos privados

- `/addproduto` e o botao **Adicionar produto** abrem pesquisa e quantidade somente para o cliente.
- O catalogo pesquisado inclui os produtos de todos os paineis da instancia atual.
- `/addcar` continua disponivel como alias compativel.

## Encerramento

- Ao finalizar, o cliente recebe por DM o resumo e o historico do chat em arquivo TXT.
- Carrinhos finalizados sao apagados em 1h30 por padrao, inclusive apos reinicio.
- Carrinhos cancelados continuam sendo apagados em instantes.
- O Pix vai primeiro por DM e so aparece no canal quando a DM estiver bloqueada.
