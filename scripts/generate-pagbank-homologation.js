require("dotenv").config();

const crypto = require("node:crypto");
const { createPixOrder } = require("../src/pagBank");

async function main() {
  const token = String(process.env.PAGBANK_TOKEN || "").trim();
  if (!token) throw new Error("Configure PAGBANK_TOKEN no .env local antes de executar.");
  if (String(process.env.PAGBANK_ENV || "sandbox").trim().toLowerCase() !== "sandbox") {
    throw new Error("Este script funciona somente com PAGBANK_ENV=sandbox.");
  }

  const referenceId = `homologacao-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const result = await createPixOrder({
    referenceId,
    amountCents: 100,
    items: [{ productId: "homologacao-1", name: "Produto digital", quantity: 1, priceCents: 100 }],
    customer: { name: "Maria da Silva", email: "comprador.teste@example.com", taxId: "52998224725" }
  }, { exportHomologation: true });

  console.log(`Homologacao Sandbox concluida. Pedido: ${result.pagBankOrderId}. Arquivo: pagbank-homologacao.txt`);
}

main().catch(error => {
  const code = error?.pagBank?.errors?.[0]?.code || "ERRO_LOCAL";
  console.error(`Falha segura na homologacao: ${code} - ${error.message}`);
  process.exitCode = 1;
});
