const assert = require("node:assert/strict");
const { buildPostgresPoolOptions } = require("../src/postgresConfig");

const url = "postgresql://user:pass@db.example.com:1234/defaultdb?sslmode=require";
const tls = buildPostgresPoolOptions(url, {});
assert.equal(tls.connectionString.includes("sslmode"), false);
assert.deepEqual(tls.ssl, { rejectUnauthorized: false });

const verified = buildPostgresPoolOptions(url, { DATABASE_CA_CERT: "CERT\\nLINE" });
assert.equal(verified.ssl.rejectUnauthorized, true);
assert.equal(verified.ssl.ca, "CERT\nLINE");

const disabled = buildPostgresPoolOptions(url, { DATABASE_SSL: "false" });
assert.equal(disabled.ssl, false);
console.log("Postgres configuration test passed.");
