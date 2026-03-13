const knex = require('../database/db');

module.exports = {
  async index(req, res) {
    const treinamentos = await knex('treinamentos').select('*');
    return res.json(treinamentos);
  },
  async create(req, res) {
    const { nome_treinamento, carga_horaria, validade_meses, obrigatorio } = req.body;
    await knex('treinamentos').insert({ nome_treinamento, carga_horaria, validade_meses, obrigatorio });
    return res.status(201).json({ message: 'Treinamento criado.' });
  }
};