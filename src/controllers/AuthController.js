const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const knex = require('../database/db');
const { gerarToken } = require('../middlewares/auth');
const { auditar } = require('../utils/auditoria');
const { ErroDeNegocio } = require('../utils/erros');
const { validarSenha } = require('../utils/senha');
const limite = require('../services/limiteTentativas');
const { enviarEmail, emailAtivo } = require('../services/email');

// Hash usado quando o e-mail não existe, para a resposta levar o mesmo tempo
// (não dá para descobrir quais e-mails estão cadastrados pelo tempo de resposta).
const HASH_FALSO = bcrypt.hashSync('senha-que-nunca-confere', 10);
const VALIDADE_LINK_MS = 60 * 60 * 1000;
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

async function filiaisVisiveis(usuario) {
  const query = knex('filiais').where('ativa', true).orderBy('nome').select('id', 'nome', 'tipo', 'uf', 'cidade');
  if (usuario.perfil !== 'admin') {
    query.whereIn('id', knex('usuario_filiais').where({ usuario_id: usuario.id }).select('filial_id'));
  }
  return query;
}

function recusarSeBloqueado(res, regras) {
  const espera = Math.max(...regras.map(([regra, chave]) => limite.bloqueadoPor(regra, chave)));
  if (!espera) return false;
  res.set('Retry-After', String(espera));
  res.status(429).json({ error: `Muitas tentativas. Tente de novo em ${Math.ceil(espera / 60)} minuto(s).` });
  return true;
}

// Endereço público do sistema para links em e-mail. Em produção vem só do .env (APP_URL):
// usar o Host da requisição permitiria a alguém forjar o link de redefinição.
function urlDoSistema(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  if (process.env.NODE_ENV === 'production') return null;
  return `${req.protocol}://${req.get('host')}`;
}

// Troca a senha, derruba as outras sessões e devolve o usuário atualizado
async function gravarNovaSenha(trx, usuarioId, senha) {
  const [u] = await trx('usuarios').where({ id: usuarioId })
    .update({ senha_hash: await bcrypt.hash(senha, 10), sessao_versao: trx.raw('sessao_versao + 1'), senha_alterada_em: trx.fn.now(), updated_at: trx.fn.now() })
    .returning(['id', 'nome', 'email', 'perfil', 'sessao_versao']);
  return u;
}

module.exports = {
  // POST /auth/login { email, senha } -> { token, usuario }
  // Limite: 5 erros na mesma conta pelo mesmo IP, ou 30 erros pelo IP, em 15 minutos.
  async login(req, res) {
    const { email, senha } = req.body || {};
    if (!email || !senha) {
      return res.status(400).json({ error: 'email e senha são obrigatórios' });
    }
    const emailNormalizado = String(email).trim().toLowerCase();
    const conta = `${emailNormalizado}|${req.ip}`;
    if (recusarSeBloqueado(res, [['login_conta', conta], ['login_ip', req.ip]])) return undefined;

    const usuario = await knex('usuarios').where({ email: emailNormalizado }).first();
    const senhaOk = await bcrypt.compare(String(senha), usuario ? usuario.senha_hash : HASH_FALSO);
    if (!usuario || !senhaOk || !usuario.ativo) {
      limite.registrar('login_conta', conta);
      limite.registrar('login_ip', req.ip);
      return res.status(401).json({ error: 'E-mail ou senha inválidos' });
    }
    limite.limpar('login_conta', conta);

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
  },

  // POST /auth/senha { senha_atual, nova_senha } — o próprio usuário troca a senha.
  // As outras sessões abertas caem; esta recebe um token novo.
  async trocarSenha(req, res) {
    const { senha_atual: atual, nova_senha: nova } = req.body || {};
    const chave = `usuario:${req.usuario.id}`;
    if (recusarSeBloqueado(res, [['login_conta', chave]])) return undefined;
    const usuario = await knex('usuarios').where({ id: req.usuario.id }).first('id', 'email', 'senha_hash');
    if (!atual || !(await bcrypt.compare(String(atual), usuario.senha_hash))) {
      limite.registrar('login_conta', chave);
      throw new ErroDeNegocio(400, 'Senha atual incorreta');
    }
    const senha = validarSenha(nova, usuario.email);
    if (await bcrypt.compare(senha, usuario.senha_hash)) throw new ErroDeNegocio(400, 'A nova senha deve ser diferente da atual');
    limite.limpar('login_conta', chave);

    const atualizado = await knex.transaction(async (trx) => {
      const u = await gravarNovaSenha(trx, usuario.id, senha);
      await auditar(trx, req, { acao: 'trocar_senha', tabela: 'usuarios', registro_id: usuario.id });
      return u;
    });
    return res.json({ message: 'Senha alterada. As outras sessões foram encerradas.', token: gerarToken(atualizado) });
  },

  // POST /auth/esqueci { email } — manda um link de redefinição (vale 1 hora, uma vez).
  // Responde sempre igual, exista ou não o e-mail.
  async esqueciSenha(req, res) {
    const resposta = { message: 'Se o e-mail estiver cadastrado, enviaremos um link para criar uma nova senha.' };
    if (recusarSeBloqueado(res, [['redefinicao_ip', req.ip]])) return undefined;
    limite.registrar('redefinicao_ip', req.ip);
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const usuario = email && await knex('usuarios').where({ email, ativo: true }).first('id', 'nome', 'email');
    const base = urlDoSistema(req);
    if (!usuario || !emailAtivo() || !base) {
      if (usuario && (!emailAtivo() || !base)) console.warn('Redefinição de senha pedida, mas o e-mail ou APP_URL não estão configurados.');
      return res.status(202).json(resposta);
    }

    const token = crypto.randomBytes(32).toString('base64url');
    await knex.transaction(async (trx) => {
      await trx('senha_redefinicoes').insert({ usuario_id: usuario.id, token_hash: hashToken(token), expira_em: new Date(Date.now() + VALIDADE_LINK_MS), ip: req.ip || null });
      await auditar(trx, { usuario, ip: req.ip }, { acao: 'pedir_redefinicao_senha', tabela: 'usuarios', registro_id: usuario.id });
    });
    // O token vai depois do "#": não aparece em log de servidor nem é repassado a outros sites
    const link = `${base}/redefinir-senha.html#token=${token}`;
    try {
      await enviarEmail({
        para: usuario.email,
        assunto: 'SESMT — criar uma nova senha',
        texto: `Olá, ${usuario.nome}.\n\nPara criar uma nova senha, abra o link abaixo (vale por 1 hora e só uma vez):\n${link}\n\nSe não foi você que pediu, ignore este e-mail: sua senha atual continua valendo.`
      });
    } catch (erro) {
      console.warn(`Falha ao enviar o e-mail de redefinição: ${erro.message}`);
    }
    return res.status(202).json(resposta);
  },

  // POST /auth/redefinir { token, nova_senha }
  async redefinirSenha(req, res) {
    const { token, nova_senha: nova } = req.body || {};
    if (!token) throw new ErroDeNegocio(400, 'Link inválido ou expirado');
    await knex.transaction(async (trx) => {
      const pedido = await trx('senha_redefinicoes').where({ token_hash: hashToken(token) }).whereNull('usado_em')
        .where('expira_em', '>', trx.fn.now()).forUpdate().first();
      const usuario = pedido && await trx('usuarios').where({ id: pedido.usuario_id, ativo: true }).first('id', 'email', 'nome');
      if (!usuario) throw new ErroDeNegocio(400, 'Link inválido ou expirado');
      const senha = validarSenha(nova, usuario.email);
      await gravarNovaSenha(trx, usuario.id, senha);
      // Usa este link e invalida os outros que estiverem abertos
      await trx('senha_redefinicoes').where({ usuario_id: usuario.id }).whereNull('usado_em').update({ usado_em: trx.fn.now() });
      await auditar(trx, { usuario, ip: req.ip }, { acao: 'redefinir_senha', tabela: 'usuarios', registro_id: usuario.id });
    });
    return res.json({ message: 'Senha criada. Entre com a nova senha.' });
  }
};
