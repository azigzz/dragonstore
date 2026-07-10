function certificateFromEnv(env) {
  const base64 = String(env.DATABASE_CA_CERT_BASE64 || "").trim();
  if (base64) {
    try {
      return Buffer.from(base64, "base64").toString("utf8").trim();
    } catch {
      return "";
    }
  }
  return String(env.DATABASE_CA_CERT || "").replace(/\\n/g, "\n").trim();
}

function connectionStringWithoutSslQuery(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    for (const key of ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return databaseUrl;
  }
}

function buildPostgresPoolOptions(databaseUrl, env = process.env) {
  const connectionString = connectionStringWithoutSslQuery(String(databaseUrl || "").trim());
  if (!connectionString) return null;
  if (env.DATABASE_SSL === "false") return { connectionString, ssl: false };

  const ca = certificateFromEnv(env);
  const options = {
    connectionString,
    ssl: ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: false }
  };

  // Alguns endpoints Aiven novos usam TLS direto, sem o pacote SSLRequest do
  // protocolo Postgres. O pg suporta os dois modos nativamente.
  if (String(env.DATABASE_DIRECT_TLS || "").trim().toLowerCase() === "true") {
    options.sslnegotiation = "direct";
  }

  return options;
}

module.exports = { buildPostgresPoolOptions, certificateFromEnv, connectionStringWithoutSslQuery };
