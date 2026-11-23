// Catálogo de treinamentos do grupo (NR-10, NR-35, brigada...): só a matriz (admin) cadastra.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { pegar, exigirCampos } = require('../utils/validacao');

const CAMPOS = ['nome_treinamento', 'carga_horaria', 'validade_meses', 'obrigatorio'];

function validar(dados) {
  for (const campo of ['carga_horaria', 'validade_meses']) {
    if (dados[campo] !== undefined && dados[campo] !== null) {
      const n = Number(dados[campo]);
      if (!Number.isInteger(n) || n < 0) throw new ErroDeNegocio(400, `${campo} deve ser um inteiro`);
      dados[campo] = n;
    }
  }
  return dados;
}

module.exports = {
  async index(req, res) {
    return res.json(await knex('treinamentos').orderBy('nome_treinamento'));
  },

  async create(req, res) {
    exigirCampos(req.body, ['nome_treinamento']);
    const dados = validar(pegar(req.body, CAMPOS));
    const treinamento = await knex.transaction(async (trx) => {
      const [novo] = await trx('treinamentos').insert(dados).returning('*');
      await auditar(trx, req, { acao: 'criar', tabela: 'treinamentos', registro_id: novo.id, depois: novo });
      return novo;
    });
    return res.status(201).json(treinamento);
  },

  async update(req, res) {
    const dados = validar(pegar(req.body, CAMPOS));
    if (!Object.keys(dados).length) throw new ErroDeNegocio(400, 'Nenhum campo para alterar');
    const treinamento = await knex.transaction(async (trx) => {
      const antes = await trx('treinamentos').where({ id: req.params.id }).forUpdate().first();
      if (!antes) throw new ErroDeNegocio(404, 'Treinamento não encontrado');
      const [depois] = await trx('treinamentos').where({ id: antes.id }).update(dados).returning('*');
      await auditar(trx, req, { acao: 'alterar', tabela: 'treinamentos', registro_id: antes.id, antes, depois });
      return depois;
    });
    return res.json(treinamento);
  }
};
