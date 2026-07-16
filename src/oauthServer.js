const crypto = require("node:crypto");
const express = require("express");
const {
  BACKUP_GUILD_ID,
  CLIENT_ID,
  CLIENT_ROLE_ID,
  CLIENT_SECRET,
  DISCORD_TOKEN,
  MAIN_GUILD_ID,
  PORT,
  REDIRECT_URI
} = require("./config");
const { listVerifiedUsers, upsertVerifiedUser } = require("./verifiedStore");

const DISCORD_API = "https://discord.com/api/v10";
const stateStore = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function htmlPage(title, message, ok = true) {
  const color = ok ? "#28f6a1" : "#ff6b6b";
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07090f;color:#f4f7fb;font-family:Inter,Arial,sans-serif}
    main{width:min(520px,calc(100% - 32px));border:1px solid rgba(255,255,255,.12);border-radius:14px;background:linear-gradient(135deg,rgba(255,255,255,.08),rgba(255,255,255,.03));padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.45)}
    .dot{width:46px;height:46px;border-radius:12px;background:${color};box-shadow:0 0 40px ${color}55}
    h1{margin:18px 0 8px;font-size:28px}p{margin:0;color:#cbd5e1;line-height:1.6}
  </style>
</head>
<body><main><div class="dot"></div><h1>${title}</h1><p>${message}</p></main></body>
</html>`;
}

function oauthReady() {
  return Boolean(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI && DISCORD_TOKEN && MAIN_GUILD_ID && CLIENT_ROLE_ID);
}

function pruneStates() {
  const now = Date.now();
  for (const [state, createdAt] of stateStore.entries()) {
    if (now - createdAt > STATE_TTL_MS) stateStore.delete(state);
  }
}

async function discordFetch(url, options = {}, retries = 2) {
  const response = await fetch(url, options);
  if (response.status === 429 && retries > 0) {
    const payload = await response.json().catch(() => ({}));
    const retryAfter = Math.min(10000, Math.max(500, Number(payload.retry_after || 1) * 1000));
    await new Promise(resolve => setTimeout(resolve, retryAfter));
    return discordFetch(url, options, retries - 1);
  }
  return response;
}

async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI
  });

  const response = await discordFetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error_description || payload.error || "Falha ao trocar code.");
  return payload;
}

async function refreshAccessToken(user) {
  if (!user?.refresh_token) throw new Error("refresh_token ausente.");
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: user.refresh_token
  });

  const response = await discordFetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error_description || payload.error || "Falha ao renovar token.");

  return upsertVerifiedUser({
    ...user,
    access_token: payload.access_token,
    refresh_token: payload.refresh_token || user.refresh_token,
    expires_at: new Date(Date.now() + Number(payload.expires_in || 0) * 1000).toISOString()
  });
}

async function getDiscordUser(accessToken) {
  const response = await discordFetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "Falha ao buscar usuario Discord.");
  return payload;
}

async function addUserToGuild(guildId, userId, accessToken) {
  const response = await discordFetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${DISCORD_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ access_token: accessToken })
  });
  if (response.status === 201) return "added";
  if (response.status === 204) return "already";
  const payload = await response.json().catch(() => ({}));
  throw new Error(payload.message || `Discord HTTP ${response.status}`);
}

async function addRoleToMainGuild(client, userId) {
  const guild = await client.guilds.fetch(MAIN_GUILD_ID).catch(() => null);
  if (!guild) throw new Error("Servidor principal nao encontrado pelo bot.");

  let member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return false;
  if (member.roles.cache.has(CLIENT_ROLE_ID)) return true;
  await member.roles.add(CLIENT_ROLE_ID, "Verificacao OAuth2 Dragon Store");
  return true;
}

async function ensureMainGuildAccess(client, userId, accessToken) {
  const guild = await client.guilds.fetch(MAIN_GUILD_ID).catch(() => null);
  if (!guild) throw new Error("Servidor principal nao encontrado pelo bot.");

  let member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {
    await addUserToGuild(MAIN_GUILD_ID, userId, accessToken);
    member = await guild.members.fetch(userId).catch(() => null);
  }
  if (!member) throw new Error("Usuario autorizado, mas nao consegui confirmar entrada no servidor principal.");
  if (!member.roles.cache.has(CLIENT_ROLE_ID)) {
    await member.roles.add(CLIENT_ROLE_ID, "Verificacao OAuth2 Dragon Store");
  }
}

function tokenExpired(user) {
  const expiresAt = Date.parse(user?.expires_at || "");
  return !expiresAt || Date.now() + 60_000 >= expiresAt;
}

async function pullVerifiedUsersToBackup() {
  if (!BACKUP_GUILD_ID) throw new Error("BACKUP_GUILD_ID nao configurado.");
  const users = listVerifiedUsers();
  const summary = { added: 0, already: 0, failed: 0 };
  const failures = [];

  for (const user of users) {
    try {
      const currentUser = tokenExpired(user) ? await refreshAccessToken(user) : user;
      const result = await addUserToGuild(BACKUP_GUILD_ID, currentUser.discord_id, currentUser.access_token);
      if (result === "already") summary.already += 1;
      else summary.added += 1;
    } catch (error) {
      summary.failed += 1;
      failures.push({ discord_id: user.discord_id, reason: error.message });
    }
  }

  return { ...summary, total: users.length, failures };
}

function createOAuthServer(client, publicStoreHandler, pagBankWebhookHandler = null, mercadoPagoWebhookHandler = null) {
  const app = express();
  app.disable("x-powered-by");

  if (pagBankWebhookHandler) {
    app.post("/webhooks/pagbank", express.raw({ type: "application/json", limit: "256kb" }), (req, res, next) => {
      Promise.resolve(pagBankWebhookHandler(req, res)).catch(next);
    });
  }
  if (mercadoPagoWebhookHandler) {
    app.post("/webhooks/mercadopago", express.raw({ type: "application/json", limit: "256kb" }), (req, res, next) => {
      Promise.resolve(mercadoPagoWebhookHandler(req, res)).catch(next);
    });
  }

  app.use(express.json({ limit: "256kb" }));

  app.use((req, res, next) => {
    if (["/api/public-store", "/api/public-orders", "/api/public-analytics"].includes(req.path) || req.method === "OPTIONS") {
      return Promise.resolve(publicStoreHandler(req, res)).catch(next);
    }
    return next();
  });

  app.get("/auth/discord/start", (req, res) => {
    if (!oauthReady()) {
      return res.status(503).send(htmlPage("Verificacao indisponivel", "A configuracao OAuth2 ainda nao foi concluida no bot.", false));
    }

    pruneStates();
    const state = crypto.randomBytes(18).toString("base64url");
    stateStore.set(state, Date.now());
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "identify guilds.join",
      state
    });
    return res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
  });

  app.get("/auth/discord/callback", async (req, res) => {
    try {
      if (req.query.error) {
        return res.status(400).send(htmlPage("Verificacao cancelada", "A autorizacao foi cancelada ou recusada no Discord.", false));
      }
      const code = String(req.query.code || "");
      const state = String(req.query.state || "");
      pruneStates();
      if (!code) return res.status(400).send(htmlPage("Code ausente", "O Discord nao retornou o codigo de autorizacao.", false));
      if (!state || !stateStore.has(state)) {
        return res.status(400).send(htmlPage("Sessao expirada", "Abra o botao Verificar novamente no Discord.", false));
      }
      stateStore.delete(state);

      const token = await exchangeCodeForToken(code);
      const discordUser = await getDiscordUser(token.access_token);
      const savedUser = upsertVerifiedUser({
        discord_id: discordUser.id,
        username: discordUser.global_name || discordUser.username,
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: new Date(Date.now() + Number(token.expires_in || 0) * 1000).toISOString(),
        verified_at: new Date().toISOString()
      });

      await ensureMainGuildAccess(client, savedUser.discord_id, savedUser.access_token);
      return res.send(htmlPage("Verificacao concluida", "Verificação concluída, você já pode voltar ao Discord."));
    } catch (error) {
      console.warn(`Falha OAuth2: ${error.message}`);
      return res.status(500).send(htmlPage("Falha na verificacao", "Nao foi possivel concluir sua verificacao agora. Tente novamente em alguns minutos.", false));
    }
  });

  app.get("/", (req, res) => res.type("text/plain").send("Bot online"));

  const server = app.listen(PORT, () => console.log(`HTTP/OAuth server rodando na porta ${PORT}`));
  return { app, server };
}

module.exports = {
  addRoleToMainGuild,
  addUserToGuild,
  createOAuthServer,
  pullVerifiedUsersToBackup,
  refreshAccessToken,
  tokenExpired
};
