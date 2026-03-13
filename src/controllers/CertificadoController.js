const knex = require('../database/db');

module.exports = {
  async index(req, res) {
    const certificados = await knex('certificados_treinamentos')
      .join('funcionarios', 'funcionarios.id', 'certificados_treinamentos.funcionario_id')
      .join('treinamentos', 'treinamentos.id', 'certificados_treinamentos.treinamento_id')
      .select('certificados_treinamentos.*', 'funcionarios.nome as funcionario', 'treinamentos.nome_treinamento');
    return res.json(certificados);
  },
  async create(req, res) {
    await knex('certificados_treinamentos').insert(req.body);
    return res.status(201).json({ message: 'Certificado emitido.' });
  }
};