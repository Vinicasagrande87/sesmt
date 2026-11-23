// Lista de presença do treinamento em PDF
const PDFDocument = require('pdfkit');
const { dataBR, dataHoraBR, cnpjFormatado } = require('./formatos');
const { desenharTabela, rodape, campo } = require('./tabelaPdf');

function gerarListaPresenca({ turma, treinamento, filial, presencas, resultados, emitidoPor, urlVerificacao }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 50, left: 40, right: 40 }, bufferPages: true });

  doc.font('Helvetica-Bold').fontSize(13).text('LISTA DE PRESENÇA — TREINAMENTO', { align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor('#555').text(`Turma nº ${turma.id} · situação: ${turma.status}`, { align: 'center' });
  doc.fillColor('#000').moveDown(0.8);

  campo(doc, 'Empregador', `${filial.razao_social || filial.nome} — CNPJ ${cnpjFormatado(filial.cnpj)}`);
  campo(doc, 'Unidade', `${filial.nome} — ${filial.cidade}/${filial.uf}`);
  campo(doc, 'Treinamento', `${treinamento.nome_treinamento}${treinamento.nr_referencia ? ` (${treinamento.nr_referencia})` : ''}`);
  campo(doc, 'Período', turma.data_inicio === turma.data_fim ? dataBR(turma.data_inicio) : `${dataBR(turma.data_inicio)} a ${dataBR(turma.data_fim)}`);
  campo(doc, 'Carga horária', `${turma.carga_horaria} h`);
  campo(doc, 'Local', turma.local);
  campo(doc, 'Instrutor', `${turma.instrutor_nome}${turma.instrutor_qualificacao ? ` — ${turma.instrutor_qualificacao}` : ''}`);
  if (treinamento.conteudo_programatico) {
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(9).text('Conteúdo programático:');
    doc.font('Helvetica').fontSize(8).text(treinamento.conteudo_programatico, { align: 'justify' });
  }
  doc.moveDown(0.6);
  doc.font('Helvetica').fontSize(8).fillColor('#333').text(
    'Os participantes abaixo assinaram eletronicamente com o crachá QR e o PIN pessoal, conforme termo de adesão, ' +
    'ou tiveram a presença registrada manualmente com justificativa. Presenças anuladas aparecem em vermelho.',
    { align: 'justify' }
  );
  doc.fillColor('#000').moveDown(0.6);

  const statusPorFuncionario = new Map(resultados.map((r) => [r.funcionario_id, r.status]));
  desenharTabela(doc, {
    colunas: [
      { titulo: 'Dia', largura: 50 },
      { titulo: 'Participante', largura: 125 },
      { titulo: 'Matrícula', largura: 50 },
      { titulo: 'Função', largura: 80 },
      { titulo: 'Assinado em', largura: 62 },
      { titulo: 'Assinatura', largura: 65 },
      { titulo: 'Código', largura: 50 },
      { titulo: 'Result.', largura: 33 }
    ],
    linhas: presencas.map((p) => [
      dataBR(p.data_presenca),
      `${p.funcionario}${p.anulada ? ' — ANULADA' : ''}`,
      p.matricula,
      p.funcao || '',
      dataHoraBR(p.assinado_em),
      p.metodo_assinatura === 'qr_pin' ? 'Crachá QR + PIN' : 'Manual',
      p.codigo_verificacao,
      ({ Aprovado: 'Apr.', Reprovado: 'Repr.' })[statusPorFuncionario.get(p.funcionario_id)] || ''
    ]),
    destacar: (i) => presencas[i].anulada
  });

  rodape(doc, `Emitido em ${dataHoraBR(new Date())} por ${emitidoPor}. Confira cada assinatura em ${urlVerificacao}<código>.`);
  doc.end();
  return doc;
}

module.exports = { gerarListaPresenca };
