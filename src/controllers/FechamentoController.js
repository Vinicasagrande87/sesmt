// Fechamento mensal por filial e conferência de integridade (auditoria encadeada + registros do mês).
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { ehAdmin, noEscopo, podeAcessarFilial } = require('../utils/escopo');
const { hoje, somarMeses, dataLocal } = require('../utils/datas');
const { idValido } = require('../utils/validacao');
const { gerarCodigo } = require('../utils/codigo');
const { selarAuditoria, verificarCadeia } = require('../services/integridade');
const { periodo, montarFechamento, conferirFechamento, hashDoFechamento } = require('../services/fechamento');

const COLUNAS_LISTA = ['f.id', 'f.filial_id', 'fi.nome as filial', 'f.competencia', 'f.data_base', 'f.resumo', 'f.hash_conteudo',
  'f.hash_anterior', 'f.hash', 'f.codigo_verificacao', 'f.fechado_em', 'u.nome as fechado_por'];

async function fechamentoNoEscopo(req, id) {
  const f = idValido(id) && await knex('fechamentos').where({ id }).first();
  if (!f || !podeAcessarFilial(req, f.filial_id)) throw new ErroDeNegocio(404, 'Fechamento não encontrado');
  return f;
}

// Meses já encerrados desde o cadastro da filial que ainda não foram fechados
async function competenciasEmAberto(filial) {
  const fechadas = new Set(await knex('fechamentos').where({ filial_id: filial.id }).pluck('competencia'));
  const ultimaEncerrada = somarMeses(`${hoje().slice(0, 7)}-01`, -1).slice(0, 7);
  const abertas = [];
  for (let c = dataLocal(filial.created_at).slice(0, 7); c <= ultimaEncerrada; c = somarMeses(`${c}-01`, 1).slice(0, 7)) {
    if (!fechadas.has(c)) abertas.push(c);
  }
  return abertas;
}

module.exports = {
  // POST /fechamentos { filial_id, competencia: 'AAAA-MM' } — gestão da filial
  async create(req, res) {
    const { filial_id: filialId, competencia } = req.body || {};
    if (!idValido(filialId) || !podeAcessarFilial(req, filialId)) throw new ErroDeNegocio(404, 'Filial não encontrada');
    if (typeof competencia !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia) || competencia < '2000-01') {
      throw new ErroDeNegocio(400, 'competencia deve estar no formato AAAA-MM');
    }
    const { ultimoDia } = periodo(competencia);
    if (ultimoDia >= hoje()) throw new ErroDeNegocio(409, 'Só é possível fechar um mês que já terminou');

    // A âncora entra na cadeia já selada; o próprio fechamento é auditado depois
    await selarAuditoria(knex);
    const resultado = await knex.transaction(async (trx) => {
      const filial = await trx('filiais').where({ id: Number(filialId) }).forUpdate().first(); // um fechamento por vez na filial
      if (!filial) throw new ErroDeNegocio(404, 'Filial não encontrada');
      if (await trx('fechamentos').where({ filial_id: filial.id, competencia }).first('id')) {
        throw new ErroDeNegocio(409, `A competência ${competencia} já foi fechada nesta filial`);
      }
      const ancora = await trx('auditoria').whereNotNull('sequencia').orderBy('sequencia', 'desc').first('sequencia', 'hash');
      const { conteudo, resumo, hashConteudo } = await montarFechamento(trx, req, filial, competencia,
        ancora ? { sequencia: Number(ancora.sequencia), hash: ancora.hash } : null);
      const anterior = await trx('fechamentos').where({ filial_id: filial.id }).orderBy('id', 'desc').first('hash');
      const fechadoEm = new Date();
      const hash = hashDoFechamento({ hashAnterior: anterior && anterior.hash, filialId: filial.id, competencia, hashConteudo, fechadoEm });
      const [novo] = await trx('fechamentos').insert({
        filial_id: filial.id, competencia, data_base: ultimoDia, resumo: JSON.stringify(resumo), conteudo: JSON.stringify(conteudo),
        hash_conteudo: hashConteudo, hash_anterior: anterior ? anterior.hash : null, hash,
        auditoria_sequencia: ancora ? ancora.sequencia : null, auditoria_hash: ancora ? ancora.hash : null,
        codigo_verificacao: gerarCodigo(), fechado_por: req.usuario.id, fechado_em: fechadoEm
      }).returning(['id', 'filial_id', 'competencia', 'data_base', 'resumo', 'hash_conteudo', 'hash_anterior', 'hash', 'codigo_verificacao', 'fechado_em']);
      await auditar(trx, req, { acao: 'fechamento_mensal', tabela: 'fechamentos', registro_id: novo.id, filial_id: filial.id,
        depois: { competencia, hash, hash_conteudo: hashConteudo } });
      return novo;
    });
    return res.status(201).json(resultado);
  },

  // GET /fechamentos?filial_id= — fechamentos (sem o conteúdo) e, com filial_id, os meses em aberto
  async index(req, res) {
    const q = noEscopo(knex('fechamentos as f'), req, 'f.filial_id').join('filiais as fi', 'fi.id', 'f.filial_id')
      .join('usuarios as u', 'u.id', 'f.fechado_por').orderBy([{ column: 'fi.nome' }, { column: 'f.competencia', order: 'desc' }]).select(COLUNAS_LISTA);
    let emAberto;
    if (req.query.filial_id !== undefined) {
      if (!idValido(req.query.filial_id) || !podeAcessarFilial(req, req.query.filial_id)) throw new ErroDeNegocio(404, 'Filial não encontrada');
      q.where('f.filial_id', Number(req.query.filial_id));
      const filial = await knex('filiais').where({ id: Number(req.query.filial_id) }).first('id', 'created_at');
      if (!filial) throw new ErroDeNegocio(404, 'Filial não encontrada');
      emAberto = await competenciasEmAberto(filial);
    }
    return res.json({ fechamentos: await q, ...(emAberto ? { em_aberto: emAberto } : {}) });
  },

  // GET /fechamentos/:id — com a situação congelada e as impressões dos registros
  async show(req, res) {
    const f = await fechamentoNoEscopo(req, req.params.id);
    return res.json(f);
  },

  // GET /fechamentos/:id/conferencia — recalcula e aponta o que mudou desde o fechamento
  async conferencia(req, res) {
    const f = await fechamentoNoEscopo(req, req.params.id);
    const resultado = await conferirFechamento(knex, f);
    await auditar(knex, req, { acao: 'conferir_fechamento', tabela: 'fechamentos', registro_id: f.id, filial_id: f.filial_id, depois: { ok: resultado.ok } });
    return res.json({ fechamento_id: f.id, competencia: f.competencia, conferido_em: new Date(), ...resultado });
  },

  // GET /auditoria/integridade — sela o pendente e confere a cadeia inteira (matriz)
  async integridade(req, res) {
    if (!ehAdmin(req)) throw new ErroDeNegocio(403, 'Somente a matriz');
    const selados = await selarAuditoria(knex);
    return res.json({ selados_agora: selados, ...(await verificarCadeia(knex)) });
  }
};
