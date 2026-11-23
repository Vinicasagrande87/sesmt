const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET não definido. Configure no .env (veja .env.example).');
}

const SEGREDO = process.env.JWT_SECRET;
const EXPIRA_EM = process.env.JWT_EXPIRES_IN || '8h';

function gerarToken(usuario) {
  return jwt.sign(
    { perfil: usuario.perfil, nome: usuario.nome },
    SEGREDO,
    { subject: String(usuario.id), expiresIn: EXPIRA_EM, algorithm: 'HS256' }
  );
}

// Exige "Authorization: Bearer <token>" e coloca os dados em req.usuario
function autenticar(req, res, next) {
  const [tipo, token] = (req.headers.authorization || '').split(' ');
  if (tipo !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Token não informado' });
  }

  try {
    const dados = jwt.verify(token, SEGREDO, { algorithms: ['HS256'] });
    req.usuario = { id: Number(dados.sub), nome: dados.nome, perfil: dados.perfil };
    return next();
  } catch (error) {
    const msg = error.name === 'TokenExpiredError' ? 'Sessão expirada, faça login novamente' : 'Token inválido';
    return res.status(401).json({ error: msg });
  }
}

// Usar depois de autenticar: exigirPerfil('admin')
function exigirPerfil(...perfis) {
  return (req, res, next) => {
    if (!req.usuario || !perfis.includes(req.usuario.perfil)) {
      return res.status(403).json({ error: 'Acesso negado para o seu perfil' });
    }
    return next();
  };
}

module.exports = { gerarToken, autenticar, exigirPerfil };
