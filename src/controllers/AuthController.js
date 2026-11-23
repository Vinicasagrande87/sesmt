const bcrypt = require('bcryptjs');
const knex = require('../database/db');
const { gerarToken } = require('../middlewares/auth');

// Hash usado quando o e-mail não existe, para a resposta levar o mesmo tempo
// (não dá para descobrir quais e-mails estão cadastrados pelo tempo de resposta).
const HASH_FALSO = bcrypt.hashSync('senha-que-nunca-confere', 10);

module.exports = {
  // POST /auth/login { email, senha } -> { token, usuario }
  async login(req, res) {
    try {
      const { email, senha } = req.body || {};
      if (!email || !senha) {
        return res.status(400).json({ error: 'email e senha são obrigatórios' });
      }

      const usuario = await knex('usuarios')
        .where({ email: String(email).trim().toLowerCase() })
        .first();

      const senhaOk = await bcrypt.compare(String(senha), usuario ? usuario.senha_hash : HASH_FALSO);
      if (!usuario || !senhaOk || !usuario.ativo) {
        return res.status(401).json({ error: 'E-mail ou senha inválidos' });
      }

      return res.json({
        token: gerarToken(usuario),
        usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, perfil: usuario.perfil }
      });
    } catch (error) {
      return res.status(500).json({ error: 'Erro ao fazer login' });
    }
  },

  // GET /auth/me -> dados de quem está logado
  async me(req, res) {
    try {
      const usuario = await knex('usuarios')
        .where({ id: req.usuario.id })
        .first('id', 'nome', 'email', 'perfil', 'ativo');
      if (!usuario || !usuario.ativo) {
        return res.status(401).json({ error: 'Usuário inativo ou removido' });
      }
      return res.json(usuario);
    } catch (error) {
      return res.status(500).json({ error: 'Erro ao buscar usuário' });
    }
  }
};
