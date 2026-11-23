// Ficha de controle de entrega de EPI (NR-6) em PDF.
const PDFDocument = require('pdfkit');
const { dataBR, dataHoraBR, cpfFormatado, cpfMascarado, cnpjFormatado } = require('./formatos');

const MOTIVOS = {
  primeira_entrega: 'Primeira entrega',
  troca_periodica: 'Troca periódica',
  desgaste: 'Desgaste/dano',
  perda: 'Perda/extravio',
  outro: 'Outro'
};

const COLUNAS = [
  { titulo: 'Data/hora', largura: 62 },
  { titulo: 'EPI', largura: 150 },
  { titulo: 'CA (validade)', largura: 70 },
  { titulo: 'Qtd', largura: 24 },
  { titulo: 'Motivo', largura: 66 },
  { titulo: 'Assinatura', largura: 85 },
  { titulo: 'Código', largura: 58 }
];

// dados: { empregador, funcionario, entregas, emitidoPor, mostrarCpfCompleto, urlVerificacao }
function gerarFichaEpi(dados) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 50, left: 40, right: 40 }, bufferPages: true });
  const largura = doc.page.width - 80;
  const { empregador, funcionario, entregas } = dados;

  // Cabeçalho
  doc.font('Helvetica-Bold').fontSize(13).text('FICHA DE CONTROLE DE ENTREGA DE EPI', { align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor('#555').text('Equipamento de Proteção Individual — NR-6', { align: 'center' });
  doc.fillColor('#000').moveDown(0.8);

  const bloco = (titulo, linhas) => {
    doc.font('Helvetica-Bold').fontSize(9).text(titulo);
    doc.font('Helvetica').fontSize(9);
    for (const [rotulo, valor] of linhas) {
      doc.font('Helvetica-Bold').text(`${rotulo}: `, { continued: true }).font('Helvetica').text(valor || '—');
    }
    doc.moveDown(0.5);
  };

  bloco('EMPREGADOR', [
    ['Razão social', empregador.razao_social || empregador.nome],
    ['CNPJ', cnpjFormatado(empregador.cnpj)],
    ['Unidade', `${empregador.nome} — ${empregador.cidade}/${empregador.uf}`]
  ]);
  bloco('EMPREGADO', [
    ['Nome', funcionario.nome],
    ['Matrícula', funcionario.matricula],
    ['CPF', dados.mostrarCpfCompleto ? cpfFormatado(funcionario.cpf) : cpfMascarado(funcionario.cpf)],
    ['Função', funcionario.funcao],
    ['Setor', funcionario.setor],
    ['Admissão', dataBR(funcionario.data_admissao)],
    ['Termo de adesão à assinatura eletrônica', funcionario.termo_adesao_data ? `assinado em ${dataBR(funcionario.termo_adesao_data)}` : 'NÃO REGISTRADO']
  ]);

  doc.font('Helvetica').fontSize(8).fillColor('#333').text(
    'Declaro ter recebido gratuitamente os EPIs abaixo, em perfeito estado, e ter sido orientado sobre o uso adequado, ' +
    'guarda e conservação. Comprometo-me a usá-los apenas para a finalidade a que se destinam, a responsabilizar-me ' +
    'pela guarda e conservação, e a comunicar ao empregador qualquer alteração que os torne impróprios para uso (NR-6). ' +
    'Cada entrega abaixo foi assinada eletronicamente com o crachá QR e o PIN pessoal do empregado, conforme termo de adesão, ' +
    'ou registrada manualmente com justificativa.',
    { align: 'justify' }
  );
  doc.fillColor('#000').moveDown(0.8);

  // Tabela
  const desenharCabecalho = () => {
    let x = 40;
    const y = doc.y;
    doc.rect(40, y - 2, largura, 14).fill('#e8ebf0').fillColor('#000');
    doc.font('Helvetica-Bold').fontSize(7.5);
    for (const c of COLUNAS) {
      doc.text(c.titulo, x + 2, y + 1, { width: c.largura - 4 });
      x += c.largura;
    }
    doc.y = y + 14;
  };
  desenharCabecalho();

  doc.font('Helvetica').fontSize(7.5);
  if (!entregas.length) {
    doc.moveDown(0.5).text('Nenhuma entrega registrada.', 42);
  }
  entregas.forEach((e, i) => {
    const valores = [
      e.data_hora ? dataHoraBR(e.data_hora) : dataBR(e.data_entrega),
      `${e.epi}${e.tamanho && e.tamanho !== 'Único' ? ` (${e.tamanho})` : ''}${e.estornada ? ' — ESTORNADA' : ''}`,
      e.ca_numero ? `${e.ca_numero}${e.ca_validade ? ` (${dataBR(e.ca_validade)})` : ''}` : '—',
      String(e.quantidade ?? 1),
      MOTIVOS[e.motivo] || '—',
      e.metodo_assinatura === 'qr_pin' ? 'Crachá QR + PIN' : (e.metodo_assinatura === 'manual' ? 'Manual (justificada)' : (e.assinatura_status || '—')),
      e.codigo_verificacao || '—'
    ];
    const altura = Math.max(...valores.map((v, k) => doc.heightOfString(v, { width: COLUNAS[k].largura - 4 }))) + 6;
    if (doc.y + altura > doc.page.height - 60) {
      doc.addPage();
      desenharCabecalho();
      doc.font('Helvetica').fontSize(7.5);
    }
    const y = doc.y;
    if (i % 2) doc.rect(40, y, largura, altura).fill('#f6f7f9').fillColor('#000');
    if (e.estornada) doc.fillColor('#8a1c17');
    let x = 40;
    valores.forEach((v, k) => {
      doc.text(v, x + 2, y + 3, { width: COLUNAS[k].largura - 4 });
      x += COLUNAS[k].largura;
    });
    doc.fillColor('#000');
    doc.y = y + altura;
  });

  // Rodapé em todas as páginas
  const emitido = `Emitido em ${dataHoraBR(new Date())} por ${dados.emitidoPor}. ` +
    (dados.urlVerificacao ? `Confira cada entrega em ${dados.urlVerificacao}<código>.` : 'Cada entrega pode ser conferida pelo código de verificação.');
  const paginas = doc.bufferedPageRange();
  for (let p = 0; p < paginas.count; p++) {
    doc.switchToPage(p);
    doc.page.margins.bottom = 0; // escrever no rodapé sem o PDFKit abrir página nova
    const yRodape = doc.page.height - 40;
    doc.font('Helvetica').fontSize(7).fillColor('#555');
    doc.text(emitido, 40, yRodape, { width: largura - 60, lineBreak: true, height: 20 });
    doc.text(`Página ${p + 1} de ${paginas.count}`, 40, yRodape, { width: largura, align: 'right' });
  }
  doc.fillColor('#000');
  doc.end();
  return doc;
}

module.exports = { gerarFichaEpi };
