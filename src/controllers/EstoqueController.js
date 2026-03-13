const knex = require('../database/db');

module.exports = {
  async index(req, res) {
    const mov = await knex('estoque_movimentacao')
      .join('epis', 'epis.id', 'estoque_movimentacao.epi_id')
      .select('estoque_movimentacao.*', 'epis.nome as epi');
    return res.json(mov);
  },
  async create(req, res) {
    await knex('estoque_movimentacao').insert(req.body);
    return res.status(201).json({ message: 'Movimentação de estoque registrada.' });
  }
};