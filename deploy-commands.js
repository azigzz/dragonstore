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
    .setName("configds")
    .setDescription("Abre o configurador visual da loja."),
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
    .setName("status-loja")
    .setDescription("Mostra a configuracao atual da loja."),
  new SlashCommandBuilder()
    .setName("ranking-gastos")
    .setDescription("Mostra o ranking de clientes por valor gasto.")
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
