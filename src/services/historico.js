// "Como estava em uma data": leitura da data-base e quem estava trabalhando em cada filial naquela data.
//
// Critério: a situação de fato na data D, com o que está registrado hoje. Vale cada documento pela data
// do fato (realização do treinamento, exame, ciência, aprovação, serviço, inspeção), registros anulados
// não contam, e quem estava lotado onde sai do histórico de lotações. Documento lançado depois de D com
// data anterior conta, mas vem marcado (lancado_depois) para ficar transparente.
const { noEscopo } = require('../utils/escopo');
const { ErroDeNegocio } = require('../utils/erros');
const { hoje, dataValida, somarDias, fimDoDia } = require('../utils/datas');

// ?data_base=AAAA-MM-DD. Hoje ou vazio = situação atual (dataBase null).
function lerDataBase(query) {
  const valor = query && query.data_base;
  if (valor === undefined || valor === '') return { dataBase: null, corte: null };
  if (!dataValida(valor)) throw new ErroDeNegocio(400, 'data_base deve estar no formato AAAA-MM-DD');
  const dataHoje = hoje();
  if (valor > dataHoje) throw new ErroDeNegocio(400, 'data_base não pode ser futura');
  if (valor < '2000-01-01') throw new ErroDeNegocio(400, 'data_base muito antiga');
  if (valor === dataHoje) return { dataBase: null, corte: null };
  return { dataBase: valor, corte: fimDoDia(valor) };
}

const COLUNAS_FUNCIONARIO = ['f.id', 'f.nome', 'f.matricula', 'f.data_demissao', 'fi.nome as filial', 'fi.grau_risco', 's.nome as setor', 'fn.nome as funcao'];

// Funcionários que contam nas pendências, com filial/setor/função da época.
// filtros: { filial_id, setor_id, funcionario_id }. incluirDesligados: os que saíram nos últimos `janelaDesligados` dias (ASO demissional).
async function funcionariosNaData(db, req, filtros = {}, { dataBase = null, incluirDesligados = false, janelaDesligados = 60 } = {}) {
  if (!dataBase) {
    const q = noEscopo(db('funcionarios as f'), req, 'f.filial_id')
      .join('filiais as fi', 'fi.id', 'f.filial_id')
      .leftJoin('setores as s', 's.id', 'f.setor_id')
      .leftJoin('funcoes as fn', 'fn.id', 'f.funcao_id')
      .select(...COLUNAS_FUNCIONARIO, 'f.status', 'f.filial_id', 'f.setor_id', 'f.funcao_id')
      .orderBy('f.nome');
    if (!incluirDesligados) q.where('f.status', 'Ativo');
    if (filtros.filial_id) q.where('f.filial_id', filtros.filial_id);
    if (filtros.setor_id) q.where('f.setor_id', filtros.setor_id);
    if (filtros.funcionario_id) q.where('f.id', filtros.funcionario_id);
    return q;
  }

  // Lotado na data: a lotação cobre D (o desligamento encerra a lotação no dia da demissão)
  const cobre = (q) => q.where('l.inicio', '<=', dataBase).andWhere((w) => w.whereNull('l.fim').orWhere('l.fim', '>=', dataBase));
  const ativos = noEscopo(db('funcionario_lotacoes as l'), req, 'l.filial_id')
    .join('funcionarios as f', 'f.id', 'l.funcionario_id')
    .join('filiais as fi', 'fi.id', 'l.filial_id')
    .leftJoin('setores as s', 's.id', 'l.setor_id')
    .leftJoin('funcoes as fn', 'fn.id', 'l.funcao_id')
    .modify(cobre)
    .distinctOn('f.id')
    .orderBy([{ column: 'f.id' }, { column: 'l.inicio', order: 'desc' }, { column: 'l.id', order: 'desc' }])
    .select(...COLUNAS_FUNCIONARIO, db.raw("'Ativo' as status"), 'l.filial_id', 'l.setor_id', 'l.funcao_id');
  if (filtros.filial_id) ativos.where('l.filial_id', filtros.filial_id);
  if (filtros.setor_id) ativos.where('l.setor_id', filtros.setor_id);
  if (filtros.funcionario_id) ativos.where('f.id', filtros.funcionario_id);
  const lista = await ativos;

  if (incluirDesligados) {
    const desligados = noEscopo(db('funcionarios as f'), req, 'f.filial_id')
      .join('filiais as fi', 'fi.id', 'f.filial_id')
      .leftJoin('setores as s', 's.id', 'f.setor_id')
      .leftJoin('funcoes as fn', 'fn.id', 'f.funcao_id')
      .where('f.data_demissao', '<', dataBase)
      .where('f.data_demissao', '>=', somarDias(dataBase, -janelaDesligados))
      .whereNotExists(db('funcionario_lotacoes as l').whereRaw('l.funcionario_id = f.id').modify(cobre))
      .select(...COLUNAS_FUNCIONARIO, db.raw("'Desligado' as status"), 'f.filial_id', 'f.setor_id', 'f.funcao_id');
    if (filtros.filial_id) desligados.where('f.filial_id', filtros.filial_id);
    if (filtros.setor_id) desligados.where('f.setor_id', filtros.setor_id);
    if (filtros.funcionario_id) desligados.where('f.id', filtros.funcionario_id);
    lista.push(...(await desligados));
  }
  return lista.sort((a, b) => a.nome.localeCompare(b.nome));
}

// Lista de pendências como a API sempre devolveu: ?situacao= filtra; sem ela, só o que precisa de ação (?todas=true traz tudo).
function filtrarPendencias(itens, situacoes, query = {}, { emDia = (i) => i.situacao === 'em_dia' } = {}) {
  if (query.situacao && !situacoes.includes(query.situacao)) throw new ErroDeNegocio(400, `situacao deve ser: ${situacoes.join(', ')}`);
  let lista = itens;
  if (query.situacao) lista = lista.filter((i) => i.situacao === query.situacao);
  else if (query.todas !== 'true') lista = lista.filter((i) => !emDia(i));
  const resumo = Object.fromEntries(situacoes.map((s) => [s, lista.filter((i) => i.situacao === s).length]));
  return { resumo, itens: lista };
}

function lerDias(query, nome, padrao) {
  if (!query || query[nome] === undefined) return padrao;
  const n = Number(query[nome]);
  if (!Number.isInteger(n) || n < 0 || n > 365) throw new ErroDeNegocio(400, `${nome} deve ser um inteiro entre 0 e 365`);
  return n;
}

module.exports = { lerDataBase, funcionariosNaData, filtrarPendencias, lerDias };
