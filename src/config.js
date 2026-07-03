const path = require("node:path");

// Variaveis para colocar no .env do bot:
// DISCORD_TOKEN=token_do_bot
// CLIENT_ID=id_da_aplicacao_discord
// CLIENT_SECRET=secret_da_aplicacao_discord
// REDIRECT_URI=https://seu-bot.onrender.com/auth/discord/callback
// MAIN_GUILD_ID=id_do_servidor_principal
// CLIENT_ROLE_ID=id_do_cargo_cliente_verificado
// BACKUP_GUILD_ID=id_do_servidor_reserva
// ADMIN_ROLE_ID=id_do_cargo_admin
// PORT=10000

const DATA_DIR = process.env.BOT_DATA_DIR || path.join(__dirname, "..", "data");

function requiredEnv(name) {
  return String(process.env[name] || "").trim();
}

function oauthStartUrl() {
  const redirectUri = requiredEnv("REDIRECT_URI");
  if (!redirectUri) return "";
  try {
    return new URL("/auth/discord/start", redirectUri).toString();
  } catch {
    return "";
  }
}

module.exports = {
  DATA_DIR,
  VERIFIED_USERS_FILE: path.join(DATA_DIR, "verifiedUsers.json"),
  DISCORD_TOKEN: requiredEnv("DISCORD_TOKEN"),
  CLIENT_ID: requiredEnv("CLIENT_ID"),
  CLIENT_SECRET: requiredEnv("CLIENT_SECRET"),
  REDIRECT_URI: requiredEnv("REDIRECT_URI"),
  MAIN_GUILD_ID: requiredEnv("MAIN_GUILD_ID") || requiredEnv("GUILD_ID"),
  CLIENT_ROLE_ID: requiredEnv("CLIENT_ROLE_ID"),
  BACKUP_GUILD_ID: requiredEnv("BACKUP_GUILD_ID"),
  ADMIN_ROLE_ID: requiredEnv("ADMIN_ROLE_ID"),
  PORT: process.env.PORT || 3000,
  oauthStartUrl
};
