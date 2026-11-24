// Regras das ocorrências de SST: tipos, prazos da CAT e da investigação, situação de cada ocorrência
// (hoje ou numa data-base) e indicadores da NBR 14280 (taxa de frequência e de gravidade).
const { hoje, somarDias, somarMeses, diasEntre, dataLocal, fimDoDia } = require('../utils/datas');
const { noEscopo } = require('../utils/escopo');

const TIPOS = {
  acidente_tipico: 'Acidente típico',
  acidente_trajeto: 'Acidente de trajeto',
  doenca_ocupacional: 'Doença ocupacional',
  incidente: 'Incidente (sem lesão)',
  quase_acidente: 'Quase-acidente'
};
const EXIGE_CAT = ['acidente_tipico', 'acidente_trajeto', 'doenca_ocupacional']; // com vítima empregada
const ACIDENTES = EXIGE_CAT;                       // exigem vítima com lesão
const VINCULOS = { empregado: 'Empregado', terceiro: 'Terceiro', estudante: 'Estudante', visitante: 'Visitante' };
const GRAVIDADES = { leve: 'Leve', moderada: 'Moderada', grave: 'Grave', fatal: 'Fatal' };
const METODOS = { arvore_causas: 'Árvore de causas', cinco_porques: '5 porquês', ishikawa: 'Ishikawa (6M)', outro: 'Outro' };
const TIPOS_CAUSA = { imediata: 'Imediata', raiz: 'Raiz', contribuinte: 'Contribuinte' };
const CATEGORIAS_CAUSA = { mao_de_obra: 'Mão de obra', metodo: 'Método', maquina: 'Máquina', material: 'Material', meio_ambiente: 'Meio ambiente', medicao: 'Medição', gestao: 'Gestão' };
const TIPOS_CAT = { inicial: 'Inicial', reabertura: 'Reabertura', obito: 'Comunicação de óbito' };
const EMITENTES = ['empregador', 'sindicato', 'medico', 'segurado', 'autoridade'];
// eSocial S-2210, tpLocal
const TIPOS_LOCAL = { 1: 'Estabelecimento do empregador', 3: 'Estabelecimento de terceiros onde presta serviço', 4: 'Via pública', 5: 'Área rural', 6: 'Embarcação', 9: 'Outros' };
const LATERALIDADES = ['esquerda', 'direita', 'ambas', 'nao_aplica'];

const PRAZO_INVESTIGACAO_DIAS = 30;
const DIAS_DEBITADOS_MORTE = 6000;   // NBR 14280, quadro 1
const HORAS_MES_PADRAO = 176;        // estimativa de horas-homem quando a filial não informou (8 h x 22 dias)
const SITUACOES = ['cat_pendente', 'investigacao_atrasada', 'cat_a_emitir', 'em_investigacao', 'em_dia'];

const numero = (o) => `${o.ano}/${String(o.sequencial).padStart(4, '0')}`;

// Primeiro dia útil seguinte (sábado e domingo pulados; feriados não são considerados)
function proximoDiaUtil(data) {
  let d = somarDias(data, 1);
  for (;;) {
    const semana = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (semana !== 0 && semana !== 6) return d;
    d = somarDias(d, 1);
  }
}

// Lei 8.213, art. 22: CAT até o 1º dia útil seguinte ao acidente; em caso de morte, de imediato
const prazoCat = (dataOcorrencia, obito) => (obito ? dataOcorrencia : proximoDiaUtil(dataOcorrencia));

// Dias perdidos (NBR 14280): informado, ou do afastamento até a véspera do retorno (sem retorno: até a data de referência)
function diasPerdidos(v, dataRef) {
  if (v.dias_perdidos !== null && v.dias_perdidos !== undefined) return v.dias_perdidos;
  if (!v.houve_afastamento || !v.data_afastamento) return 0;
  const fim = v.data_retorno ? somarDias(v.data_retorno, -1) : dataRef;
  return fim < v.data_afastamento ? 0 : diasEntre(v.data_afastamento, fim);
}

// Situação de cada ocorrência (abertas, ou dos últimos 12 meses). Com dataBase: como estava naquele dia.
async function situacaoOcorrencias(db, req, filtros = {}, { dataBase = null } = {}) {
  const dataRef = dataBase || hoje();
  const corte = fimDoDia(dataRef);
  const q = noEscopo(db('ocorrencias as o'), req, 'o.filial_id').join('filiais as f', 'f.id', 'o.filial_id')
    .where('o.legado', false).where('o.data_hora', '<', corte)
    .andWhere((w) => w.whereNull('o.cancelada_em').orWhere('o.cancelada_em', '>=', corte))
    .andWhere((w) => w.where('o.data_hora', '>=', new Date(`${somarMeses(dataRef, -12)}T00:00:00-03:00`))
      .orWhereNull('o.concluida_em').orWhere('o.concluida_em', '>=', corte))
    .orderBy('o.data_hora', 'desc')
    .select('o.*', 'f.nome as filial');
  if (filtros.filial_id) q.where('o.filial_id', filtros.filial_id);
  if (filtros.ocorrencia_id) q.where('o.id', filtros.ocorrencia_id);
  const ocorrencias = await q;
  if (!ocorrencias.length) return [];

  const ids = ocorrencias.map((o) => o.id);
  const vitimas = await db('ocorrencia_vitimas as v').leftJoin('funcionarios as fu', 'fu.id', 'v.funcionario_id')
    .whereIn('v.ocorrencia_id', ids).select('v.*', db.raw('coalesce(fu.nome, v.nome) as nome_vitima'));
  const cats = await db('cats as c').leftJoin('cat_anulacoes as n', 'n.cat_id', 'c.id').whereNull('n.id')
    .whereIn('c.vitima_id', vitimas.map((v) => v.id).concat(0)).where('c.data_emissao', '<=', dataRef)
    .select('c.vitima_id', 'c.tipo');

  return ocorrencias.map((o) => {
    const data = dataLocal(o.data_hora);
    const minhas = vitimas.filter((v) => v.ocorrencia_id === o.id);
    const precisamCat = EXIGE_CAT.includes(o.tipo) ? minhas.filter((v) => v.vinculo === 'empregado' && (v.houve_lesao || v.obito)) : [];
    const semCat = precisamCat.filter((v) => !cats.some((c) => c.vitima_id === v.id && (c.tipo === 'inicial' || c.tipo === 'obito')));
    const prazo = prazoCat(data, minhas.some((v) => v.obito));
    const concluida = o.status === 'concluida' && o.concluida_em && new Date(o.concluida_em) < corte;
    const prazoInvestigacao = somarDias(data, PRAZO_INVESTIGACAO_DIAS);
    const estados = [];
    if (semCat.length) estados.push(dataRef > prazo ? 'cat_pendente' : 'cat_a_emitir');
    if (!concluida) estados.push(dataRef > prazoInvestigacao ? 'investigacao_atrasada' : 'em_investigacao');
    const situacao = SITUACOES.find((s) => estados.includes(s)) || 'em_dia';
    return {
      ocorrencia_id: o.id, numero: numero(o), filial_id: o.filial_id, filial: o.filial, tipo: o.tipo, data, gravidade: o.gravidade,
      local: o.local_descricao, status: o.status, situacao,
      prazo_cat: precisamCat.length ? prazo : null, cat_pendente_de: semCat.map((v) => v.nome_vitima),
      prazo_investigacao: concluida ? null : prazoInvestigacao,
      vitimas: minhas.length, afastados: minhas.filter((v) => v.houve_afastamento && (!v.data_retorno || v.data_retorno > dataRef)).length
    };
  });
}

// Horas-homem do mês: informada pela filial ou estimada (empregados lotados no dia 15 x 176 h)
async function horasDoMes(db, filialId, competencia) {
  const informada = await db('horas_trabalhadas').where({ filial_id: filialId, competencia }).first('horas');
  if (informada) return { hht: Number(informada.horas), estimado: false };
  const meio = `${competencia}-15`;
  const { n } = await db('funcionario_lotacoes').where({ filial_id: filialId }).where('inicio', '<=', meio)
    .andWhere((w) => w.whereNull('fim').orWhere('fim', '>=', meio)).countDistinct({ n: 'funcionario_id' }).first();
  return { hht: Number(n) * HORAS_MES_PADRAO, estimado: true };
}

const taxa = (valor, hht) => (hht > 0 ? Math.round((valor * 1e6 / hht) * 100) / 100 : null);

// Indicadores NBR 14280 por filial e mês do ano. Trajeto fica fora das taxas (contado à parte).
async function indicadores(db, filiais, ano) {
  const dataHoje = hoje();
  const ultimoMes = String(ano) === dataHoje.slice(0, 4) ? Number(dataHoje.slice(5, 7)) : 12;
  const resultado = [];
  for (const f of filiais) {
    const linhas = await db('ocorrencias as o').join('ocorrencia_vitimas as v', 'v.ocorrencia_id', 'o.id')
      .where('o.filial_id', f.id).whereNull('o.cancelada_em').where('o.ano', ano).select('o.tipo', 'o.data_hora', 'o.id as ocorrencia_id', 'v.*');
    const semVitima = await db('ocorrencias').where({ filial_id: f.id, ano }).whereNull('cancelada_em').whereIn('tipo', ['incidente', 'quase_acidente'])
      .select('tipo', 'data_hora');
    const meses = [];
    for (let m = 1; m <= ultimoMes; m++) {
      const competencia = `${ano}-${String(m).padStart(2, '0')}`;
      const doMes = (l) => dataLocal(l.data_hora).slice(0, 7) === competencia;
      const vit = linhas.filter(doMes).filter((v) => v.vinculo === 'empregado');
      const tipicas = vit.filter((v) => (v.tipo === 'acidente_tipico' || v.tipo === 'doenca_ocupacional') && (v.houve_lesao || v.obito));
      const comAfastamento = tipicas.filter((v) => v.houve_afastamento || v.obito);
      const perdidos = comAfastamento.reduce((t, v) => t + diasPerdidos(v, dataHoje), 0);
      const debitados = tipicas.reduce((t, v) => t + (v.dias_debitados ?? (v.obito ? DIAS_DEBITADOS_MORTE : 0)), 0);
      const { hht, estimado } = await horasDoMes(db, f.id, competencia);
      meses.push({
        competencia, hht, hht_estimado: estimado,
        com_afastamento: comAfastamento.length, sem_afastamento: tipicas.length - comAfastamento.length,
        trajeto: vit.filter((v) => v.tipo === 'acidente_trajeto').length,
        doencas: vit.filter((v) => v.tipo === 'doenca_ocupacional').length,
        obitos: tipicas.filter((v) => v.obito).length,
        incidentes: semVitima.filter((o) => o.tipo === 'incidente' && dataLocal(o.data_hora).slice(0, 7) === competencia).length,
        quase_acidentes: semVitima.filter((o) => o.tipo === 'quase_acidente' && dataLocal(o.data_hora).slice(0, 7) === competencia).length,
        dias_perdidos: perdidos, dias_debitados: debitados,
        taxa_frequencia: taxa(comAfastamento.length, hht), taxa_gravidade: taxa(perdidos + debitados, hht)
      });
    }
    const soma = (k) => meses.reduce((t, m) => t + m[k], 0);
    const hht = soma('hht');
    const total = {
      hht, hht_estimado: meses.some((m) => m.hht_estimado),
      ...Object.fromEntries(['com_afastamento', 'sem_afastamento', 'trajeto', 'doencas', 'obitos', 'incidentes', 'quase_acidentes', 'dias_perdidos', 'dias_debitados'].map((k) => [k, soma(k)]))
    };
    total.taxa_frequencia = taxa(total.com_afastamento, hht);
    total.taxa_gravidade = taxa(total.dias_perdidos + total.dias_debitados, hht);

    const ultimo = await db('ocorrencias as o').join('ocorrencia_vitimas as v', 'v.ocorrencia_id', 'o.id')
      .where('o.filial_id', f.id).whereNull('o.cancelada_em').whereIn('o.tipo', ['acidente_tipico', 'doenca_ocupacional'])
      .where('v.vinculo', 'empregado').andWhere((w) => w.where('v.houve_afastamento', true).orWhere('v.obito', true))
      .orderBy('o.data_hora', 'desc').first('o.data_hora');
    resultado.push({
      filial_id: f.id, filial: f.nome, meses, total,
      ultimo_acidente_com_afastamento: ultimo ? dataLocal(ultimo.data_hora) : null,
      dias_sem_acidente_com_afastamento: ultimo ? diasEntre(dataLocal(ultimo.data_hora), dataHoje) - 1 : null
    });
  }
  return resultado;
}

module.exports = {
  TIPOS, EXIGE_CAT, ACIDENTES, VINCULOS, GRAVIDADES, METODOS, TIPOS_CAUSA, CATEGORIAS_CAUSA, TIPOS_CAT, EMITENTES, TIPOS_LOCAL, LATERALIDADES,
  PRAZO_INVESTIGACAO_DIAS, DIAS_DEBITADOS_MORTE, HORAS_MES_PADRAO, SITUACOES,
  numero, proximoDiaUtil, prazoCat, diasPerdidos, situacaoOcorrencias, horasDoMes, indicadores
};
