const bcrypt = require('bcryptjs');
const knex = require('../database/db');

const PERFIS = ['admin', 'tecnico'];

module.exports = {
  // GET /usuarios (admin)
  async index(req, res) {
    try {
      const usuarios = await knex('usuarios')
        .select('id', 'nome', 'email', 'perfil', 'ativo', 'created_at');
      return res.json(usuarios);
    } catch (error) {
      return res.status(500).json({ error: 'Erro ao listar usuários' });
    }
  },

  // POST /usuarios { nome, email, senha, perfil? } (admin)
  async create(req, res) {
    try {
      const { nome, email, senha, perfil = 'tecnico' } = req.body || {};

      const faltando = ['nome', 'email', 'senha'].filter((c) => !req.body || !req.body[c]);
      if (faltando.length) {
        return res.status(400).json({ error: `Campos obrigatórios: ${faltando.join(', ')}` });
      }
      if (String(senha).length < 8) {
        return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres' });
      }
      if (!PERFIS.includes(perfil)) {
        return res.status(400).json({ error: `perfil deve ser: ${PERFIS.join(' ou ')}` });
      }

      const emailNormalizado = String(email).trim().toLowerCase();
      const existe = await knex('usuarios').where({ email: emailNormalizado }).first('id');
      if (existe) {
        return res.status(409).json({ error: 'Já existe um usuário com esse e-mail' });
      }

      await knex('usuarios').insert({
        nome,
        email: emailNormalizado,
        senha_hash: await bcrypt.hash(String(senha), 10),
        perfil
      });

      return res.status(201).json({ message: 'Usuário cadastrado com sucesso!' });
    } catch (error) {
      return res.status(400).json({ error: 'Erro ao cadastrar usuário' });
    }
  }
};
