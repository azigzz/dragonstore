const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  downloadAndValidateProof,
  findLatestProofAttachment,
  safeProofFilename,
  validateProofMetadata
} = require("../src/proofAttachment");
const {
  sendManualProofNotification
} = require("../src/services/notificationService");

function response(buffer, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => name.toLowerCase() === "content-length" ? String(buffer.length) : null },
    arrayBuffer: async () => buffer
  };
}

function attachment(name, contentType, buffer, overrides = {}) {
  return {
    name,
    contentType,
    size: buffer.length,
    url: `https://cdn.discord.test/${encodeURIComponent(name)}`,
    ...overrides
  };
}

function message(userId, createdTimestamp, attachments) {
  return {
    author: { id: userId },
    createdTimestamp,
    attachments: new Map(attachments.map((item, index) => [String(index), item]))
  };
}

const samples = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0xff, 0xd9]),
  webp: Buffer.from("RIFF0000WEBPVP8 ", "ascii"),
  pdf: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii")
};

(async () => {
  for (const [name, contentType, buffer] of [
    ["comprovante.png", "image/png", samples.png],
    ["comprovante.jpg", "image/jpeg", samples.jpeg],
    ["comprovante.jpeg", "image/jpeg", samples.jpeg],
    ["comprovante.webp", "image/webp", samples.webp],
    ["comprovante.pdf", "application/pdf", samples.pdf]
  ]) {
    const item = attachment(name, contentType, buffer);
    const result = await downloadAndValidateProof(item, { fetchImpl: async () => response(buffer) });
    assert.equal(result.buffer.equals(buffer), true);
  }

  const invalidPdf = Buffer.from("isto nao e um pdf", "utf8");
  await assert.rejects(
    downloadAndValidateProof(attachment("falso.pdf", "application/pdf", invalidPdf), { fetchImpl: async () => response(invalidPdf) }),
    error => error.code === "invalid_content"
  );

  const oversizedPdf = attachment("grande.pdf", "application/pdf", samples.pdf, { size: 9 * 1024 * 1024 });
  assert.equal(validateProofMetadata(oversizedPdf, { maxBytes: 8 * 1024 * 1024 }).code, "too_large");
  const oversizedImage = attachment("grande.png", "image/png", samples.png, { size: 9 * 1024 * 1024 });
  assert.equal(validateProofMetadata(oversizedImage, { maxBytes: 8 * 1024 * 1024 }).code, "too_large");
  await assert.rejects(
    downloadAndValidateProof(attachment("cresceu.png", "image/png", samples.png), {
      maxBytes: samples.png.length,
      fetchImpl: async () => response(Buffer.concat([samples.png, Buffer.from([0x00])]))
    }),
    error => error.code === "too_large"
  );
  assert.equal(validateProofMetadata(attachment("falso.pdf", "image/png", samples.png)).code, "extension_mismatch");
  assert.equal(validateProofMetadata(null).code, "missing_attachment");

  const ownerId = "owner";
  const oldProof = attachment("antigo.png", "image/png", samples.png);
  const newestProof = attachment("novo.pdf", "application/pdf", samples.pdf);
  const otherUserProof = attachment("terceiro.pdf", "application/pdf", samples.pdf);
  const latest = findLatestProofAttachment([
    message(ownerId, 100, [oldProof]),
    message("outra-pessoa", 300, [otherUserProof]),
    message(ownerId, 200, [newestProof])
  ], ownerId);
  assert.equal(latest.attachment.name, "novo.pdf");
  assert.equal(findLatestProofAttachment([message("outra-pessoa", 300, [otherUserProof])], ownerId), null);

  await assert.rejects(
    downloadAndValidateProof(oldProof, { fetchImpl: async () => { throw new Error("cdn offline"); } }),
    error => error.code === "download_failed"
  );

  assert.equal(safeProofFilename("123/456", { extension: ".pdf" }), "comprovante-pedido-123456.pdf");

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dragon-store-test-"));
  const env = { NTFY_URL: "https://ntfy.test", NTFY_TOPIC: "loja" };
  let published;
  const notificationInput = {
    products: ["Produto x1"],
    total: "R$ 1,00",
    customerName: "Cliente",
    customerId: "123",
    orderId: "7654321",
    discordUrl: "https://discord.com/channels/1/2",
    idempotencyKey: "manual:7654321",
    attachment: {
      buffer: samples.pdf,
      filename: "comprovante-pedido-7654321.pdf",
      contentType: "application/pdf"
    }
  };
  const sent = await sendManualProofNotification(notificationInput, {
    env,
    tmpRoot,
    fetchImpl: async (url, options) => {
      published = { url, options };
      return { ok: true, status: 200 };
    }
  });
  assert.equal(sent.sent, true);
  assert.equal(published.options.method, "PUT");
  assert.equal(published.options.headers.Filename, "comprovante-pedido-7654321.pdf");
  assert.equal(Buffer.from(published.options.body).equals(samples.pdf), true);
  assert.deepEqual(await fs.readdir(tmpRoot), []);

  const imageSent = await sendManualProofNotification({
    ...notificationInput,
    attachment: {
      buffer: samples.png,
      filename: "comprovante-pedido-7654321.png",
      contentType: "image/png"
    }
  }, {
    env,
    tmpRoot,
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.Filename, "comprovante-pedido-7654321.png");
      assert.equal(options.headers["Content-Type"], "image/png");
      return { ok: true, status: 200 };
    }
  });
  assert.equal(imageSent.sent, true);
  assert.deepEqual(await fs.readdir(tmpRoot), []);

  await assert.rejects(
    sendManualProofNotification(notificationInput, {
      env,
      tmpRoot,
      fetchImpl: async () => ({ ok: false, status: 500 })
    }),
    error => error.code === "ntfy_failed"
  );
  assert.deepEqual(await fs.readdir(tmpRoot), []);
  await fs.rm(tmpRoot, { recursive: true, force: true });

  console.log("Proof attachment and ntfy notification tests passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
