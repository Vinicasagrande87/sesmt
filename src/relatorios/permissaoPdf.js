// Permissão de trabalho em PDF, para afixar no local: dados, participantes com a conferência de
// treinamento e ASO, checklist, medições e QR para conferir se a permissão está válida.
const PDFDocument = require('pdfkit');
const { dataBR, dataHoraBR, cnpjFormatado } = require('./formatos');
const { desenharTabela, rodape, campo } = require('./tabelaPdf');

const STATUS = { aguardando_assinaturas: 'AGUARDANDO ASSINATURAS — NÃO INICIAR', liberada: 'LIBERADA', encerrada: 'ENCERRADA', cancelada: 'CANCELADA / SUSPENSA' };

function titulo(doc, texto) {
  if (doc.y > doc.page.height - 120) doc.addPage();
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(9.5).fillColor('#1d3557').text(texto.toUpperCase());
  doc.fillColor('#000').moveDown(0.2);
}

function gerarPermissaoPdf({ permissao: p, qr, url, emitidoPor }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 50, left: 40, right: 40 }, bufferPages: true });
  doc.image(qr, doc.page.width - 40 - 70, 34, { width: 70 });
  doc.font('Helvetica-Bold').fontSize(13).text(`PERMISSÃO DE TRABALHO Nº ${p.numero}`, 40, 40, { width: 420 });
  doc.font('Helvetica-Bold').fontSize(11).text(p.nome_tipo.toUpperCase(), { width: 420 });
  const corStatus = p.status === 'liberada' && !p.vencida ? '#1b5e20' : '#8a1c17';
  doc.fillColor(corStatus).fontSize(10).text(p.vencida ? 'VENCIDA — NÃO CONTINUAR' : STATUS[p.status], { width: 420 }).fillColor('#000');
  doc.font('Helvetica').fontSize(7.5).fillColor('#555').text(`Confira se ainda está válida: ${url}`, { width: 420 }).fillColor('#000');
  if (doc.y < 112) doc.y = 112;
  doc.moveDown(0.4);

  const f = p.filial_dados;
  campo(doc, 'Empregador', `${f.razao_social || f.nome} — CNPJ ${cnpjFormatado(f.cnpj)}`);
  campo(doc, 'Local', [p.predio, p.local_descricao].filter(Boolean).join(' · '));
  campo(doc, 'Serviço', p.servico);
  campo(doc, 'Validade', `de ${dataHoraBR(p.inicio)} até ${dataHoraBR(p.fim)}`);
  campo(doc, 'Emitida por', `${p.emitida_por_nome} em ${dataHoraBR(p.created_at)}`);
  if (p.epis) campo(doc, 'EPIs', p.epis);
  if (p.medidas_adicionais) campo(doc, 'Medidas adicionais', p.medidas_adicionais);

  titulo(doc, 'Participantes (conferidos na emissão)');
  desenharTabela(doc, {
    colunas: [{ titulo: 'Nome', largura: 130 }, { titulo: 'Papel', largura: 80 }, { titulo: 'Treinamento (validade)', largura: 135 },
      { titulo: 'ASO (validade)', largura: 70 }, { titulo: 'Ciência', largura: 100 }],
    linhas: p.participantes.map((x) => [
      `${x.nome} (${x.matricula})`, x.nome_papel,
      x.conferencia.treinamentos.map((t) => `${t.treinamento}${t.vencimento ? ` (${dataBR(t.vencimento)})` : ''}`).join('\n') || '—',
      x.conferencia.aso ? (x.conferencia.aso.vencimento ? dataBR(x.conferencia.aso.vencimento) : 'apto') : '—',
      x.assinado_em ? `${dataHoraBR(x.assinado_em)}${x.metodo_assinatura === 'qr_pin' ? ' (crachá + PIN)' : ' (manual)'}` : 'PENDENTE'
    ])
  });

  titulo(doc, 'Verificações antes de iniciar');
  desenharTabela(doc, {
    colunas: [{ titulo: 'Item', largura: 445 }, { titulo: 'Resposta', largura: 70 }],
    linhas: p.checklist_itens.map((i) => [i.descricao, i.resposta === true ? 'Sim' : 'Não se aplica'])
  });

  if (p.medicoes.length) {
    titulo(doc, 'Medições da atmosfera');
    desenharTabela(doc, {
      colunas: [{ titulo: 'Hora', largura: 85 }, { titulo: 'O2 %', largura: 50 }, { titulo: 'LIE %', largura: 50 }, { titulo: 'H2S ppm', largura: 55 },
        { titulo: 'CO ppm', largura: 55 }, { titulo: 'Resultado', largura: 70 }, { titulo: 'Equipamento', largura: 150 }],
      linhas: p.medicoes.map((m) => [dataHoraBR(m.medido_em), m.o2 ?? '', m.lie ?? '', m.h2s ?? '', m.co ?? '', m.dentro_limites ? 'Dentro' : 'FORA', m.equipamento || '']),
      destacar: (i) => !p.medicoes[i].dentro_limites
    });
  }

  if (p.status === 'encerrada') { titulo(doc, 'Encerramento'); campo(doc, dataHoraBR(p.encerrada_em), p.encerramento_observacao); }
  if (p.status === 'cancelada') { titulo(doc, 'Cancelamento / suspensão'); campo(doc, dataHoraBR(p.cancelada_em), p.motivo_cancelamento); }

  rodape(doc, `Permissão ${p.numero} · código ${p.codigo_verificacao} · emitido em ${dataHoraBR(new Date())} por ${emitidoPor}`);
  doc.end();
  return doc;
}

module.exports = { gerarPermissaoPdf };
