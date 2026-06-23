require("dotenv").config();
const { ChannelType, REST, Routes, SlashCommandBuilder } = require("discord.js");

const token = process.env.DISCORD_TOKEN?.trim();
const clientId = process.env.CLIENT_ID?.trim();
const guildId = process.env.GUILD_ID?.trim();

if (!token || !clientId || !guildId) {
  console.error("Preencha DISCORD_TOKEN, CLIENT_ID e GUILD_ID.");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Mostra todos os comandos disponiveis do bot."),
  new SlashCommandBuilder()
    .setName("configds")
    .setDescription("Abre o configurador visual da loja."),
  new SlashCommandBuilder()
    .setName("configserver")
    .setDescription("Abre as configuracoes gerais do servidor."),
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
    .setName("pago")
    .setDescription("Marca o pagamento manual do carrinho atual."),
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

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    console.log("Limpando comandos globais antigos...");
    await rest.put(Routes.applicationCommands(clientId), { body: [] });

    console.log("Registrando comandos no servidor...");
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log("Comandos registrados.");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
