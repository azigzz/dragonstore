function cleanInstanceId(value) {
  return String(value || "primary")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "primary";
}

const STORE_INSTANCE_ID = cleanInstanceId(process.env.STORE_INSTANCE_ID);
const PRIMARY_GUILD_ID = String(process.env.GUILD_ID || process.env.MAIN_GUILD_ID || "").trim();
const STRICT_GUILD_ISOLATION = process.env.STRICT_GUILD_ISOLATION !== "false";
function isolatedStoragePrefix(value = "") {
  const base = String(value || "dragon-store:bot").trim().replace(/:+$/g, "") || "dragon-store:bot";
  if (STORE_INSTANCE_ID === "primary") return base;
  const suffix = `:${STORE_INSTANCE_ID}`;
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}
const DEFAULT_STORAGE_PREFIX = isolatedStoragePrefix();

function acceptsGuild(guildId) {
  if (!STRICT_GUILD_ISOLATION || !PRIMARY_GUILD_ID) return true;
  return String(guildId || "") === PRIMARY_GUILD_ID;
}

function installationSummary() {
  return {
    instanceId: STORE_INSTANCE_ID,
    guildId: PRIMARY_GUILD_ID,
    strictGuildIsolation: STRICT_GUILD_ISOLATION,
    storagePrefix: DEFAULT_STORAGE_PREFIX
  };
}

module.exports = {
  DEFAULT_STORAGE_PREFIX,
  PRIMARY_GUILD_ID,
  STORE_INSTANCE_ID,
  STRICT_GUILD_ISOLATION,
  acceptsGuild,
  cleanInstanceId,
  installationSummary,
  isolatedStoragePrefix
};
