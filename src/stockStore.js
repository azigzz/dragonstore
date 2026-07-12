const crypto = require("node:crypto");

const STOCK_MODE = Object.freeze({ MANUAL: "MANUAL", AUTOMATIC: "AUTOMATIC" });
const STOCK_STATUS = Object.freeze({ AVAILABLE: "AVAILABLE", RESERVED: "RESERVED", SOLD: "SOLD", DISABLED: "DISABLED" });

function parseStockLines(input) {
  const seen = new Set();
  const values = [];
  let blank = 0;
  let duplicate = 0;
  for (const raw of String(input || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    const value = raw.trim();
    if (!value) {
      blank += 1;
      continue;
    }
    if (seen.has(value)) {
      duplicate += 1;
      continue;
    }
    seen.add(value);
    values.push(value);
  }
  return { values, blank, duplicate };
}

function encryptionKey(value) {
  const raw = String(value || "").trim();
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === 32) return decoded;
  } catch {}
  throw new Error("STOCK_ENCRYPTION_KEY deve conter 32 bytes em Base64 ou 64 caracteres hexadecimais.");
}

function encryptStockValue(value, secret) {
  const key = encryptionKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return {
    encryptedValue: encrypted.toString("base64"),
    encryptionIv: iv.toString("base64"),
    encryptionAuthTag: cipher.getAuthTag().toString("base64"),
    valueFingerprint: crypto.createHmac("sha256", key).update(String(value), "utf8").digest("hex")
  };
}

function decryptStockValue(row, secret) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(row.encryption_iv || row.encryptionIv, "base64"));
  decipher.setAuthTag(Buffer.from(row.encryption_auth_tag || row.encryptionAuthTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.encrypted_value || row.encryptedValue, "base64")),
    decipher.final()
  ]).toString("utf8");
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await callback(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

async function setStockMode(pool, productId, guildId, mode) {
  if (!Object.values(STOCK_MODE).includes(mode)) throw new Error("Modo de estoque invalido.");
  const result = await pool.query("update products set stock_mode = $3, updated_at = now() where id = $1 and guild_id = $2 returning stock_mode", [productId, guildId, mode]);
  if (result.rowCount !== 1) throw new Error("Produto nao encontrado no banco persistente.");
  return result.rows[0].stock_mode;
}

async function addStock(pool, input) {
  const parsed = parseStockLines(input.text);
  if (!parsed.values.length) return { added: 0, existing: 0, ignored: parsed.blank + parsed.duplicate };
  const securedValues = parsed.values.map(value => encryptStockValue(value, input.secret));
  return withTransaction(pool, async client => {
    if (input.replace) {
      await client.query(`
        update stock_items set status = 'DISABLED', updated_at = now()
        where product_id = $1 and guild_id = $2 and status = 'AVAILABLE'
          and value_fingerprint <> all($3::text[])
      `, [input.productId, input.guildId, securedValues.map(item => item.valueFingerprint)]);
    }
    let added = 0;
    let existing = 0;
    for (const secured of securedValues) {
      const result = await client.query(`
        insert into stock_items (
          product_id, guild_id, encrypted_value, encryption_iv, encryption_auth_tag,
          value_fingerprint, status, created_by_user_id, updated_at
        ) values ($1,$2,$3,$4,$5,$6,'AVAILABLE',$7,now())
        on conflict (product_id, value_fingerprint) where value_fingerprint is not null do update set
          encrypted_value = case when $8 and stock_items.status = 'DISABLED' then excluded.encrypted_value else stock_items.encrypted_value end,
          encryption_iv = case when $8 and stock_items.status = 'DISABLED' then excluded.encryption_iv else stock_items.encryption_iv end,
          encryption_auth_tag = case when $8 and stock_items.status = 'DISABLED' then excluded.encryption_auth_tag else stock_items.encryption_auth_tag end,
          status = case when $8 and stock_items.status = 'DISABLED' then 'AVAILABLE' else stock_items.status end,
          updated_at = now()
        returning (xmax = 0) as inserted
      `, [input.productId, input.guildId, secured.encryptedValue, secured.encryptionIv, secured.encryptionAuthTag, secured.valueFingerprint, input.actorId || null, Boolean(input.replace)]);
      if (result.rows[0]?.inserted) added += 1;
      else existing += 1;
    }
    return { added, existing, ignored: parsed.blank + parsed.duplicate };
  });
}

async function stockSummary(pool, productId, guildId) {
  const result = await pool.query(`select status, count(*)::int as quantity from stock_items where product_id = $1 and guild_id = $2 group by status`, [productId, guildId]);
  const summary = { AVAILABLE: 0, RESERVED: 0, SOLD: 0, DISABLED: 0 };
  for (const row of result.rows) summary[row.status] = Number(row.quantity) || 0;
  return summary;
}

async function listStock(pool, productId, guildId, options = {}) {
  const limit = Math.min(25, Math.max(1, Number(options.limit) || 10));
  const offset = Math.max(0, Number(options.offset) || 0);
  const status = Object.values(STOCK_STATUS).includes(options.status) ? options.status : null;
  const result = await pool.query(`
    select id, encrypted_value, encryption_iv, encryption_auth_tag, status,
      reserved_by_order_id, sold_by_order_id, sold_to_discord_user_id,
      created_at, reserved_at, sold_at
    from stock_items where product_id = $1 and guild_id = $2
      and ($5::text is null or status = $5)
    order by id desc limit $3 offset $4
  `, [productId, guildId, limit, offset, status]);
  return result.rows;
}

async function reserveStock(client, input) {
  const result = await client.query(`
    select id from stock_items
    where product_id = $1 and guild_id = $2 and status = 'AVAILABLE'
      and encrypted_value is not null and encryption_iv is not null and encryption_auth_tag is not null
    order by id for update skip locked limit $3
  `, [input.productId, input.guildId, input.quantity]);
  if (result.rowCount !== input.quantity) throw new Error("Este produto esta indisponivel no momento.");
  const ids = result.rows.map(row => row.id);
  await client.query(`
    update stock_items set status = 'RESERVED', reserved_by_order_id = $2,
      reserved_at = now(), updated_at = now() where id = any($1::bigint[])
  `, [ids, input.orderId]);
  return ids;
}

async function releaseOrderStock(pool, orderId) {
  const result = await pool.query(`
    update stock_items set status = 'AVAILABLE', reserved_by_order_id = null,
      reserved_at = null, updated_at = now()
    where reserved_by_order_id = $1 and status = 'RESERVED'
  `, [orderId]);
  return result.rowCount;
}

async function reservedStockForOrder(pool, orderId) {
  const result = await pool.query(`
    select id, product_id, guild_id, encrypted_value, encryption_iv, encryption_auth_tag,
      status, reserved_by_order_id from stock_items
    where reserved_by_order_id = $1 and status in ('RESERVED', 'SOLD') order by id
  `, [orderId]);
  return result.rows;
}

async function markOrderStockSold(pool, orderId, userId) {
  const result = await pool.query(`
    update stock_items set status = 'SOLD', sold_by_order_id = $1,
      sold_to_discord_user_id = $2, sold_at = coalesce(sold_at, now()), updated_at = now()
    where reserved_by_order_id = $1 and status = 'RESERVED'
  `, [orderId, userId]);
  return result.rowCount;
}

async function disableStockItem(pool, productId, guildId, itemId) {
  const result = await pool.query(`
    update stock_items set status = 'DISABLED', updated_at = now()
    where id = $1 and product_id = $2 and guild_id = $3 and status = 'AVAILABLE'
  `, [itemId, productId, guildId]);
  return result.rowCount === 1;
}

async function clearAvailableStock(pool, productId, guildId) {
  const result = await pool.query("update stock_items set status = 'DISABLED', updated_at = now() where product_id = $1 and guild_id = $2 and status = 'AVAILABLE'", [productId, guildId]);
  return result.rowCount;
}

module.exports = {
  STOCK_MODE,
  STOCK_STATUS,
  addStock,
  clearAvailableStock,
  decryptStockValue,
  disableStockItem,
  encryptStockValue,
  encryptionKey,
  listStock,
  markOrderStockSold,
  parseStockLines,
  releaseOrderStock,
  reserveStock,
  reservedStockForOrder,
  setStockMode,
  stockSummary,
  withTransaction
};
