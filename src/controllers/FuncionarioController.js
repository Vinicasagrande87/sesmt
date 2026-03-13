const knex = require('../database/db'); 

module.exports = {
  // Listar todos os funcionários
  async index(req, res) {
    try {
      const funcionarios = await knex('funcionarios').select('*');
      return res.json(funcionarios);
    } catch (error) {
      return res.status(500).json({ error: 'Erro ao buscar funcionários' });
    }
  },

  // Cadastrar um novo funcionário
  async create(req, res) {
    try {
      const { nome, cargo, cpf, data_admissao } = req.body;

      await knex('funcionarios').insert({
        nome,
        cargo,
        cpf,
        data_admissao
      });

      return res.status(201).json({ message: 'Funcionário cadastrado com sucesso!' });
    } catch (error) {
      console.error(error);
      return res.status(400).json({ error: 'Erro ao cadastrar funcionário' });
    }
  },

  // Deletar um funcionário pelo ID
  async delete(req, res) {
    try {
      const { id } = req.params;

      await knex('funcionarios')
        .where({ id })
        .del();

      return res.status(204).send();
    } catch (error) {
      return res.status(400).json({ error: 'Erro ao deletar funcionário' });
    }
  }
};