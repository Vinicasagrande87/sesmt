// Gera o arquivo do relatório (PDF paisagem ou Excel) a partir do conteúdo já calculado.
// O cabeçalho traz a data-base, quem emitiu, o código de verificação (com QR) e o SHA-256 do conteúdo.
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const QRCode = require('qrcode');
const { dataBR, dataHoraBR } = require('./formatos');
const { desenharTabela, rodape } = require('./tabelaPdf');
const { NOTA_LANCADO_DEPOIS } = require('./definicoes');

const COR_TEXTO = { vermelho: '#8a1c17', amarelo: '#7a5200' };
const COR_FUNDO_EXCEL = { vermelho: 'FFF8D7D5', amarelo: 'FFFFF1CC' };

function valorTexto(coluna, item) {
  const v = coluna.valor(item);
  if (v === null || v === undefined) return '';
  return coluna.tipo === 'data' ? dataBR(v) : String(v);
}

function linhaResumo(resumo) {
  return Object.entries(resumo).map(([k, v]) => `${k}: ${v}`).join('   ·   ');
}

function paraBuffer(doc) {
  return new Promise((resolve, reject) => {
    const partes = [];
    doc.on('data', (p) => partes.push(p));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);
  });
}

// meta: { titulo, filiais: [nomes], dataBase, ehHoje, emitidoEm, emitidoPor, codigo, hashConteudo, url, parametros: [texto] }
async function gerarPdf({ definicao, itens, gravidade, resumo, meta }) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 36, bottom: 50, left: 40, right: 40 }, bufferPages: true,
    info: { Title: `${meta.titulo} — ${meta.codigo}`, Author: 'Sistema SESMT' } });
  const pronto = paraBuffer(doc);
  const larguraUtil = doc.page.width - 80;

  const qr = await QRCode.toBuffer(meta.url, { type: 'png', width: 180, margin: 1, errorCorrectionLevel: 'M' });
  doc.image(qr, doc.page.width - 40 - 62, 30, { width: 62 });

  doc.font('Helvetica-Bold').fontSize(14).text(meta.titulo, 40, 36, { width: larguraUtil - 80 });
  doc.font('Helvetica').fontSize(8.5).fillColor('#333');
  doc.text(`Filiais: ${meta.filiais.join(', ') || '—'}`, { width: larguraUtil - 80 });
  doc.font('Helvetica-Bold').text(meta.ehHoje ? `Situação em ${dataBR(meta.dataBase)} (atual)` : `Situação como estava em ${dataBR(meta.dataBase)}`, { width: larguraUtil - 80 });
  doc.font('Helvetica');
  if (meta.parametros.length) doc.text(meta.parametros.join(' · '), { width: larguraUtil - 80 });
  doc.text(`Emitido em ${dataHoraBR(meta.emitidoEm)} por ${meta.emitidoPor} · Código de verificação ${meta.codigo} (${meta.url})`, { width: larguraUtil - 80 });
  doc.fillColor('#000').moveDown(0.5);

  if (Object.keys(resumo).length) {
    doc.font('Helvetica-Bold').fontSize(8.5).text('Resumo: ', { continued: true }).font('Helvetica').text(linhaResumo(resumo), { width: larguraUtil });
    doc.moveDown(0.4);
  }
  if (doc.y < 100) doc.y = 100;

  desenharTabela(doc, {
    colunas: definicao.colunas.map((c) => ({ titulo: c.titulo, largura: c.largura })),
    linhas: itens.map((i) => definicao.colunas.map((c) => valorTexto(c, i))),
    corDaLinha: (k) => COR_TEXTO[gravidade(itens[k])] || null
  });
  if (itens.some((i) => i.lancado_depois)) doc.moveDown(0.5).font('Helvetica-Oblique').fontSize(7.5).text(NOTA_LANCADO_DEPOIS);

  rodape(doc, `${meta.titulo} · ${meta.codigo} · confira em ${meta.url} · SHA-256 do conteúdo ${meta.hashConteudo.slice(0, 24)}…`);
  doc.end();
  return pronto;
}

async function gerarExcel({ definicao, itens, gravidade, resumo, meta }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sistema SESMT';
  wb.created = meta.emitidoEm;
  const fonte = { name: 'Arial', size: 10 };

  const ws = wb.addWorksheet('Relatório', { views: [{ state: 'frozen', ySplit: 8 }] });
  ws.columns = definicao.colunas.map((c) => ({ width: Math.max(10, Math.round(c.largura / 5.5)) }));
  const cabecalho = [
    [meta.titulo],
    [`Filiais: ${meta.filiais.join(', ') || '—'}`],
    [meta.ehHoje ? `Situação em ${dataBR(meta.dataBase)} (atual)` : `Situação como estava em ${dataBR(meta.dataBase)}`],
    [meta.parametros.join(' · ')],
    [`Emitido em ${dataHoraBR(meta.emitidoEm)} por ${meta.emitidoPor}`],
    [`Código de verificação ${meta.codigo} — confira em ${meta.url}`],
    [`SHA-256 do conteúdo: ${meta.hashConteudo}`]
  ];
  cabecalho.forEach((linha, k) => {
    const r = ws.addRow(linha);
    r.font = { ...fonte, bold: k === 0 || k === 2, size: k === 0 ? 14 : 10 };
  });

  const titulos = ws.addRow(definicao.colunas.map((c) => c.titulo));
  titulos.font = { ...fonte, bold: true };
  titulos.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EBF0' } }; });

  for (const item of itens) {
    const valores = definicao.colunas.map((c) => {
      const v = c.valor(item);
      if (v === null || v === undefined || v === '') return null;
      if (c.tipo === 'data') { const [a, m, d] = String(v).slice(0, 10).split('-').map(Number); return new Date(Date.UTC(a, m - 1, d)); }
      return v;
    });
    const r = ws.addRow(valores);
    r.font = fonte;
    definicao.colunas.forEach((c, k) => { if (c.tipo === 'data') r.getCell(k + 1).numFmt = 'dd/mm/yyyy'; });
    const fundo = COR_FUNDO_EXCEL[gravidade(item)];
    if (fundo) r.eachCell({ includeEmpty: true }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fundo } }; });
  }
  ws.autoFilter = { from: { row: 8, column: 1 }, to: { row: 8, column: definicao.colunas.length } };
  if (itens.some((i) => i.lancado_depois)) ws.addRow([NOTA_LANCADO_DEPOIS]).font = { ...fonte, italic: true };

  const wr = wb.addWorksheet('Resumo');
  wr.columns = [{ width: 45 }, { width: 14 }];
  wr.addRow(['Situação', 'Quantidade']).font = { ...fonte, bold: true };
  for (const [k, v] of Object.entries(resumo)) wr.addRow([k, v]).font = fonte;
  wr.addRow(['Total de linhas', itens.length]).font = { ...fonte, bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { gerarPdf, gerarExcel };
