const assert = require("node:assert/strict");
const { ChannelType, Collection, PermissionsBitField } = require("discord.js");
const { createServerBackup, restoreServerBackup, validateServerBackup } = require("../src/serverBackup");

function fakeRole(id, name, position, permissions = "0") {
  return {
    id,
    name,
    rawPosition: position,
    managed: false,
    color: 0,
    hoist: false,
    mentionable: false,
    unicodeEmoji: null,
    permissions: new PermissionsBitField(BigInt(permissions)),
    edit: async () => null,
    setPermissions: async () => null
  };
}

function sourceGuild() {
  const roles = new Collection([
    ["source", fakeRole("source", "@everyone", 0)],
    ["role-client", fakeRole("role-client", "Cliente", 1, "1024")]
  ]);
  const overwrites = { cache: new Collection() };
  const channels = new Collection([
    ["category", {
      id: "category",
      name: "LOJA",
      type: ChannelType.GuildCategory,
      rawPosition: 0,
      parentId: null,
      permissionOverwrites: overwrites
    }],
    ["products", {
      id: "products",
      name: "produtos",
      type: ChannelType.GuildText,
      rawPosition: 1,
      parentId: "category",
      topic: "Catalogo",
      nsfw: false,
      rateLimitPerUser: 0,
      defaultAutoArchiveDuration: 1440,
      defaultThreadRateLimitPerUser: 0,
      permissionOverwrites: overwrites
    }]
  ]);
  return {
    id: "source",
    name: "Loja origem",
    description: "Teste",
    iconURL: () => "",
    bannerURL: () => "",
    splashURL: () => "",
    verificationLevel: 0,
    explicitContentFilter: 0,
    defaultMessageNotifications: 0,
    afkTimeout: 300,
    preferredLocale: "pt-BR",
    features: [],
    systemChannelId: "products",
    systemChannelFlags: new PermissionsBitField(0n),
    afkChannelId: null,
    rulesChannelId: null,
    publicUpdatesChannelId: null,
    roles: { fetch: async () => roles, everyone: roles.get("source") },
    channels: { fetch: async () => channels },
    emojis: { fetch: async () => new Collection() },
    stickers: { fetch: async () => new Collection() }
  };
}

function targetGuild() {
  let sequence = 0;
  const roles = new Collection();
  const everyone = fakeRole("target", "@everyone", 0);
  roles.set(everyone.id, everyone);
  const channels = new Collection();
  return {
    id: "target",
    name: "Destino",
    roles: {
      cache: roles,
      everyone,
      create: async options => {
        const role = fakeRole(`role-${++sequence}`, options.name, sequence, String(options.permissions || 0));
        roles.set(role.id, role);
        return role;
      },
      setPositions: async () => null
    },
    channels: {
      cache: channels,
      create: async options => {
        const channel = {
          id: `channel-${++sequence}`,
          name: options.name,
          type: options.type,
          parentId: options.parent || null,
          edit: async () => null
        };
        channels.set(channel.id, channel);
        return channel;
      },
      setPositions: async () => null
    },
    emojis: { cache: new Collection(), create: async () => null },
    stickers: { cache: new Collection(), create: async () => null },
    members: { fetch: async () => ({ roles: { add: async () => null } }) },
    setName: async () => null,
    edit: async () => null,
    setIcon: async () => null,
    setBanner: async () => null,
    setSplash: async () => null
  };
}

async function main() {
  const payload = await createServerBackup(sourceGuild(), { store: { panels: [] } });
  assert.equal(payload.format, "dragon-store-server-backup");
  assert.equal(payload.roles.length, 1);
  assert.equal(payload.channels.length, 2);
  assert.throws(() => validateServerBackup({ format: "invalido" }));

  const restored = await restoreServerBackup(targetGuild(), payload, {
    ceoUserId: "ceo-user",
    allowedMemberIds: ["ceo-user"]
  });
  assert.equal(restored.roleMap.size, 1);
  assert.equal(restored.channelMap.size, 2);
  assert.deepEqual(restored.report.failures, []);
  console.log("Server backup smoke test passed.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
