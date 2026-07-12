const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  decryptStockValue,
  encryptStockValue,
  parseStockLines,
  reserveStock
} = require("../src/stockStore");

(async () => {

const parsed = parseStockLines("  KEY-AAAA BBBB  \r\n\r\nKEY-CCCC-DDDD\r\nKEY-AAAA BBBB\r\n");
assert.deepEqual(parsed.values, ["KEY-AAAA BBBB", "KEY-CCCC-DDDD"]);
assert.equal(parsed.blank, 2);
assert.equal(parsed.duplicate, 1);

const secret = crypto.randomBytes(32).toString("base64");
const secured = encryptStockValue("KEY-SECRET-1234", secret);
assert.equal(JSON.stringify(secured).includes("KEY-SECRET-1234"), false, "texto puro nao pode ser armazenado");
assert.equal(decryptStockValue(secured, secret), "KEY-SECRET-1234");
assert.throws(() => decryptStockValue(secured, crypto.randomBytes(32).toString("base64")));

const queries = [];
const fakeClient = {
  async query(sql, params) {
    queries.push({ sql, params });
    if (/select id from stock_items/i.test(sql)) return { rowCount: 2, rows: [{ id: 10 }, { id: 11 }] };
    return { rowCount: 2, rows: [] };
  }
};
const reserved = await reserveStock(fakeClient, { productId: "panel:p1", guildId: "guild", orderId: "order", quantity: 2 });
assert.deepEqual(reserved, [10, 11]);
assert.match(queries[0].sql, /for update skip locked/i, "a reserva precisa usar lock atomico");
assert.equal(queries.some(query => JSON.stringify(query.params).includes("KEY-SECRET-1234")), false);

console.log("Stock encryption and reservation tests passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
