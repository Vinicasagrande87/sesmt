const knex = require('../database/db');

module.exports = {
  async index(req, res) {
    const acidentes = await knex('acidentes_trabalho')
      .join('funcionarios', 'funcionarios.id', 'acidentes_trabalho.funcionario_id')
      .select('acidentes_trabalho.*', 'funcionarios.nome as funcionario');
    return res.json(acidentes);
  },
  async create(req, res) {
    const data = req.body;
    await knex('acidentes_trabalho').insert(data);
    return res.status(201).json({ message: 'Acidente registrado.' });
  }
};