const assert = require("node:assert/strict");
const { parseQuickPanelTemplate } = require("../src/quickPanelTemplate");

const tagged = parseQuickPanelTemplate([
  "&T XBOX GAMEPASS",
  "&D Uma conta Microsoft completa com assinatura **Game Pass Ultimate ativa**.",
  "&P Gamepass 30d privada | 42,90 | Conta privada | infinito",
  "&P Gamepass pelo menos 10d | 4,90 | compartilhada | 20",
  "&C #34eb67"
].join("\n"));
assert.equal(tagged.title, "XBOX GAMEPASS");
assert.equal(tagged.products.length, 2);
assert.equal(tagged.products[1].description, "compartilhada");
assert.equal(tagged.color, "#34eb67");

const dotted = parseQuickPanelTemplate([
  ".XBOX GAMEPASS",
  ".Uma conta Microsoft completa com assinatura **Game Pass Ultimate ativa**.",
  "..Gamepass 30d privada - 42,90",
  "..Gamepass pelo menos 10d - 4,90 + compartilhada",
  "..Gamepass 1 ano privada - 259,90",
  ",#34eb67"
].join("\n"));
assert.equal(dotted.products.length, 3);
assert.equal(dotted.products[1].price, "4,90");
assert.equal(dotted.products[1].description, "compartilhada");

const colorWithoutHash = parseQuickPanelTemplate(".Teste\n.Descricao\n..Produto - 1,00\n,34eb67");
assert.equal(colorWithoutHash.color, "#34eb67");

assert.throws(() => parseQuickPanelTemplate("&T Sem produtos"), /pelo menos um produto/i);
assert.throws(() => parseQuickPanelTemplate("&T Teste\n&P Produto | 10,00\n&C verde"), /cor invalida/i);

console.log("Quick panel template parser tests passed.");
