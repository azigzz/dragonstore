const assert = require("node:assert/strict");
const { buildPostgresPoolOptions, normalizeConnectionString, postgresTargetSummary } = require("../src/postgresConfig");

const url = "postgresql://user:pass@db.example.com:1234/defaultdb?sslmode=require";
assert.equal(normalizeConnectionString(`"${url}"`), url);
const tls = buildPostgresPoolOptions(url, {});
assert.equal(tls.connectionString.includes("sslmode"), false);
assert.deepEqual(tls.ssl, { rejectUnauthorized: false });

const verified = buildPostgresPoolOptions(url, { DATABASE_CA_CERT: "CERT\\nLINE" });
assert.equal(verified.ssl.rejectUnauthorized, true);
assert.equal(verified.ssl.ca, "CERT\nLINE");

const disabled = buildPostgresPoolOptions(url, { DATABASE_SSL: "false" });
assert.equal(disabled.ssl, false);

const directTls = buildPostgresPoolOptions(url, { DATABASE_DIRECT_TLS: "true" });
assert.equal(directTls.sslnegotiation, "direct");

assert.deepEqual(postgresTargetSummary(url, tls), {
  host: "db.example.com",
  port: "1234",
  database: "defaultdb",
  tls: "ativo",
  negotiation: "postgres"
});
console.log("Postgres configuration test passed.");
