// Movimentações de estoque (versão provisória: saldo único do grupo).
// Etapa 2: estoque por filial, lotes com valor pago e custo PEPS.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { idValido } = require('../utils/validacao');
const { saldoDoEpi } = require('./EntregaController');

const TIPOS = ['Entrada', 'Saída'];

module.exports = {
  async index(req, res) {
    const query = knex('estoque_movimentacao')
      .join('epis', 'epis.id', 'estoque_movimentacao.epi_id')
      .select('estoque_movimentacao.*', 'epis.nome as epi')
      .orderBy('estoque_movimentacao.id', 'desc');
    if (req.query.epi_id) query.where('estoque_movimentacao.epi_id', req.query.epi_id);
    return res.json(await query);
  },

  // { epi_id, tipo: 'Entrada' | 'Saída', quantidade, observacao? }
  async create(req, res) {
    const { epi_id, tipo, observacao } = req.body;
    const quantidade = Number(req.body.quantidade);
    if (!idValido(epi_id)) throw new ErroDeNegocio(400, 'epi_id é obrigatório');
    if (!TIPOS.includes(tipo)) throw new ErroDeNegocio(400, `tipo deve ser: ${TIPOS.join(' ou ')}`);
    if (!Number.isInteger(quantidade) || quantidade < 1) {
      throw new ErroDeNegocio(400, 'quantidade deve ser um número inteiro maior que zero');
    }

    const movimentacao = await knex.transaction(async (trx) => {
      const epi = await trx('epis').where({ id: epi_id }).forUpdate().first('id', 'ativo');
      if (!epi) throw new ErroDeNegocio(404, 'EPI não encontrado');

      if (tipo === 'Saída') {
        const saldo = await saldoDoEpi(trx, epi.id);
        if (saldo < quantidade) throw new ErroDeNegocio(409, `Saldo insuficiente: disponível ${saldo}`);
      }

      const [nova] = await trx('estoque_movimentacao')
        .insert({ epi_id: epi.id, tipo, quantidade, observacao }).returning('*');
      await auditar(trx, req, { acao: 'criar', tabela: 'estoque_movimentacao', registro_id: nova.id, depois: nova });
      return nova;
    });
    return res.status(201).json(movimentacao);
  }
};
