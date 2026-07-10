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
  return {
    connectionString,
    ssl: ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: false }
  };
}

module.exports = { buildPostgresPoolOptions, certificateFromEnv, connectionStringWithoutSslQuery };
