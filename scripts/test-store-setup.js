const assert = require("node:assert/strict");
const { Collection } = require("discord.js");
const { currentSetupSummary, provisionStoreSetup } = require("../src/storeSetup");

function fakeGuild() {
  let sequence = 0;
  const roles = new Collection();
  const channels = new Collection();
  return {
    id: "guild-test",
    roles: {
      cache: roles,
      fetch: async () => roles,
      create: async options => {
        const role = {
          id: `role-${++sequence}`,
          name: options.name,
          managed: false
        };
        roles.set(role.id, role);
        return role;
      }
    },
    channels: {
      cache: channels,
      fetch: async () => channels,
      create: async options => {
        const channel = {
          id: `channel-${++sequence}`,
          name: options.name,
          type: options.type,
          parentId: options.parent || null
        };
        channels.set(channel.id, channel);
        return channel;
      }
    },
    members: {
      fetch: async () => ({ roles: { add: async () => null } })
    }
  };
}

function currentFromResult(result) {
  return {
    ...result.roles,
    ...result.categories,
    ...result.channels
  };
}

async function main() {
  const guild = fakeGuild();
  const first = await provisionStoreSetup(guild, {}, { ceoUserId: "ceo", botUserId: "bot" });
  assert.equal(first.report.created.length, 14);
  assert.equal(first.roles.adminRoleId.startsWith("role-"), true);
  assert.equal(first.channels.productsChannelId.startsWith("channel-"), true);

  const current = currentFromResult(first);
  const summary = currentSetupSummary(guild, current);
  assert.equal(summary.every(item => item.ready), true);

  const second = await provisionStoreSetup(guild, current, { ceoUserId: "ceo", botUserId: "bot" });
  assert.equal(second.report.created.length, 0);
  assert.equal(second.report.reused.length, 14);
  assert.equal(second.channels.productsChannelId, first.channels.productsChannelId);
  console.log("Store setup idempotency test passed.");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
