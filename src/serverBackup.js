const { ChannelType, PermissionFlagsBits } = require("discord.js");

const BACKUP_FORMAT = "dragon-store-server-backup";
const BACKUP_VERSION = 1;
const SUPPORTED_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildCategory,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum
]);

function bitfield(value) {
  try {
    return BigInt(String(value || "0"));
  } catch {
    return 0n;
  }
}

function serializeOverwrite(overwrite, guildId, allowedMemberIds) {
  const isRole = Number(overwrite.type) === 0;
  if (!isRole && !allowedMemberIds.has(overwrite.id)) return null;
  return {
    id: overwrite.id === guildId ? "@everyone" : overwrite.id,
    type: isRole ? "role" : "member",
    allow: String(overwrite.allow?.bitfield || 0n),
    deny: String(overwrite.deny?.bitfield || 0n)
  };
}

function serializeChannel(channel, guildId, allowedMemberIds) {
  const overwrites = [...(channel.permissionOverwrites?.cache?.values?.() || [])]
    .map(overwrite => serializeOverwrite(overwrite, guildId, allowedMemberIds))
    .filter(Boolean);
  const base = {
    sourceId: channel.id,
    name: channel.name,
    type: channel.type,
    position: Number(channel.rawPosition || 0),
    parentId: channel.parentId || "",
    permissionOverwrites: overwrites
  };

  if ([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(channel.type)) {
    base.topic = channel.topic || "";
    base.nsfw = Boolean(channel.nsfw);
    base.rateLimitPerUser = Number(channel.rateLimitPerUser || 0);
    base.defaultAutoArchiveDuration = channel.defaultAutoArchiveDuration || undefined;
    base.defaultThreadRateLimitPerUser = Number(channel.defaultThreadRateLimitPerUser || 0);
  }
  if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) {
    base.bitrate = Number(channel.bitrate || 64000);
    base.userLimit = Number(channel.userLimit || 0);
    base.rtcRegion = channel.rtcRegion || null;
    base.videoQualityMode = channel.videoQualityMode || undefined;
  }
  if (channel.type === ChannelType.GuildForum) {
    base.defaultForumLayout = channel.defaultForumLayout ?? undefined;
    base.defaultSortOrder = channel.defaultSortOrder ?? undefined;
    base.availableTags = (channel.availableTags || []).slice(0, 20).map(tag => ({
      name: tag.name,
      moderated: Boolean(tag.moderated),
      emoji: tag.emoji ? { id: tag.emoji.id || null, name: tag.emoji.name || null } : null
    }));
    base.defaultReactionEmoji = channel.defaultReactionEmoji ? {
      id: channel.defaultReactionEmoji.id || null,
      name: channel.defaultReactionEmoji.name || null
    } : null;
  }
  return base;
}

async function createServerBackup(guild, options = {}) {
  const excludedChannelIds = new Set(options.excludedChannelIds || []);
  const allowedMemberIds = new Set(options.allowedMemberIds || []);
  const roles = await guild.roles.fetch();
  const channels = await guild.channels.fetch();
  const emojis = await guild.emojis.fetch().catch(() => new Map());
  const stickers = await guild.stickers.fetch().catch(() => new Map());

  const roleData = [...roles.values()]
    .filter(role => role && role.id !== guild.id && !role.managed)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map(role => ({
      sourceId: role.id,
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: String(role.permissions.bitfield),
      position: role.rawPosition,
      unicodeEmoji: role.unicodeEmoji || null
    }));

  const channelData = [...channels.values()]
    .filter(channel => channel && SUPPORTED_CHANNEL_TYPES.has(channel.type) && !excludedChannelIds.has(channel.id))
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map(channel => serializeChannel(channel, guild.id, allowedMemberIds));

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    sourceGuildId: guild.id,
    sourceGuildName: guild.name,
    guild: {
      name: guild.name,
      description: guild.description || "",
      iconUrl: guild.iconURL({ extension: "png", size: 1024 }) || "",
      bannerUrl: guild.bannerURL({ extension: "png", size: 2048 }) || "",
      splashUrl: guild.splashURL({ extension: "png", size: 2048 }) || "",
      verificationLevel: guild.verificationLevel,
      explicitContentFilter: guild.explicitContentFilter,
      defaultMessageNotifications: guild.defaultMessageNotifications,
      afkTimeout: guild.afkTimeout,
      preferredLocale: guild.preferredLocale,
      features: [...(guild.features || [])],
      systemChannelId: guild.systemChannelId || "",
      systemChannelFlags: String(guild.systemChannelFlags?.bitfield || 0n),
      afkChannelId: guild.afkChannelId || "",
      rulesChannelId: guild.rulesChannelId || "",
      publicUpdatesChannelId: guild.publicUpdatesChannelId || "",
      everyonePermissions: String(guild.roles.everyone.permissions.bitfield)
    },
    roles: roleData,
    channels: channelData,
    emojis: [...emojis.values()].filter(Boolean).slice(0, 100).map(emoji => ({
      name: emoji.name,
      animated: Boolean(emoji.animated),
      url: emoji.imageURL({ extension: emoji.animated ? "gif" : "png", size: 256 })
    })),
    stickers: [...stickers.values()].filter(Boolean).slice(0, 15).map(sticker => ({
      name: sticker.name,
      description: sticker.description || "",
      tags: sticker.tags || "dragon-store",
      url: sticker.url
    })),
    store: options.store || {}
  };
}

function validateServerBackup(payload) {
  if (!payload || payload.format !== BACKUP_FORMAT || payload.version !== BACKUP_VERSION) {
    throw new Error("Arquivo de backup Dragon Store invalido ou incompativel.");
  }
  if (!Array.isArray(payload.roles) || payload.roles.length > 250) throw new Error("Lista de cargos invalida.");
  if (!Array.isArray(payload.channels) || payload.channels.length > 500) throw new Error("Lista de canais invalida.");
  if (!Array.isArray(payload.emojis) || payload.emojis.length > 250) throw new Error("Lista de emojis invalida.");
  if (payload.stickers !== undefined && (!Array.isArray(payload.stickers) || payload.stickers.length > 30)) throw new Error("Lista de stickers invalida.");
  if (!Array.isArray(payload.stickers)) payload.stickers = [];
  return payload;
}

function mappedOverwrites(items, guild, roleMap, allowedMemberIds) {
  return (Array.isArray(items) ? items : []).flatMap(item => {
    if (item?.type === "role") {
      const id = item.id === "@everyone" ? guild.id : roleMap.get(String(item.id));
      return id ? [{ id, allow: bitfield(item.allow), deny: bitfield(item.deny) }] : [];
    }
    const memberId = String(item?.id || "");
    return allowedMemberIds.has(memberId)
      ? [{ id: memberId, allow: bitfield(item.allow), deny: bitfield(item.deny) }]
      : [];
  });
}

function reusableRole(guild, sourceRole) {
  return guild.roles.cache.find(role => !role.managed && role.id !== guild.id && role.name === sourceRole.name) || null;
}

function reusableChannel(guild, sourceChannel, parentId) {
  return guild.channels.cache.find(channel =>
    channel.type === sourceChannel.type &&
    channel.name === sourceChannel.name &&
    String(channel.parentId || "") === String(parentId || "")
  ) || null;
}

function channelCreateOptions(source, guild, roleMap, channelMap, allowedMemberIds) {
  const parent = source.parentId ? channelMap.get(String(source.parentId)) : null;
  const options = {
    name: String(source.name || "canal").slice(0, 100),
    type: source.type,
    permissionOverwrites: mappedOverwrites(source.permissionOverwrites, guild, roleMap, allowedMemberIds),
    reason: "Restauracao de backup Dragon Store"
  };
  if (parent) options.parent = parent;
  if ([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(source.type)) {
    options.topic = String(source.topic || "").slice(0, 1024) || undefined;
    options.nsfw = Boolean(source.nsfw);
    options.rateLimitPerUser = Math.max(0, Number(source.rateLimitPerUser || 0));
    options.defaultAutoArchiveDuration = source.defaultAutoArchiveDuration || undefined;
    options.defaultThreadRateLimitPerUser = Math.max(0, Number(source.defaultThreadRateLimitPerUser || 0));
  }
  if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(source.type)) {
    options.bitrate = Math.max(8000, Number(source.bitrate || 64000));
    options.userLimit = Math.max(0, Number(source.userLimit || 0));
    options.rtcRegion = source.rtcRegion || null;
    options.videoQualityMode = source.videoQualityMode || undefined;
  }
  if (source.type === ChannelType.GuildForum) {
    options.availableTags = Array.isArray(source.availableTags)
      ? source.availableTags.slice(0, 20).map(tag => ({
        name: String(tag.name || "Tag").slice(0, 20),
        moderated: Boolean(tag.moderated),
        emoji: tag.emoji?.id ? null : (tag.emoji || null)
      }))
      : [];
    options.defaultReactionEmoji = source.defaultReactionEmoji?.id ? undefined : (source.defaultReactionEmoji || undefined);
    options.defaultForumLayout = source.defaultForumLayout ?? undefined;
    options.defaultSortOrder = source.defaultSortOrder ?? undefined;
  }
  return options;
}

async function syncReusableChannel(channel, source, guild, roleMap, channelMap, allowedMemberIds) {
  const options = channelCreateOptions(source, guild, roleMap, channelMap, allowedMemberIds);
  const editable = { ...options, parent: options.parent || null };
  delete editable.type;
  delete editable.name;
  await channel.edit(editable);
}

async function fetchImage(url) {
  if (!url) return null;
  try {
    const parsed = new URL(String(url));
    const trusted = parsed.protocol === "https:" && ["discordapp.com", "discordapp.net", "discord.com"].some(domain =>
      parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)
    );
    if (!trusted) return null;
  } catch {
    return null;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes.length <= 10 * 1024 * 1024 ? bytes : null;
}

async function restoreServerBackup(guild, rawPayload, options = {}) {
  const payload = validateServerBackup(rawPayload);
  const report = { rolesCreated: 0, rolesReused: 0, channelsCreated: 0, channelsReused: 0, emojisCreated: 0, stickersCreated: 0, failures: [] };
  const roleMap = new Map();
  const channelMap = new Map();
  const allowedMemberIds = new Set(options.allowedMemberIds || []);
  const progress = typeof options.onProgress === "function" ? options.onProgress : async () => {};

  await progress("Atualizando identidade do servidor...");
  await guild.setName(String(payload.guild?.name || guild.name).slice(0, 100), "Restauracao de backup Dragon Store")
    .catch(error => report.failures.push(`Nome do servidor: ${error.message}`));
  await guild.edit({
    verificationLevel: payload.guild?.verificationLevel,
    explicitContentFilter: payload.guild?.explicitContentFilter,
    defaultMessageNotifications: payload.guild?.defaultMessageNotifications,
    afkTimeout: payload.guild?.afkTimeout,
    preferredLocale: payload.guild?.preferredLocale,
    reason: "Restauracao de backup Dragon Store"
  }).catch(error => report.failures.push(`Servidor: ${error.message}`));
  if (payload.guild?.description) {
    await guild.edit({ description: String(payload.guild.description).slice(0, 120), reason: "Restauracao de backup Dragon Store" })
      .catch(error => report.failures.push(`Descricao: ${error.message}`));
  }
  if (payload.guild?.iconUrl) {
    const icon = await fetchImage(payload.guild.iconUrl).catch(() => null);
    if (icon) await guild.setIcon(icon, "Restauracao de backup Dragon Store").catch(error => report.failures.push(`Icone: ${error.message}`));
  }
  if (payload.guild?.bannerUrl) {
    const banner = await fetchImage(payload.guild.bannerUrl).catch(() => null);
    if (banner) await guild.setBanner(banner, "Restauracao de backup Dragon Store").catch(error => report.failures.push(`Banner: ${error.message}`));
  }
  if (payload.guild?.splashUrl) {
    const splash = await fetchImage(payload.guild.splashUrl).catch(() => null);
    if (splash) await guild.setSplash(splash, "Restauracao de backup Dragon Store").catch(error => report.failures.push(`Splash: ${error.message}`));
  }
  if (payload.guild?.everyonePermissions) {
    await guild.roles.everyone.setPermissions(bitfield(payload.guild.everyonePermissions), "Restauracao de backup Dragon Store")
      .catch(error => report.failures.push(`@everyone: ${error.message}`));
  }

  await progress("Criando cargos...");
  for (const source of [...payload.roles].sort((a, b) => Number(a.position || 0) - Number(b.position || 0))) {
    try {
      let role = reusableRole(guild, source);
      if (role) {
        report.rolesReused += 1;
        await role.edit({
          color: Number(source.color || 0),
          hoist: Boolean(source.hoist),
          mentionable: Boolean(source.mentionable),
          permissions: bitfield(source.permissions),
          unicodeEmoji: source.unicodeEmoji || null,
          reason: "Restauracao de backup Dragon Store"
        });
      } else {
        role = await guild.roles.create({
          name: String(source.name || "Cargo").slice(0, 100),
          color: Number(source.color || 0),
          hoist: Boolean(source.hoist),
          mentionable: Boolean(source.mentionable),
          permissions: bitfield(source.permissions),
          unicodeEmoji: source.unicodeEmoji || undefined,
          reason: "Restauracao de backup Dragon Store"
        });
        report.rolesCreated += 1;
      }
      roleMap.set(String(source.sourceId), role.id);
    } catch (error) {
      report.failures.push(`Cargo ${source.name}: ${error.message}`);
    }
  }
  const rolePositions = payload.roles.flatMap(source => {
    const targetId = roleMap.get(String(source.sourceId));
    return targetId ? [{ role: targetId, position: Math.max(1, Number(source.position || 1)) }] : [];
  });
  if (rolePositions.length) {
    await guild.roles.setPositions(rolePositions).catch(error => report.failures.push(`Ordem dos cargos: ${error.message}`));
  }

  const ceoUserId = String(options.ceoUserId || "").trim();
  let ceoRole = guild.roles.cache.find(role => !role.managed && role.name === "CEO") || null;
  try {
    if (!ceoRole) {
      ceoRole = await guild.roles.create({
        name: "CEO",
        color: 0x28f6a1,
        hoist: true,
        mentionable: false,
        permissions: PermissionFlagsBits.Administrator,
        reason: "CEO da instalacao Dragon Store"
      });
      report.rolesCreated += 1;
    }
    await ceoRole.setPermissions(PermissionFlagsBits.Administrator, "CEO da instalacao Dragon Store");
    if (ceoUserId) {
      const member = await guild.members.fetch(ceoUserId);
      await member.roles.add(ceoRole, "CEO da instalacao Dragon Store");
    }
  } catch (error) {
    report.failures.push(`CEO: ${error.message}`);
  }

  await progress("Criando categorias e canais...");
  const categories = payload.channels.filter(channel => channel.type === ChannelType.GuildCategory);
  const basicChannels = payload.channels.filter(channel => ![
    ChannelType.GuildCategory,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum
  ].includes(channel.type));
  const communityChannels = payload.channels.filter(channel => [ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(channel.type));
  async function restoreChannels(channelsToRestore) {
    for (const source of channelsToRestore) {
      if (!SUPPORTED_CHANNEL_TYPES.has(source.type)) continue;
      try {
        const parentId = source.parentId ? channelMap.get(String(source.parentId)) : null;
        let channel = reusableChannel(guild, source, parentId);
        if (channel) {
          report.channelsReused += 1;
          await syncReusableChannel(channel, source, guild, roleMap, channelMap, allowedMemberIds)
            .catch(error => report.failures.push(`Atualizar canal ${source.name}: ${error.message}`));
        } else {
          channel = await guild.channels.create(channelCreateOptions(source, guild, roleMap, channelMap, allowedMemberIds));
          report.channelsCreated += 1;
        }
        channelMap.set(String(source.sourceId), channel.id);
      } catch (error) {
        if ([ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(source.type)) {
          try {
            const fallback = { ...source, type: ChannelType.GuildText };
            const channel = await guild.channels.create(channelCreateOptions(fallback, guild, roleMap, channelMap, allowedMemberIds));
            channelMap.set(String(source.sourceId), channel.id);
            report.channelsCreated += 1;
            report.failures.push(`Canal ${source.name}: criado como texto porque o tipo original falhou (${error.message}).`);
            continue;
          } catch (fallbackError) {
            report.failures.push(`Canal ${source.name}: ${fallbackError.message}`);
            continue;
          }
        }
        report.failures.push(`Canal ${source.name}: ${error.message}`);
      }
    }
  }
  await restoreChannels(categories);
  await restoreChannels(basicChannels);

  if ((payload.guild?.features || []).includes("COMMUNITY")) {
    const rulesChannel = channelMap.get(String(payload.guild.rulesChannelId || ""));
    const publicUpdatesChannel = channelMap.get(String(payload.guild.publicUpdatesChannelId || ""));
    if (rulesChannel && publicUpdatesChannel) {
      await guild.edit({
        features: ["COMMUNITY"],
        rulesChannel,
        publicUpdatesChannel,
        reason: "Restauracao de comunidade Dragon Store"
      }).catch(error => report.failures.push(`Comunidade: ${error.message}`));
    }
  }
  await restoreChannels(communityChannels);

  const channelPositions = payload.channels.flatMap(source => {
    const targetId = channelMap.get(String(source.sourceId));
    if (!targetId) return [];
    const parentId = source.parentId ? channelMap.get(String(source.parentId)) : null;
    return [{ channel: targetId, position: Math.max(0, Number(source.position || 0)), parent: parentId || null, lockPermissions: false }];
  });
  if (channelPositions.length) {
    await guild.channels.setPositions(channelPositions).catch(error => report.failures.push(`Ordem dos canais: ${error.message}`));
  }

  const systemChannel = channelMap.get(String(payload.guild?.systemChannelId || ""));
  const afkChannel = channelMap.get(String(payload.guild?.afkChannelId || ""));
  const rulesChannel = channelMap.get(String(payload.guild?.rulesChannelId || ""));
  const publicUpdatesChannel = channelMap.get(String(payload.guild?.publicUpdatesChannelId || ""));
  await guild.edit({
    systemChannel: systemChannel || undefined,
    systemChannelFlags: payload.guild?.systemChannelFlags ? bitfield(payload.guild.systemChannelFlags) : undefined,
    afkChannel: afkChannel || undefined,
    rulesChannel: rulesChannel || undefined,
    publicUpdatesChannel: publicUpdatesChannel || undefined,
    reason: "Restauracao de canais especiais Dragon Store"
  }).catch(error => report.failures.push(`Canais especiais: ${error.message}`));

  await progress("Copiando emojis...");
  for (const source of payload.emojis.slice(0, 100)) {
    if (!source?.name || !source?.url || guild.emojis.cache.some(emoji => emoji.name === source.name)) continue;
    try {
      await guild.emojis.create({ attachment: source.url, name: source.name, reason: "Restauracao de backup Dragon Store" });
      report.emojisCreated += 1;
    } catch (error) {
      report.failures.push(`Emoji ${source.name}: ${error.message}`);
    }
  }

  await progress("Copiando stickers...");
  for (const source of payload.stickers.slice(0, 15)) {
    if (!source?.name || !source?.url || guild.stickers.cache.some(sticker => sticker.name === source.name)) continue;
    try {
      const file = await fetchImage(source.url);
      if (!file) throw new Error("arquivo indisponivel");
      await guild.stickers.create({
        file,
        name: String(source.name).slice(0, 30),
        description: String(source.description || "").slice(0, 100) || null,
        tags: String(source.tags || "dragon-store").slice(0, 200),
        reason: "Restauracao de backup Dragon Store"
      });
      report.stickersCreated += 1;
    } catch (error) {
      report.failures.push(`Sticker ${source.name}: ${error.message}`);
    }
  }

  return { report, roleMap, channelMap, ceoRoleId: ceoRole?.id || "", payload };
}

module.exports = {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  createServerBackup,
  restoreServerBackup,
  validateServerBackup
};
