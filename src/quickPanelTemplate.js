const QUICK_PANEL_TEMPLATE = [
  "&T NOME DO PAINEL",
  "&D Descricao do painel para os clientes.",
  "&P Produto 1 | 19,90 | Descricao curta | infinito",
  "&P Produto 2 | 29,90 | Outra descricao | 50",
  "&C #34eb67"
].join("\n");

function markerName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function lineError(lineNumber, message) {
  return new Error(`Linha ${lineNumber}: ${message}`);
}

function parseTaggedProduct(value, lineNumber) {
  const parts = String(value || "").split("|").map(part => part.trim());
  if (parts.length < 2 || parts.length > 4) {
    throw lineError(lineNumber, "use &P Nome | preco | descricao | estoque");
  }
  const [name, price, description = "Produto da loja", stock = "infinito"] = parts;
  if (!name) throw lineError(lineNumber, "produto sem nome");
  if (!price) throw lineError(lineNumber, `produto ${name} sem preco`);
  return { name, price, description: description || "Produto da loja", stock: stock || "infinito" };
}

function parseDotProduct(value, lineNumber) {
  const separator = String(value || "").indexOf(" - ");
  if (separator < 1) throw lineError(lineNumber, "use ..Nome do produto - preco + descricao");
  const name = value.slice(0, separator).trim();
  const details = value.slice(separator + 3).trim();
  const descriptionSeparator = details.indexOf(" + ");
  const price = (descriptionSeparator >= 0 ? details.slice(0, descriptionSeparator) : details).trim();
  const description = (descriptionSeparator >= 0 ? details.slice(descriptionSeparator + 3) : "Produto da loja").trim();
  if (!name) throw lineError(lineNumber, "produto sem nome");
  if (!price) throw lineError(lineNumber, `produto ${name} sem preco`);
  return { name, price, description: description || "Produto da loja", stock: "infinito" };
}

function normalizeColor(value, lineNumber) {
  const color = String(value || "").trim();
  if (!/^#?[0-9a-f]{6}$/i.test(color)) throw lineError(lineNumber, "cor invalida; use #34eb67");
  return `#${color.replace(/^#/, "").toLowerCase()}`;
}

function parseQuickPanelTemplate(input) {
  const result = { title: "", description: "", color: "", products: [] };
  let dotTextFields = 0;
  const lines = String(input || "").replace(/\r/g, "").split("\n");

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) return;

    if (line.startsWith("..")) {
      result.products.push(parseDotProduct(line.slice(2).trim(), lineNumber));
      return;
    }
    if (line.startsWith(",")) {
      result.color = normalizeColor(line.slice(1), lineNumber);
      return;
    }
    if (line.startsWith(".")) {
      const value = line.slice(1).trim();
      if (!value) throw lineError(lineNumber, "campo vazio");
      if (dotTextFields === 0) result.title = value;
      else if (dotTextFields === 1) result.description = value;
      else throw lineError(lineNumber, "use apenas uma linha .titulo e uma .descricao");
      dotTextFields += 1;
      return;
    }

    const tagged = line.match(/^&([A-Za-z]+)\s*[:=-]?\s*(.*)$/);
    if (!tagged) throw lineError(lineNumber, "prefixo desconhecido; use &T, &D, &P ou &C");
    const marker = markerName(tagged[1]);
    const value = tagged[2].trim();
    if (["T", "TITULO"].includes(marker)) result.title = value;
    else if (["D", "DESCRICAO"].includes(marker)) result.description = value;
    else if (["P", "PRODUTO"].includes(marker)) result.products.push(parseTaggedProduct(value, lineNumber));
    else if (["C", "COR"].includes(marker)) result.color = normalizeColor(value, lineNumber);
    else throw lineError(lineNumber, `marcador &${tagged[1]} desconhecido`);
  });

  if (!result.title) throw new Error("Adicione o titulo com &T ou .titulo");
  if (!result.description) result.description = "Confira os produtos disponiveis neste painel.";
  if (!result.products.length) throw new Error("Adicione pelo menos um produto com &P ou ..produto");
  if (result.products.length > 25) throw new Error("O template aceita no maximo 25 produtos por painel");
  return result;
}

module.exports = { QUICK_PANEL_TEMPLATE, parseQuickPanelTemplate };
