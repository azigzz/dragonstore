# Dragon Store 2.5.0

Release de estabilizacao e qualidade de operacao.

## Compatibilidade

- Nenhuma configuracao existente e migrada, apagada ou substituida automaticamente.
- IDs antigos continuam validos na instancia `primary`.
- O setup automatico so roda apos comando do dono/CEO e confirmacao por botao.
- Produtos, Pix, pedidos, vendas, rankings e paineis publicados existentes sao preservados.

## Melhorias

- `/setup-loja` e `!setup-loja` criam apenas cargos, categorias e canais ausentes.
- Setup idempotente: pode ser executado novamente sem duplicar a estrutura gerenciada.
- Sessao de configuracao, addcar, uploads e restauracao usam limpeza central de memoria.
- `/diagnostico` mostra o estado temporario do processo.
- Erros de interacao sao registrados sem URL/token de callback.
- Interacoes expiradas ou ja respondidas deixam de gerar uma segunda falha.
- Restauracao completa gera arquivo com detalhes de falhas nao criticas.
- Testes permanentes cobrem clone/restauracao e idempotencia do setup.

## Validacao

```bash
npm run check
npm test
```
