// Situação da ordem de serviço de cada funcionário (NR-1, 1.4.1 "c"): há PGR vigente, o setor/função
// está em algum grupo e o funcionário deu ciência da OS. Hoje ou como estava numa data-base.
const { hoje, fimDoDia } = require('../utils/datas');
const { osVigenteDoFuncionario } = require('./pgr');
const { funcionariosNaData } = require('./historico');

const SITUACOES = ['sem_pgr', 'sem_grupo', 'ciencia_pendente', 'em_dia'];

// Ciência válida (não anulada) da OS; com dataBase, só a dada até aquela data
function cienciaValida(trx, osId, funcionarioId, { dataBase = null } = {}) {
  const q = trx('os_ciencias as c')
    .leftJoin('os_ciencia_anulacoes as a', 'a.ciencia_id', 'c.id')
    .where({ 'c.ordem_servico_id': osId, 'c.funcionario_id': funcionarioId })
    .whereNull('a.id')
    .orderBy('c.data_ciencia');
  if (dataBase) q.where('c.data_ciencia', '<=', dataBase);
  return q.first('c.*');
}

// EPIs exigidos pela OS (vinculados ao catálogo) que o funcionário nunca recebeu (até a data-base)
async function episNuncaEntregues(trx, funcionarioId, conteudo, { dataBase = null } = {}) {
  const exigidos = conteudo.epis.filter((e) => e.epi_id);
  if (!exigidos.length) return [];
  const q = trx('entregas as e').leftJoin('entrega_estornos as est', 'est.entrega_id', 'e.id')
    .where('e.funcionario_id', funcionarioId).whereNull('est.id');
  if (dataBase) q.where('e.data_hora', '<', fimDoDia(dataBase));
  const recebidos = new Set(await q.distinct('e.epi_id').pluck('e.epi_id'));
  return exigidos.filter((e) => !recebidos.has(e.epi_id)).map((e) => `${e.parte_corpo}: ${e.descricao}`);
}

// Todas as linhas (inclusive em dia)
async function situacaoOrdensServico(db, req, filtros = {}, { dataBase = null } = {}) {
  const dataRef = dataBase || hoje();
  const corte = dataBase ? fimDoDia(dataBase) : null;
  const itens = [];
  for (const f of await funcionariosNaData(db, req, filtros, { dataBase })) {
    const atual = await osVigenteDoFuncionario(db, f, { corte });
    const base = { funcionario_id: f.id, funcionario: f.nome, matricula: f.matricula, filial_id: f.filial_id, filial: f.filial, setor: f.setor, funcao: f.funcao };
    if (atual.situacao !== 'ok') {
      itens.push({ ...base, situacao: atual.situacao, pgr_vencido: atual.pgr ? atual.pgr.data_fim < dataRef : null });
      continue;
    }
    const ciencia = await cienciaValida(db, atual.os.id, f.id, { dataBase });
    itens.push({
      ...base, situacao: ciencia ? 'em_dia' : 'ciencia_pendente', ordem_servico_id: atual.os.id,
      pgr_vencido: atual.pgr.data_fim < dataRef, ciencia_em: ciencia ? ciencia.assinado_em : null,
      epis_nunca_entregues: await episNuncaEntregues(db, f.id, atual.os.conteudo, { dataBase }),
      ...(corte ? { lancado_depois: !!ciencia && new Date(ciencia.assinado_em) >= corte } : {})
    });
  }
  return itens.sort((a, b) => SITUACOES.indexOf(a.situacao) - SITUACOES.indexOf(b.situacao) || a.funcionario.localeCompare(b.funcionario));
}

// Precisa de ação: sem OS, sem ciência, PGR vencido ou EPI da OS nunca entregue
const osEmDia = (i) => i.situacao === 'em_dia' && !i.pgr_vencido && !(i.epis_nunca_entregues || []).length;

module.exports = { SITUACOES, cienciaValida, episNuncaEntregues, situacaoOrdensServico, osEmDia };
