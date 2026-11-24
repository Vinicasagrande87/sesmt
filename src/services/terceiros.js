// Regras das terceirizadas: o que se exige da empresa (PGR e PCMSO) e de cada trabalhador alocado (ASO apto,
// integração de segurança e os treinamentos do contrato), a situação de cada exigência (hoje ou numa data-base)
// e a conferência de um trabalhador para entrar na filial ou numa permissão de trabalho.
const { hoje, somarDias, fimDoDia } = require('../utils/datas');
const { ehAdmin } = require('../utils/escopo');

const DOCS_EMPRESA = { pgr: 'PGR da contratada', pcmso: 'PCMSO da contratada', outro: 'Outro documento da empresa' };
const DOCS_TRABALHADOR = { aso: 'ASO', integracao: 'Integração de segurança', treinamento: 'Treinamento', outro: 'Outro documento' };
const EXIGIDOS_EMPRESA = ['pgr', 'pcmso'];
const INTEGRACAO_MESES = 12;      // validade padrão da integração, quando o documento não traz
const SITUACOES = ['faltando', 'inapto', 'vencido', 'vencendo', 'em_dia'];

const nr = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const dataBR = (d) => String(d).split('-').reverse().join('/');

// Documentos válidos (não anulados), com data até a data de referência
async function documentosValidos(db, { empresaIds = [], trabalhadorIds = [] }, dataRef) {
  if (!empresaIds.length && !trabalhadorIds.length) return [];
  return db('terceiro_documentos as d').leftJoin('terceiro_documento_anulacoes as n', 'n.documento_id', 'd.id').whereNull('n.id')
    .where('d.data_documento', '<=', dataRef)
    .andWhere((w) => {
      if (empresaIds.length) w.orWhere((x) => x.whereIn('d.empresa_id', empresaIds).whereNull('d.trabalhador_id'));
      if (trabalhadorIds.length) w.orWhereIn('d.trabalhador_id', trabalhadorIds);
    })
    .select('d.id', 'd.empresa_id', 'd.trabalhador_id', 'd.tipo', 'd.treinamento_id', 'd.nr_referencia', 'd.resultado', 'd.data_documento', 'd.data_vencimento', 'd.descricao');
}

// O documento que vale: o de vencimento mais distante (sem vencimento ganha); ASO: o mais recente
function melhor(lista, tipo) {
  if (!lista.length) return null;
  if (tipo === 'aso') return [...lista].sort((a, b) => b.data_documento.localeCompare(a.data_documento) || b.id - a.id)[0];
  return [...lista].sort((a, b) => String(b.data_vencimento || '9999-12-31').localeCompare(String(a.data_vencimento || '9999-12-31')))[0];
}

function situacaoDoDocumento(doc, tipo, dataRef, limite) {
  if (!doc) return 'faltando';
  if (tipo === 'aso' && doc.resultado === 'inapto') return 'inapto';
  if (!doc.data_vencimento) return 'em_dia';
  if (doc.data_vencimento < dataRef) return 'vencido';
  if (doc.data_vencimento <= limite) return 'vencendo';
  return 'em_dia';
}

// Requisitos de treinamento: [{ treinamento_id?, nr?, nome }] -> o documento que atende cada um
const atende = (req, d) => d.tipo === 'treinamento' && ((req.treinamento_id && d.treinamento_id === req.treinamento_id) || (req.nr && nr(d.nr_referencia) === nr(req.nr)));

async function requisitosDosTreinamentos(db, ids) {
  if (!ids || !ids.length) return [];
  const t = await db('treinamentos').whereIn('id', ids).select('id', 'nome_treinamento', 'nr_referencia');
  return t.map((x) => ({ treinamento_id: x.id, nr: x.nr_referencia, nome: x.nome_treinamento + (x.nr_referencia ? ` (${x.nr_referencia})` : '') }));
}

// Contratos ativos na data, no escopo do usuário (filtros: filial_id, empresa_id, contrato_id)
async function contratosAtivos(db, req, filtros, dataRef, corte) {
  const q = db('terceiro_contratos as c').join('empresas_terceiras as e', 'e.id', 'c.empresa_id').join('filiais as f', 'f.id', 'c.filial_id')
    .where('c.inicio', '<=', dataRef).andWhere((w) => w.whereNull('c.fim').orWhere('c.fim', '>=', dataRef))
    .andWhere((w) => w.whereNull('c.encerrado_em').orWhere('c.encerrado_em', '>=', corte))
    .select('c.*', 'e.razao_social as empresa', 'e.ativa as empresa_ativa', 'f.nome as filial');
  if (!ehAdmin(req)) q.whereIn('c.filial_id', req.usuario.filiais);
  if (filtros.filial_id) q.where('c.filial_id', filtros.filial_id);
  if (filtros.empresa_id) q.where('c.empresa_id', filtros.empresa_id);
  if (filtros.contrato_id) q.where('c.id', filtros.contrato_id);
  return q;
}

async function situacaoTerceiros(db, req, filtros = {}, { dias = 30, dataBase = null } = {}) {
  const dataRef = dataBase || hoje();
  const corte = fimDoDia(dataRef);
  const limite = somarDias(dataRef, dias);
  const contratos = await contratosAtivos(db, req, filtros, dataRef, corte);
  if (!contratos.length) return [];
  const alocacoes = await db('terceiro_alocacoes as a').join('terceiro_trabalhadores as t', 't.id', 'a.trabalhador_id')
    .whereIn('a.contrato_id', contratos.map((c) => c.id)).where('a.inicio', '<=', dataRef)
    .andWhere((w) => w.whereNull('a.fim').orWhere('a.fim', '>=', dataRef)).where('t.ativo', true)
    .select('a.contrato_id', 't.id', 't.nome', 't.cpf', 't.funcao');
  const docs = await documentosValidos(db, { empresaIds: [...new Set(contratos.map((c) => c.empresa_id))], trabalhadorIds: [...new Set(alocacoes.map((a) => a.id))] }, dataRef);
  const itens = [];
  for (const c of contratos) {
    const base = { contrato_id: c.id, contrato: c.numero ? `${c.numero} — ${c.objeto}` : c.objeto, empresa_id: c.empresa_id, empresa: c.empresa, filial_id: c.filial_id, filial: c.filial };
    for (const tipo of EXIGIDOS_EMPRESA) {
      const d = melhor(docs.filter((x) => x.empresa_id === c.empresa_id && !x.trabalhador_id && x.tipo === tipo), tipo);
      itens.push({ ...base, trabalhador_id: null, trabalhador: null, tipo, exigencia: DOCS_EMPRESA[tipo], situacao: situacaoDoDocumento(d, tipo, dataRef, limite),
        vencimento: d ? d.data_vencimento : null, documento_id: d ? d.id : null });
    }
    const requisitos = await requisitosDosTreinamentos(db, c.treinamentos_exigidos);
    for (const t of alocacoes.filter((a) => a.contrato_id === c.id)) {
      const meus = docs.filter((x) => x.trabalhador_id === t.id);
      const linha = (tipo, exigencia, d) => ({ ...base, trabalhador_id: t.id, trabalhador: t.nome, tipo, exigencia,
        situacao: situacaoDoDocumento(d, tipo, dataRef, limite), vencimento: d ? d.data_vencimento : null, documento_id: d ? d.id : null,
        ...(tipo === 'aso' && d && d.resultado === 'apto_restricao' ? { com_restricao: true } : {}) });
      itens.push(linha('aso', 'ASO', melhor(meus.filter((x) => x.tipo === 'aso'), 'aso')));
      itens.push(linha('integracao', 'Integração de segurança', melhor(meus.filter((x) => x.tipo === 'integracao'), 'integracao')));
      for (const r of requisitos) itens.push(linha('treinamento', r.nome, melhor(meus.filter((x) => atende(r, x)), 'treinamento')));
    }
  }
  return itens.sort((a, b) => SITUACOES.indexOf(a.situacao) - SITUACOES.indexOf(b.situacao) || String(a.vencimento || '').localeCompare(String(b.vencimento || '')));
}

// Pode trabalhar na filial na data? requisitosExtra: treinamentos exigidos por fora (ex.: NR-35 da permissão de trabalho)
async function conferirTerceiro(db, trabalhador, filialId, dataRef, requisitosExtra = []) {
  const problemas = [];
  const empresa = await db('empresas_terceiras').where({ id: trabalhador.empresa_id }).first();
  if (!trabalhador.ativo) problemas.push('trabalhador inativo');
  if (!empresa.ativa) problemas.push('empresa inativa');
  const contratos = await db('terceiro_contratos as c').join('terceiro_alocacoes as a', 'a.contrato_id', 'c.id')
    .where({ 'c.filial_id': filialId, 'c.empresa_id': empresa.id, 'a.trabalhador_id': trabalhador.id }).whereNull('c.encerrado_em')
    .where('c.inicio', '<=', dataRef).andWhere((w) => w.whereNull('c.fim').orWhere('c.fim', '>=', dataRef))
    .where('a.inicio', '<=', dataRef).andWhere((w) => w.whereNull('a.fim').orWhere('a.fim', '>=', dataRef))
    .select('c.id', 'c.objeto', 'c.treinamentos_exigidos');
  if (!contratos.length) problemas.push('sem contrato ativo nesta filial com este trabalhador alocado');
  const docs = await documentosValidos(db, { empresaIds: [empresa.id], trabalhadorIds: [trabalhador.id] }, hoje());
  const conferido = { empresa: empresa.razao_social, contratos: contratos.map((c) => ({ id: c.id, objeto: c.objeto })), documentos: [] };
  const exigir = (rotulo, d, tipo) => {
    conferido.documentos.push({ exigencia: rotulo, documento_id: d ? d.id : null, vencimento: d ? d.data_vencimento : null, resultado: d ? d.resultado : undefined });
    if (!d) return problemas.push(`sem ${rotulo}`);
    if (tipo === 'aso' && d.resultado === 'inapto') return problemas.push('ASO inapto');
    if (tipo === 'aso' && d.resultado === 'apto_restricao') return problemas.push('ASO apto com restrição (avaliar antes de liberar)');
    if (d.data_vencimento && d.data_vencimento < dataRef) return problemas.push(`${rotulo} vencido em ${dataBR(d.data_vencimento)}`);
    return null;
  };
  for (const tipo of EXIGIDOS_EMPRESA) exigir(DOCS_EMPRESA[tipo], melhor(docs.filter((x) => !x.trabalhador_id && x.tipo === tipo), tipo), tipo);
  const meus = docs.filter((x) => x.trabalhador_id === trabalhador.id);
  exigir('ASO', melhor(meus.filter((x) => x.tipo === 'aso'), 'aso'), 'aso');
  exigir('integração de segurança', melhor(meus.filter((x) => x.tipo === 'integracao'), 'integracao'), 'integracao');
  const doContrato = await requisitosDosTreinamentos(db, [...new Set(contratos.flatMap((c) => c.treinamentos_exigidos || []))]);
  for (const r of [...doContrato, ...requisitosExtra]) exigir(r.nome, melhor(meus.filter((x) => atende(r, x)), 'treinamento'), 'treinamento');
  return { ok: !problemas.length, problemas, conferencia: conferido };
}

module.exports = {
  DOCS_EMPRESA, DOCS_TRABALHADOR, EXIGIDOS_EMPRESA, INTEGRACAO_MESES, SITUACOES,
  documentosValidos, situacaoTerceiros, conferirTerceiro, requisitosDosTreinamentos
};
