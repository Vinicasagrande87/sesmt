// Regras do PPCI por prédio: tipos de equipamento, periodicidades, checklist da inspeção mensal,
// situação do alvará, situação de cada equipamento e comparação "projeto aprovado x instalado".
const { hoje: hojeBR, somarDias, paraISO, dataLocal, fimDoDia } = require('../utils/datas');
const { noEscopo } = require('../utils/escopo');

const AGENTES = {
  agua: 'Água pressurizada',
  espuma: 'Espuma mecânica',
  pqs_bc: 'Pó químico BC',
  pqs_abc: 'Pó químico ABC',
  co2: 'Gás carbônico (CO2)',
  classe_d: 'Classe D',
  classe_k: 'Classe K'
};

// Checklist comum a todos: o equipamento precisa estar no lugar, visível e acessível
const BASE = [
  ['no_local', 'Está no local indicado'],
  ['acesso_desobstruido', 'Acesso desobstruído'],
  ['sinalizacao', 'Sinalização visível e em bom estado']
];

// manutencoes: tipo -> meses até a próxima; exige: o que precisa ter registro (senão vira pendência)
const EQUIPAMENTOS = {
  extintor: {
    nome: 'Extintor',
    manutencoes: { recarga: 12, teste_hidrostatico: 60 },  // NBR 12962: nível 2 anual, nível 3 a cada 5 anos
    exige: ['recarga', 'teste_hidrostatico'],
    checklist: [...BASE,
      ['lacre_intacto', 'Lacre e pino de segurança intactos'],
      ['manometro_na_faixa', 'Manômetro na faixa verde (não se aplica ao CO2)'],
      ['selo_inmetro', 'Selo do Inmetro e etiqueta de manutenção legíveis'],
      ['mangueira_bico', 'Mangueira, bico e difusor sem danos ou entupimento'],
      ['corpo_sem_danos', 'Cilindro sem amassados, corrosão ou vazamento']]
  },
  hidrante: {
    nome: 'Hidrante',
    manutencoes: { manutencao: 12 },                         // NBR 12779: inspeção e manutenção anual das mangueiras
    exige: ['manutencao'],
    checklist: [...BASE,
      ['abrigo_conservado', 'Abrigo conservado, com vidro/porta em ordem'],
      ['mangueiras_acondicionadas', 'Mangueiras completas e acondicionadas'],
      ['esguicho_chave', 'Esguicho e chave de mangueira presentes'],
      ['registro_sem_vazamento', 'Registro sem vazamento']]
  },
  mangotinho: {
    nome: 'Mangotinho',
    manutencoes: { manutencao: 12 },
    exige: ['manutencao'],
    checklist: [...BASE,
      ['mangueira_enrolada', 'Mangueira completa e enrolada no carretel'],
      ['esguicho', 'Esguicho presente'],
      ['registro_sem_vazamento', 'Registro sem vazamento']]
  },
  iluminacao_emergencia: {
    nome: 'Iluminação de emergência',
    manutencoes: { manutencao: 12 },
    exige: [],
    checklist: [['no_local', 'Está no local indicado'],
      ['acende_no_teste', 'Acende no botão de teste'],
      ['fixacao', 'Bem fixada, sem danos']]
  },
  acionador_alarme: {
    nome: 'Acionador manual de alarme',
    manutencoes: { manutencao: 12 },
    exige: [],
    checklist: [...BASE, ['sem_danos', 'Sem danos, com vidro/tampa em ordem'], ['central_sem_falha', 'Central sem indicação de falha']]
  },
  detector: {
    nome: 'Detector de fumaça/calor',
    manutencoes: { manutencao: 12 },
    exige: [],
    checklist: [['no_local', 'Está no local indicado'], ['sem_danos', 'Sem danos ou obstrução'], ['led_normal', 'Indicador (LED) em estado normal']]
  },
  porta_corta_fogo: {
    nome: 'Porta corta-fogo',
    manutencoes: { manutencao: 12 },
    exige: [],
    checklist: [['desobstruida', 'Passagem desobstruída e sem calço'], ['fecha_sozinha', 'Fecha sozinha e trava'], ['sinalizacao', 'Sinalização visível']]
  },
  bomba_incendio: {
    nome: 'Bomba de incêndio',
    manutencoes: { manutencao: 12 },
    exige: ['manutencao'],
    checklist: [['painel_automatico', 'Painel em modo automático'], ['sem_vazamento', 'Sem vazamentos'], ['teste_partida', 'Partida no teste semanal registrada']]
  }
};

// Medidas do projeto que não são equipamentos com QR: entram no projeto, mas não são contadas
const OUTRAS_MEDIDAS = {
  sinalizacao: 'Sinalização de emergência',
  saida_emergencia: 'Saídas de emergência',
  brigada: 'Brigada de incêndio',
  spda: 'SPDA (para-raios)',
  compartimentacao: 'Compartimentação',
  controle_materiais: 'Controle de materiais de acabamento',
  acesso_viaturas: 'Acesso de viaturas',
  central_gas: 'Central de GLP/GN',
  chuveiros_automaticos: 'Chuveiros automáticos (sprinklers)',
  plano_emergencia: 'Plano de emergência',
  outro: 'Outra medida'
};

const TIPOS_MEDIDA = [...Object.keys(EQUIPAMENTOS), ...Object.keys(OUTRAS_MEDIDAS)];
const nomeDaMedida = (tipo) => (EQUIPAMENTOS[tipo] ? EQUIPAMENTOS[tipo].nome : OUTRAS_MEDIDAS[tipo]);

const INSPECAO_DIAS = 30;          // inspeção mensal
const DIAS_EQUIPAMENTO = 30;       // aviso de vencimento de recarga/teste/manutenção
const DIAS_ALVARA = 90;            // a renovação do alvará precisa ser pedida com antecedência

const MANUTENCOES = [...new Set(Object.values(EQUIPAMENTOS).flatMap((e) => Object.keys(e.manutencoes)))];
const SITUACOES_EQUIPAMENTO = [
  ...MANUTENCOES.flatMap((t) => [`${t}_vencida`, `${t}_vencendo`, `${t}_nao_registrada`]),
  'inspecao_atrasada', 'nao_conforme'
];
const SITUACOES_PREDIO = ['sem_ppci', 'sem_alvara', 'alvara_vencido', 'alvara_vencendo', 'divergencia_projeto'];

function situacaoDoAlvara(alvara, { hoje = hojeBR(), dias = DIAS_ALVARA } = {}) {
  if (!alvara) return 'sem_alvara';
  const validade = paraISO(alvara.data_validade);
  if (validade < hoje) return 'vencido';
  if (validade <= somarDias(hoje, dias)) return 'vencendo';
  return 'vigente';
}

// Último registro não anulado por chave (ex.: PPCI mais recente de cada prédio); com dataBase, só até a data
async function ultimosVigentes(db, { tabela, anulacoes, fk, chave, ids, ordem, dataBase = null }) {
  if (!ids.length) return new Map();
  const q = db(`${tabela} as t`)
    .leftJoin(`${anulacoes} as n`, `n.${fk}`, 't.id')
    .whereNull('n.id')
    .whereIn(`t.${chave}`, ids)
    .distinctOn(`t.${chave}`)
    .orderBy([{ column: `t.${chave}` }, ...ordem.map((c) => ({ column: `t.${c}`, order: 'desc' })), { column: 't.id', order: 'desc' }])
    .select('t.*');
  if (dataBase) q.where(`t.${ordem[0]}`, '<=', dataBase);
  const linhas = await q;
  return new Map(linhas.map((l) => [l[chave], l]));
}

const ppcisVigentes = (db, predioIds, { dataBase } = {}) => ultimosVigentes(db, {
  tabela: 'ppcis', anulacoes: 'ppci_anulacoes', fk: 'ppci_id', chave: 'predio_id', ids: predioIds, ordem: ['data_aprovacao'], dataBase
});
const alvarasVigentes = (db, predioIds, { dataBase } = {}) => ultimosVigentes(db, {
  tabela: 'alvaras', anulacoes: 'alvara_anulacoes', fk: 'alvara_id', chave: 'predio_id', ids: predioIds, ordem: ['data_emissao', 'data_validade'], dataBase
});

// Equipamentos ativos nos prédios (hoje, ou onde estavam e se estavam ativos no fim do dia da data-base)
async function equipamentosDosPredios(db, predioIds, { dataBase = null } = {}) {
  if (!predioIds.length) return [];
  if (!dataBase) {
    return db('equipamentos_incendio').whereIn('predio_id', predioIds).where('ativo', true).orderBy('identificacao');
  }
  const naData = db('equipamento_historico as h')
    .where('h.inicio', '<', fimDoDia(dataBase))
    .distinctOn('h.equipamento_id')
    .orderBy([{ column: 'h.equipamento_id' }, { column: 'h.inicio', order: 'desc' }, { column: 'h.id', order: 'desc' }])
    .select('h.equipamento_id', 'h.predio_id', 'h.ativo');
  const linhas = await db.from(naData.as('h')).join('equipamentos_incendio as e', 'e.id', 'h.equipamento_id')
    .whereIn('h.predio_id', predioIds).where('h.ativo', true)
    .orderBy('e.identificacao').select('e.*', 'h.predio_id as predio_na_data');
  return linhas.map(({ predio_na_data, ...e }) => ({ ...e, predio_id: predio_na_data, ativo: true }));
}

// Situação de cada equipamento: manutenções por tipo e última inspeção. Devolve os equipamentos com
// { manutencoes: { recarga: {...} }, inspecao: {...}, pendencias: ['recarga_vencida', ...] }
// Com dataBase: só serviços e inspeções até aquela data, e prazos contados a partir dela.
async function situacaoDosEquipamentos(db, equipamentos, { hoje = hojeBR(), dias = DIAS_EQUIPAMENTO, dataBase = null } = {}) {
  const ids = equipamentos.map((e) => e.id);
  if (!ids.length) return [];
  if (dataBase) hoje = dataBase;
  const qManut = db('equipamento_manutencoes as m')
    .leftJoin('manutencao_anulacoes as n', 'n.manutencao_id', 'm.id')
    .whereNull('n.id').whereIn('m.equipamento_id', ids)
    .distinctOn('m.equipamento_id', 'm.tipo')
    .orderBy([{ column: 'm.equipamento_id' }, { column: 'm.tipo' }, { column: 'm.data_servico', order: 'desc' }, { column: 'm.id', order: 'desc' }])
    .select('m.id', 'm.equipamento_id', 'm.tipo', 'm.data_servico', 'm.data_proxima', 'm.empresa', 'm.numero_selo');
  if (dataBase) qManut.where('m.data_servico', '<=', dataBase);
  const manutencoes = await qManut;
  const qInsp = db('equipamento_inspecoes as i')
    .leftJoin('inspecao_anulacoes as n', 'n.inspecao_id', 'i.id')
    .whereNull('n.id').whereIn('i.equipamento_id', ids)
    .distinctOn('i.equipamento_id')
    .orderBy([{ column: 'i.equipamento_id' }, { column: 'i.data_hora', order: 'desc' }, { column: 'i.id', order: 'desc' }])
    .select('i.id', 'i.equipamento_id', 'i.data_hora', 'i.conforme', 'i.itens', 'i.observacao', 'i.codigo_verificacao');
  if (dataBase) qInsp.where('i.data_hora', '<', fimDoDia(dataBase));
  const inspecoes = await qInsp;

  const limite = somarDias(hoje, dias);
  return equipamentos.map((eq) => {
    const config = EQUIPAMENTOS[eq.tipo];
    const pendencias = [];
    const resumo = {};
    for (const tipo of Object.keys(config.manutencoes)) {
      const m = manutencoes.find((x) => x.equipamento_id === eq.id && x.tipo === tipo);
      let proxima = m ? paraISO(m.data_proxima) : null;
      let estimada = false;
      // Sem teste hidrostático registrado: conta 5 anos a partir do ano de fabricação (estimativa conservadora)
      if (!m && tipo === 'teste_hidrostatico' && eq.ano_fabricacao) {
        proxima = `${eq.ano_fabricacao + config.manutencoes[tipo] / 12}-01-01`;
        estimada = true;
      }
      let situacao;
      if (!proxima) situacao = config.exige.includes(tipo) ? 'nao_registrada' : 'sem_registro';
      else if (proxima < hoje) situacao = 'vencida';
      else if (proxima <= limite) situacao = 'vencendo';
      else situacao = 'em_dia';
      if (['vencida', 'vencendo', 'nao_registrada'].includes(situacao)) pendencias.push(`${tipo}_${situacao}`);
      resumo[tipo] = { situacao, data_servico: m ? paraISO(m.data_servico) : null, data_proxima: proxima, estimada, empresa: m ? m.empresa : null, numero_selo: m ? m.numero_selo : null };
    }

    const ultima = inspecoes.find((x) => x.equipamento_id === eq.id);
    const dataUltima = ultima ? dataLocal(ultima.data_hora) : null;
    const atrasada = !ultima || dataUltima < somarDias(hoje, -INSPECAO_DIAS);
    if (atrasada) pendencias.push('inspecao_atrasada');
    if (ultima && !ultima.conforme) pendencias.push('nao_conforme');
    const inspecao = ultima
      ? { id: ultima.id, data: dataUltima, data_hora: ultima.data_hora, conforme: ultima.conforme, observacao: ultima.observacao,
        nao_conformes: Object.entries(ultima.itens).filter(([, v]) => v === false).map(([k]) => k), proxima: somarDias(dataUltima, INSPECAO_DIAS),
        codigo_verificacao: ultima.codigo_verificacao }
      : null;
    return { ...eq, manutencoes: resumo, inspecao, pendencias };
  });
}

// Projeto aprovado x instalado. Medidas contáveis (equipamentos com quantidade) são comparadas com os
// equipamentos ativos do prédio; extintor com agente compara só os daquele agente.
function compararProjeto(medidas, equipamentosAtivos) {
  const linhas = [];
  const grupos = new Map();
  for (const m of medidas) {
    if (!EQUIPAMENTOS[m.tipo] || m.quantidade === null || m.quantidade === undefined) {
      linhas.push({ tipo: m.tipo, nome: nomeDaMedida(m.tipo), agente: m.agente || null, especificacao: m.especificacao || null,
        previsto: m.quantidade ?? null, instalado: null, diferenca: null, situacao: 'nao_controlado' });
      continue;
    }
    const k = `${m.tipo}|${m.agente || ''}`;
    const g = grupos.get(k) || { tipo: m.tipo, agente: m.agente || null, previsto: 0, especificacoes: [] };
    g.previsto += m.quantidade;
    if (m.especificacao) g.especificacoes.push(m.especificacao);
    grupos.set(k, g);
  }
  for (const g of grupos.values()) {
    const instalado = equipamentosAtivos.filter((e) => e.tipo === g.tipo && (!g.agente || e.agente === g.agente)).length;
    const diferenca = instalado - g.previsto;
    linhas.unshift({ tipo: g.tipo, nome: nomeDaMedida(g.tipo), agente: g.agente, agente_nome: g.agente ? AGENTES[g.agente] : null,
      especificacao: g.especificacoes.join('; ') || null, previsto: g.previsto, instalado, diferenca,
      situacao: diferenca < 0 ? 'faltando' : diferenca > 0 ? 'excedente' : 'ok' });
  }
  // Instalado sem nada previsto daquele tipo no projeto
  const tiposPrevistos = new Set(medidas.map((m) => m.tipo));
  const fora = new Map();
  for (const e of equipamentosAtivos) if (!tiposPrevistos.has(e.tipo)) fora.set(e.tipo, (fora.get(e.tipo) || 0) + 1);
  for (const [tipo, instalado] of fora) {
    linhas.push({ tipo, nome: nomeDaMedida(tipo), agente: null, especificacao: null, previsto: 0, instalado, diferenca: instalado, situacao: 'fora_do_projeto' });
  }
  return linhas;
}

// Painel de um prédio: PPCI e alvará que valem (hoje ou na data-base), comparação e equipamentos com a situação
async function painelDoPredio(db, predio, { dias = DIAS_EQUIPAMENTO, diasAlvara = DIAS_ALVARA, dataBase = null } = {}) {
  const ppci = (await ppcisVigentes(db, [predio.id], { dataBase })).get(predio.id) || null;
  const alvara = (await alvarasVigentes(db, [predio.id], { dataBase })).get(predio.id) || null;
  const medidas = ppci ? await db('ppci_medidas').where({ ppci_id: ppci.id }).orderBy('id') : [];
  const equipamentos = await equipamentosDosPredios(db, [predio.id], { dataBase });
  const situacao = await situacaoDosEquipamentos(db, equipamentos, { dias, dataBase });
  const comparacao = ppci ? compararProjeto(medidas, equipamentos) : [];
  return {
    ppci: ppci && { ...ppci, data_aprovacao: paraISO(ppci.data_aprovacao), medidas },
    alvara: alvara && { ...alvara, data_emissao: paraISO(alvara.data_emissao), data_validade: paraISO(alvara.data_validade) },
    situacao_alvara: situacaoDoAlvara(alvara, { dias: diasAlvara, ...(dataBase ? { hoje: dataBase } : {}) }),
    comparacao,
    equipamentos: situacao
  };
}

// Pendências de PPCI dos prédios ativos (filtros: filial_id, predio_id). Devolve os itens e as
// unidades verificadas (prédios e equipamentos), para o percentual de conformidade.
async function situacaoPpci(db, req, filtros = {}, { dias = DIAS_EQUIPAMENTO, diasAlvara = DIAS_ALVARA, dataBase = null } = {}) {
  const q = noEscopo(db('predios as p'), req, 'p.filial_id').join('filiais as f', 'f.id', 'p.filial_id')
    .where('p.ativo', true).select('p.*', 'f.nome as filial').orderBy(['f.nome', 'p.nome']);
  if (filtros.filial_id) q.where('p.filial_id', filtros.filial_id);
  if (filtros.predio_id) q.where('p.id', filtros.predio_id);
  if (dataBase) q.where('p.created_at', '<', fimDoDia(dataBase));
  const predios = await q;

  const itens = [];
  const unidades = []; // o que foi verificado: cada prédio e cada equipamento (base do percentual de conformidade)
  for (const predio of predios) {
    const pn = await painelDoPredio(db, predio, { dias, diasAlvara, dataBase });
    unidades.push({ filial_id: predio.filial_id, chave: `p${predio.id}` }, ...pn.equipamentos.map((e) => ({ filial_id: predio.filial_id, chave: `e${e.id}` })));
    const base = { filial_id: predio.filial_id, filial: predio.filial, predio_id: predio.id, predio: predio.nome };
    if (!pn.ppci) itens.push({ ...base, nivel: 'predio', situacao: 'sem_ppci' });
    if (pn.situacao_alvara !== 'vigente') {
      itens.push({ ...base, nivel: 'predio', situacao: pn.situacao_alvara === 'sem_alvara' ? 'sem_alvara' : `alvara_${pn.situacao_alvara}`,
        data_validade: pn.alvara ? pn.alvara.data_validade : null });
    }
    const faltando = pn.comparacao.filter((c) => c.situacao === 'faltando');
    if (faltando.length) {
      itens.push({ ...base, nivel: 'predio', situacao: 'divergencia_projeto',
        detalhe: faltando.map((c) => ({ tipo: c.tipo, agente: c.agente, previsto: c.previsto, instalado: c.instalado })) });
    }
    for (const eq of pn.equipamentos) {
      for (const situacao of eq.pendencias) {
        const manut = eq.manutencoes[situacao.replace(/_(vencida|vencendo|nao_registrada)$/, '')];
        itens.push({ ...base, nivel: 'equipamento', situacao, equipamento_id: eq.id, identificacao: eq.identificacao, tipo: eq.tipo,
          agente: eq.agente, localizacao: eq.localizacao,
          data_limite: situacao.startsWith('inspecao') ? (eq.inspecao ? eq.inspecao.proxima : null) : (manut ? manut.data_proxima : null),
          ...(situacao === 'nao_conforme' ? { nao_conformes: eq.inspecao.nao_conformes, observacao: eq.inspecao.observacao } : {}) });
      }
    }
  }
  return { itens, unidades };
}

module.exports = {
  AGENTES, EQUIPAMENTOS, OUTRAS_MEDIDAS, TIPOS_MEDIDA, MANUTENCOES, INSPECAO_DIAS, DIAS_EQUIPAMENTO, DIAS_ALVARA,
  SITUACOES_EQUIPAMENTO, SITUACOES_PREDIO, nomeDaMedida, situacaoDoAlvara, ppcisVigentes, alvarasVigentes,
  equipamentosDosPredios, situacaoDosEquipamentos, compararProjeto, painelDoPredio, situacaoPpci
};
