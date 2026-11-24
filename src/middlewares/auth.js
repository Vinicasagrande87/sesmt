const jwt = require('jsonwebtoken');
const knex = require('../database/db');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET não definido. Configure no .env (veja .env.example).');
}

const SEGREDO = process.env.JWT_SECRET;
const EXPIRA_EM = process.env.JWT_EXPIRES_IN || '8h';

// admin = login da matriz (vê e faz tudo, em todas as filiais).
// Os demais só atuam nas filiais vinculadas a eles (tabela usuario_filiais).
const PERFIS = ['admin', 'gestor', 'tecnico', 'saude', 'consulta'];

// v = versão da sessão: trocar a senha, desativar ou "encerrar sessões" incrementa e invalida os tokens antigos
function gerarToken(usuario) {
  return jwt.sign(
    { perfil: usuario.perfil, nome: usuario.nome, v: usuario.sessao_versao || 0 },
    SEGREDO,
    { subject: String(usuario.id), expiresIn: EXPIRA_EM, algorithm: 'HS256' }
  );
}

// Exige "Authorization: Bearer <token>". Confere no banco a cada requisição:
// usuário desativado, com a senha trocada ou com perfil/filiais alterados vale na hora, sem esperar o token expirar.
async function autenticar(req, res, next) {
  const [tipo, token] = (req.headers.authorization || '').split(' ');
  if (tipo !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Token não informado' });
  }

  let dados;
  try {
    dados = jwt.verify(token, SEGREDO, { algorithms: ['HS256'] });
  } catch (error) {
    const msg = error.name === 'TokenExpiredError' ? 'Sessão expirada, faça login novamente' : 'Token inválido';
    return res.status(401).json({ error: msg });
  }

  const usuario = await knex('usuarios')
    .where({ id: Number(dados.sub) })
    .first('id', 'nome', 'email', 'perfil', 'ativo', 'sessao_versao');
  if (!usuario || !usuario.ativo) {
    return res.status(401).json({ error: 'Usuário inativo ou removido' });
  }
  if ((dados.v || 0) !== usuario.sessao_versao) {
    return res.status(401).json({ error: 'Sessão encerrada, faça login novamente' });
  }

  const filiais = usuario.perfil === 'admin'
    ? null // null = todas
    : (await knex('usuario_filiais').where({ usuario_id: usuario.id }).pluck('filial_id')).map(Number);

  req.usuario = { id: usuario.id, nome: usuario.nome, email: usuario.email, perfil: usuario.perfil, filiais };
  return next();
}

// Usar depois de autenticar: permitir('admin', 'gestor')
function permitir(...perfis) {
  return (req, res, next) => {
    if (!req.usuario || !perfis.includes(req.usuario.perfil)) {
      return res.status(403).json({ error: 'Acesso negado para o seu perfil' });
    }
    return next();
  };
}

module.exports = { PERFIS, gerarToken, autenticar, permitir };
