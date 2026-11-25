// Lista de presença do DDS em PDF
const PDFDocument = require('pdfkit');
const { dataBR, dataHoraBR, cnpjFormatado } = require('./formatos');
const { desenharTabela, rodape, campo } = require('./tabelaPdf');

const STATUS = { aberto: 'em andamento', encerrado: 'encerrado', cancelado: 'cancelado' };

function gerarListaDds({ dds: d, emitidoPor, urlVerificacao }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 50, left: 40, right: 40 }, bufferPages: true });
  doc.font('Helvetica-Bold').fontSize(13).text('DIÁLOGO DIÁRIO DE SEGURANÇA (DDS)', { align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor('#555').text(`DDS nº ${d.numero} · ${STATUS[d.status]}`, { align: 'center' });
  doc.fillColor('#000').moveDown(0.8);

  campo(doc, 'Empregador', `${d.filial_dados.razao_social || d.filial} — CNPJ ${cnpjFormatado(d.filial_dados.cnpj)}`);
  campo(doc, 'Data', dataBR(d.data) + (d.duracao_min ? ` · ${d.duracao_min} min` : ''));
  campo(doc, 'Setor / local', [d.setor || 'Filial inteira', d.local].filter(Boolean).join(' · '));
  campo(doc, 'Tema', d.tema);
  campo(doc, 'Conduzido por', d.condutor);
  if (d.resumo) {
    doc.moveDown(0.3).font('Helvetica-Bold').fontSize(9).text('O que foi falado:');
    doc.font('Helvetica').fontSize(8.5).text(d.resumo, { align: 'justify' });
  }
  if (d.status === 'cancelado') campo(doc, 'Cancelado', d.motivo_cancelamento);
  doc.moveDown(0.6).font('Helvetica').fontSize(8).fillColor('#333')
    .text('Os participantes assinaram com o crachá QR e o PIN pessoal, ou tiveram a presença lançada pela gestão com justificativa (lista em papel). Presenças anuladas em vermelho.', { align: 'justify' });
  doc.fillColor('#000').moveDown(0.5);

  desenharTabela(doc, {
    colunas: [{ titulo: 'Participante', largura: 150 }, { titulo: 'Matrícula', largura: 55 }, { titulo: 'Setor', largura: 95 },
      { titulo: 'Assinado em', largura: 75 }, { titulo: 'Assinatura', largura: 75 }, { titulo: 'Código', largura: 65 }],
    linhas: d.presencas.map((p) => [`${p.nome}${p.anulada ? ' — ANULADA' : ''}`, p.matricula, p.setor || '', dataHoraBR(p.assinado_em),
      p.metodo === 'qr_pin' ? 'Crachá QR + PIN' : 'Manual', p.codigo_verificacao]),
    destacar: (i) => d.presencas[i].anulada
  });

  rodape(doc, `Emitido em ${dataHoraBR(new Date())} por ${emitidoPor}. Confira cada assinatura em ${urlVerificacao}<código>.`);
  doc.end();
  return doc;
}

module.exports = { gerarListaDds };
