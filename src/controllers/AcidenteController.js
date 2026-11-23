const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { noEscopo } = require('../utils/escopo');
const { pegar, exigirCampos } = require('../utils/validacao');
const { buscarNoEscopo } = require('./FuncionarioController');

const CAMPOS = ['funcionario_id', 'data_hora_acidente', 'local_acidente', 'descricao_ocorrencia',
  'parte_corpo_atingida', 'houve_afastamento', 'dias_afastado', 'cat_emitida'];

module.exports = {
  async index(req, res) {
    const query = noEscopo(knex('acidentes_trabalho'), req, 'funcionarios.filial_id')
      .join('funcionarios', 'funcionarios.id', 'acidentes_trabalho.funcionario_id')
      .select('acidentes_trabalho.*', 'funcionarios.nome as funcionario')
      .orderBy('acidentes_trabalho.data_hora_acidente', 'desc');
    if (req.query.funcionario_id) query.where('acidentes_trabalho.funcionario_id', req.query.funcionario_id);
    return res.json(await query);
  },

  async create(req, res) {
    exigirCampos(req.body, ['funcionario_id', 'local_acidente']);
    const dados = pegar(req.body, CAMPOS);
    if (dados.dias_afastado !== undefined && dados.dias_afastado !== null) {
      const dias = Number(dados.dias_afastado);
      if (!Number.isInteger(dias) || dias < 0) throw new ErroDeNegocio(400, 'dias_afastado deve ser um inteiro');
    }

    const acidente = await knex.transaction(async (trx) => {
      const funcionario = await buscarNoEscopo(req, dados.funcionario_id, trx);
      const [novo] = await trx('acidentes_trabalho').insert(dados).returning('*');
      await auditar(trx, req, {
        acao: 'criar', tabela: 'acidentes_trabalho', registro_id: novo.id,
        filial_id: funcionario.filial_id, depois: novo
      });
      return novo;
    });
    return res.status(201).json(acidente);
  }
};
