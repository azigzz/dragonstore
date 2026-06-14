require("dotenv").config();

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const config = require("../config.json");

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot online");
}).listen(PORT, () => console.log(`Health server rodando na porta ${PORT}`));

const DATA_DIR = path.join(__dirname, "..", "data");
const PANELS_FILE = path.join(DATA_DIR, "panels.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const STAFF_FILE = path.join(DATA_DIR, "staff.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PANELS_FILE)) fs.writeFileSync(PANELS_FILE, JSON.stringify({ guilds: {} }, null, 2));
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, JSON.stringify({ orders: {}, tickets: {} }, null, 2));
if (!fs.existsSync(STAFF_FILE)) fs.writeFileSync(STAFF_FILE, JSON.stringify({ guilds: {} }, null, 2));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const sessions = new Map();
const imageUploads = new Map();
const IMAGE_UPLOAD_TTL_MS = 3 * 60 * 1000;
const MAX_SAVED_IMAGE_BYTES = 8 * 1024 * 1024;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function writeJson(file, data) {
  const tmpFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, file);
}
function readPanels() { return readJson(PANELS_FILE, { guilds: {} }); }
function writePanels(data) { writeJson(PANELS_FILE, data); }
function readOrders() { return readJson(ORDERS_FILE, { orders: {}, tickets: {} }); }
function writeOrders(data) { writeJson(ORDERS_FILE, data); }
function readStaff() { return readJson(STAFF_FILE, { guilds: {} }); }
function writeStaff(data) { writeJson(STAFF_FILE, data); }
function defaultStaffGuild() {
  return {
    users: {},
    panelChannelId: "",
    panelMessageId: ""
  };
}
function getStaffGuild(guildId) {
  const db = readStaff();
  if (!db.guilds[guildId]) {
    db.guilds[guildId] = defaultStaffGuild();
    writeStaff(db);
  }
  return db.guilds[guildId];
}
function saveStaffGuild(guildId, staffGuild) {
  const db = readStaff();
  db.guilds[guildId] = staffGuild;
  writeStaff(db);
}
function getStaffProfile(guildId, userId) {
  const staff = getStaffGuild(guildId);
  return staff.users[userId] || null;
}
function saveStaffProfile(guildId, userId, profilePatch) {
  const staff = getStaffGuild(guildId);
  const old = staff.users[userId] || {};
  staff.users[userId] = {
    userId,
    displayName: old.displayName || "",
    pixKey: old.pixKey || "",
    qrCodeUrl: old.qrCodeUrl || "",
    note: old.note || "",
    online: Boolean(old.online),
    updatedAt: old.updatedAt || new Date().toISOString(),
    ...profilePatch,
    updatedAt: new Date().toISOString()
  };
  saveStaffGuild(guildId, staff);
  return staff.users[userId];
}
function configuredStaffProfiles(guildId) {
  const staff = getStaffGuild(guildId);
  return Object.values(staff.users || {}).filter(p => p.pixKey || p.displayName);
}
function onlineStaffProfiles(guildId) {
  return configuredStaffProfiles(guildId).filter(p => p.online && p.pixKey);
}
function staffDisplayName(profile, fallbackUser) {
  return String(profile?.displayName || fallbackUser?.username || "ADM").trim() || "ADM";
}
function staffStatusEmoji(profile) {
  return profile?.online ? "🟢" : "⚫";
}

function random7() { return String(Math.floor(1000000 + Math.random() * 9000000)); }
function sid() { return Math.random().toString(36).slice(2, 9); }
function parseColor(hex, fallback = 0x9b00ff) {
  const clean = String(hex || "").replace("#", "");
  const n = Number.parseInt(clean, 16);
  return Number.isNaN(n) ? fallback : n;
}
function normColor(v) {
  const raw = String(v || "").trim();
  const c = raw.startsWith("#") ? raw : `#${raw}`;
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#9b00ff";
}
function validUrl(v) {
  const raw = String(v || "").trim();
  if (!raw) return true;
  try {
    const u = new URL(raw);
    return ["http:", "https:"].includes(u.protocol);
  } catch { return false; }
}
function imageUploadKey(guildId, channelId, userId) {
  return `${guildId}:${channelId}:${userId}`;
}
function isImageAttachment(attachment) {
  const type = String(attachment.contentType || "");
  const name = String(attachment.name || attachment.url || "");
  return type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(name);
}
function savedImageName(attachment) {
  const original = String(attachment.name || "imagem.png");
  const extension = original.match(/\.(png|jpe?g|webp|gif)$/i)?.[0]?.toLowerCase() || ".png";
  return `dragon-store-${random7()}${extension}`;
}
function imageUploadTargetLabel(pending, panel) {
  if (pending.target === "panelImage") return "banner do painel";
  if (pending.target === "panelThumb") return "thumbnail do painel";
  if (pending.target === "product") {
    const p = product(panel, pending.productId);
    return p ? `foto do produto ${p.name}` : "foto do produto";
  }
  return "imagem";
}
function safeName(text) {
  return String(text || "usuario")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 24) || "usuario";
}
function clampText(value, max, fallback = "") {
  const text = String(value || fallback).trim();
  return text.slice(0, max);
}
function parsePrice(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const onlyNumber = raw
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const amount = Number.parseFloat(onlyNumber);
  return Number.isFinite(amount) ? amount : null;
}
function money(value) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function isAdmin(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator) || member?.roles?.cache?.has(config.adminRoleId));
}
async function requireAdminInteraction(interaction, text = "Você precisa ser ADM para usar esse comando.") {
  if (isAdmin(interaction.member)) return true;
  await interaction.reply({ content: text, ephemeral: true });
  return false;
}

async function sendSafeDM(userId, payload) {
  try {
    const user = await client.users.fetch(userId);
    await user.send(payload);
    return true;
  } catch (error) {
    console.log(`Não consegui mandar DM para ${userId}: ${error.message}`);
    return false;
  }
}

function buildStaffPanelEmbed(guildId) {
  const staff = getStaffGuild(guildId);
  const profiles = Object.values(staff.users || {});

  const lines = profiles.length
    ? profiles
        .sort((a, b) => String(a.displayName || a.userId).localeCompare(String(b.displayName || b.userId)))
        .map(profile => {
          const pix = profile.pixKey ? "Pix configurado ✅" : "Pix faltando ⚠️";
          return `${staffStatusEmoji(profile)} **${profile.displayName || "ADM"}** — <@${profile.userId}> | ${pix}`;
        })
        .join("\n")
    : "Nenhum ADM configurou Pix ainda. Clique em **Configurar meu Pix**.";

  return new EmbedBuilder()
    .setTitle("🟢 Atendimento / Recebedores Pix")
    .setDescription(
      `Use esse painel para dizer quem está online para receber vendas.\n\n` +
      `Quando o cliente abrir carrinho:\n` +
      `• se só 1 ADM estiver ON, a compra vai automaticamente para ele;\n` +
      `• se 2 ou mais estiverem ON, fica para quem clicar em **Assumir compra** primeiro;\n` +
      `• só ADM consegue assumir.\n\n` +
      `**Status atual:**\n${lines}`
    )
    .setColor(0x2ecc71)
    .setFooter({ text: "Configure seu Pix antes de ficar online." })
    .setTimestamp();
}
function staffPanelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("staff:on").setLabel("Ficar ON").setEmoji("🟢").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("staff:off").setLabel("Ficar OFF").setEmoji("⚫").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("staff:config").setLabel("Configurar meu Pix").setEmoji("💸").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("staff:refresh").setLabel("Atualizar").setEmoji("♻️").setStyle(ButtonStyle.Secondary)
    )
  ];
}
function pixShortcutRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("staff:config")
        .setLabel("Configurar meu Pix")
        .setEmoji("💸")
        .setStyle(ButtonStyle.Primary)
    )
  ];
}
async function refreshStaffPanel(guildId) {
  const staff = getStaffGuild(guildId);
  if (!staff.panelChannelId || !staff.panelMessageId) return false;

  try {
    const guild = await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(staff.panelChannelId);
    if (!channel || !channel.isTextBased()) return false;
    const message = await channel.messages.fetch(staff.panelMessageId);
    await message.edit({ embeds: [buildStaffPanelEmbed(guildId)], components: staffPanelRows() });
    return true;
  } catch (error) {
    console.log("Não consegui atualizar painel de atendimento:", error.message);
    return false;
  }
}
async function setupStaffPanel(interactionOrMessage) {
  const guild = interactionOrMessage.guild;
  const channel = interactionOrMessage.channel;
  const member = interactionOrMessage.member;

  if (!isAdmin(member)) {
    const text = "Você precisa ser admin ou ter o cargo ADM configurado para criar esse painel.";
    if (interactionOrMessage.isRepliable?.()) return interactionOrMessage.reply({ content: text, ephemeral: true });
    return channel.send(text);
  }

  const staff = getStaffGuild(guild.id);
  let oldMessage = null;

  if (staff.panelChannelId && staff.panelMessageId) {
    const oldChannel = await guild.channels.fetch(staff.panelChannelId).catch(() => null);
    if (oldChannel?.isTextBased()) oldMessage = await oldChannel.messages.fetch(staff.panelMessageId).catch(() => null);
  }

  if (oldMessage) {
    await oldMessage.edit({ embeds: [buildStaffPanelEmbed(guild.id)], components: staffPanelRows() });
    if (interactionOrMessage.isRepliable?.()) {
      return interactionOrMessage.reply({ content: `Painel de atendimento atualizado em <#${staff.panelChannelId}>.`, ephemeral: true });
    }
    return channel.send(`Painel de atendimento atualizado em <#${staff.panelChannelId}>.`);
  }

  const sent = await channel.send({ embeds: [buildStaffPanelEmbed(guild.id)], components: staffPanelRows() });
  staff.panelChannelId = channel.id;
  staff.panelMessageId = sent.id;
  saveStaffGuild(guild.id, staff);

  if (interactionOrMessage.isRepliable?.()) {
    return interactionOrMessage.reply({ content: `Painel de atendimento criado em <#${channel.id}>.`, ephemeral: true });
  }
}
function pixConfigModal(guildId, user) {
  const current = getStaffProfile(guildId, user.id) || {};

  return new ModalBuilder()
    .setCustomId("pixmodal")
    .setTitle("Configurar meu Pix")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("displayName")
          .setLabel("Nome que aparece na venda")
          .setPlaceholder("Ex: Sávio, Bruno")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50)
          .setRequired(true)
          .setValue(String(current.displayName || user.username).slice(0, 50))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("pixKey")
          .setLabel("Chave Pix")
          .setPlaceholder("CPF, email, telefone ou chave aleatória")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(180)
          .setRequired(true)
          .setValue(String(current.pixKey || "").slice(0, 180))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("qrCodeUrl")
          .setLabel("Link da imagem do QR Code, se tiver")
          .setPlaceholder("https://.../qrcode.png")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(500)
          .setRequired(false)
          .setValue(String(current.qrCodeUrl || "").slice(0, 500))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("note")
          .setLabel("Mensagem extra opcional")
          .setPlaceholder("Ex: Envie o comprovante aqui no carrinho.")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(700)
          .setRequired(false)
          .setValue(String(current.note || "Envie o comprovante aqui no carrinho.").slice(0, 700))
      )
    );
}
function buildPixEmbed(order, panel, profile) {
  const embed = new EmbedBuilder()
    .setTitle("💸 Pagamento Pix")
    .setDescription(
      `**Atendente:** ${profile.displayName || "ADM"} (<@${profile.userId}>)\n` +
      `**ID da compra:** \`${order.id}\`\n\n` +
      `**Total estimado:** ${totalLine(order, panel)}\n\n` +
      `**Chave Pix:**\n\`${profile.pixKey}\`\n\n` +
      `**Resumo:**\n${cartText(order, panel)}\n\n` +
      `${profile.note || "Envie o comprovante aqui no carrinho."}`
    )
    .setColor(parseColor(panel.color))
    .setTimestamp();

  if (profile.qrCodeUrl && validUrl(profile.qrCodeUrl)) embed.setImage(profile.qrCodeUrl);
  return embed;
}
function staffChoiceEmbed(order, guildId) {
  const online = onlineStaffProfiles(guildId);
  const onlineLine = online.length
    ? online.map(p => `🟢 **${p.displayName || "ADM"}** (<@${p.userId}>)`).join("\n")
    : "Nenhum ADM online. Um ADM ainda pode configurar Pix e assumir manualmente.";

  const assignedLine = order.assignedAdminId
    ? `✅ Assumido por **${order.assignedAdminName || "ADM"}** (<@${order.assignedAdminId}>).`
    : "⏳ Aguardando um ADM assumir.";

  return new EmbedBuilder()
    .setTitle("👥 Atendimento da compra")
    .setDescription(
      `${assignedLine}\n\n` +
      `**ADMs online:**\n${onlineLine}\n\n` +
      `Só quem tem cargo ADM pode clicar. Se tiver mais de um ON, fica para quem clicar primeiro.`
    )
    .setColor(order.assignedAdminId ? 0x2ecc71 : 0xf1c40f);
}
function staffChoiceRows(orderId, assigned = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`assume:${orderId}`).setLabel("Assumir compra").setEmoji("🙋").setStyle(ButtonStyle.Success).setDisabled(assigned),
      new ButtonBuilder().setCustomId(`sendpix:${orderId}`).setLabel("Reenviar Pix").setEmoji("💸").setStyle(ButtonStyle.Primary).setDisabled(!assigned)
    )
  ];
}
async function sendStaffChoiceMessage(channel, order, guildId) {
  const online = onlineStaffProfiles(guildId);
  const panel = getOrderPanel(order, guildId);

  if (online.length === 1 && !order.assignedAdminId) {
    const profile = online[0];
    const db = readOrders();
    const saved = db.orders[order.id];
    if (saved && !saved.assignedAdminId) {
      saved.assignedAdminId = profile.userId;
      saved.assignedAdminName = profile.displayName || "ADM";
      saved.assignedAt = new Date().toISOString();
      db.orders[order.id] = saved;
      writeOrders(db);
      order = saved;
    }

    await channel.send({
      content: `✅ Compra assumida automaticamente por **${profile.displayName || "ADM"}**, único ADM online.`,
      embeds: [buildPixEmbed(order, panel, profile)],
      components: staffChoiceRows(order.id, true)
    });

    await sendSafeDM(order.userId, {
      embeds: [buildPixEmbed(order, panel, profile)]
    });

    return;
  }

  await channel.send({ embeds: [staffChoiceEmbed(order, guildId)], components: staffChoiceRows(order.id, Boolean(order.assignedAdminId)) });
}
async function assumeOrder(interaction, id) {
  const db = readOrders();
  const order = db.orders[id];

  if (!order || order.status !== "open") {
    return interaction.reply({ content: "Carrinho fechado ou inexistente.", ephemeral: true });
  }

  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: "Só ADM pode assumir compra.", ephemeral: true });
  }

  if (order.assignedAdminId) {
    return interaction.reply({ content: `Essa compra já foi assumida por <@${order.assignedAdminId}>.`, ephemeral: true });
  }

  const profile = getStaffProfile(interaction.guildId, interaction.user.id);
  if (!profile?.pixKey) {
    return interaction.reply({ content: "Configure seu Pix primeiro com `!configpix`, `/configpix` ou no botão **Configurar meu Pix** do painel de atendimento.", ephemeral: true });
  }

  const online = onlineStaffProfiles(interaction.guildId);
  if (online.length > 0 && !profile.online) {
    return interaction.reply({ content: "Você está OFF. Clique em **Ficar ON** no painel de atendimento antes de assumir.", ephemeral: true });
  }

  order.assignedAdminId = interaction.user.id;
  order.assignedAdminName = profile.displayName || interaction.user.username;
  order.assignedAt = new Date().toISOString();
  db.orders[id] = order;
  writeOrders(db);

  const panel = getOrderPanel(order, interaction.guildId);

  await interaction.channel.send({
    content: `✅ Compra #${id} assumida por **${order.assignedAdminName}** (<@${interaction.user.id}>).`,
    embeds: [buildPixEmbed(order, panel, profile)],
    components: staffChoiceRows(id, true)
  });

  await sendSafeDM(order.userId, { embeds: [buildPixEmbed(order, panel, profile)] });

  return interaction.reply({ content: "Compra assumida e Pix enviado.", ephemeral: true });
}
async function resendPix(interaction, id) {
  const db = readOrders();
  const order = db.orders[id];

  if (!order || order.status !== "open") {
    return interaction.reply({ content: "Carrinho fechado ou inexistente.", ephemeral: true });
  }

  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: "Só ADM pode reenviar Pix.", ephemeral: true });
  }

  if (!order.assignedAdminId) {
    return interaction.reply({ content: "Essa compra ainda não foi assumida. Clique em **Assumir compra** primeiro.", ephemeral: true });
  }

  const profile = getStaffProfile(interaction.guildId, order.assignedAdminId);
  if (!profile?.pixKey) {
    return interaction.reply({ content: "O ADM responsável não tem Pix configurado mais.", ephemeral: true });
  }

  const panel = getOrderPanel(order, interaction.guildId);
  await interaction.channel.send({ embeds: [buildPixEmbed(order, panel, profile)] });
  await sendSafeDM(order.userId, { embeds: [buildPixEmbed(order, panel, profile)] });

  return interaction.reply({ content: "Pix reenviado.", ephemeral: true });
}
async function handleStaffButton(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: "Só ADM pode mexer nesse painel.", ephemeral: true });
  }

  const [, action] = interaction.customId.split(":");

  if (action === "config") {
    return interaction.showModal(pixConfigModal(interaction.guildId, interaction.user));
  }

  if (action === "on") {
    const profile = getStaffProfile(interaction.guildId, interaction.user.id);
    if (!profile?.pixKey) {
      return interaction.reply({ content: "Configure seu Pix antes de ficar ON.", ephemeral: true });
    }

    saveStaffProfile(interaction.guildId, interaction.user.id, { online: true });
    await refreshStaffPanel(interaction.guildId);
    return interaction.reply({ content: "Você está ON para receber vendas.", ephemeral: true });
  }

  if (action === "off") {
    saveStaffProfile(interaction.guildId, interaction.user.id, { online: false });
    await refreshStaffPanel(interaction.guildId);
    return interaction.reply({ content: "Você está OFF.", ephemeral: true });
  }

  if (action === "refresh") {
    await refreshStaffPanel(interaction.guildId);
    return interaction.reply({ content: "Painel atualizado.", ephemeral: true });
  }
}
async function handlePixModal(interaction) {
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: "Só ADM pode configurar Pix.", ephemeral: true });
  }

  const displayName = interaction.fields.getTextInputValue("displayName").trim();
  const pixKey = interaction.fields.getTextInputValue("pixKey").trim();
  const qrCodeUrl = interaction.fields.getTextInputValue("qrCodeUrl").trim();
  const note = interaction.fields.getTextInputValue("note").trim();

  if (qrCodeUrl && !validUrl(qrCodeUrl)) {
    return interaction.reply({ content: "Link de QR Code inválido. Use http/https ou deixe vazio.", ephemeral: true });
  }

  saveStaffProfile(interaction.guildId, interaction.user.id, {
    displayName,
    pixKey,
    qrCodeUrl,
    note,
    online: false
  });

  await refreshStaffPanel(interaction.guildId);

  return interaction.reply({ content: "Pix salvo. Agora clique em **Ficar ON** no painel quando estiver disponível.", ephemeral: true });
}
function defaultPanel(guildId, scopeId = "default") {
  return {
    id: scopeId === "default" ? "main" : `panel_${scopeId}`,
    guildId,
    scopeId,
    channelId: "",
    publishedChannelId: "",
    publishedMessageId: "",
    configMessageChannelId: "",
    configMessageId: "",
    title: "🐉 Dragon Store",
    color: "#9b00ff",
    imageUrl: "",
    thumbnailUrl: "",
    quickOrder: defaultQuickOrder(),
    description: `🛒 **Loja digital de packs prontos**\n\nEscolha o produto no menu abaixo e o bot abre um carrinho privado para atendimento.\n\n📦 **O que você encontra**\n\n🎥 **Packs de edição e cortes**\nConteúdo pronto para usar em reels, criativos e páginas de venda.\n\n💎 **Packs lifestyle premium**\nVídeos com estética de luxo, viagens, carros e rotina de alto padrão.\n\n🎁 **Caixa surpresa digital**\nBrindes digitais sorteados somente após a compra ser finalizada pelo ADM.\n\n✅ Atendimento manual\n✅ Pagamento via Pix do atendente\n✅ Entrega combinada no carrinho`,
    products: [
      { id: "p" + random7(), name: "250 Cortes de Filmes e Séries aleatórios", price: "R$ 1,00", description: "Conteúdo pronto para postar e reaproveitar", stock: "infinito" },
      { id: "p" + random7(), name: "Pack de 100 Vídeos Lifestyle Rico", price: "R$ 1,00", description: "Vídeos de alto padrão para conteúdo", stock: "infinito" },
      { id: "p" + random7(), name: "Pack de 20K Vídeos Lifestyle Rico", price: "R$ 5,00", description: "Pack grande para criativos e páginas", stock: "infinito" },
      { id: "p" + random7(), name: "Pack de Edição de Vídeo", price: "R$ 5,00", description: "Vídeos ideais para edições e reels", stock: "infinito" },
      {
        id: "p" + random7(),
        type: "mystery_box",
        name: "Caixa Surpresa de Packs",
        price: "R$ 0,10",
        description: "Sorteia um brinde digital aleatório após a compra ser finalizada",
        stock: "infinito",
        rewards: [
          { name: "Mini Pack de Cortes", description: "10 cortes aleatórios", weight: 70 },
          { name: "Pack Lifestyle Pequeno", description: "20 vídeos lifestyle", weight: 20 },
          { name: "Pack Premium de Edição", description: "Brinde premium de edição", weight: 8 },
          { name: "Pack Grande Surpresa", description: "Brinde raro de conteúdo digital", weight: 2 }
        ]
      }
    ],
    updatedAt: new Date().toISOString()
  };
}
const PRODUCT_PRESETS = {
  tft: {
    label: "TFT Sets",
    title: "Frosted TFT",
    color: "#22c7ff",
    description:
      "🛒 **Sets TFT prontos para compra**\n\nSelecione um set no menu abaixo para abrir um carrinho privado com a equipe.\n\nDepois informe seu nick e o set desejado no carrinho para agilizar o atendimento.",
    productDescription: "Set TFT com entrega combinada no carrinho.",
    items: [
      ["Set Party Balloons", "R$ 18,90"],
      ["Set Lovesick", "R$ 11,80"],
      ["Set Spooky Brew", "R$ 9,40"],
      ["Set Pumpkin Slice", "R$ 8,90"],
      ["Set Gothic Bouquet", "R$ 8,40"],
      ["Set Dragon Puppet", "R$ 3,80"],
      ["Set Lovely Heart", "R$ 3,40"],
      ["Set Cherry Blossom", "R$ 4,90"],
      ["Set Icecream Mix", "R$ 4,90"],
      ["Set Bleak Ink", "R$ 6,90"],
      ["Set Batwing", "R$ 4,40"],
      ["Set Classic", "R$ 5,90"],
      ["Set Psycho", "R$ 4,50"],
      ["Set Dark Bone", "R$ 4,50"],
      ["Set Hollow Scythe", "R$ 2,00"],
      ["Set Bleeding Heart", "R$ 2,00"],
      ["Qualquer Hunter (2 por 1)", "R$ 2,00"],
      ["Sets da descrição", "R$ 2,00"],
      ["Set Devilish", "R$ 9,40"],
      ["Set Lion Dance", "R$ 3,50"],
      ["Set Devilborn", "R$ 3,90"],
      ["Set Pegasus Blade", "R$ 3,48"]
    ]
  },
  steam: {
    label: "Steam Keys",
    title: "Steam Keys",
    color: "#5865f2",
    description:
      "🎮 **Steam Keys digitais**\n\nEscolha uma opção no menu abaixo para abrir um carrinho privado. O atendimento e a entrega são feitos pela equipe.",
    productDescription: "Steam key digital com entrega manual no carrinho.",
    items: [
      ["Steam Key Black Premium", "R$ 3,99"],
      ["Steam Key Ruby", "R$ 2,69"],
      ["3x Steam Keys Aleatórias", "R$ 2,00"]
    ]
  },
  smm: {
    label: "SMM",
    title: "Serviços SMM",
    color: "#19c37d",
    description:
      "📈 **Serviços para redes sociais**\n\nSelecione o serviço desejado no menu abaixo para abrir um carrinho privado com a equipe.",
    productDescription: "Serviço SMM com detalhes combinados no carrinho.",
    items: [
      ["1.000 Seguidores (Sem Garantia)", "R$ 2,00"],
      ["5.000 Seguidores (Sem Garantia)", "R$ 7,50"],
      ["10.000 Seguidores (Sem Garantia)", "R$ 14,00"],
      ["1.000 Curtidas Mundiais", "R$ 2,00"],
      ["5.000 Curtidas Mundiais", "R$ 3,00"],
      ["10.000 Curtidas Mundiais", "R$ 5,50"],
      ["1.000 Curtidas Brasileiras", "R$ 4,00"],
      ["5.000 Curtidas Brasileiras", "R$ 18,00"],
      ["10.000 Curtidas Brasileiras", "R$ 35,00"],
      ["1.000 Seguidores Mundiais (Garantia 30 Dias)", "R$ 4,90"],
      ["5.000 Seguidores Mundiais (Garantia 30 Dias)", "R$ 22,50"],
      ["10.000 Seguidores Mundiais (Garantia 30 Dias)", "R$ 43,90"],
      ["1.000 Seguidores Brasileiros", "R$ 8,90"],
      ["10.000 Visualizações", "R$ 2,00"],
      ["50.000 Visualizações", "R$ 2,50"],
      ["100.000 Visualizações", "R$ 4,00"]
    ]
  }
};
function defaultQuickOrder() {
  return {
    title: "Compre aqui",
    description:
      "🛒 **ESCOLHA UMA DAS OPÇÕES PARA SER ATENDIDO!**\n\n• **Comprar:** Compre sets e robux com o suporte da nossa equipe.\n• **Automático:** Compre sets e receba rápido via sistema automático.\n• **Combos:** Compre x-all, combos e sets via sistema automático.",
    buttonLabel: "Comprar",
    question1: "Nick no roblox",
    question2: "Nome do Set que você deseja comprar",
    publishedChannelId: "",
    publishedMessageId: ""
  };
}
function productsFromPreset(preset) {
  return preset.items.map(([name, price]) => ({
    id: "p" + random7(),
    name,
    price,
    description: preset.productDescription,
    stock: "infinito",
    imageUrl: ""
  }));
}
function applyProductPreset(panel, presetKey) {
  const preset = PRODUCT_PRESETS[presetKey];
  if (!preset) return false;

  panel.title = preset.title;
  panel.color = preset.color;
  panel.description = preset.description;
  panel.products = productsFromPreset(preset);
  const oldQuick = quickOrderConfig(panel);
  panel.quickOrder = {
    ...oldQuick,
    title: presetKey === "tft" ? "Compre aqui" : oldQuick.title,
    description: presetKey === "tft"
      ? "🛒 **ESCOLHA UMA DAS OPÇÕES PARA SER ATENDIDO!**\n\n• **Comprar:** Compre sets e robux com o suporte da nossa equipe.\n• **Automático:** Compre sets e receba rápido via sistema automático.\n• **Combos:** Compre x-all, combos e sets via sistema automático."
      : oldQuick.description,
    buttonLabel: oldQuick.buttonLabel,
    question1: oldQuick.question1,
    question2: oldQuick.question2
  };

  return true;
}
function ensurePanelStore(store, guildId) {
  if (!store.guilds[guildId]) store.guilds[guildId] = {};
  const guildStore = store.guilds[guildId];

  if (!guildStore.panels) guildStore.panels = {};

  if (guildStore.panel && !Object.keys(guildStore.panels).length) {
    const legacyScopeId = guildStore.panel.scopeId || guildStore.panel.configMessageChannelId || "default";
    guildStore.panel.scopeId = legacyScopeId;
    if (!guildStore.panel.id) guildStore.panel.id = legacyScopeId === "default" ? "main" : `panel_${legacyScopeId}`;
    guildStore.panels[legacyScopeId] = guildStore.panel;
  }

  return guildStore;
}
function getPanel(guildId, scopeId = "default") {
  const store = readPanels();
  const guildStore = ensurePanelStore(store, guildId);
  const key = String(scopeId || "default");

  if (!guildStore.panels[key]) {
    guildStore.panels[key] = defaultPanel(guildId, key);
    writePanels(store);
  }

  return guildStore.panels[key];
}
function savePanel(guildId, panel, scopeId = null) {
  const store = readPanels();
  const guildStore = ensurePanelStore(store, guildId);
  const key = String(scopeId || panel.scopeId || panel.configMessageChannelId || "default");
  panel.scopeId = key;
  if (!panel.id) panel.id = key === "default" ? "main" : `panel_${key}`;
  panel.updatedAt = new Date().toISOString();
  guildStore.panels[key] = panel;
  if (key === "default") guildStore.panel = panel;
  writePanels(store);
}
function getPanelById(guildId, panelId) {
  const store = readPanels();
  const guildStore = ensurePanelStore(store, guildId);
  const panels = Object.values(guildStore.panels || {});
  const found = panels.find(panel => panel.id === panelId);

  if (!found && guildStore.panel?.id === panelId) return guildStore.panel;
  return found || null;
}
function getOrderPanel(order, guildId) {
  return (order?.panelId && getPanelById(guildId, order.panelId)) ||
    getPanel(guildId, order?.panelScopeId || order?.scopeId || "default");
}
function product(panel, id) { return panel.products.find(p => p.id === id); }
function normalizeProductInput({ name, price, description, stock, imageUrl }) {
  const cleanImage = clampText(imageUrl, 500);
  return {
    name: clampText(name, 100, "Produto"),
    price: clampText(price, 50, "R$ 0,00"),
    description: clampText(description, 200, "Produto da loja"),
    stock: clampText(stock, 50, "infinito") || "infinito",
    imageUrl: cleanImage
  };
}
function orderItemFromProduct(p) {
  return {
    productId: p.id,
    quantity: 1,
    name: p.name,
    price: p.price,
    description: p.description || "",
    stock: p.stock || "infinito",
    type: p.type || "product",
    imageUrl: p.imageUrl || "",
    rewards: Array.isArray(p.rewards) ? p.rewards : undefined
  };
}
function orderItemDetails(item, panel) {
  const current = product(panel, item.productId);
  return {
    productId: item.productId,
    name: item.name || current?.name || "Produto removido",
    price: item.price || current?.price || "valor indisponível",
    description: item.description || current?.description || "",
    stock: item.stock || current?.stock || "infinito",
    type: item.type || current?.type || "product",
    imageUrl: item.imageUrl || current?.imageUrl || "",
    rewards: Array.isArray(item.rewards) ? item.rewards : current?.rewards
  };
}
function orderTotals(order, panel) {
  return (order.items || []).reduce((summary, item) => {
    const details = orderItemDetails(item, panel);
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const unit = parsePrice(details.price);

    summary.quantity += quantity;
    if (unit === null) summary.unknown += quantity;
    else summary.amount += unit * quantity;

    return summary;
  }, { amount: 0, quantity: 0, unknown: 0 });
}
function totalLine(order, panel) {
  const totals = orderTotals(order, panel);
  if (!totals.quantity) return "Carrinho vazio";
  if (totals.unknown) return `${money(totals.amount)} + itens sem preço numérico`;
  return money(totals.amount);
}
function orderId(type) {
  const db = readOrders();
  let id = random7();
  while ((type === "order" && db.orders[id]) || (type === "ticket" && db.tickets[id])) id = random7();
  return id;
}

function isMysteryBox(item) {
  return item?.type === "mystery_box" && Array.isArray(item.rewards) && item.rewards.length > 0;
}
function productIcon(item) {
  return isMysteryBox(item) ? "🎁" : "🛒";
}
function parseRewardLines(raw) {
  const rewards = String(raw || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split("|").map(part => part.trim());
      const name = parts[0] || "Brinde surpresa";
      const weight = Math.max(0, Number.parseFloat((parts[1] || "1").replace(",", ".")) || 1);
      const description = parts.slice(2).join(" | ") || "Brinde digital";
      return { name: name.slice(0, 100), description: description.slice(0, 200), weight };
    })
    .filter(reward => reward.weight > 0);

  return rewards.length ? rewards : [
    { name: "Mini Pack Digital", description: "Brinde digital padrão", weight: 100 }
  ];
}
function rewardChanceText(rewards) {
  const total = rewards.reduce((sum, reward) => sum + (Number(reward.weight) || 0), 0) || 1;
  return rewards.map(reward => {
    const chance = (((Number(reward.weight) || 0) / total) * 100).toFixed(2).replace(".00", "");
    return `• **${reward.name}** — ${chance}% (${reward.description || "brinde digital"})`;
  }).join("\n");
}
function pickWeightedReward(rewards) {
  const valid = rewards.filter(reward => Number(reward.weight) > 0);
  const total = valid.reduce((sum, reward) => sum + Number(reward.weight), 0);
  let roll = Math.random() * total;

  for (const reward of valid) {
    roll -= Number(reward.weight);
    if (roll <= 0) return reward;
  }

  return valid[valid.length - 1] || { name: "Brinde digital", description: "Brinde digital", weight: 1 };
}
function rollMysteryBoxes(order, panel) {
  const results = [];

  for (const item of order.items || []) {
    const p = orderItemDetails(item, panel);
    if (!isMysteryBox(p)) continue;

    const quantity = Math.max(1, Number(item.quantity) || 1);
    for (let i = 0; i < quantity; i++) {
      const reward = pickWeightedReward(p.rewards);
      results.push({
        boxProductId: p.productId,
        boxName: p.name,
        rewardName: reward.name,
        rewardDescription: reward.description || "Brinde digital",
        rolledAt: new Date().toISOString()
      });
    }
  }

  return results;
}
function mysteryResultsText(results) {
  if (!Array.isArray(results) || !results.length) return "";
  return results.map((result, index) => {
    return `🎁 **Caixa ${index + 1}: ${result.boxName}**
Resultado: **${result.rewardName}**
${result.rewardDescription}`;
  }).join("\n\n");
}
function mysteryResultsEmbed(results, panel) {
  if (!Array.isArray(results) || !results.length) return null;
  return new EmbedBuilder()
    .setTitle("🎁 Resultado da Caixa Surpresa")
    .setDescription(mysteryResultsText(results).slice(0, 4096))
    .setColor(parseColor(panel.color))
    .setFooter({ text: "Sorteio de brindes digitais, sem prêmio em dinheiro/Pix." })
    .setTimestamp();
}

function panelEmbed(panel) {
  const e = new EmbedBuilder()
    .setTitle(panel.title || "Loja")
    .setDescription(String(panel.description || "Selecione um produto abaixo.").slice(0, 4096))
    .setColor(parseColor(panel.color))
    .setFooter({ text: "Selecione um produto para abrir um carrinho privado com a equipe." });
  if (panel.imageUrl && validUrl(panel.imageUrl)) e.setImage(panel.imageUrl);
  if (panel.thumbnailUrl && validUrl(panel.thumbnailUrl)) e.setThumbnail(panel.thumbnailUrl);
  return e;
}
function productOptionDescription(p) {
  const parts = [
    String(p.price || "valor a combinar"),
    String(p.description || "Produto da loja"),
    `Estoque: ${String(p.stock || "infinito")}`
  ];
  return parts.join(" | ").slice(0, 100);
}
function productSelect(panel, customId = `buy:${panel.id}`) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder("📦 Selecione um produto")
    .setMinValues(1).setMaxValues(1);
  if (!panel.products.length) {
    menu.setDisabled(true).addOptions([{ label: "Nenhum produto configurado", value: "none", description: "Use !configds para adicionar." }]);
  } else {
    menu.addOptions(panel.products.slice(0, 25).map(p => ({
      label: `${productIcon(p)} ${String(p.name).slice(0, 96)}`,
      description: productOptionDescription(p),
      value: p.id
    })));
  }
  return new ActionRowBuilder().addComponents(menu);
}
function saleMessage(panel) { return { embeds: [panelEmbed(panel)], components: [productSelect(panel)] }; }
function quickOrderConfig(panel) {
  return { ...defaultQuickOrder(), ...(panel.quickOrder || {}) };
}
function quickOrderEmbed(panel) {
  const quick = quickOrderConfig(panel);
  const embed = new EmbedBuilder()
    .setTitle(quick.title || "Compre aqui")
    .setDescription(String(quick.description || defaultQuickOrder().description).slice(0, 4096))
    .setColor(parseColor(panel.color));

  if (panel.imageUrl && validUrl(panel.imageUrl)) embed.setImage(panel.imageUrl);
  if (panel.thumbnailUrl && validUrl(panel.thumbnailUrl)) embed.setThumbnail(panel.thumbnailUrl);
  return embed;
}
function quickOrderRows(panel) {
  const quick = quickOrderConfig(panel);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`quickbuy:${panel.id}`)
        .setLabel(String(quick.buttonLabel || "Comprar").slice(0, 80))
        .setEmoji("🛍️")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`quickauto:${panel.id}`)
        .setLabel("Automático")
        .setEmoji("🎁")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`quickcombo:${panel.id}`)
        .setLabel("Combos")
        .setEmoji("🎁")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`quickhelp:${panel.id}`)
        .setLabel("?")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    )
  ];
}
function quickOrderMessage(panel) {
  return { embeds: [quickOrderEmbed(panel)], components: quickOrderRows(panel) };
}
function quickOrderEditModal(sessionId, panel) {
  const quick = quickOrderConfig(panel);
  return new ModalBuilder()
    .setCustomId(`modal:${sessionId}:quickedit`)
    .setTitle("Editar mensagem comprar")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("quickTitle")
          .setLabel("Título da mensagem")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true)
          .setValue(String(quick.title || "Compre aqui").slice(0, 100))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("quickDescription")
          .setLabel("Texto da mensagem")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(2000)
          .setRequired(true)
          .setValue(String(quick.description || defaultQuickOrder().description).slice(0, 2000))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("buttonLabel")
          .setLabel("Texto do botão comprar")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(true)
          .setValue(String(quick.buttonLabel || "Comprar").slice(0, 80))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("question1")
          .setLabel("Pergunta 1 do formulário")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(45)
          .setRequired(true)
          .setValue(String(quick.question1 || "Nick no roblox").slice(0, 45))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("question2")
          .setLabel("Pergunta 2 do formulário")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(45)
          .setRequired(true)
          .setValue(String(quick.question2 || "Nome do Set que você deseja comprar").slice(0, 45))
      )
    );
}
function quickOrderBuyModal(panel) {
  const quick = quickOrderConfig(panel);
  return new ModalBuilder()
    .setCustomId(`quickmodal:${panel.id}`)
    .setTitle(String(quick.title || "Comprar").slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("answer1")
          .setLabel(String(quick.question1 || "Nick no roblox").slice(0, 45))
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("answer2")
          .setLabel(String(quick.question2 || "Nome do Set que você deseja comprar").slice(0, 45))
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true)
      )
    );
}
function productInfoEmbed(item, panel, title = "Produto selecionado") {
  const details = item.productId ? orderItemDetails(item, panel) : item;
  const embed = new EmbedBuilder()
    .setTitle(`${productIcon(details)} ${title}`)
    .setDescription(`**${details.name}**\n${details.description || "Produto da loja"}`.slice(0, 4096))
    .setColor(parseColor(panel.color))
    .addFields(
      { name: "Valor", value: String(details.price || "a combinar").slice(0, 1024), inline: true },
      { name: "Estoque", value: String(details.stock || "infinito").slice(0, 1024), inline: true }
    );

  if (isMysteryBox(details)) {
    embed.addFields({ name: "Possíveis brindes", value: rewardChanceText(details.rewards).slice(0, 1024), inline: false });
  }

  if (details.imageUrl && validUrl(details.imageUrl)) embed.setImage(details.imageUrl);
  return embed;
}

function configEmbed(panel, ownerId) {
  const lines = panel.products.length
    ? panel.products.slice(0, 15).map((p, i) => {
        const extra = isMysteryBox(p) ? ` | 🎁 ${p.rewards.length} brindes` : "";
        const image = p.imageUrl ? " | 🖼️ imagem" : "";
        return `\`${i + 1}.\` ${productIcon(p)} **${p.name}** — ${p.price} | Estoque: ${p.stock || "infinito"}${image}${extra}`;
      }).join("\n")
    : "Nenhum produto.";

  const publishedLine = panel.publishedChannelId && panel.publishedMessageId
    ? `<#${panel.publishedChannelId}> / mensagem \`${panel.publishedMessageId}\``
    : "Nenhum painel publicado salvo ainda.";
  const scopeLine = /^\d{15,25}$/.test(String(panel.scopeId || ""))
    ? `<#${panel.scopeId}>`
    : "canal atual";

  return new EmbedBuilder()
    .setTitle("⚙️ Configurador da Loja")
    .setColor(parseColor(panel.color))
    .setDescription(`Use os botões abaixo para montar o painel igual ao da print.

**Dono:** <@${ownerId}>
**Config deste canal:** ${scopeLine}
**Canal de publicação:** ${panel.channelId ? `<#${panel.channelId}>` : "não definido; se publicar agora, usa este canal"}
**Painel publicado salvo:** ${publishedLine}
**Cor:** \`${panel.color}\`
**Imagem:** ${panel.imageUrl ? "configurada ✅" : "sem imagem"}

**Produtos:**
${lines}

**Publicar painel** publica ou reutiliza a mensagem salva quando possível.
**Atualizar publicado** edita manualmente o painel que já está no chat.
Use **Editar produto** para trocar nome, preço, estoque, foto e brindes.
Use **Presets** para substituir os produtos só deste canal.
Use os botões de **Enviar imagem** para mandar arquivo direto no Discord, sem colar link.`);
}
function configRows(sessionId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:title`).setLabel("Título").setEmoji("🏷️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:desc`).setLabel("Descrição").setEmoji("📝").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:image`).setLabel("Imagem").setEmoji("🖼️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:color`).setLabel("Cor").setEmoji("🎨").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:channel`).setLabel("Canal").setEmoji("📢").setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:add`).setLabel("Adicionar produto").setEmoji("➕").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:remove`).setLabel("Remover produto").setEmoji("🗑️").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:preview`).setLabel("Preview").setEmoji("👁️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:publish`).setLabel("Publicar painel").setEmoji("🚀").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:update`).setLabel("Atualizar publicado").setEmoji("♻️").setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:mystery`).setLabel("Adicionar caixa surpresa").setEmoji("🎁").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:edit`).setLabel("Editar produto").setEmoji("✏️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:reset`).setLabel("Resetar exemplo").setEmoji("♻️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:close`).setLabel("Fechar config").setEmoji("🔒").setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:uploadpanel`).setLabel("Enviar imagem do painel").setEmoji("🖼️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:uploadproduct`).setLabel("Enviar foto de produto").setEmoji("📸").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:preset`).setLabel("Presets").setEmoji("📋").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:quickedit`).setLabel("Editar compra").setEmoji("🧾").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`cfg:${sessionId}:quickpublish`).setLabel("Publicar compra").setEmoji("🛍️").setStyle(ButtonStyle.Success)
    )
  ];
}
async function refreshConfig(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  try {
    const guild = await client.guilds.fetch(s.guildId);
    const ch = await guild.channels.fetch(s.channelId);
    const msg = await ch.messages.fetch(s.messageId);
    const panel = getPanel(s.guildId, s.scopeId);
    await msg.edit({ embeds: [configEmbed(panel, s.ownerId)], components: configRows(sessionId) });
  } catch (e) { console.error("refreshConfig:", e.message); }
}
async function startConfig(channel, member, user) {
  if (!isAdmin(member)) return channel.send(`<@${user.id}> você precisa ser admin ou ter o cargo ADM configurado.`);

  const guildId = channel.guild.id;
  const panel = getPanel(guildId, channel.id);
  const sessionId = sid();
  let msg = null;

  // Se já existe um !configds nesse mesmo canal, edita ele em vez de criar outro.
  if (panel.configMessageChannelId === channel.id && panel.configMessageId) {
    msg = await channel.messages.fetch(panel.configMessageId).catch(() => null);
  }

  if (msg) {
    await msg.edit({ embeds: [configEmbed(panel, user.id)], components: configRows(sessionId) });
  } else {
    msg = await channel.send({ embeds: [configEmbed(panel, user.id)], components: configRows(sessionId) });
    panel.configMessageChannelId = channel.id;
    panel.configMessageId = msg.id;
    savePanel(guildId, panel, channel.id);
  }

  sessions.set(sessionId, { guildId, scopeId: channel.id, channelId: channel.id, messageId: msg.id, ownerId: user.id, createdAt: Date.now() });
  setTimeout(() => sessions.delete(sessionId), 60 * 60 * 1000);
}
async function sessionOrReply(interaction, sessionId) {
  const s = sessions.get(sessionId);
  if (!s) {
    await interaction.reply({ content: "Sessão expirada. Use `!configds` ou `/configds` de novo.", ephemeral: true });
    return null;
  }
  if (interaction.user.id !== s.ownerId && !isAdmin(interaction.member)) {
    await interaction.reply({ content: "Só quem abriu ou um admin pode mexer nisso.", ephemeral: true });
    return null;
  }
  return s;
}
function editModal(sessionId, field, panel) {
  const modal = new ModalBuilder().setCustomId(`modal:${sessionId}:${field}`).setTitle("Configurar painel");
  if (field === "title") modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("title").setLabel("Título").setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(true).setValue(String(panel.title || "").slice(0, 256))));
  if (field === "desc") modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("desc").setLabel("Descrição").setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(true).setValue(String(panel.description || "").slice(0, 4000))));
  if (field === "image") modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("image").setLabel("URL da imagem/banner").setStyle(TextInputStyle.Short).setMaxLength(500).setRequired(false).setValue(String(panel.imageUrl || "").slice(0, 500))),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("thumb").setLabel("URL do thumbnail/opcional").setStyle(TextInputStyle.Short).setMaxLength(500).setRequired(false).setValue(String(panel.thumbnailUrl || "").slice(0, 500)))
  );
  if (field === "color") modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("color").setLabel("Cor HEX").setPlaceholder("#9b00ff").setStyle(TextInputStyle.Short).setMaxLength(7).setRequired(true).setValue(String(panel.color || "#9b00ff"))));
  if (field === "channel") modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("channel").setLabel("ID do canal de publicação").setPlaceholder("Cole o ID do canal").setStyle(TextInputStyle.Short).setMaxLength(30).setRequired(false).setValue(String(panel.channelId || ""))));
  if (field === "add") modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("name").setLabel("Nome do produto").setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("price").setLabel("Valor").setPlaceholder("R$ 5,00").setStyle(TextInputStyle.Short).setMaxLength(50).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("pdesc").setLabel("Descrição curta").setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("stock").setLabel("Estoque").setPlaceholder("infinito").setStyle(TextInputStyle.Short).setMaxLength(50).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("imageUrl").setLabel("URL da foto do produto").setPlaceholder("https://.../produto.png").setStyle(TextInputStyle.Short).setMaxLength(500).setRequired(false))
  );
  if (field === "mystery") modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("name").setLabel("Nome da caixa surpresa").setPlaceholder("Ex: Caixa Surpresa de Packs").setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("price").setLabel("Valor").setPlaceholder("R$ 0,10").setStyle(TextInputStyle.Short).setMaxLength(50).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("pdesc").setLabel("Descrição curta").setPlaceholder("Sorteia um brinde digital após finalizar").setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("stock").setLabel("Estoque").setPlaceholder("infinito").setStyle(TextInputStyle.Short).setMaxLength(50).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("rewards").setLabel("Brindes: nome | peso | descrição").setPlaceholder("Mini Pack | 70 | 10 cortes aleatórios\nPack Premium | 5 | pack raro").setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true))
  );
  return modal;
}
function productEditModal(sessionId, p) {
  const modal = new ModalBuilder()
    .setCustomId(`modal:${sessionId}:edit:${p.id}`)
    .setTitle("Editar produto")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("name")
          .setLabel("Nome")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(100)
          .setRequired(true)
          .setValue(String(p.name || "").slice(0, 100))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("price")
          .setLabel("Valor")
          .setPlaceholder("R$ 5,00")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50)
          .setRequired(true)
          .setValue(String(p.price || "").slice(0, 50))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("pdesc")
          .setLabel("Descrição curta")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(200)
          .setRequired(false)
          .setValue(String(p.description || "").slice(0, 200))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("stock")
          .setLabel("Estoque")
          .setPlaceholder("infinito")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50)
          .setRequired(false)
          .setValue(String(p.stock || "infinito").slice(0, 50))
      )
    );

  if (isMysteryBox(p)) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("rewards")
          .setLabel("Brindes: nome | peso | descrição")
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(1000)
          .setRequired(true)
          .setValue((p.rewards || []).map(reward => `${reward.name} | ${reward.weight} | ${reward.description || ""}`).join("\n").slice(0, 1000))
      )
    );
  } else {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("imageUrl")
          .setLabel("URL da foto do produto")
          .setPlaceholder("https://.../produto.png")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(500)
          .setRequired(false)
          .setValue(String(p.imageUrl || "").slice(0, 500))
      )
    );
  }

  return modal;
}
async function publishPanelMessage(interaction, panel, guildId) {
  const channelId = panel.channelId || panel.publishedChannelId || interaction.channelId;
  const ch = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    return { ok: false, message: "Canal inválido. Clique em **Canal** e cole o ID correto." };
  }

  let oldMessage = null;
  if (panel.publishedChannelId === ch.id && panel.publishedMessageId) {
    oldMessage = await ch.messages.fetch(panel.publishedMessageId).catch(() => null);
  }

  if (oldMessage) {
    await oldMessage.edit(saleMessage(panel));
    return { ok: true, action: "updated", channelId: ch.id, messageId: oldMessage.id };
  }

  const sent = await ch.send(saleMessage(panel));
  panel.publishedChannelId = ch.id;
  panel.publishedMessageId = sent.id;
  savePanel(guildId, panel, panel.scopeId);
  return { ok: true, action: "published", channelId: ch.id, messageId: sent.id };
}
async function updatePublishedPanel(guild, panel) {
  if (!panel.publishedChannelId || !panel.publishedMessageId) return false;

  try {
    const ch = await guild.channels.fetch(panel.publishedChannelId);
    if (!ch || !ch.isTextBased()) return false;
    const msg = await ch.messages.fetch(panel.publishedMessageId);
    await msg.edit(saleMessage(panel));
    return true;
  } catch (error) {
    console.log("Não consegui atualizar painel publicado:", error.message);
    return false;
  }
}
async function updatePublishedQuickOrder(guild, panel) {
  const quick = quickOrderConfig(panel);
  if (!quick.publishedChannelId || !quick.publishedMessageId) return false;

  try {
    const ch = await guild.channels.fetch(quick.publishedChannelId);
    if (!ch || !ch.isTextBased()) return false;
    const msg = await ch.messages.fetch(quick.publishedMessageId);
    await msg.edit(quickOrderMessage(panel));
    return true;
  } catch (error) {
    console.log("Não consegui atualizar mensagem de compra publicada:", error.message);
    return false;
  }
}
function panelImageUploadMenu(sessionId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`uploadpanel:${sessionId}`)
      .setPlaceholder("Onde salvar a imagem?")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions([
        { label: "Banner do painel", description: "Imagem grande do embed da loja", value: "panelImage" },
        { label: "Thumbnail do painel", description: "Imagem pequena no canto do embed", value: "panelThumb" }
      ])
  );
}
function productImageUploadMenu(sessionId, panel) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`uploadproduct:${sessionId}`)
      .setPlaceholder("Produto que vai receber a foto")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(panel.products.slice(0, 25).map(p => ({
        label: `${productIcon(p)} ${String(p.name).slice(0, 95)}`,
        description: productOptionDescription(p),
        value: p.id
      })))
  );
}
function presetMenu(sessionId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`preset:${sessionId}`)
      .setPlaceholder("Escolha um preset para substituir os produtos")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(Object.entries(PRODUCT_PRESETS).map(([value, preset]) => ({
        label: preset.label,
        description: `${preset.items.length} produtos cadastrados automaticamente`,
        value
      })))
  );
}
async function publishQuickOrderMessage(interaction, panel, guildId) {
  const quick = quickOrderConfig(panel);
  const channelId = panel.channelId || quick.publishedChannelId || interaction.channelId;
  const ch = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) {
    return { ok: false, message: "Canal inválido. Clique em **Canal** e cole o ID correto." };
  }

  let oldMessage = null;
  if (quick.publishedChannelId === ch.id && quick.publishedMessageId) {
    oldMessage = await ch.messages.fetch(quick.publishedMessageId).catch(() => null);
  }

  if (oldMessage) {
    await oldMessage.edit(quickOrderMessage(panel));
    return { ok: true, action: "updated", channelId: ch.id, messageId: oldMessage.id };
  }

  const sent = await ch.send(quickOrderMessage(panel));
  panel.quickOrder = {
    ...quick,
    publishedChannelId: ch.id,
    publishedMessageId: sent.id
  };
  savePanel(guildId, panel, panel.scopeId);
  return { ok: true, action: "published", channelId: ch.id, messageId: sent.id };
}
async function saveAttachmentAsDiscordImage(channel, attachment, label) {
  if (attachment.size > MAX_SAVED_IMAGE_BYTES) {
    return {
      url: attachment.url,
      copied: false,
      note: "O arquivo era grande demais para eu reenviar; salvei a URL do anexo original."
    };
  }

  try {
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get("content-type") || attachment.contentType || "image/png";
    if (!contentType.startsWith("image/")) throw new Error("arquivo baixado não é imagem");

    const bytes = Buffer.from(await response.arrayBuffer());
    const file = new AttachmentBuilder(bytes, { name: savedImageName(attachment) });
    const saved = await channel.send({ content: `Imagem salva para **${label}**.`, files: [file] });
    const savedAttachment = saved.attachments.first();

    return {
      url: savedAttachment?.url || attachment.url,
      copied: Boolean(savedAttachment),
      note: savedAttachment ? "Copiei a imagem para uma mensagem do bot e salvei essa URL." : "Salvei a URL do anexo original."
    };
  } catch (error) {
    console.log("Não consegui copiar imagem enviada:", error.message);
    return {
      url: attachment.url,
      copied: false,
      note: "Não consegui copiar a imagem, então salvei a URL do anexo original."
    };
  }
}
async function queueImageUpload(interaction, sessionId, pending) {
  const key = imageUploadKey(interaction.guildId, interaction.channelId, interaction.user.id);
  const uploadState = {
    ...pending,
    sessionId,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    expiresAt: Date.now() + IMAGE_UPLOAD_TTL_MS
  };
  imageUploads.set(key, uploadState);
  setTimeout(() => {
    if (imageUploads.get(key)?.expiresAt === uploadState.expiresAt) imageUploads.delete(key);
  }, IMAGE_UPLOAD_TTL_MS + 1000);

  const s = sessions.get(sessionId);
  const panel = getPanel(interaction.guildId, s?.scopeId || interaction.channelId);
  const label = imageUploadTargetLabel(pending, panel);
  return interaction.reply({
    content: `Beleza. Agora envie a imagem como **anexo neste canal** em até 3 minutos. Vou salvar como ${label}.`,
    ephemeral: true
  });
}
async function handleConfigButton(interaction) {
  const [, sessionId, action] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;
  const panel = getPanel(s.guildId, s.scopeId);
  if (["title", "desc", "image", "color", "channel", "add", "mystery"].includes(action)) return interaction.showModal(editModal(sessionId, action, panel));
  if (action === "preview") return interaction.reply({ content: "Preview:", ...saleMessage(panel), ephemeral: true });
  if (action === "preset") {
    return interaction.reply({ content: "Escolha o preset. Isso substitui os produtos atuais deste canal.", components: [presetMenu(sessionId)], ephemeral: true });
  }
  if (action === "quickedit") {
    return interaction.showModal(quickOrderEditModal(sessionId, panel));
  }
  if (action === "quickpublish") {
    const result = await publishQuickOrderMessage(interaction, panel, s.guildId);
    if (!result.ok) return interaction.reply({ content: result.message, ephemeral: true });
    await refreshConfig(sessionId);
    const actionText = result.action === "updated" ? "Mensagem de compra atualizada" : "Mensagem de compra publicada";
    return interaction.reply({ content: `${actionText} em <#${result.channelId}>.`, ephemeral: true });
  }
  if (action === "uploadpanel") {
    return interaction.reply({ content: "Escolha onde a imagem do painel vai entrar:", components: [panelImageUploadMenu(sessionId)], ephemeral: true });
  }
  if (action === "uploadproduct") {
    if (!panel.products.length) return interaction.reply({ content: "Cadastre um produto antes de enviar foto.", ephemeral: true });
    return interaction.reply({ content: "Escolha o produto que vai receber a foto:", components: [productImageUploadMenu(sessionId, panel)], ephemeral: true });
  }
  if (action === "publish") {
    const result = await publishPanelMessage(interaction, panel, s.guildId);
    if (!result.ok) return interaction.reply({ content: result.message, ephemeral: true });
    await refreshConfig(sessionId);

    const actionText = result.action === "updated" ? "Painel existente atualizado" : "Painel publicado";
    return interaction.reply({ content: `${actionText} em <#${result.channelId}> e salvo para futuras edições.`, ephemeral: true });
  }
  if (action === "update") {
    if (!panel.publishedChannelId || !panel.publishedMessageId) {
      return interaction.reply({ content: "Ainda não tem painel publicado salvo. Clique em **Publicar painel** primeiro.", ephemeral: true });
    }

    const ch = await interaction.guild.channels.fetch(panel.publishedChannelId).catch(() => null);
    if (!ch || !ch.isTextBased()) return interaction.reply({ content: "Não achei o canal do painel publicado. Publique de novo.", ephemeral: true });

    const msg = await ch.messages.fetch(panel.publishedMessageId).catch(() => null);
    if (!msg) return interaction.reply({ content: "Não achei a mensagem antiga do painel. Ela pode ter sido apagada. Publique de novo.", ephemeral: true });

    await msg.edit(saleMessage(panel));
    return interaction.reply({ content: `Painel antigo atualizado em <#${ch.id}>.`, ephemeral: true });
  }
  if (action === "edit") {
    if (!panel.products.length) return interaction.reply({ content: "Não tem produto para editar.", ephemeral: true });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`edit:${sessionId}`)
      .setPlaceholder("Produto para editar")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(panel.products.slice(0, 25).map(p => ({
        label: `${productIcon(p)} ${String(p.name).slice(0, 95)}`,
        description: productOptionDescription(p),
        value: p.id
      })));
    return interaction.reply({ content: "Escolha o produto que quer editar:", components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
  }
  if (action === "remove") {
    if (!panel.products.length) return interaction.reply({ content: "Não tem produto para remover.", ephemeral: true });
    const menu = new StringSelectMenuBuilder().setCustomId(`remove:${sessionId}`).setPlaceholder("Produto para remover").setMinValues(1).setMaxValues(1).addOptions(panel.products.slice(0,25).map(p => ({ label: `${productIcon(p)} ${String(p.name).slice(0,95)}`, description: isMysteryBox(p) ? `Caixa surpresa | Valor: ${p.price}`.slice(0,100) : `Valor: ${p.price}`.slice(0,100), value: p.id })));
    return interaction.reply({ content: "Escolha o produto:", components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
  }
  if (action === "reset") {
    const resetPanel = defaultPanel(s.guildId, s.scopeId);
    resetPanel.configMessageChannelId = s.channelId;
    resetPanel.configMessageId = s.messageId;
    savePanel(s.guildId, resetPanel, s.scopeId);
    await refreshConfig(sessionId);
    return interaction.reply({ content: "Resetado para o exemplo da Dragon Store.", ephemeral: true });
  }
  if (action === "close") {
    sessions.delete(sessionId);
    return interaction.update({ content: "Configuração fechada.", embeds: [], components: [] });
  }
}
async function handleModal(interaction) {
  const [, sessionId, field, productId] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;
  const panel = getPanel(s.guildId, s.scopeId);
  if (field === "title") panel.title = interaction.fields.getTextInputValue("title").trim();
  if (field === "desc") panel.description = interaction.fields.getTextInputValue("desc").trim();
  if (field === "image") {
    const image = interaction.fields.getTextInputValue("image").trim();
    const thumb = interaction.fields.getTextInputValue("thumb").trim();
    if (!validUrl(image) || !validUrl(thumb)) return interaction.reply({ content: "URL inválida. Use link http/https ou deixe vazio.", ephemeral: true });
    panel.imageUrl = image; panel.thumbnailUrl = thumb;
  }
  if (field === "color") panel.color = normColor(interaction.fields.getTextInputValue("color"));
  if (field === "channel") {
    const channel = interaction.fields.getTextInputValue("channel").trim();
    if (channel && !/^\d{15,25}$/.test(channel)) return interaction.reply({ content: "ID de canal inválido.", ephemeral: true });
    panel.channelId = channel;
  }
  if (field === "quickedit") {
    const oldQuick = quickOrderConfig(panel);
    panel.quickOrder = {
      ...oldQuick,
      title: interaction.fields.getTextInputValue("quickTitle").trim() || "Compre aqui",
      description: interaction.fields.getTextInputValue("quickDescription").trim() || defaultQuickOrder().description,
      buttonLabel: interaction.fields.getTextInputValue("buttonLabel").trim() || "Comprar",
      question1: interaction.fields.getTextInputValue("question1").trim() || "Nick no roblox",
      question2: interaction.fields.getTextInputValue("question2").trim() || "Nome do Set que você deseja comprar"
    };
  }
  if (field === "add") {
    if (panel.products.length >= 25) return interaction.reply({ content: "Limite de 25 produtos atingido.", ephemeral: true });
    const imageUrl = interaction.fields.getTextInputValue("imageUrl").trim();
    if (imageUrl && !validUrl(imageUrl)) return interaction.reply({ content: "URL da foto inválida. Use link http/https ou deixe vazio.", ephemeral: true });
    panel.products.push({
      id: "p" + random7(),
      ...normalizeProductInput({
        name: interaction.fields.getTextInputValue("name"),
        price: interaction.fields.getTextInputValue("price"),
        description: interaction.fields.getTextInputValue("pdesc") || "Produto da loja",
        stock: interaction.fields.getTextInputValue("stock") || "infinito",
        imageUrl
      })
    });
  }
  if (field === "mystery") {
    if (panel.products.length >= 25) return interaction.reply({ content: "Limite de 25 produtos atingido.", ephemeral: true });
    panel.products.push({
      id: "p" + random7(),
      type: "mystery_box",
      name: interaction.fields.getTextInputValue("name").trim(),
      price: interaction.fields.getTextInputValue("price").trim(),
      description: interaction.fields.getTextInputValue("pdesc").trim() || "Sorteia um brinde digital após a compra ser finalizada",
      stock: interaction.fields.getTextInputValue("stock").trim() || "infinito",
      rewards: parseRewardLines(interaction.fields.getTextInputValue("rewards"))
    });
  }
  if (field === "edit") {
    const target = product(panel, productId);
    if (!target) return interaction.reply({ content: "Produto não encontrado. Reabra o configurador e tente de novo.", ephemeral: true });

    const patch = normalizeProductInput({
      name: interaction.fields.getTextInputValue("name"),
      price: interaction.fields.getTextInputValue("price"),
      description: interaction.fields.getTextInputValue("pdesc") || "Produto da loja",
      stock: interaction.fields.getTextInputValue("stock") || "infinito",
      imageUrl: target.imageUrl || ""
    });

    target.name = patch.name;
    target.price = patch.price;
    target.description = patch.description;
    target.stock = patch.stock;

    if (isMysteryBox(target)) {
      target.rewards = parseRewardLines(interaction.fields.getTextInputValue("rewards"));
    } else {
      const imageUrl = interaction.fields.getTextInputValue("imageUrl").trim();
      if (imageUrl && !validUrl(imageUrl)) return interaction.reply({ content: "URL da foto inválida. Use link http/https ou deixe vazio.", ephemeral: true });
      target.imageUrl = imageUrl;
    }
  }
  savePanel(s.guildId, panel, s.scopeId);
  await refreshConfig(sessionId);
  return interaction.reply({ content: "Atualizado.", ephemeral: true });
}
async function handleRemove(interaction) {
  const [, sessionId] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;
  const panel = getPanel(s.guildId, s.scopeId);
  panel.products = panel.products.filter(p => p.id !== interaction.values[0]);
  savePanel(s.guildId, panel, s.scopeId);
  await refreshConfig(sessionId);
  return interaction.update({ content: "Produto removido.", components: [] });
}
async function handleEditProduct(interaction) {
  const [, sessionId] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;

  const panel = getPanel(s.guildId, s.scopeId);
  const p = product(panel, interaction.values[0]);
  if (!p) return interaction.reply({ content: "Produto não encontrado. Reabra o configurador e tente de novo.", ephemeral: true });

  return interaction.showModal(productEditModal(sessionId, p));
}
async function handlePanelImageUploadTarget(interaction) {
  const [, sessionId] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;

  return queueImageUpload(interaction, sessionId, { target: interaction.values[0] });
}
async function handleProductImageUploadTarget(interaction) {
  const [, sessionId] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;

  const panel = getPanel(s.guildId, s.scopeId);
  const p = product(panel, interaction.values[0]);
  if (!p) return interaction.reply({ content: "Produto não encontrado. Reabra o configurador e tente de novo.", ephemeral: true });

  return queueImageUpload(interaction, sessionId, { target: "product", productId: p.id });
}
async function handlePresetSelect(interaction) {
  const [, sessionId] = interaction.customId.split(":");
  const s = await sessionOrReply(interaction, sessionId);
  if (!s) return;

  const panel = getPanel(s.guildId, s.scopeId);
  const presetKey = interaction.values[0];
  const ok = applyProductPreset(panel, presetKey);
  if (!ok) return interaction.reply({ content: "Preset não encontrado.", ephemeral: true });

  savePanel(s.guildId, panel, s.scopeId);
  await refreshConfig(sessionId);

  const preset = PRODUCT_PRESETS[presetKey];
  return interaction.update({
    content: `Preset **${preset.label}** aplicado neste canal com **${preset.items.length}** produtos.`,
    components: []
  });
}

async function privateChannel(guild, user, name, parent) {
  return guild.channels.create({
    name, type: ChannelType.GuildText, parent,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
      { id: config.adminRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] }
    ]
  });
}
function cartText(order, panel) {
  if (!Array.isArray(order.items) || !order.items.length) return "Carrinho vazio.";
  const base = order.items.map(item => {
    const p = orderItemDetails(item, panel);
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const unit = parsePrice(p.price);
    const subtotal = unit === null ? "" : ` = ${money(unit * quantity)}`;
    return `• ${productIcon(p)} **${p.name}** — ${p.price} x${quantity}${subtotal}`;
  }).join("\n");

  if (Array.isArray(order.mysteryResults) && order.mysteryResults.length) {
    return `${base}

**Caixas abertas:**
${mysteryResultsText(order.mysteryResults)}`;
  }

  return base;
}
function cartEmbed(order, panel) {
  const totals = orderTotals(order, panel);
  const firstImage = (order.items || [])
    .map(item => orderItemDetails(item, panel).imageUrl)
    .find(url => url && validUrl(url));
  const embed = new EmbedBuilder()
    .setTitle(`🛒 Carrinho #${order.id}`)
    .setDescription(cartText(order, panel))
    .setColor(parseColor(panel.color))
    .addFields(
      { name: "Cliente", value: `<@${order.userId}>`, inline: true },
      { name: "Status", value: order.status === "open" ? "Aberto" : "Fechado", inline: true },
      { name: "Atendente", value: order.assignedAdminId ? `<@${order.assignedAdminId}>` : "Ainda não assumido", inline: true },
      { name: "Itens", value: String(totals.quantity), inline: true },
      { name: "Total estimado", value: totalLine(order, panel), inline: true }
    )
    .setTimestamp();

  if (firstImage) embed.setThumbnail(firstImage);
  return embed;
}
function cartButtons(orderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`call:${orderId}`).setLabel("Chamar ADM").setEmoji("📣").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`view:${orderId}`).setLabel("Ver carrinho").setEmoji("🧾").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`finish:${orderId}`).setLabel("Finalizar compra").setEmoji("✅").setStyle(ButtonStyle.Success)
  );
}
function buildStoreStatusEmbed(guildId, scopeId = "default") {
  const panel = getPanel(guildId, scopeId);
  const db = readOrders();
  const orders = Object.values(db.orders || {}).filter(order => {
    const sameGuild = !order.guildId || order.guildId === guildId;
    const samePanel = order.panelScopeId ? order.panelScopeId === scopeId : scopeId === "default";
    return sameGuild && samePanel;
  });
  const openOrders = orders.filter(order => order.status === "open");
  const closedOrders = orders.filter(order => order.status === "closed");
  const revenue = closedOrders.reduce((summary, order) => {
    const totals = orderTotals(order, panel);
    summary.amount += totals.amount;
    summary.unknown += totals.unknown;
    return summary;
  }, { amount: 0, unknown: 0 });
  const online = onlineStaffProfiles(guildId);
  const published = panel.publishedChannelId && panel.publishedMessageId
    ? `<#${panel.publishedChannelId}> / \`${panel.publishedMessageId}\``
    : "Nenhum painel publicado salvo";
  const staffLine = online.length
    ? online.map(profile => `🟢 ${profile.displayName || "ADM"} (<@${profile.userId}>)`).join("\n")
    : "Nenhum ADM online agora";
  const revenueLine = revenue.unknown
    ? `${money(revenue.amount)} + ${revenue.unknown} item(ns) sem preço numérico`
    : money(revenue.amount);

  return new EmbedBuilder()
    .setTitle("📊 Status da loja")
    .setColor(parseColor(panel.color))
    .addFields(
      { name: "Produtos", value: `${panel.products.length}/25 cadastrados`, inline: true },
      { name: "Carrinhos abertos", value: String(openOrders.length), inline: true },
      { name: "Vendas fechadas", value: String(closedOrders.length), inline: true },
      { name: "Faturamento estimado", value: revenueLine, inline: false },
      { name: "Painel publicado", value: published, inline: false },
      { name: "Atendimento online", value: staffLine.slice(0, 1024), inline: false }
    )
    .setFooter({ text: "Valores são estimativas a partir dos preços cadastrados; pagamento continua manual via Pix." })
    .setTimestamp();
}
async function openCart(interaction) {
  const [, panelId] = interaction.customId.split(":");
  const panel = getPanelById(interaction.guildId, panelId);
  if (!panel) return interaction.reply({ content: "Painel antigo. Peça para um admin publicar de novo.", ephemeral: true });
  const p = product(panel, interaction.values[0]);
  if (!p) return interaction.reply({ content: "Produto não encontrado.", ephemeral: true });
  const id = orderId("order");
  const ch = await privateChannel(interaction.guild, interaction.user, `carrinho-${safeName(interaction.user.username)}-aberto-${id}`, config.categories.cartOpen);
  const order = {
    id,
    guildId: interaction.guildId,
    panelId: panel.id,
    panelScopeId: panel.scopeId || "default",
    status: "open",
    userId: interaction.user.id,
    username: interaction.user.username,
    channelId: ch.id,
    items: [orderItemFromProduct(p)],
    assignedAdminId: null,
    assignedAdminName: null,
    assignedAt: null,
    createdAt: new Date().toISOString(),
    closedAt: null
  };
  const db = readOrders(); db.orders[id] = order; writeOrders(db);
  const intro = new EmbedBuilder().setTitle(`🛒 Carrinho aberto #${id}`).setDescription(config.messages.cartWelcome).setColor(parseColor(panel.color)).addFields({ name: "Cliente", value: `<@${interaction.user.id}>`, inline: true }, { name: "ID da compra", value: id, inline: true });
  await ch.send({ content: `<@${interaction.user.id}>`, embeds: [intro, productInfoEmbed(p, panel, "Produto inicial"), cartEmbed(order, panel)], components: [productSelect(panel, `cartadd:${id}`), cartButtons(id)] });
  await sendStaffChoiceMessage(ch, order, interaction.guildId);

  await sendSafeDM(interaction.user.id, {
    embeds: [
      new EmbedBuilder()
        .setTitle("🛒 Carrinho criado")
        .setDescription(
          `Seu carrinho foi criado com sucesso!

` +
          `**Produto inicial:** ${productIcon(p)} ${p.name}
` +
          `**Valor:** ${p.price}
` +
          `**Total estimado:** ${totalLine(order, panel)}
` +
          `**ID da compra:** \`${id}\`

` +
          `Acesse o canal do carrinho no servidor para finalizar: ${ch}`
        )
        .setColor(parseColor(panel.color))
        .setTimestamp()
    ]
  });

  return interaction.reply({ content: `Carrinho criado: ${ch}`, ephemeral: true });
}
async function handleQuickBuyButton(interaction, panelId) {
  const panel = getPanelById(interaction.guildId, panelId);
  if (!panel) return interaction.reply({ content: "Mensagem de compra antiga. Peça para um admin publicar de novo.", ephemeral: true });
  return interaction.showModal(quickOrderBuyModal(panel));
}
function quickOrderAnswersEmbed(order, panel) {
  const quick = order.quickOrder || quickOrderConfig(panel);
  const answers = order.customAnswers || {};
  return new EmbedBuilder()
    .setTitle(`🛍️ Pedido personalizado #${order.id}`)
    .setDescription("Pedido criado pelo botão **Comprar**.")
    .setColor(parseColor(panel.color))
    .addFields(
      { name: quick.question1 || "Nick no roblox", value: String(answers.answer1 || "Não informado").slice(0, 1024), inline: false },
      { name: quick.question2 || "Nome do Set que você deseja comprar", value: String(answers.answer2 || "Não informado").slice(0, 1024), inline: false }
    )
    .setTimestamp();
}
async function handleQuickOrderSubmit(interaction) {
  const [, panelId] = interaction.customId.split(":");
  const panel = getPanelById(interaction.guildId, panelId);
  if (!panel) return interaction.reply({ content: "Mensagem de compra antiga. Peça para um admin publicar de novo.", ephemeral: true });

  const quick = quickOrderConfig(panel);
  const answer1 = interaction.fields.getTextInputValue("answer1").trim();
  const answer2 = interaction.fields.getTextInputValue("answer2").trim();
  const id = orderId("order");
  const ch = await privateChannel(interaction.guild, interaction.user, `carrinho-${safeName(interaction.user.username)}-aberto-${id}`, config.categories.cartOpen);
  const order = {
    id,
    guildId: interaction.guildId,
    panelId: panel.id,
    panelScopeId: panel.scopeId || "default",
    status: "open",
    userId: interaction.user.id,
    username: interaction.user.username,
    channelId: ch.id,
    items: [{
      productId: `custom_${id}`,
      quantity: 1,
      name: answer2 || "Pedido personalizado",
      price: "A combinar",
      description: `${quick.question1}: ${answer1}\n${quick.question2}: ${answer2}`,
      stock: "sob demanda",
      type: "custom_order",
      imageUrl: panel.imageUrl || ""
    }],
    customAnswers: { answer1, answer2 },
    quickOrder: {
      title: quick.title,
      question1: quick.question1,
      question2: quick.question2
    },
    assignedAdminId: null,
    assignedAdminName: null,
    assignedAt: null,
    createdAt: new Date().toISOString(),
    closedAt: null
  };

  const db = readOrders();
  db.orders[id] = order;
  writeOrders(db);

  const intro = new EmbedBuilder()
    .setTitle(`🛒 Carrinho aberto #${id}`)
    .setDescription(config.messages.cartWelcome)
    .setColor(parseColor(panel.color))
    .addFields(
      { name: "Cliente", value: `<@${interaction.user.id}>`, inline: true },
      { name: "ID da compra", value: id, inline: true }
    );

  await ch.send({
    content: `<@${interaction.user.id}>`,
    embeds: [intro, quickOrderAnswersEmbed(order, panel), cartEmbed(order, panel)],
    components: [productSelect(panel, `cartadd:${id}`), cartButtons(id)]
  });
  await sendStaffChoiceMessage(ch, order, interaction.guildId);

  await sendSafeDM(interaction.user.id, {
    embeds: [
      new EmbedBuilder()
        .setTitle("🛒 Carrinho criado")
        .setDescription(
          `Seu carrinho foi criado com sucesso!\n\n` +
          `**${quick.question1}:** ${answer1}\n` +
          `**${quick.question2}:** ${answer2}\n` +
          `**ID da compra:** \`${id}\`\n\n` +
          `Acesse o canal do carrinho no servidor para continuar: ${ch}`
        )
        .setColor(parseColor(panel.color))
        .setTimestamp()
    ]
  });

  return interaction.reply({ content: `Carrinho criado: ${ch}`, ephemeral: true });
}
async function addCart(interaction) {
  const [, id] = interaction.customId.split(":");
  const db = readOrders(); const order = db.orders[id];
  if (!order || order.status !== "open") return interaction.reply({ content: "Carrinho fechado ou inexistente.", ephemeral: true });
  if (interaction.user.id !== order.userId && !isAdmin(interaction.member)) return interaction.reply({ content: "Você não pode alterar esse carrinho.", ephemeral: true });
  const panel = getOrderPanel(order, interaction.guildId); const p = product(panel, interaction.values[0]);
  if (!p) return interaction.reply({ content: "Produto não encontrado.", ephemeral: true });
  const item = order.items.find(i => i.productId === p.id);
  if (item) item.quantity += 1; else order.items.push(orderItemFromProduct(p));
  db.orders[id] = order; writeOrders(db);
  await interaction.reply({ content: `Adicionado: ${productIcon(p)} **${p.name}** — ${p.price}`, ephemeral: true });
  return interaction.channel.send({ embeds: [productInfoEmbed(p, panel, "Produto adicionado"), cartEmbed(order, panel)] });
}
async function callAdmin(interaction, id, type = "order") {
  const db = readOrders(); const record = type === "ticket" ? db.tickets[id] : db.orders[id];
  if (!record || record.status !== "open") return interaction.reply({ content: "Canal fechado ou inexistente.", ephemeral: true });
  if (interaction.user.id !== record.userId && !isAdmin(interaction.member)) return interaction.reply({ content: "Sem permissão.", ephemeral: true });
  await interaction.channel.send({ content: `<@&${config.adminRoleId}> ${config.messages.adminCall}\nID: **${id}** | Cliente: <@${record.userId}>` });
  return interaction.reply({ content: "ADM chamado.", ephemeral: true });
}
async function viewCart(interaction, id) {
  const db = readOrders(); const order = db.orders[id];
  if (!order) return interaction.reply({ content: "Carrinho não encontrado.", ephemeral: true });
  if (interaction.user.id !== order.userId && !isAdmin(interaction.member)) return interaction.reply({ content: "Sem permissão.", ephemeral: true });
  return interaction.reply({ embeds: [cartEmbed(order, getOrderPanel(order, interaction.guildId))], ephemeral: true });
}
async function finishCart(interaction, id) {
  const db = readOrders(); const order = db.orders[id];
  if (!order || order.status !== "open") return interaction.reply({ content: "Carrinho fechado ou inexistente.", ephemeral: true });
  if (config.settings.finalizeCartOnlyAdmins && !isAdmin(interaction.member)) return interaction.reply({ content: "Só admin finaliza. Clique em **Chamar ADM**.", ephemeral: true });
  const panel = getOrderPanel(order, interaction.guildId);
  const mysteryResults = Array.isArray(order.mysteryResults) && order.mysteryResults.length
    ? order.mysteryResults
    : rollMysteryBoxes(order, panel);
  if (mysteryResults.length) order.mysteryResults = mysteryResults;
  order.status = "closed";
  order.closedAt = new Date().toISOString();
  order.closedByAdminId = interaction.user.id;
  order.closedByAdminName = interaction.member?.displayName || interaction.user.username;
  db.orders[id] = order;
  writeOrders(db);
  await interaction.channel.setName(interaction.channel.name.includes("aberto") ? interaction.channel.name.replace("aberto", "fechado") : `carrinho-${safeName(order.username)}-fechado-${id}`).catch(() => null);
  if (config.categories.closed) await interaction.channel.setParent(config.categories.closed, { lockPermissions: false }).catch(() => null);
  await interaction.channel.permissionOverwrites.edit(order.userId, { ViewChannel: true, SendMessages: false, ReadMessageHistory: true }).catch(() => null);
  const thanks = config.messages.purchaseThanks.replaceAll("{id}", id);
  const extraEmbed = mysteryResultsEmbed(mysteryResults, panel);
  await interaction.channel.send({ content: `<@${order.userId}> ${thanks}`, embeds: [cartEmbed(order, panel), extraEmbed].filter(Boolean) });

  await sendSafeDM(order.userId, {
    embeds: [
      new EmbedBuilder()
        .setTitle("✅ Compra finalizada")
        .setDescription(`${thanks}

**Resumo da compra:**
Total estimado: **${totalLine(order, panel)}**

${cartText(order, panel)}`.slice(0, 4096))
        .setColor(parseColor(panel.color))
        .setTimestamp(),
      extraEmbed
    ].filter(Boolean)
  });

  return interaction.reply({ content: mysteryResults.length ? `Compra #${id} finalizada e caixa surpresa sorteada.` : `Compra #${id} finalizada.`, ephemeral: true });
}

function ticketPanelEmbed() { return new EmbedBuilder().setTitle(config.ticketPanel.title).setDescription(config.ticketPanel.description).setColor(parseColor(config.ticketPanel.embedColor, 0x2b2d31)); }
async function setupTicket(interaction) {
  if (!await requireAdminInteraction(interaction, "Você precisa ser ADM para enviar o painel de ticket.")) return;
  const ch = await interaction.guild.channels.fetch(config.ticketPanel.channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) return interaction.reply({ content: "Canal de ticket inválido no config.json.", ephemeral: true });
  const btn = new ButtonBuilder().setCustomId("openticket").setLabel(config.ticketPanel.buttonLabel).setEmoji(config.ticketPanel.buttonEmoji).setStyle(ButtonStyle.Primary);
  await ch.send({ embeds: [ticketPanelEmbed()], components: [new ActionRowBuilder().addComponents(btn)] });
  return interaction.reply({ content: `Painel de ticket enviado em <#${ch.id}>.`, ephemeral: true });
}
async function openTicket(interaction) {
  const id = orderId("ticket");
  const ch = await privateChannel(interaction.guild, interaction.user, `ticket-${safeName(interaction.user.username)}-aberto-${id}`, config.categories.ticketOpen || config.categories.cartOpen);
  const db = readOrders(); db.tickets[id] = { id, status: "open", userId: interaction.user.id, username: interaction.user.username, channelId: ch.id, createdAt: new Date().toISOString(), closedAt: null }; writeOrders(db);
  const embed = new EmbedBuilder().setTitle(`🎫 Ticket #${id}`).setDescription(config.messages.ticketWelcome).setColor(0x2b2d31).addFields({ name: "Cliente", value: `<@${interaction.user.id}>`, inline: true });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`tcall:${id}`).setLabel("Chamar ADM").setEmoji("📣").setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`tclose:${id}`).setLabel("Fechar ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger));
  await ch.send({ content: `<@${interaction.user.id}>`, embeds: [embed], components: [row] });
  return interaction.reply({ content: `Ticket criado: ${ch}`, ephemeral: true });
}
async function closeTicket(interaction, id) {
  const db = readOrders(); const ticket = db.tickets[id];
  if (!ticket || ticket.status !== "open") return interaction.reply({ content: "Ticket fechado ou inexistente.", ephemeral: true });
  if (interaction.user.id !== ticket.userId && !isAdmin(interaction.member)) return interaction.reply({ content: "Sem permissão.", ephemeral: true });
  ticket.status = "closed"; ticket.closedAt = new Date().toISOString(); db.tickets[id] = ticket; writeOrders(db);
  const seconds = Number(config.settings.deleteTicketAfterCloseSeconds ?? 5);
  await interaction.reply({ content: `Ticket fechado. Apagando em ${seconds}s.` });
  setTimeout(() => interaction.channel.delete(`Ticket ${id} fechado`).catch(() => null), Math.max(1, seconds) * 1000);
}
async function handlePendingImageUpload(message) {
  const key = imageUploadKey(message.guild.id, message.channel.id, message.author.id);
  const pending = imageUploads.get(key);
  if (!pending) return false;

  if (Date.now() > pending.expiresAt) {
    imageUploads.delete(key);
    await message.reply("O tempo para enviar a imagem expirou. Clique no botão de envio de imagem de novo.").catch(() => null);
    return false;
  }

  if (!isAdmin(message.member)) {
    imageUploads.delete(key);
    await message.reply("Só ADM pode salvar imagem no painel da loja.").catch(() => null);
    return true;
  }

  const attachment = message.attachments.find(isImageAttachment);
  if (!attachment) {
    if (message.attachments.size) {
      await message.reply("Recebi um anexo, mas ele não parece ser imagem. Envie PNG, JPG, WEBP ou GIF.").catch(() => null);
      return true;
    }
    return false;
  }

  const s = sessions.get(pending.sessionId);
  if (!s) {
    imageUploads.delete(key);
    await message.reply("A sessão do configurador expirou. Abra `/configds` de novo.").catch(() => null);
    return true;
  }

  const panel = getPanel(s.guildId, s.scopeId);
  const label = imageUploadTargetLabel(pending, panel);
  const savedImage = await saveAttachmentAsDiscordImage(message.channel, attachment, label);

  if (pending.target === "panelImage") {
    panel.imageUrl = savedImage.url;
  } else if (pending.target === "panelThumb") {
    panel.thumbnailUrl = savedImage.url;
  } else if (pending.target === "product") {
    const p = product(panel, pending.productId);
    if (!p) {
      imageUploads.delete(key);
      await message.reply("Não achei mais esse produto. Reabra o configurador e tente de novo.").catch(() => null);
      return true;
    }
    p.imageUrl = savedImage.url;
  }

  savePanel(s.guildId, panel, s.scopeId);
  imageUploads.delete(key);
  await refreshConfig(pending.sessionId);

  const publishedUpdated = ["panelImage", "panelThumb"].includes(pending.target)
    ? await updatePublishedPanel(message.guild, panel)
    : false;
  const quickUpdated = ["panelImage", "panelThumb"].includes(pending.target)
    ? await updatePublishedQuickOrder(message.guild, panel)
    : false;
  const publishedText = [
    publishedUpdated ? "Painel publicado atualizado também." : "",
    quickUpdated ? "Mensagem de compra publicada atualizada também." : ""
  ].filter(Boolean).join("\n");

  await message.reply(`Imagem salva como **${label}**.\n${savedImage.note}${publishedText ? `\n${publishedText}` : ""}`).catch(() => null);
  return true;
}

client.once("ready", () => console.log(`Bot online como ${client.user.tag}`));

client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild) return;
  if (await handlePendingImageUpload(message)) return;
  const content = message.content.trim().toLowerCase();

  if (content === `${config.prefix || "!"}configds`) {
    await message.delete().catch(() => null);
    return startConfig(message.channel, message.member, message.author);
  }

  if (content === `${config.prefix || "!"}atendimento`) {
    await message.delete().catch(() => null);
    return setupStaffPanel(message);
  }

  if (content === `${config.prefix || "!"}configpix`) {
    if (!isAdmin(message.member)) return message.reply("Só ADM pode configurar Pix.");
    await message.delete().catch(() => null);
    const reply = await message.channel.send({
      content: `<@${message.author.id}> clique no botão abaixo para abrir o formulário do Pix. Se o Discord não mostrar os comandos com \`/\`, esse botão resolve.`,
      components: pixShortcutRows()
    });
    setTimeout(() => reply.delete().catch(() => null), 2 * 60 * 1000);
    return;
  }

  if (content === `${config.prefix || "!"}status-loja`) {
    if (!isAdmin(message.member)) return message.reply("Só ADM pode ver o status da loja.");
    await message.delete().catch(() => null);
    const sent = await sendSafeDM(message.author.id, { embeds: [buildStoreStatusEmbed(message.guild.id, message.channel.id)] });
    return message.channel.send(sent
      ? `<@${message.author.id}> enviei o status da loja no seu privado.`
      : `<@${message.author.id}> não consegui mandar DM. Use \`/status-loja\` para ver em modo privado.`);
  }
});

client.on("interactionCreate", async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "configds") {
        if (!await requireAdminInteraction(interaction, "Você precisa ser ADM para abrir o configurador da loja.")) return;
        await interaction.reply({ content: "Abri o configurador neste canal.", ephemeral: true });
        return startConfig(interaction.channel, interaction.member, interaction.user);
      }
      if (interaction.commandName === "setup-ticket") return setupTicket(interaction);
      if (interaction.commandName === "setup-atendimento") return setupStaffPanel(interaction);
      if (interaction.commandName === "configpix") {
        if (!await requireAdminInteraction(interaction, "Você precisa ser ADM para configurar Pix.")) return;
        return interaction.showModal(pixConfigModal(interaction.guildId, interaction.user));
      }
      if (interaction.commandName === "status-loja") {
        if (!await requireAdminInteraction(interaction, "Você precisa ser ADM para ver o status da loja.")) return;
        return interaction.reply({ embeds: [buildStoreStatusEmbed(interaction.guildId, interaction.channelId)], ephemeral: true });
      }
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("cfg:")) return handleConfigButton(interaction);
      if (interaction.customId.startsWith("staff:")) return handleStaffButton(interaction);
      if (interaction.customId.startsWith("quickbuy:")) {
        const [, panelId] = interaction.customId.split(":");
        return handleQuickBuyButton(interaction, panelId);
      }
      if (interaction.customId === "openticket") return openTicket(interaction);
      const [act, id] = interaction.customId.split(":");
      if (act === "call") return callAdmin(interaction, id, "order");
      if (act === "view") return viewCart(interaction, id);
      if (act === "finish") return finishCart(interaction, id);
      if (act === "assume") return assumeOrder(interaction, id);
      if (act === "sendpix") return resendPix(interaction, id);
      if (act === "tcall") return callAdmin(interaction, id, "ticket");
      if (act === "tclose") return closeTicket(interaction, id);
    }
    if (interaction.isModalSubmit() && interaction.customId === "pixmodal") return handlePixModal(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("quickmodal:")) return handleQuickOrderSubmit(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith("modal:")) return handleModal(interaction);
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("preset:")) return handlePresetSelect(interaction);
      if (interaction.customId.startsWith("remove:")) return handleRemove(interaction);
      if (interaction.customId.startsWith("edit:")) return handleEditProduct(interaction);
      if (interaction.customId.startsWith("uploadpanel:")) return handlePanelImageUploadTarget(interaction);
      if (interaction.customId.startsWith("uploadproduct:")) return handleProductImageUploadTarget(interaction);
      if (interaction.customId.startsWith("buy:")) return openCart(interaction);
      if (interaction.customId.startsWith("cartadd:")) return addCart(interaction);
    }
  } catch (err) {
    console.error(err);
    const payload = { content: `Erro: \`${err.message}\``, ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => null);
    else await interaction.reply(payload).catch(() => null);
  }
});

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error("DISCORD_TOKEN não configurado.");
  process.exit(1);
}
client.login(token);
