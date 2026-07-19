require("dotenv").config();
const { ChannelType, REST, Routes, SlashCommandBuilder } = require("discord.js");

const token = process.env.DISCORD_TOKEN?.trim();
const clientId = process.env.CLIENT_ID?.trim();
const guildId = process.env.GUILD_ID?.trim();

const commands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Mostra todos os comandos disponiveis do bot."),
  new SlashCommandBuilder()
    .setName("configds")
    .setDescription("Abre o configurador visual da loja."),
  new SlashCommandBuilder()
    .setName("configds2")
    .setDescription("Cria ou atualiza um painel rapidamente por template."),
  new SlashCommandBuilder()
    .setName("configserver")
    .setDescription("Abre as configuracoes gerais do servidor."),
  new SlashCommandBuilder()
    .setName("setup-loja")
    .setDescription("Cria somente os cargos e canais que faltam na loja."),
  new SlashCommandBuilder()
    .setName("backup")
    .setDescription("Gera um backup completo da estrutura e da loja."),
  new SlashCommandBuilder()
    .setName("restaurar")
    .setDescription("Restaura um backup completo neste servidor.")
    .addAttachmentOption(option =>
      option
        .setName("arquivo")
        .setDescription("Arquivo JSON criado pelo comando backup.")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("exportarloja")
    .setDescription("Exporta paineis e produtos sem dados privados."),
  new SlashCommandBuilder()
    .setName("importarloja")
    .setDescription("Importa um painel exportado para este canal.")
    .addAttachmentOption(option =>
      option
        .setName("arquivo")
        .setDescription("Arquivo JSON criado pelo comando exportarloja.")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("painel")
        .setDescription("Numero ou titulo do painel dentro do arquivo.")
        .setMaxLength(100)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("setup-ticket")
    .setDescription("Envia o painel de ticket no canal configurado."),
  new SlashCommandBuilder()
    .setName("setup-atendimento")
    .setDescription("Cria/atualiza o painel ON/OFF dos ADMs e recebedores Pix."),
  new SlashCommandBuilder()
    .setName("setupsucess")
    .setDescription("Define este canal como feed de vendas concluidas.")
    .addBooleanOption(option =>
      option
        .setName("ativo")
        .setDescription("Ativa ou desativa o envio de vendas concluidas neste canal.")
        .setRequired(false)
    )
    .addRoleOption(option =>
      option
        .setName("cargo-cliente")
        .setDescription("Cargo que o cliente recebe quando a compra for finalizada.")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("setupfaturamento")
    .setDescription("Configura o painel privado de faturamento real da loja.")
    .addChannelOption(option =>
      option
        .setName("canal")
        .setDescription("Canal privado que recebera o painel.")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)
    )
    .addBooleanOption(option =>
      option
        .setName("mostrar-lista")
        .setDescription("Mostra as 10 vendas mais recentes no painel.")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("faturamento")
    .setDescription("Mostra um resumo privado do faturamento da loja."),
  new SlashCommandBuilder()
    .setName("pedido")
    .setDescription("Consulta um pedido criado no site da loja.")
    .addStringOption(option =>
      option
        .setName("codigo")
        .setDescription("Codigo no formato SS-XXXXX-XXXX.")
        .setMaxLength(40)
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("avaliacao")
    .setDescription("Finaliza o carrinho e pede avaliacao ao cliente.")
    .addChannelOption(option =>
      option
        .setName("canal")
        .setDescription("Canal onde o cliente deve deixar a avaliacao.")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName("mensagem")
        .setDescription("Mensagem personalizada. Use {channel} para mencionar o canal.")
        .setMaxLength(1000)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("configpix")
    .setDescription("Configura seu nome, chave Pix e QR Code para assumir compras."),
  new SlashCommandBuilder()
    .setName("togglepagbank")
    .setDescription("Alterna entre Pix automatico PagBank e Pix manual antigo."),
  new SlashCommandBuilder()
    .setName("configpagamento")
    .setDescription("Escolhe o provedor de pagamento automatico da loja.")
    .addStringOption(option => option.setName("provedor").setDescription("Provedor para novos pagamentos.").setRequired(true)
      .addChoices({ name: "Mercado Pago", value: "mercadopago" }, { name: "PagBank", value: "pagbank" }, { name: "Pix manual", value: "manual" })),
  new SlashCommandBuilder()
    .setName("salvarpix")
    .setDescription("Salva/atualiza o backup do Pix e painel de atendimento no Discord."),
  new SlashCommandBuilder()
    .setName("caixapix")
    .setDescription("Sorteia Caixas Pix usando o preset padrao.")
    .addIntegerOption(option =>
      option
        .setName("quantidade")
        .setDescription("Quantidade de caixas para sortear.")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true)
    )
    .addUserOption(option =>
      option
        .setName("cliente")
        .setDescription("Cliente para marcar no resultado, opcional.")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("carrinho")
    .setDescription("Abre um carrinho privado para um cliente.")
    .addUserOption(option =>
      option
        .setName("cliente")
        .setDescription("Cliente que vai receber o carrinho.")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("lock")
    .setDescription("Trava o chat atual para o cliente ou para @everyone."),
  new SlashCommandBuilder()
    .setName("unlock")
    .setDescription("Libera o chat atual para o cliente ou para @everyone."),
  new SlashCommandBuilder()
    .setName("status-loja")
    .setDescription("Mostra a configuracao atual da loja."),
  new SlashCommandBuilder()
    .setName("pedidos")
    .setDescription("Lista os pedidos abertos para a equipe."),
  new SlashCommandBuilder()
    .setName("diagnostico")
    .setDescription("Mostra saude do bot, KV, Pix, paineis e carrinhos."),
  new SlashCommandBuilder()
    .setName("testntfy")
    .setDescription("Envia uma notificacao de teste para o ntfy configurado."),
  new SlashCommandBuilder()
    .setName("reconciliarpagbank")
    .setDescription("Consulta e processa um pedido PagBank pago.")
    .addStringOption(option =>
      option
        .setName("order_id")
        .setDescription("ID PagBank no formato ORDE_...")
        .setMinLength(15)
        .setMaxLength(90)
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("reconciliarmercadopago")
    .setDescription("Consulta e processa um Pix Mercado Pago.")
    .addStringOption(option => option.setName("payment_id").setDescription("ID numerico do pagamento.").setRequired(true).setMinLength(5).setMaxLength(30)),
  new SlashCommandBuilder()
    .setName("pago")
    .setDescription("Aprova Pix manual ou consulta o provedor do carrinho atual."),
  new SlashCommandBuilder()
    .setName("verificarpagamento")
    .setDescription("Consulta o status oficial do Pix automatico deste carrinho."),
  new SlashCommandBuilder()
    .setName("entregar")
    .setDescription("Entrega manualmente o produto no carrinho atual."),
  new SlashCommandBuilder()
    .setName("addcar")
    .setDescription("Adiciona um produto ao carrinho atual com pesquisa e quantidade.")
    .addStringOption(option =>
      option
        .setName("pesquisa")
        .setDescription("Filtro opcional para abrir a lista ja pesquisada.")
        .setMaxLength(100)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("addproduto")
    .setDescription("Pesquisa e adiciona produtos ao seu carrinho de forma privada.")
    .addStringOption(option =>
      option
        .setName("pesquisa")
        .setDescription("Nome ou palavra-chave do produto, opcional.")
        .setMaxLength(100)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("ranking-gastos")
    .setDescription("Mostra o ranking de clientes por valor gasto."),
  new SlashCommandBuilder()
    .setName("rankinggastos")
    .setDescription("Mostra o top 10 publico de membros que mais gastaram."),
  new SlashCommandBuilder()
    .setName("saldogasto")
    .setDescription("Mostra seu saldo gasto na loja.")
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("ADM pode consultar outro usuario.")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("vendas")
    .setDescription("Mostra o saldo de vendas por ADM."),
  new SlashCommandBuilder()
    .setName("vendasreset")
    .setDescription("Reseta o saldo de vendas dos ADMs.")
    .addUserOption(option =>
      option
        .setName("vendedor")
        .setDescription("Opcional: reseta apenas um ADM.")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("gastos-add")
    .setDescription("Adiciona saldo gasto manualmente para um cliente.")
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Cliente que vai receber saldo.")
        .setRequired(true)
    )
    .addNumberOption(option =>
      option
        .setName("valor")
        .setDescription("Valor em reais.")
        .setMinValue(0.01)
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("motivo")
        .setDescription("Motivo do ajuste.")
        .setMaxLength(200)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("gastos-remover")
    .setDescription("Remove saldo gasto manualmente de um cliente.")
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Cliente que vai perder saldo.")
        .setRequired(true)
    )
    .addNumberOption(option =>
      option
        .setName("valor")
        .setDescription("Valor em reais.")
        .setMinValue(0.01)
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("motivo")
        .setDescription("Motivo do ajuste.")
        .setMaxLength(200)
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("gastos-reset")
    .setDescription("Remove um cliente do ranking de gastos.")
    .addUserOption(option =>
      option
        .setName("usuario")
        .setDescription("Cliente que sera removido do ranking.")
        .setRequired(true)
    )
].map(command => command.toJSON());

async function deployCommands() {
  if (!token || !clientId || !guildId) {
    throw new Error("Preencha DISCORD_TOKEN, CLIENT_ID e GUILD_ID.");
  }
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    console.log("Limpando comandos globais antigos...");
    await rest.put(Routes.applicationCommands(clientId), { body: [] });

    console.log("Registrando comandos no servidor...");
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log("Comandos registrados.");
  } catch (err) {
    console.error("Falha ao registrar comandos:", {
      message: String(err?.message || err).slice(0, 500),
      code: err?.code,
      status: err?.status
    });
    process.exit(1);
  }
}

if (require.main === module) deployCommands();

module.exports = { commands, deployCommands };
