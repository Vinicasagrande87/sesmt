// Certificado de treinamento (turma interna) em PDF, paisagem
const PDFDocument = require('pdfkit');
const { dataBR, dataHoraBR, cpfFormatado, cnpjFormatado } = require('./formatos');

function gerarCertificado({ certificado, funcionario, treinamento, turma, filial, emitidoPor, urlVerificacao }) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 50, bottom: 40, left: 60, right: 60 } });
  const largura = doc.page.width - 120;

  doc.rect(25, 25, doc.page.width - 50, doc.page.height - 50).lineWidth(2).stroke('#1f3b63');
  doc.rect(31, 31, doc.page.width - 62, doc.page.height - 62).lineWidth(0.5).stroke('#1f3b63');

  doc.moveDown(1.5);
  doc.font('Helvetica-Bold').fontSize(28).fillColor('#1f3b63').text('CERTIFICADO', { align: 'center' });
  doc.font('Helvetica').fontSize(11).fillColor('#555').text(treinamento.nr_referencia ? `Treinamento ${treinamento.nr_referencia}` : 'Treinamento', { align: 'center' });
  doc.moveDown(1.5).fillColor('#000');

  const periodo = turma.data_inicio === turma.data_fim
    ? `em ${dataBR(turma.data_inicio)}`
    : `no período de ${dataBR(turma.data_inicio)} a ${dataBR(turma.data_fim)}`;
  doc.font('Helvetica').fontSize(13).text(
    `Certificamos que ${funcionario.nome}, CPF ${cpfFormatado(funcionario.cpf)}, participou do treinamento ` +
    `"${treinamento.nome_treinamento}", com carga horária de ${certificado.carga_horaria || turma.carga_horaria} horas, ` +
    `realizado ${periodo}${turma.local ? `, em ${turma.local}` : ''}, obtendo aproveitamento satisfatório.`,
    { align: 'center', width: largura, lineGap: 4 }
  );
  doc.moveDown(1);
  doc.fontSize(10).fillColor('#333').text(
    certificado.data_vencimento ? `Válido até ${dataBR(certificado.data_vencimento)}.` : 'Sem prazo de reciclagem definido.',
    { align: 'center' }
  );

  if (treinamento.conteudo_programatico) {
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text('Conteúdo programático', { align: 'left' });
    doc.font('Helvetica').fontSize(8).text(treinamento.conteudo_programatico, { width: largura, align: 'justify', height: 90, ellipsis: true });
  }

  // Assinaturas
  const yAss = doc.page.height - 150;
  const meia = largura / 2;
  doc.moveTo(60 + 30, yAss).lineTo(60 + meia - 30, yAss).stroke('#000');
  doc.moveTo(60 + meia + 30, yAss).lineTo(60 + largura - 30, yAss).stroke('#000');
  doc.font('Helvetica').fontSize(9);
  doc.text(turma.instrutor_nome, 60, yAss + 5, { width: meia, align: 'center' });
  doc.fontSize(8).fillColor('#555').text(turma.instrutor_qualificacao || 'Instrutor', 60, yAss + 18, { width: meia, align: 'center' });
  doc.fontSize(9).fillColor('#000').text(funcionario.nome, 60 + meia, yAss + 5, { width: meia, align: 'center' });
  doc.fontSize(8).fillColor('#555').text('Participante (presença assinada com crachá QR + PIN)', 60 + meia, yAss + 18, { width: meia, align: 'center' });

  doc.fontSize(8).fillColor('#555').text(
    `${filial.razao_social || filial.nome} — CNPJ ${cnpjFormatado(filial.cnpj)} — ${filial.cidade}/${filial.uf}`,
    60, doc.page.height - 95, { width: largura, align: 'center' }
  );
  doc.text(
    `Código de verificação: ${certificado.codigo_verificacao} — confira em ${urlVerificacao}${certificado.codigo_verificacao}`,
    60, doc.page.height - 82, { width: largura, align: 'center' }
  );
  doc.text(`Emitido em ${dataHoraBR(new Date())} por ${emitidoPor}`, 60, doc.page.height - 69, { width: largura, align: 'center' });

  doc.end();
  return doc;
}

module.exports = { gerarCertificado };
