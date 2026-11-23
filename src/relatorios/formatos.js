const FUSO = 'America/Sao_Paulo';

function dataBR(iso) {
  if (!iso) return '';
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

function dataHoraBR(valor) {
  if (!valor) return '';
  return new Date(valor)
    .toLocaleString('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    .replace(',', '');
}

function cpfFormatado(cpf) {
  const d = String(cpf || '');
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : d;
}

function cpfMascarado(cpf) {
  const d = String(cpf || '');
  return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : '';
}

function cnpjFormatado(cnpj) {
  const d = String(cnpj || '');
  return d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : d;
}

function moeda(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

module.exports = { dataBR, dataHoraBR, cpfFormatado, cpfMascarado, cnpjFormatado, moeda };
