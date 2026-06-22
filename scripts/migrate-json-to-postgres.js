require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client } = require("pg");

const rootDir = path.join(__dirname, "..");
const dataDir = process.env.BOT_DATA_DIR || path.join(rootDir, "data");
const botDbPrefix = process.env.BOT_DB_PREFIX || process.env.BOT_KV_PREFIX || "dragon-store:bot";

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(dataDir, file), "utf8"));
  } catch {
    return fallback;
  }
}

function text(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function parsePrice(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const amount = Number.parseFloat(raw
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", "."));
  return Number.isFinite(amount) ? amount : null;
}

function cents(value) {
  const amount = parsePrice(value);
  return amount === null ? null : Math.round(amount * 100);
}

function centsFromNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function stockQuantityFromLabel(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || /inf|ilimit|sob|consulta|demanda/.test(raw)) return null;
  const match = raw.match(/\d{1,9}/);
  if (!match) return null;
  const quantity = Number.parseInt(match[0], 10);
  return Number.isFinite(quantity) ? Math.max(0, quantity) : null;
}

function normalizeStatus(status) {
  const value = text(status, "open").toLowerCase();
  if (value === "canceled") return "cancelled";
  if (["open", "processing", "closed", "cancelled", "expired"].includes(value)) return value;
  return "open";
}

function stablePanelId(panel, scopeId = "default") {
  return text(panel?.id) || (scopeId === "default" ? "main" : `panel_${scopeId}`);
}

function dbProductId(panelId, product) {
  return `${panelId}:${text(product?.id, crypto.randomUUID())}`.slice(0, 240);
}

function orderItemProductId(item, panelId = "") {
  const productId = text(item?.sourceProductId || item?.productId);
  return productId && panelId ? `${panelId}:${productId}`.slice(0, 240) : productId || null;
}

function json(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function allPanels(panelStore) {
  const rows = [];
  for (const [guildId, guildStore] of Object.entries(panelStore.guilds || {})) {
    const panels = guildStore?.panels && typeof guildStore.panels === "object"
      ? Object.entries(guildStore.panels)
      : [];
    const seen = new Set();
    for (const [scopeId, panel] of panels) {
      if (!panel) continue;
      const id = stablePanelId(panel, scopeId);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({ guildId, scopeId, panel: { ...panel, id, scopeId: panel.scopeId || scopeId } });
    }
    if (guildStore?.panel) {
      const scopeId = guildStore.panel.scopeId || "default";
      const id = stablePanelId(guildStore.panel, scopeId);
      if (!seen.has(id)) rows.push({ guildId, scopeId, panel: { ...guildStore.panel, id, scopeId } });
    }
  }
  return rows;
}

function guildIdsFromData(panels, orders, staff) {
  const ids = new Set();
  for (const panel of panels) ids.add(panel.guildId);
  for (const order of Object.values(orders.orders || {})) if (order?.guildId) ids.add(order.guildId);
  for (const guildId of Object.keys(orders.customers || {})) ids.add(guildId);
  for (const guildId of Object.keys(orders.sellers || {})) ids.add(guildId);
  for (const guildId of Object.keys(staff.guilds || {})) ids.add(guildId);
  ids.add(process.env.GUILD_ID || "default");
  return [...ids].filter(Boolean);
}

function maybeEncryptPixKey(value) {
  const pixKey = text(value);
  if (!pixKey) return null;
  const secret = process.env.PIX_ENCRYPTION_KEY || "";
  if (!secret) return null;

  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(pixKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `aes-256-gcm:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

async function main() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    console.error("DATABASE_URL nao configurado.");
    process.exit(1);
  }

  const [panelStore, orderStore, staffStore] = await Promise.all([
    readJson("panels.json", { guilds: {} }),
    readJson("orders.json", { orders: {}, tickets: {}, customers: {}, sellers: {}, auditLogs: [] }),
    readJson("staff.json", { guilds: {} })
  ]);
  const panelRows = allPanels(panelStore);
  const client = new Client({
    connectionString,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
  });

  await client.connect();
  try {
    await client.query(await fs.readFile(path.join(rootDir, "database", "postgres-schema.sql"), "utf8"));
    await client.query("begin");

    for (const [key, payload] of Object.entries({
      [`${botDbPrefix}:panels`]: panelStore,
      [`${botDbPrefix}:orders`]: orderStore,
      [`${botDbPrefix}:staff`]: staffStore
    })) {
      await client.query(`
        insert into bot_json_store (key, payload, updated_at)
        values ($1, $2::jsonb, now())
        on conflict (key) do update set payload = excluded.payload, updated_at = now()
      `, [key, json(payload, {})]);
    }

    for (const guildId of guildIdsFromData(panelRows, orderStore, staffStore)) {
      await client.query(`
        insert into guilds (id, name, updated_at)
        values ($1, $2, now())
        on conflict (id) do update set updated_at = now()
      `, [guildId, guildId]);
    }

    for (const { guildId, scopeId, panel } of panelRows) {
      await client.query(`
        insert into panels (
          id, guild_id, scope_id, title, description, color, image_url, thumbnail_url,
          channel_id, published_channel_id, published_message_id, quick_order, updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,now())
        on conflict (id) do update set
          title = excluded.title,
          description = excluded.description,
          color = excluded.color,
          image_url = excluded.image_url,
          thumbnail_url = excluded.thumbnail_url,
          channel_id = excluded.channel_id,
          published_channel_id = excluded.published_channel_id,
          published_message_id = excluded.published_message_id,
          quick_order = excluded.quick_order,
          updated_at = now()
      `, [
        panel.id,
        guildId,
        scopeId || "default",
        text(panel.title, "Dragon Store"),
        text(panel.description),
        text(panel.color, "#9b00ff"),
        text(panel.imageUrl),
        text(panel.thumbnailUrl),
        text(panel.channelId),
        text(panel.publishedChannelId),
        text(panel.publishedMessageId),
        json(panel.quickOrder || {}, {})
      ]);

      for (const product of panel.products || []) {
        await client.query(`
          insert into products (
            id, panel_id, guild_id, name, price_label, price_cents, description,
            stock_label, stock_quantity, type, image_url, rewards, active, updated_at
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,true,now())
          on conflict (id) do update set
            name = excluded.name,
            price_label = excluded.price_label,
            price_cents = excluded.price_cents,
            description = excluded.description,
            stock_label = excluded.stock_label,
            stock_quantity = excluded.stock_quantity,
            type = excluded.type,
            image_url = excluded.image_url,
            rewards = excluded.rewards,
            active = true,
            updated_at = now()
        `, [
          dbProductId(panel.id, product),
          panel.id,
          guildId,
          text(product.name, "Produto"),
          text(product.price, "A combinar"),
          Number.isFinite(Number(product.priceCents)) ? Number(product.priceCents) : cents(product.price),
          text(product.description),
          text(product.stock, "infinito"),
          stockQuantityFromLabel(product.stock),
          text(product.type, "product"),
          text(product.imageUrl),
          json(Array.isArray(product.rewards) ? product.rewards : [], [])
        ]);
      }
    }

    for (const [orderId, order] of Object.entries(orderStore.orders || {})) {
      if (!order || typeof order !== "object") continue;
      const guildId = text(order.guildId, process.env.GUILD_ID || "default");
      const panelId = text(order.panelId);
      const panelExists = panelRows.some(row => row.guildId === guildId && row.panel.id === panelId);
      const grossCents = Number.isFinite(Number(order.grossAmount)) ? centsFromNumber(order.grossAmount) : 0;
      const discountCents = Number.isFinite(Number(order.discountAmount)) ? centsFromNumber(order.discountAmount) : 0;
      const paidCents = Number.isFinite(Number(order.spentAmount)) ? centsFromNumber(order.spentAmount) : Math.max(0, grossCents - discountCents);

      await client.query(`
        insert into orders (
          id, guild_id, panel_id, panel_scope_id, channel_id, user_id, username, status,
          version, discount, gross_amount_cents, discount_amount_cents, paid_amount_cents,
          assigned_admin_id, assigned_admin_name, processing_by_admin_id, processing_by_admin_name,
          delivered_by_admin_id, delivered_by_admin_name, delivery_message,
          closed_by_admin_id, closed_by_admin_name,
          processing_started_at, delivered_at, closed_at, cancelled_at, created_at, updated_at
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
        on conflict (id) do update set
          status = excluded.status,
          version = excluded.version,
          discount = excluded.discount,
          gross_amount_cents = excluded.gross_amount_cents,
          discount_amount_cents = excluded.discount_amount_cents,
          paid_amount_cents = excluded.paid_amount_cents,
          assigned_admin_id = excluded.assigned_admin_id,
          assigned_admin_name = excluded.assigned_admin_name,
          processing_by_admin_id = excluded.processing_by_admin_id,
          processing_by_admin_name = excluded.processing_by_admin_name,
          delivered_by_admin_id = excluded.delivered_by_admin_id,
          delivered_by_admin_name = excluded.delivered_by_admin_name,
          delivery_message = excluded.delivery_message,
          closed_by_admin_id = excluded.closed_by_admin_id,
          closed_by_admin_name = excluded.closed_by_admin_name,
          processing_started_at = excluded.processing_started_at,
          delivered_at = excluded.delivered_at,
          closed_at = excluded.closed_at,
          cancelled_at = excluded.cancelled_at,
          updated_at = excluded.updated_at
      `, [
        orderId,
        guildId,
        panelExists ? panelId : null,
        text(order.panelScopeId || order.scopeId, "default"),
        text(order.channelId),
        text(order.userId),
        text(order.username),
        normalizeStatus(order.status),
        Number(order.version) || 0,
        json(order.discount || null, null),
        grossCents,
        discountCents,
        paidCents,
        text(order.assignedAdminId) || null,
        text(order.assignedAdminName),
        text(order.processingByAdminId) || null,
        text(order.processingByAdminName),
        text(order.deliveredByAdminId) || null,
        text(order.deliveredByAdminName),
        text(order.deliveryMessage),
        text(order.closedByAdminId) || null,
        text(order.closedByAdminName),
        order.processingStartedAt || null,
        order.deliveredAt || null,
        order.closedAt || null,
        order.cancelledAt || null,
        order.createdAt || new Date().toISOString(),
        order.updatedAt || new Date().toISOString()
      ]);

      await client.query("delete from order_items where order_id = $1", [orderId]);
      for (const item of order.items || []) {
        await client.query(`
          insert into order_items (
            order_id, product_id, source_panel_id, name, price_label, price_cents,
            description, stock_label, type, image_url, rewards, quantity
          )
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
        `, [
          orderId,
          orderItemProductId(item, panelId),
          text(item.sourcePanelId || panelId),
          text(item.name, "Produto"),
          text(item.price),
          Number.isFinite(Number(item.priceCents)) ? Number(item.priceCents) : cents(item.price),
          text(item.description),
          text(item.stock),
          text(item.type, "product"),
          text(item.imageUrl),
          json(Array.isArray(item.rewards) ? item.rewards : [], []),
          Math.max(1, Number(item.quantity) || 1)
        ]);
      }

      const hasProof = Boolean(order.paymentProofLatestUrl || (Array.isArray(order.paymentProofs) && order.paymentProofs.length));
      if (order.paymentStatus === "marked_paid" || order.paidAt || hasProof) {
        const paymentStatus = order.paymentStatus === "marked_paid" || order.paidAt ? "marked_paid" : "proof_received";
        const paymentTime = order.paidAt || order.paymentProofSubmittedAt || order.closedAt || new Date().toISOString();
        await client.query(`
          insert into payments (
            external_id, order_id, guild_id, status, amount_cents, method,
            staff_user_id, proof_attachment_url, marked_paid_at, created_at
          )
          values ($1,$2,$3,$4,$5,'pix_manual',$6,$7,$8,$8)
          on conflict (external_id) do update set
            status = excluded.status,
            amount_cents = excluded.amount_cents,
            method = excluded.method,
            staff_user_id = excluded.staff_user_id,
            proof_attachment_url = excluded.proof_attachment_url,
            marked_paid_at = excluded.marked_paid_at
        `, [
          `payment_${orderId}_manual`,
          orderId,
          guildId,
          paymentStatus,
          Number.isFinite(Number(order.paidAmount)) ? centsFromNumber(order.paidAmount) : paidCents,
          text(order.paidByAdminId || order.assignedAdminId || order.closedByAdminId) || null,
          text(order.paymentProofLatestUrl) || null,
          paymentTime
        ]);
      }
    }

    for (const [guildId, guildStaff] of Object.entries(staffStore.guilds || {})) {
      for (const [userId, profile] of Object.entries(guildStaff.users || {})) {
        await client.query(`
          insert into staff (guild_id, user_id, display_name, pix_key_encrypted, qr_code_url, note, online, updated_at)
          values ($1,$2,$3,$4,$5,$6,$7,now())
          on conflict (guild_id, user_id) do update set
            display_name = excluded.display_name,
            pix_key_encrypted = coalesce(excluded.pix_key_encrypted, staff.pix_key_encrypted),
            qr_code_url = excluded.qr_code_url,
            note = excluded.note,
            online = excluded.online,
            updated_at = now()
        `, [
          guildId,
          userId,
          text(profile.displayName),
          maybeEncryptPixKey(profile.pixKey),
          text(profile.qrCodeUrl),
          text(profile.note),
          Boolean(profile.online)
        ]);
      }
    }

    for (const [guildId, customers] of Object.entries(orderStore.customers || {})) {
      for (const [userId, stats] of Object.entries(customers || {})) {
        await client.query(`
          insert into customer_stats (guild_id, user_id, username, total_spent_cents, order_count, periods, last_order_at, updated_at)
          values ($1,$2,$3,$4,$5,$6::jsonb,$7,now())
          on conflict (guild_id, user_id) do update set
            username = excluded.username,
            total_spent_cents = excluded.total_spent_cents,
            order_count = excluded.order_count,
            periods = excluded.periods,
            last_order_at = excluded.last_order_at,
            updated_at = now()
        `, [
          guildId,
          userId,
          text(stats.username),
          centsFromNumber(stats.totalSpent),
          Number(stats.orderCount) || 0,
          json(stats.periods || {}, {}),
          stats.lastOrderAt || null
        ]);
      }
    }

    for (const [guildId, sellers] of Object.entries(orderStore.sellers || {})) {
      for (const [userId, stats] of Object.entries(sellers || {})) {
        await client.query(`
          insert into admin_sales (guild_id, admin_user_id, username, total_sold_cents, order_count, total_items, periods, last_sale_at, updated_at)
          values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,now())
          on conflict (guild_id, admin_user_id) do update set
            username = excluded.username,
            total_sold_cents = excluded.total_sold_cents,
            order_count = excluded.order_count,
            total_items = excluded.total_items,
            periods = excluded.periods,
            last_sale_at = excluded.last_sale_at,
            updated_at = now()
        `, [
          guildId,
          userId,
          text(stats.username),
          centsFromNumber(stats.totalSold),
          Number(stats.orderCount) || 0,
          Number(stats.totalItems) || 0,
          json(stats.periods || {}, {}),
          stats.lastSaleAt || null
        ]);
      }
    }

    for (const entry of orderStore.auditLogs || []) {
      const guildId = text(entry.guildId, process.env.GUILD_ID || "default");
      await client.query(`
        insert into audit_logs (external_id, guild_id, actor_id, actor_name, action, order_id, target_user_id, details, created_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
        on conflict (external_id) do update set
          actor_id = excluded.actor_id,
          actor_name = excluded.actor_name,
          action = excluded.action,
          order_id = excluded.order_id,
          target_user_id = excluded.target_user_id,
          details = excluded.details
      `, [
        text(entry.id) || crypto.createHash("sha256").update(json(entry, {})).digest("hex"),
        guildId,
        text(entry.actorId) || null,
        text(entry.actorName),
        text(entry.action, "unknown"),
        text(entry.orderId) || null,
        text(entry.targetUserId) || null,
        json(entry.details || {}, {}),
        entry.createdAt || new Date().toISOString()
      ]);
    }

    await client.query("commit");
    console.log("Migracao JSON -> Postgres concluida.");
    if (!process.env.PIX_ENCRYPTION_KEY) {
      console.log("Aviso: PIX_ENCRYPTION_KEY nao configurado; chaves Pix nao foram migradas por seguranca.");
    }
  } catch (error) {
    await client.query("rollback").catch(() => null);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error("Falha na migracao JSON -> Postgres:", error);
  process.exit(1);
});
