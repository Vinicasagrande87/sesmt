// Treinamentos realizados por funcionário (etapa 3: turmas e lista de presença por QR).
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { noEscopo } = require('../utils/escopo');
const { dataValida } = require('../utils/datas');
const { pegar, exigirCampos, idValido } = require('../utils/validacao');
const { buscarNoEscopo } = require('./FuncionarioController');

const CAMPOS = ['funcionario_id', 'treinamento_id', 'data_realizacao', 'data_vencimento', 'instrutor', 'status'];

module.exports = {
  async index(req, res) {
    const query = noEscopo(knex('certificados_treinamentos'), req, 'funcionarios.filial_id')
      .join('funcionarios', 'funcionarios.id', 'certificados_treinamentos.funcionario_id')
      .join('treinamentos', 'treinamentos.id', 'certificados_treinamentos.treinamento_id')
      .select('certificados_treinamentos.*', 'funcionarios.nome as funcionario', 'treinamentos.nome_treinamento')
      .orderBy('certificados_treinamentos.data_realizacao', 'desc');
    if (req.query.funcionario_id) query.where('certificados_treinamentos.funcionario_id', req.query.funcionario_id);
    return res.json(await query);
  },

  async create(req, res) {
    exigirCampos(req.body, ['funcionario_id', 'treinamento_id', 'data_realizacao']);
    const dados = pegar(req.body, CAMPOS);
    if (!idValido(dados.treinamento_id)) throw new ErroDeNegocio(400, 'treinamento_id inválido');
    for (const campo of ['data_realizacao', 'data_vencimento']) {
      if (dados[campo] && !dataValida(dados[campo])) throw new ErroDeNegocio(400, `${campo} deve estar no formato AAAA-MM-DD`);
    }

    const certificado = await knex.transaction(async (trx) => {
      const funcionario = await buscarNoEscopo(req, dados.funcionario_id, trx);
      const [novo] = await trx('certificados_treinamentos').insert(dados).returning('*');
      await auditar(trx, req, {
        acao: 'criar', tabela: 'certificados_treinamentos', registro_id: novo.id,
        filial_id: funcionario.filial_id, depois: novo
      });
      return novo;
    });
    return res.status(201).json(certificado);
  }
};
