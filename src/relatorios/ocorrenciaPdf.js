// Relatório da ocorrência (comunicação + vítimas + CAT + testemunhas + investigação) em PDF.
// Dados médicos (CID, médico, atestado) só saem para saude/admin.
const PDFDocument = require('pdfkit');
const { dataBR, dataHoraBR, cnpjFormatado } = require('./formatos');
const { desenharTabela, rodape, campo } = require('./tabelaPdf');
const O = require('../services/ocorrencias');

const STATUS = { aberta: 'Aberta', em_investigacao: 'Em investigação', concluida: 'Concluída', cancelada: 'Cancelada' };

function titulo(doc, texto) {
  if (doc.y > doc.page.height - 130) doc.addPage();
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(9.5).fillColor('#1d3557').text(texto.toUpperCase());
  doc.fillColor('#000').moveDown(0.2);
}

function paragrafo(doc, texto) {
  doc.font('Helvetica').fontSize(8.5).text(texto || '—', { align: 'justify' });
}

function gerarOcorrenciaPdf({ ocorrencia: o, comDadosMedicos, emitidoPor }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 50, left: 40, right: 40 }, bufferPages: true });
  doc.font('Helvetica-Bold').fontSize(13).text(`${O.TIPOS[o.tipo].toUpperCase()} Nº ${o.numero}`, { align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor('#555').text(`Situação: ${STATUS[o.status]}${o.legado ? ' · registro do sistema antigo' : ''}`, { align: 'center' });
  doc.fillColor('#000').moveDown(0.8);

  const f = o.filial_dados;
  campo(doc, 'Empregador', `${f.razao_social || f.nome} — CNPJ ${cnpjFormatado(f.cnpj)} — ${f.cidade}/${f.uf}`);
  campo(doc, 'Data e hora', dataHoraBR(o.data_hora));
  campo(doc, 'Local', [o.predio, o.setor, o.local_descricao].filter(Boolean).join(' · ') + (o.tipo_local ? ` (${O.TIPOS_LOCAL[o.tipo_local]})` : ''));
  if (o.gravidade) campo(doc, 'Gravidade', O.GRAVIDADES[o.gravidade]);
  if (o.gravidade_potencial) campo(doc, 'Gravidade potencial', O.GRAVIDADES[o.gravidade_potencial]);
  if (o.horas_trabalhadas_antes) campo(doc, 'Horas trabalhadas antes', o.horas_trabalhadas_antes);
  if (o.comunicou_policia !== null && o.comunicou_policia !== undefined) campo(doc, 'Comunicado à polícia', o.comunicou_policia ? 'Sim' : 'Não');
  if (o.status === 'cancelada') campo(doc, 'Cancelada', `${dataHoraBR(o.cancelada_em)} — ${o.motivo_cancelamento}`);

  titulo(doc, 'O que aconteceu');
  paragrafo(doc, o.descricao);
  if (o.atividade) { doc.moveDown(0.3); campo(doc, 'Atividade em execução', o.atividade); }
  if (o.danos_materiais) { doc.moveDown(0.3); campo(doc, 'Danos materiais', o.danos_materiais); }

  if (o.vitimas.length) {
    titulo(doc, 'Pessoas atingidas');
    desenharTabela(doc, {
      colunas: [{ titulo: 'Nome', largura: 120 }, { titulo: 'Vínculo / função', largura: 95 }, { titulo: 'Lesão', largura: 160 },
        { titulo: 'Afastamento', largura: 85 }, { titulo: 'CAT', largura: 55 }],
      linhas: o.vitimas.map((v) => [
        v.nome_vitima,
        [O.VINCULOS[v.vinculo], v.funcao, v.empresa].filter(Boolean).join(' — '),
        v.houve_lesao ? [v.parte_corpo, v.lateralidade && v.lateralidade !== 'nao_aplica' ? v.lateralidade : null, v.natureza_lesao, v.agente_causador && `agente: ${v.agente_causador}`].filter(Boolean).join('; ') || 'Com lesão' : 'Sem lesão',
        v.obito ? `Óbito em ${dataBR(v.data_obito)}` : v.houve_afastamento ? `Desde ${dataBR(v.data_afastamento)}${v.data_retorno ? `, retorno ${dataBR(v.data_retorno)}` : ''} (${v.dias_perdidos_calculados} dias)` : 'Não',
        (v.cats || []).filter((c) => !c.anulada).map((c) => `${c.numero} (${dataBR(c.data_emissao)})`).join('\n') || (v.vinculo === 'empregado' && O.EXIGE_CAT.includes(o.tipo) && v.houve_lesao ? 'PENDENTE' : '—')
      ])
    });
    if (o.prazo_cat) doc.moveDown(0.3).font('Helvetica-Oblique').fontSize(7.5).text(`Prazo legal da CAT (Lei 8.213, art. 22): ${dataBR(o.prazo_cat)}.`);
    if (comDadosMedicos) {
      const medicos = o.vitimas.filter((v) => v.cid || v.medico_nome || v.atestado_data);
      if (medicos.length) {
        titulo(doc, 'Atendimento médico (dado de saúde — sigiloso)');
        for (const v of medicos) {
          campo(doc, v.nome_vitima, [v.atestado_data && `atestado ${dataBR(v.atestado_data)} ${v.atestado_hora || ''}`.trim(), v.cid && `CID ${v.cid}`,
            v.internacao ? 'com internação' : null, v.duracao_tratamento_dias && `${v.duracao_tratamento_dias} dias de tratamento`,
            v.medico_nome && `Dr(a). ${v.medico_nome}${v.medico_crm ? ` CRM ${v.medico_crm}/${v.medico_uf || ''}` : ''}`].filter(Boolean).join(' · '));
        }
      }
    }
  }

  if (o.testemunhas.length) {
    titulo(doc, 'Testemunhas');
    for (const t of o.testemunhas) {
      doc.font('Helvetica-Bold').fontSize(8.5).text(t.nome + (t.contato ? ` — ${t.contato}` : ''));
      if (t.relato) paragrafo(doc, t.relato);
      doc.moveDown(0.2);
    }
  }

  const inv = o.investigacao;
  titulo(doc, 'Investigação');
  if (!inv) paragrafo(doc, 'Ainda não registrada.');
  else {
    campo(doc, 'Método', O.METODOS[inv.metodo]);
    campo(doc, 'Equipe', inv.equipe.join('; '));
    campo(doc, 'Início', dataBR(inv.data_inicio));
    if (inv.descricao_fatos) { doc.moveDown(0.3); paragrafo(doc, inv.descricao_fatos); }
    if (inv.causas.length) {
      doc.moveDown(0.4);
      desenharTabela(doc, {
        colunas: [{ titulo: 'Tipo', largura: 75 }, { titulo: 'Categoria', largura: 90 }, { titulo: 'Causa', largura: 350 }],
        linhas: inv.causas.map((c) => [O.TIPOS_CAUSA[c.tipo], O.CATEGORIAS_CAUSA[c.categoria], c.descricao])
      });
    }
    if (inv.conclusao) { doc.moveDown(0.4); campo(doc, 'Conclusão', ''); paragrafo(doc, inv.conclusao); }
    if ((inv.medidas_recomendadas || []).length) {
      doc.moveDown(0.3).font('Helvetica-Bold').fontSize(9).text('Medidas recomendadas:');
      doc.font('Helvetica').fontSize(8.5);
      for (const m of inv.medidas_recomendadas) doc.text(`•  ${m}`, { indent: 6 });
    }
    if (o.status === 'concluida') doc.moveDown(0.3).font('Helvetica-Oblique').fontSize(8).text(`Investigação concluída em ${dataHoraBR(o.concluida_em)}.`);
  }

  if (o.anexos.length) {
    titulo(doc, 'Anexos');
    for (const a of o.anexos) doc.font('Helvetica').fontSize(8).text(`•  ${a.descricao} (SHA-256 ${a.sha256.slice(0, 16)}…)`);
  }

  rodape(doc, `Ocorrência ${o.numero} · emitido em ${dataHoraBR(new Date())} por ${emitidoPor}${comDadosMedicos ? ' · contém dado de saúde' : ''}`);
  doc.end();
  return doc;
}

module.exports = { gerarOcorrenciaPdf };
