const { ChannelType, PermissionFlagsBits } = require("discord.js");

const SETUP_REASON = "Setup automatico Dragon Store";

function roleById(guild, roleId) {
  return roleId ? guild.roles.cache.get(String(roleId)) || null : null;
}

function channelById(guild, channelId, types = []) {
  const channel = channelId ? guild.channels.cache.get(String(channelId)) || null : null;
  if (!channel || (types.length && !types.includes(channel.type))) return null;
  return channel;
}

function namedRole(guild, name) {
  return guild.roles.cache.find(role => !role.managed && role.id !== guild.id && role.name.toLowerCase() === name.toLowerCase()) || null;
}

function namedChannel(guild, name, types, parentId = "") {
  return guild.channels.cache.find(channel =>
    types.includes(channel.type) &&
    channel.name.toLowerCase() === name.toLowerCase() &&
    (!parentId || channel.parentId === parentId)
  ) || null;
}

async function ensureRole(guild, currentId, spec, report) {
  let role = roleById(guild, currentId) || namedRole(guild, spec.name);
  if (role) {
    report.reused.push(`Cargo ${role.name}`);
    return role;
  }
  role = await guild.roles.create({ ...spec, reason: SETUP_REASON });
  report.created.push(`Cargo ${role.name}`);
  return role;
}

async function ensureCategory(guild, currentId, name, overwrites, report) {
  let channel = channelById(guild, currentId, [ChannelType.GuildCategory]) ||
    namedChannel(guild, name, [ChannelType.GuildCategory]);
  if (channel) {
    report.reused.push(`Categoria ${channel.name}`);
    return channel;
  }
  channel = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
    reason: SETUP_REASON
  });
  report.created.push(`Categoria ${channel.name}`);
  return channel;
}

async function ensureChannel(guild, currentId, spec, report) {
  const types = [spec.type];
  let channel = channelById(guild, currentId, types) || namedChannel(guild, spec.name, types, spec.parent || "");
  if (channel) {
    report.reused.push(`Canal ${channel.name}`);
    return channel;
  }
  channel = await guild.channels.create({ ...spec, reason: SETUP_REASON });
  report.created.push(`Canal ${channel.name}`);
  return channel;
}

function privateOverwrites(guild, adminRoleId, botUserId) {
  return [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    ...(adminRoleId ? [{
      id: adminRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages]
    }] : []),
    ...(botUserId ? [{
      id: botUserId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks]
    }] : [])
  ];
}

function statusVoiceOverwrites(guild, adminRoleId, botUserId) {
  return [
    { id: guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
    ...(adminRoleId ? [{ id: adminRoleId, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] }] : []),
    ...(botUserId ? [{ id: botUserId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] }] : [])
  ];
}

function currentSetupSummary(guild, current = {}) {
  const checks = [
    ["Cargo CEO/ADM", roleById(guild, current.adminRoleId)],
    ["Cargo Cliente", roleById(guild, current.customerRoleId)],
    ["Cargo Premium", roleById(guild, current.resellerRoleId)],
    ["Categoria Carrinhos", channelById(guild, current.cartOpenCategoryId, [ChannelType.GuildCategory])],
    ["Categoria Finalizados", channelById(guild, current.closedCategoryId, [ChannelType.GuildCategory])],
    ["Categoria Tickets", channelById(guild, current.ticketOpenCategoryId, [ChannelType.GuildCategory])],
    ["Canal Atendimento", channelById(guild, current.staffPanelChannelId, [ChannelType.GuildText, ChannelType.GuildAnnouncement])],
    ["Canal Vendas", channelById(guild, current.completionChannelId, [ChannelType.GuildText, ChannelType.GuildAnnouncement])],
    ["Canal Avaliacoes", channelById(guild, current.reviewChannelId, [ChannelType.GuildText, ChannelType.GuildAnnouncement])],
    ["Canal Cancelamentos", channelById(guild, current.cancellationChannelId, [ChannelType.GuildText, ChannelType.GuildAnnouncement])],
    ["Canal Suporte", channelById(guild, current.ticketPanelChannelId, [ChannelType.GuildText, ChannelType.GuildAnnouncement])],
    ["Call de status", channelById(guild, current.statusVoiceChannelId, [ChannelType.GuildVoice, ChannelType.GuildStageVoice])]
  ];
  return checks.map(([label, resource]) => ({ label, ready: Boolean(resource), id: resource?.id || "" }));
}

async function provisionStoreSetup(guild, current = {}, options = {}) {
  await guild.roles.fetch();
  await guild.channels.fetch();
  const report = { created: [], reused: [] };
  const progress = typeof options.onProgress === "function" ? options.onProgress : async () => {};
  const ceoUserId = String(options.ceoUserId || "").trim();
  const botUserId = String(options.botUserId || "").trim();

  await progress("Preparando cargos...");
  const ceoRole = await ensureRole(guild, current.adminRoleId, {
    name: "CEO",
    color: 0x28f6a1,
    hoist: true,
    mentionable: false,
    permissions: PermissionFlagsBits.Administrator
  }, report);
  if (ceoUserId) {
    const member = await guild.members.fetch(ceoUserId);
    await member.roles.add(ceoRole, SETUP_REASON);
  }
  const customerRole = await ensureRole(guild, current.customerRoleId, {
    name: "Cliente",
    color: 0x57f287,
    hoist: false,
    mentionable: false,
    permissions: []
  }, report);
  const resellerRole = await ensureRole(guild, current.resellerRoleId, {
    name: "Premium",
    color: 0xfee75c,
    hoist: true,
    mentionable: false,
    permissions: []
  }, report);

  const privatePermissions = privateOverwrites(guild, ceoRole.id, botUserId);
  await progress("Preparando categorias...");
  const storeCategory = await ensureCategory(guild, current.storeCategoryId, "LOJA", [], report);
  const cartCategory = await ensureCategory(guild, current.cartOpenCategoryId, "CARRINHOS", privatePermissions, report);
  const closedCategory = await ensureCategory(guild, current.closedCategoryId, "FINALIZADOS", privatePermissions, report);
  const ticketCategory = await ensureCategory(guild, current.ticketOpenCategoryId, "TICKETS", privatePermissions, report);

  await progress("Preparando canais da operacao...");
  const products = await ensureChannel(guild, current.productsChannelId, {
    name: "produtos",
    type: ChannelType.GuildText,
    parent: storeCategory.id,
    topic: "Catalogo e paineis de produtos da loja."
  }, report);
  const staffPanel = await ensureChannel(guild, current.staffPanelChannelId, {
    name: "painel-atendimento",
    type: ChannelType.GuildText,
    parent: storeCategory.id,
    topic: "Painel privado de atendimento e disponibilidade da equipe.",
    permissionOverwrites: privatePermissions
  }, report);
  const completion = await ensureChannel(guild, current.completionChannelId, {
    name: "vendas-concluidas",
    type: ChannelType.GuildText,
    parent: storeCategory.id,
    topic: "Feed publico de pedidos entregues."
  }, report);
  const review = await ensureChannel(guild, current.reviewChannelId, {
    name: "avaliacoes",
    type: ChannelType.GuildText,
    parent: storeCategory.id,
    topic: "Avaliacoes dos clientes da loja."
  }, report);
  const cancellation = await ensureChannel(guild, current.cancellationChannelId, {
    name: "compras-canceladas",
    type: ChannelType.GuildText,
    parent: storeCategory.id,
    topic: "Registro privado de compras canceladas.",
    permissionOverwrites: privatePermissions
  }, report);
  const ticketPanel = await ensureChannel(guild, current.ticketPanelChannelId, {
    name: "abrir-ticket",
    type: ChannelType.GuildText,
    parent: storeCategory.id,
    topic: "Abra um atendimento privado com a equipe."
  }, report);
  const statusVoice = await ensureChannel(guild, current.statusVoiceChannelId, {
    name: "status-da-loja",
    type: ChannelType.GuildVoice,
    parent: storeCategory.id,
    permissionOverwrites: statusVoiceOverwrites(guild, ceoRole.id, botUserId)
  }, report);

  return {
    report,
    roles: { adminRoleId: ceoRole.id, customerRoleId: customerRole.id, resellerRoleId: resellerRole.id },
    categories: {
      storeCategoryId: storeCategory.id,
      cartOpenCategoryId: cartCategory.id,
      closedCategoryId: closedCategory.id,
      ticketOpenCategoryId: ticketCategory.id
    },
    channels: {
      productsChannelId: products.id,
      staffPanelChannelId: staffPanel.id,
      completionChannelId: completion.id,
      reviewChannelId: review.id,
      cancellationChannelId: cancellation.id,
      ticketPanelChannelId: ticketPanel.id,
      statusVoiceChannelId: statusVoice.id
    }
  };
}

module.exports = { currentSetupSummary, provisionStoreSetup };
