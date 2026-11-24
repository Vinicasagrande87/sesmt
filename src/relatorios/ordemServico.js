// Ordem de serviço em PDF, montada a partir da "fotografia" gravada na publicação do PGR
const PDFDocument = require('pdfkit');
const { dataBR, dataHoraBR, cnpjFormatado, cpfMascarado } = require('./formatos');
const { desenharTabela, rodape, campo } = require('./tabelaPdf');

function titulo(doc, texto) {
  if (doc.y > doc.page.height - 130) doc.addPage();
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(9.5).fillColor('#1d3557').text(texto.toUpperCase());
  doc.fillColor('#000').moveDown(0.2);
}

function lista(doc, itens) {
  doc.font('Helvetica').fontSize(8.5);
  for (const item of itens) doc.text(`•  ${item}`, { indent: 6, align: 'justify' });
}

function gerarOrdemServico({ os, funcionario, ciencia, emitidoPor, urlVerificacao }) {
  const c = os.conteudo;
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 50, left: 40, right: 40 }, bufferPages: true });

  doc.font('Helvetica-Bold').fontSize(13).text('ORDEM DE SERVIÇO — SEGURANÇA E SAÚDE NO TRABALHO', { align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor('#555').text(`NR-1, item 1.4.1, alínea "c" · OS nº ${os.id}`, { align: 'center' });
  doc.fillColor('#000').moveDown(0.8);

  for (const f of c.filiais) campo(doc, 'Empregador', `${f.razao_social || f.nome} — CNPJ ${cnpjFormatado(f.cnpj)} — ${f.cidade}/${f.uf}`);
  campo(doc, 'Programa', `${c.pgr.titulo} — vigência ${dataBR(c.pgr.data_inicio)} a ${dataBR(c.pgr.data_fim)}`);
  campo(doc, 'Responsável técnico', c.pgr.responsavel);
  doc.moveDown(0.4);
  if (funcionario) {
    campo(doc, 'Empregado', `${funcionario.nome} — matrícula ${funcionario.matricula}${funcionario.cpf ? ` — CPF ${cpfMascarado(funcionario.cpf)}` : ''}`);
    campo(doc, 'Função / setor', `${funcionario.funcao || '—'} / ${funcionario.setor || c.setor}`);
  } else {
    campo(doc, 'Setor', c.setor);
    campo(doc, 'Funções expostas', c.funcoes.join(', '));
  }
  campo(doc, 'Atividade', c.atividade);
  if (c.descricao_atividades) {
    doc.font('Helvetica').fontSize(8.5).text(c.descricao_atividades, { align: 'justify' });
  }

  titulo(doc, 'Riscos da atividade');
  desenharTabela(doc, {
    colunas: [
      { titulo: 'Tipo', largura: 60 }, { titulo: 'Agente', largura: 105 }, { titulo: 'Fonte geradora', largura: 140 },
      { titulo: 'Exposição', largura: 65 }, { titulo: 'Avaliação', largura: 85 }, { titulo: 'Nível', largura: 60 }
    ],
    linhas: c.riscos.map((r) => [
      r.categoria, r.referencia ? `${r.agente} — ${r.referencia}` : r.agente, r.fonte_geradora || '', r.exposicao || '', r.medicao || '', r.nivel || ''
    ])
  });

  titulo(doc, 'Medidas de prevenção');
  const epcs = [...new Set(c.riscos.map((r) => r.epc).filter(Boolean))];
  const medidas = [c.medidas_controle, ...epcs.map((e) => `Proteção coletiva: ${e}`)].filter(Boolean);
  lista(doc, medidas.length ? medidas : ['Seguir os procedimentos da área e as orientações do SESMT.']);

  titulo(doc, 'Equipamentos de proteção individual obrigatórios');
  desenharTabela(doc, {
    colunas: [{ titulo: 'Proteção para', largura: 130 }, { titulo: 'EPI', largura: 385 }],
    linhas: c.epis.map((e) => [e.parte_corpo, e.descricao])
  });
  if (c.observacao_epi) doc.moveDown(0.3).font('Helvetica-Oblique').fontSize(8.5).text(c.observacao_epi, { align: 'justify' });

  if (c.treinamentos.length) {
    titulo(doc, 'Treinamentos indicados');
    lista(doc, c.treinamentos);
  }
  titulo(doc, 'Obrigações do empregado');
  lista(doc, c.obrigacoes);
  titulo(doc, 'Proibições');
  lista(doc, c.proibicoes);
  titulo(doc, 'Em caso de acidente ou situação de risco');
  lista(doc, c.acidente);

  titulo(doc, 'Ciência do empregado');
  doc.font('Helvetica').fontSize(8.5).text(c.ciencia, { align: 'justify' }).moveDown(0.6);
  if (ciencia) {
    const forma = ciencia.metodo_assinatura === 'qr_pin'
      ? `Assinado eletronicamente com o crachá QR e o PIN pessoal em ${dataHoraBR(ciencia.assinado_em)}`
      : `Ciência registrada manualmente em ${dataBR(ciencia.data_ciencia)} (OS assinada em papel)`;
    doc.font('Helvetica-Bold').fontSize(9).text(forma);
    doc.font('Helvetica').fontSize(8.5).text(`Código de verificação: ${ciencia.codigo_verificacao} — confira em ${urlVerificacao}${ciencia.codigo_verificacao}`);
  } else {
    if (doc.y > doc.page.height - 110) doc.addPage();
    const y = doc.y + 25;
    const x = doc.page.margins.left;
    doc.moveTo(x, y).lineTo(x + 280, y).stroke().moveTo(x + 330, y).lineTo(x + 515, y).stroke();
    doc.fontSize(8).text(funcionario ? funcionario.nome : 'Assinatura do empregado', x, y + 3, { width: 280 });
    doc.text('Data', x + 330, y + 3, { width: 185 });
    doc.x = x;
    doc.y = y + 20;
  }

  rodape(doc, `Emitido em ${dataHoraBR(new Date())} por ${emitidoPor}. Conteúdo da OS (SHA-256): ${os.hash.slice(0, 16)}…`);
  doc.end();
  return doc;
}

module.exports = { gerarOrdemServico };
