require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const { Client } = require("pg");

async function main() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    console.error("DATABASE_URL nao configurado.");
    process.exit(1);
  }

  const schemaPath = path.join(__dirname, "..", "database", "postgres-schema.sql");
  const schema = await fs.readFile(schemaPath, "utf8");
  const client = new Client({
    connectionString,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false }
  });

  await client.connect();
  try {
    await client.query(schema);
    console.log("Schema Postgres aplicado com sucesso.");
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error("Falha ao aplicar schema Postgres:", error);
  process.exit(1);
});
