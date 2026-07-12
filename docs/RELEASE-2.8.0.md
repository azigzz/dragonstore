# Release 2.8.0

## Criacao rapida de paineis

- Novo comando privado `/configds2` para criar ou atualizar o painel do canal por template.
- Formato recomendado com marcadores `&T`, `&D`, `&P` e `&C`.
- Compatibilidade com o formato curto `.titulo`, `.descricao`, `..produto - preco + descricao` e `,#cor`.
- Modos `substituir`, `adicionar` e `mesclar` para controlar os produtos existentes.
- Apos importar, o configurador visual privado abre automaticamente para revisao e publicacao.
- Validacao por linha, cor hexadecimal e limite de 25 produtos por painel.
