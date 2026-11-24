// Regras do plano de ação: origens, hierarquia de controle (NR-1), prioridades, status e a situação de cada
// ação (hoje ou como estava numa data-base, reconstruída pela linha do tempo e pelas reprogramações).
const { hoje, somarDias, somarMeses, diasEntre, dataLocal, fimDoDia } = require('../utils/datas');
const { noEscopo } = require('../utils/escopo');
const { ErroDeNegocio } = require('../utils/erros');
const { idValido } = require('../utils/validacao');
const { TIPOS: TIPOS_OCORRENCIA, numero: numeroOcorrencia } = require('./ocorrencias');

const ORIGENS = { ocorrencia: 'Ocorrência', pgr: 'PGR', inspecao_incendio: 'Inspeção de incêndio', predio: 'Prédio (PPCI)', manual: 'Outra (visita, auditoria, reunião...)' };
// NR-1, 1.5.5.1.2: hierarquia das medidas de prevenção
const TIPOS_MEDIDA = { eliminacao: 'Eliminação do perigo', substituicao: 'Substituição', engenharia: 'Proteção coletiva (engenharia)', administrativa: 'Administrativa / organizacional', epi: 'EPI' };
const PRIORIDADES = { baixa: 'Baixa', media: 'Média', alta: 'Alta', urgente: 'Urgente' };
const STATUS = { aberta: 'Aberta', em_andamento: 'Em andamento', concluida: 'Concluída (aguarda verificação)', verificada: 'Verificada (eficaz)', cancelada: 'Cancelada' };
const ABERTAS = ['aberta', 'em_andamento'];
const SITUACOES = ['atrasada', 'vence_em_breve', 'no_prazo', 'concluida', 'verificada'];

const numero = (a) => `${a.ano}/${String(a.sequencial).padStart(4, '0')}`;

// Confere a origem (precisa ser da filial da ação) e devolve o texto que fica gravado na ação
async function descreverOrigem(db, { tipo, id, filialId, descricao }) {
  if (!ORIGENS[tipo]) throw new ErroDeNegocio(400, `origem_tipo deve ser: ${Object.keys(ORIGENS).join(', ')}`);
  if (tipo === 'manual') {
    const t = descricao ? String(descricao).trim() : '';
    if (!t) throw new ErroDeNegocio(400, 'Origem manual: descreva de onde veio a ação (origem_descricao)');
    if (t.length > 300) throw new ErroDeNegocio(400, 'origem_descricao: máximo 300 caracteres');
    return { id: null, descricao: t };
  }
  if (!idValido(id)) throw new ErroDeNegocio(400, 'Informe origem_id');
  const n = Number(id);
  const recusar = () => { throw new ErroDeNegocio(400, `${ORIGENS[tipo]} ${id} não encontrada nesta filial`); };
  if (tipo === 'ocorrencia') {
    const o = await db('ocorrencias').where({ id: n }).first();
    if (!o || o.filial_id !== filialId) recusar();
    if (o.status === 'cancelada') throw new ErroDeNegocio(409, 'Ocorrência cancelada');
    return { id: n, descricao: `Ocorrência ${numeroOcorrencia(o)} — ${TIPOS_OCORRENCIA[o.tipo]} (${o.local_descricao})` };
  }
  if (tipo === 'pgr') {
    const p = await db('pgrs as p').join('pgr_filiais as pf', 'pf.pgr_id', 'p.id').where({ 'p.id': n, 'pf.filial_id': filialId }).first('p.titulo', 'p.status');
    if (!p) recusar();
    return { id: n, descricao: `PGR "${p.titulo}"` };
  }
  if (tipo === 'inspecao_incendio') {
    const i = await db('equipamento_inspecoes as i').join('equipamentos_incendio as e', 'e.id', 'i.equipamento_id').where('i.id', n)
      .first('i.filial_id', 'i.data_hora', 'i.conforme', 'e.identificacao', 'i.localizacao');
    if (!i || i.filial_id !== filialId) recusar();
    return { id: n, descricao: `Inspeção de ${i.identificacao} (${i.localizacao}) em ${dataLocal(i.data_hora).split('-').reverse().join('/')}${i.conforme ? '' : ' — não conforme'}` };
  }
  const p = await db('predios').where({ id: n }).first('filial_id', 'nome');
  if (!p || p.filial_id !== filialId) recusar();
  return { id: n, descricao: `Prédio ${p.nome}` };
}

// Situação das ações (abertas, ou concluídas nos últimos 12 meses). filtros: filial_id, responsavel_id, origem_tipo, origem_id
async function situacaoAcoes(db, req, filtros = {}, { dias = 30, dataBase = null } = {}) {
  const dataRef = dataBase || hoje();
  const corte = dataBase ? fimDoDia(dataBase) : null;
  const q = noEscopo(db('acoes as a'), req, 'a.filial_id').join('filiais as f', 'f.id', 'a.filial_id')
    .leftJoin('usuarios as u', 'u.id', 'a.responsavel_id')
    .select('a.*', 'f.nome as filial', db.raw('coalesce(u.nome, a.responsavel_nome) as responsavel'),
      db.raw('(select count(*)::int from acao_prazos p where p.acao_id = a.id) as reprogramacoes'))
    .orderBy([{ column: 'a.prazo' }, { column: 'a.id' }]);
  if (corte) q.where('a.created_at', '<', corte);
  if (filtros.filial_id) q.where('a.filial_id', filtros.filial_id);
  if (filtros.responsavel_id) q.where('a.responsavel_id', filtros.responsavel_id);
  if (filtros.origem_tipo) q.where('a.origem_tipo', filtros.origem_tipo);
  if (filtros.origem_id) q.where('a.origem_id', filtros.origem_id);
  const acoes = await q;
  if (!acoes.length) return [];

  // Na data-base: status pela linha do tempo e prazo pelas reprogramações feitas até ali
  let statusNaData = new Map();
  let prazoNaData = new Map();
  if (corte) {
    const ids = acoes.map((a) => a.id);
    const regs = await db('acao_registros').whereIn('acao_id', ids).whereNotNull('status_novo').where('created_at', '<', corte).orderBy(['created_at', 'id']).select('acao_id', 'status_novo');
    statusNaData = new Map(regs.map((r) => [r.acao_id, r.status_novo]));
    const prazos = await db('acao_prazos').whereIn('acao_id', ids).where('created_at', '<', corte).orderBy(['created_at', 'id']).select('acao_id', 'prazo_novo');
    prazoNaData = new Map(prazos.map((p) => [p.acao_id, p.prazo_novo]));
  }
  const limite = somarDias(dataRef, dias);
  const inicioJanela = somarMeses(dataRef, -12);
  const itens = [];
  for (const a of acoes) {
    const status = corte ? (statusNaData.get(a.id) || 'aberta') : a.status;
    const prazo = corte ? (prazoNaData.get(a.id) || a.prazo_original) : a.prazo;
    if (status === 'cancelada') continue;
    if (!ABERTAS.includes(status) && a.concluida_em && dataLocal(a.concluida_em) < inicioJanela) continue;
    let situacao = status;
    if (ABERTAS.includes(status)) situacao = prazo < dataRef ? 'atrasada' : prazo <= limite ? 'vence_em_breve' : 'no_prazo';
    itens.push({
      acao_id: a.id, numero: numero(a), filial_id: a.filial_id, filial: a.filial, titulo: a.titulo,
      origem_tipo: a.origem_tipo, origem_id: a.origem_id, origem: a.origem_descricao, tipo_medida: a.tipo_medida, prioridade: a.prioridade,
      responsavel_id: a.responsavel_id, responsavel: a.responsavel, prazo, status, situacao,
      dias_atraso: situacao === 'atrasada' ? diasEntre(prazo, dataRef) - 1 : 0, reprogramacoes: a.reprogramacoes
    });
  }
  return itens.sort((x, y) => SITUACOES.indexOf(x.situacao) - SITUACOES.indexOf(y.situacao) || x.prazo.localeCompare(y.prazo));
}

module.exports = { ORIGENS, TIPOS_MEDIDA, PRIORIDADES, STATUS, ABERTAS, SITUACOES, numero, descreverOrigem, situacaoAcoes };
