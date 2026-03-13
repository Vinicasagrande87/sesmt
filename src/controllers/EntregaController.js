const knex = require('../database/db');

module.exports = {
  // Listar todas as entregas realizadas
  // Aqui usamos um "join" para mostrar nomes em vez de apenas IDs
  async index(req, res) {
    try {
      const entregas = await knex('entregas')
        .join('funcionarios', 'funcionarios.id', '=', 'entregas.funcionario_id')
        .join('epis', 'epis.id', '=', 'entregas.epi_id')
        .select(
          'entregas.id',
          'funcionarios.nome as funcionario',
          'epis.nome as epi',
          'entregas.data_entrega'
        );
      
      return res.json(entregas);
    } catch (error) {
      return res.status(500).json({ error: 'Erro ao listar entregas' });
    }
  },

  // Registrar uma nova entrega de EPI
  async create(req, res) {
    try {
      const { funcionario_id, epi_id, data_entrega } = req.body;

      await knex('entregas').insert({
        funcionario_id,
        epi_id,
        data_entrega
      });

      return res.status(201).json({ message: 'Entrega registrada com sucesso!' });
    } catch (error) {
      console.error(error);
      return res.status(400).json({ error: 'Erro ao registrar entrega' });
    }
  }
};