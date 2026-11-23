// Catálogo de EPIs do grupo: todos consultam, só a matriz (admin) cadastra e altera.
// EPI com histórico não é apagado: envie { ativo: false }.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { pegar, exigirCampos } = require('../utils/validacao');

const CAMPOS = ['nome', 'ca', 'fabricante', 'descricao', 'validade_dias', 'ativo'];

function validar(dados) {
  if (dados.validade_dias !== undefined) {
    const dias = Number(dados.validade_dias);
    if (!Number.isInteger(dias) || dias < 1) throw new ErroDeNegocio(400, 'validade_dias deve ser um inteiro maior que zero');
    dados.validade_dias = dias;
  }
  return dados;
}

module.exports = {
  async index(req, res) {
    const query = knex('epis').orderBy('nome');
    if (req.query.ativo !== undefined) query.where('ativo', req.query.ativo === 'true');
    return res.json(await query);
  },

  async create(req, res) {
    exigirCampos(req.body, ['nome', 'ca', 'validade_dias']);
    const dados = validar(pegar(req.body, CAMPOS));
    const epi = await knex.transaction(async (trx) => {
      const [novo] = await trx('epis').insert(dados).returning('*');
      await auditar(trx, req, { acao: 'criar', tabela: 'epis', registro_id: novo.id, depois: novo });
      return novo;
    });
    return res.status(201).json(epi);
  },

  async update(req, res) {
    const dados = validar(pegar(req.body, CAMPOS));
    if (!Object.keys(dados).length) throw new ErroDeNegocio(400, 'Nenhum campo para alterar');
    const epi = await knex.transaction(async (trx) => {
      const antes = await trx('epis').where({ id: req.params.id }).forUpdate().first();
      if (!antes) throw new ErroDeNegocio(404, 'EPI não encontrado');
      const [depois] = await trx('epis').where({ id: antes.id })
        .update({ ...dados, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar', tabela: 'epis', registro_id: antes.id, antes, depois });
      return depois;
    });
    return res.json(epi);
  }
};
