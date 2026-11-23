// Catálogo de funções do grupo: todos consultam, só a matriz (admin) cadastra e altera.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { pegar, exigirCampos, somenteDigitos } = require('../utils/validacao');

const CAMPOS = ['nome', 'cbo', 'descricao', 'ativa'];

function normalizar(dados) {
  if (dados.cbo) {
    dados.cbo = somenteDigitos(dados.cbo);
    if (dados.cbo.length !== 6) throw new ErroDeNegocio(400, 'CBO deve ter 6 dígitos');
  }
  return dados;
}

module.exports = {
  async index(req, res) {
    const query = knex('funcoes').orderBy('nome');
    if (req.query.ativa !== undefined) query.where('ativa', req.query.ativa === 'true');
    return res.json(await query);
  },

  async create(req, res) {
    exigirCampos(req.body, ['nome']);
    const dados = normalizar(pegar(req.body, CAMPOS));
    const funcao = await knex.transaction(async (trx) => {
      const [nova] = await trx('funcoes').insert(dados).returning('*');
      await auditar(trx, req, { acao: 'criar', tabela: 'funcoes', registro_id: nova.id, depois: nova });
      return nova;
    });
    return res.status(201).json(funcao);
  },

  async update(req, res) {
    const dados = normalizar(pegar(req.body, CAMPOS));
    if (!Object.keys(dados).length) throw new ErroDeNegocio(400, 'Nenhum campo para alterar');
    const funcao = await knex.transaction(async (trx) => {
      const antes = await trx('funcoes').where({ id: req.params.id }).forUpdate().first();
      if (!antes) throw new ErroDeNegocio(404, 'Função não encontrada');
      const [depois] = await trx('funcoes').where({ id: antes.id })
        .update({ ...dados, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar', tabela: 'funcoes', registro_id: antes.id, antes, depois });
      return depois;
    });
    return res.json(funcao);
  }
};
