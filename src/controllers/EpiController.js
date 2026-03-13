const knex = require('../database/db');

module.exports = {
  // Listar todos os EPIs cadastrados
  async index(req, res) {
    try {
      const epis = await knex('epis').select('*');
      return res.json(epis);
    } catch (error) {
      return res.status(500).json({ error: 'Erro ao listar EPIs' });
    }
  },

  // Cadastrar um novo EPI (ex: Capacete, Luva, Bota)
  async create(req, res) {
    try {
      const { nome, descricao, validade_dias } = req.body;

      await knex('epis').insert({
        nome,
        descricao,
        validade_dias
      });

      return res.status(201).json({ message: 'EPI cadastrado com sucesso!' });
    } catch (error) {
      return res.status(400).json({ error: 'Erro ao cadastrar EPI' });
    }
  },

  // Remover um EPI do sistema
  async delete(req, res) {
    try {
      const { id } = req.params;
      await knex('epis').where({ id }).del();
      return res.status(204).send();
    } catch (error) {
      return res.status(400).json({ error: 'Erro ao deletar EPI' });
    }
  }
};