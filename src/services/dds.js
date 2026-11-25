// Regras do DDS: frequência da meta, situação de cada meta (hoje ou numa data-base) e indicadores do mês.
// Conta o DDS encerrado com ao menos uma presença válida. DDS da filial inteira (sem setor) vale para todos os setores.
const { hoje, somarDias, somarMeses, diasEntre } = require('../utils/datas');
const { noEscopo } = require('../utils/escopo');
const { funcionariosNaData } = require('./historico');

const FREQUENCIAS = { diaria: 'Diária (dias úteis)', semanal: 'Semanal', quinzenal: 'Quinzenal', mensal: 'Mensal' };
const PERIODO_DIAS = { semanal: 7, quinzenal: 15, mensal: 31 };
const SITUACOES = ['sem_dds', 'atrasado', 'em_dia'];

const numero = (d) => `${d.ano}/${String(d.sequencial).padStart(4, '0')}`;
const diaDaSemana = (data) => new Date(`${data}T12:00:00Z`).getUTCDay();

function diaUtilAnterior(data) {
  let d = somarDias(data, -1);
  while ([0, 6].includes(diaDaSemana(d))) d = somarDias(d, -1);
  return d;
}

// Data mais antiga aceitável para o último DDS, e até quando vale o último realizado
function limiteDaMeta(frequencia, dataRef) {
  if (frequencia === 'diaria') return diaUtilAnterior(dataRef);
  return somarDias(dataRef, -PERIODO_DIAS[frequencia]);
}
function proximoDevido(frequencia, ultimo) {
  if (frequencia === 'diaria') {
    let d = somarDias(ultimo, 1);
    while ([0, 6].includes(diaDaSemana(d))) d = somarDias(d, 1);
    return d;
  }
  return somarDias(ultimo, PERIODO_DIAS[frequencia]);
}

// DDS válidos (encerrados, com presença não anulada) até a data, por filial
function ddsRealizados(db, filialIds, ate) {
  return db('dds as d').where('d.status', 'encerrado').whereIn('d.filial_id', filialIds).where('d.data', '<=', ate)
    .whereExists(db('dds_presencas as p').leftJoin('dds_presenca_anulacoes as n', 'n.presenca_id', 'p.id').whereRaw('p.dds_id = d.id').whereNull('n.id'))
    .select('d.id', 'd.filial_id', 'd.setor_id', 'd.data', 'd.tema', 'd.duracao_min');
}

async function situacaoDds(db, req, filtros = {}, { dataBase = null } = {}) {
  const dataRef = dataBase || hoje();
  const q = noEscopo(db('dds_metas as m'), req, 'm.filial_id').join('filiais as f', 'f.id', 'm.filial_id').leftJoin('setores as s', 's.id', 'm.setor_id')
    .where('m.ativa', true).select('m.*', 'f.nome as filial', 's.nome as setor');
  if (filtros.filial_id) q.where('m.filial_id', filtros.filial_id);
  const metas = await q;
  if (!metas.length) return [];
  const filialIds = [...new Set(metas.map((m) => m.filial_id))];
  const realizados = await ddsRealizados(db, filialIds, dataRef);
  const pessoas = await funcionariosNaData(db, req, filtros.filial_id ? { filial_id: filtros.filial_id } : {}, { dataBase });
  const desde30 = somarDias(dataRef, -29);
  const presencas = realizados.length ? await db('dds_presencas as p').leftJoin('dds_presenca_anulacoes as n', 'n.presenca_id', 'p.id').whereNull('n.id')
    .whereIn('p.dds_id', realizados.filter((d) => d.data >= desde30).map((d) => d.id).concat(0)).select('p.dds_id', 'p.funcionario_id') : [];

  const itens = [];
  for (const m of metas) {
    const doAlvo = pessoas.filter((p) => p.filial_id === m.filial_id && (!m.setor_id || p.setor_id === m.setor_id));
    if (!doAlvo.length) continue; // setor sem ninguém trabalhando: nada a cobrar
    const ddsDoAlvo = realizados.filter((d) => d.filial_id === m.filial_id && (!m.setor_id || !d.setor_id || d.setor_id === m.setor_id));
    const ultimo = ddsDoAlvo.map((d) => d.data).sort().pop() || null;
    let situacao = 'em_dia';
    if (!ultimo) situacao = 'sem_dds';
    else if (ultimo < limiteDaMeta(m.frequencia, dataRef)) situacao = 'atrasado';
    const ids = new Set(ddsDoAlvo.filter((d) => d.data >= desde30).map((d) => d.id));
    const alvo = new Set(doAlvo.map((p) => p.id));
    const participantes = new Set(presencas.filter((p) => ids.has(p.dds_id) && alvo.has(p.funcionario_id)).map((p) => p.funcionario_id));
    itens.push({
      meta_id: m.id, filial_id: m.filial_id, filial: m.filial, setor_id: m.setor_id, setor: m.setor || 'Filial inteira', frequencia: m.frequencia,
      situacao, ultimo_dds: ultimo, proximo: ultimo ? proximoDevido(m.frequencia, ultimo) : dataRef,
      dias_desde: ultimo ? diasEntre(ultimo, dataRef) - 1 : null,
      empregados: doAlvo.length, participantes_30_dias: participantes.size,
      participacao_30_dias: Math.round((participantes.size / doAlvo.length) * 1000) / 10
    });
  }
  return itens.sort((a, b) => SITUACOES.indexOf(a.situacao) - SITUACOES.indexOf(b.situacao) || a.filial.localeCompare(b.filial));
}

// Indicadores do mês (AAAA-MM) por filial e setor; detalhar = lista quem não participou
async function indicadores(db, req, { filialId = null, mes, detalhar = false }) {
  const inicio = `${mes}-01`;
  const fim = somarDias(somarMeses(inicio, 1), -1);
  const q = noEscopo(db('filiais'), req, 'id').where('ativa', true).orderBy('nome').select('id', 'nome');
  if (filialId) q.where('id', filialId);
  const filiais = await q;
  const realizados = (await ddsRealizados(db, filiais.map((f) => f.id).concat(0), fim)).filter((d) => d.data >= inicio);
  const presencas = realizados.length ? await db('dds_presencas as p').leftJoin('dds_presenca_anulacoes as n', 'n.presenca_id', 'p.id').whereNull('n.id')
    .whereIn('p.dds_id', realizados.map((d) => d.id)).select('p.dds_id', 'p.funcionario_id') : [];
  const pessoas = await funcionariosNaData(db, req, filialId ? { filial_id: filialId } : {}, { dataBase: fim < hoje() ? fim : null });
  const setores = await db('setores').whereIn('filial_id', filiais.map((f) => f.id).concat(0)).select('id', 'nome', 'filial_id');

  return filiais.map((f) => {
    const daFilial = realizados.filter((d) => d.filial_id === f.id);
    const ids = new Set(daFilial.map((d) => d.id));
    const pres = presencas.filter((p) => ids.has(p.dds_id));
    const participaram = new Set(pres.map((p) => p.funcionario_id));
    const ativos = pessoas.filter((p) => p.filial_id === f.id);
    const porSetor = setores.filter((s) => s.filial_id === f.id).map((s) => {
      const doSetor = ativos.filter((p) => p.setor_id === s.id);
      const ddsSetor = daFilial.filter((d) => !d.setor_id || d.setor_id === s.id);
      const partSetor = doSetor.filter((p) => participaram.has(p.id));
      return {
        setor_id: s.id, setor: s.nome, empregados: doSetor.length, dds: ddsSetor.length, participantes: partSetor.length,
        participacao: doSetor.length ? Math.round((partSetor.length / doSetor.length) * 1000) / 10 : null,
        ...(detalhar ? { sem_participacao: doSetor.filter((p) => !participaram.has(p.id)).map((p) => ({ funcionario_id: p.id, nome: p.nome, matricula: p.matricula })) } : {})
      };
    }).filter((s) => s.empregados || s.dds);
    return {
      filial_id: f.id, filial: f.nome, mes, dds: daFilial.length, presencas: pres.length, minutos: daFilial.reduce((t, d) => t + (d.duracao_min || 0), 0),
      empregados: ativos.length, participantes: [...participaram].filter((id) => ativos.some((p) => p.id === id)).length,
      participacao: ativos.length ? Math.round(([...participaram].filter((id) => ativos.some((p) => p.id === id)).length / ativos.length) * 1000) / 10 : null,
      setores: porSetor
    };
  });
}

module.exports = { FREQUENCIAS, SITUACOES, numero, diaUtilAnterior, limiteDaMeta, situacaoDds, indicadores };
