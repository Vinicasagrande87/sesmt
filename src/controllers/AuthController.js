const bcrypt = require('bcryptjs');
const knex = require('../database/db');
const { gerarToken } = require('../middlewares/auth');
const { auditar } = require('../utils/auditoria');

// Hash usado quando o e-mail não existe, para a resposta levar o mesmo tempo
// (não dá para descobrir quais e-mails estão cadastrados pelo tempo de resposta).
const HASH_FALSO = bcrypt.hashSync('senha-que-nunca-confere', 10);

async function filiaisVisiveis(usuario) {
  const query = knex('filiais').where('ativa', true).orderBy('nome').select('id', 'nome', 'tipo', 'uf', 'cidade');
  if (usuario.perfil !== 'admin') {
    query.whereIn('id', knex('usuario_filiais').where({ usuario_id: usuario.id }).select('filial_id'));
  }
  return query;
}

module.exports = {
  // POST /auth/login { email, senha } -> { token, usuario }
  async login(req, res) {
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

    await auditar(knex, { usuario, ip: req.ip }, { acao: 'login', tabela: 'usuarios', registro_id: usuario.id });

    return res.json({
      token: gerarToken(usuario),
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        perfil: usuario.perfil,
        filiais: await filiaisVisiveis(usuario)
      }
    });
  },

  // GET /auth/me -> quem está logado e em quais filiais atua
  async me(req, res) {
    const usuario = await knex('usuarios')
      .where({ id: req.usuario.id })
      .first('id', 'nome', 'email', 'perfil');
    return res.json({ ...usuario, filiais: await filiaisVisiveis(usuario) });
  }
};
