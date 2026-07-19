const PAYMENT_METHOD = Object.freeze({
  MANUAL_PIX: "MANUAL_PIX",
  PAGBANK_PIX: "PAGBANK_PIX",
  MERCADOPAGO_PIX: "MERCADOPAGO_PIX"
});

function validAmountInCents(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function paymentProviderHttpStatus(error) {
  const status = Number(error?.mercadoPago?.status ?? error?.pagBank?.status ?? error?.status ?? 0);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}

function isAmbiguousPaymentProviderFailure(error) {
  const status = paymentProviderHttpStatus(error);
  return status === 0 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function automaticPaymentRecoveryAvailable(order) {
  if (![PAYMENT_METHOD.PAGBANK_PIX, PAYMENT_METHOD.MERCADOPAGO_PIX].includes(order?.paymentMethod)) return false;
  if (order.paymentState !== "AWAITING_PAGBANK_PAYMENT") return false;
  if (order.paymentMethod === PAYMENT_METHOD.MERCADOPAGO_PIX) {
    return Boolean(order.mercadoPagoReferenceId && order.mercadoPagoIdempotencyKey && !order.mercadoPagoPixCopyPaste);
  }
  return Boolean(order.pagBankReferenceId && order.pagBankIdempotencyKey && !order.pagBankPixCopyPaste);
}

function resolvePaymentMethod(amountInCents) {
  if (!validAmountInCents(amountInCents)) {
    throw new TypeError("O valor do pedido deve ser um inteiro positivo em centavos.");
  }
  return amountInCents >= 100 ? PAYMENT_METHOD.PAGBANK_PIX : PAYMENT_METHOD.MANUAL_PIX;
}

function calculateServerCart(requestedItems, getServerProduct, discountPercent = 0) {
  if (!Array.isArray(requestedItems) || !requestedItems.length) throw new Error("O carrinho esta vazio.");
  const items = [];
  let grossCents = 0;
  for (const requested of requestedItems) {
    const product = getServerProduct(requested);
    if (!product) throw new Error("Produto nao encontrado no catalogo do servidor.");
    const priceCents = Number(product.priceCents);
    const quantity = Math.trunc(Number(requested.quantity) || 0);
    if (!Number.isSafeInteger(priceCents) || priceCents <= 0) throw new Error("Produto sem preco valido no servidor.");
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 9999) throw new Error("Quantidade invalida.");
    items.push({ ...product, priceCents, quantity });
    grossCents += priceCents * quantity;
  }
  const percent = Math.min(90, Math.max(0, Number(discountPercent) || 0));
  const discountCents = Math.round(grossCents * percent / 100);
  const totalCents = grossCents - discountCents;
  if (!validAmountInCents(totalCents)) throw new Error("Total do pedido invalido.");
  return { items, grossCents, discountCents, totalCents, discountPercent: percent };
}

module.exports = {
  PAYMENT_METHOD,
  automaticPaymentRecoveryAvailable,
  calculateServerCart,
  isAmbiguousPaymentProviderFailure,
  paymentProviderHttpStatus,
  resolvePaymentMethod,
  validAmountInCents
};
