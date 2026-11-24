// Tabela simples para PDFKit, com quebra de página repetindo o cabeçalho e rodapé numerado.

function desenharTabela(doc, { colunas, linhas, destacar }) {
  const x0 = doc.page.margins.left;
  const largura = colunas.reduce((t, c) => t + c.largura, 0);

  const cabecalho = () => {
    const y = doc.y;
    doc.rect(x0, y - 2, largura, 14).fill('#e8ebf0').fillColor('#000');
    doc.font('Helvetica-Bold').fontSize(7.5);
    let x = x0;
    for (const c of colunas) {
      doc.text(c.titulo, x + 2, y + 1, { width: c.largura - 4 });
      x += c.largura;
    }
    doc.y = y + 14;
    doc.font('Helvetica').fontSize(7.5);
  };

  cabecalho();
  if (!linhas.length) {
    doc.moveDown(0.5).text('Nenhum registro.', x0 + 2);
    doc.x = x0;
    return;
  }
  linhas.forEach((valores, i) => {
    const altura = Math.max(...valores.map((v, k) => doc.heightOfString(String(v ?? ''), { width: colunas[k].largura - 4 }))) + 6;
    if (doc.y + altura > doc.page.height - 60) {
      doc.addPage();
      cabecalho();
    }
    const y = doc.y;
    if (i % 2) doc.rect(x0, y, largura, altura).fill('#f6f7f9').fillColor('#000');
    if (destacar && destacar(i)) doc.fillColor('#8a1c17');
    let x = x0;
    valores.forEach((v, k) => {
      doc.text(String(v ?? ''), x + 2, y + 3, { width: colunas[k].largura - 4 });
      x += colunas[k].largura;
    });
    doc.fillColor('#000');
    doc.y = y + altura;
  });
  doc.x = x0; // devolve o cursor à margem (senão o texto seguinte sai na última coluna)
}

function rodape(doc, texto) {
  const paginas = doc.bufferedPageRange();
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  for (let p = 0; p < paginas.count; p++) {
    doc.switchToPage(p);
    doc.page.margins.bottom = 0; // escrever no rodapé sem o PDFKit abrir página nova
    const y = doc.page.height - 40;
    doc.font('Helvetica').fontSize(7).fillColor('#555');
    doc.text(texto, doc.page.margins.left, y, { width: largura - 60 });
    doc.text(`Página ${p + 1} de ${paginas.count}`, doc.page.margins.left, y, { width: largura, align: 'right' });
  }
  doc.fillColor('#000');
}

function campo(doc, rotulo, valor) {
  doc.font('Helvetica-Bold').fontSize(9).text(`${rotulo}: `, { continued: true }).font('Helvetica').text(valor || '—');
}

module.exports = { desenharTabela, rodape, campo };
