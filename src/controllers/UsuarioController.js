// Usuários do sistema. Só a matriz (admin) cria e altera.
const bcrypt = require('bcryptjs');
const knex = require('../database/db');
const { PERFIS } = require('../middlewares/auth');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { exigirCampos, idValido } = require('../utils/validacao');

async function filiaisDoUsuario(trx, usuarioId) {
  return trx('usuario_filiais as uf')
    .join('filiais', 'filiais.id', 'uf.filial_id')
    .where('uf.usuario_id', usuarioId)
    .orderBy('filiais.nome')
    .select('filiais.id', 'filiais.nome');
}

// Valida a lista de filiais conforme o perfil: admin não tem (vê todas); os demais precisam de pelo menos uma
async function validarFiliais(trx, perfil, filiais) {
  if (perfil === 'admin') return [];
  if (!Array.isArray(filiais) || !filiais.length || !filiais.every(idValido)) {
    throw new ErroDeNegocio(400, 'Informe filiais: lista com o id de pelo menos uma filial');
  }
  const ids = [...new Set(filiais.map(Number))];
  const existentes = await trx('filiais').whereIn('id', ids).pluck('id');
  if (existentes.length !== ids.length) throw new ErroDeNegocio(400, 'Alguma filial informada não existe');
  return ids;
}

async function gravarFiliais(trx, usuarioId, ids) {
  await trx('usuario_filiais').where({ usuario_id: usuarioId }).del();
  if (ids.length) await trx('usuario_filiais').insert(ids.map((filial_id) => ({ usuario_id: usuarioId, filial_id })));
}

function validarSenha(senha) {
  if (String(senha).length < 8) throw new ErroDeNegocio(400, 'A senha precisa ter pelo menos 8 caracteres');
}

module.exports = {
  // GET /usuarios
  async index(req, res) {
    const usuarios = await knex('usuarios')
      .orderBy('nome')
      .select('id', 'nome', 'email', 'perfil', 'ativo', 'created_at');
    const vinculos = await knex('usuario_filiais as uf')
      .join('filiais', 'filiais.id', 'uf.filial_id')
      .select('uf.usuario_id', 'filiais.id', 'filiais.nome');
    return res.json(usuarios.map((u) => ({
      ...u,
      filiais: vinculos.filter((v) => v.usuario_id === u.id).map(({ id, nome }) => ({ id, nome }))
    })));
  },

  // POST /usuarios { nome, email, senha, perfil?, filiais: [ids] }
  async create(req, res) {
    exigirCampos(req.body, ['nome', 'email', 'senha']);
    const { nome, email, senha, perfil = 'tecnico', filiais } = req.body;
    validarSenha(senha);
    if (!PERFIS.includes(perfil)) throw new ErroDeNegocio(400, `perfil deve ser: ${PERFIS.join(', ')}`);

    const emailNormalizado = String(email).trim().toLowerCase();
    const usuario = await knex.transaction(async (trx) => {
      const ids = await validarFiliais(trx, perfil, filiais);
      const existe = await trx('usuarios').where({ email: emailNormalizado }).first('id');
      if (existe) throw new ErroDeNegocio(409, 'Já existe um usuário com esse e-mail');

      const [novo] = await trx('usuarios').insert({
        nome,
        email: emailNormalizado,
        senha_hash: await bcrypt.hash(String(senha), 10),
        perfil
      }).returning(['id', 'nome', 'email', 'perfil', 'ativo']);
      await gravarFiliais(trx, novo.id, ids);
      await auditar(trx, req, { acao: 'criar', tabela: 'usuarios', registro_id: novo.id, depois: { ...novo, filiais: ids } });
      return { ...novo, filiais: await filiaisDoUsuario(trx, novo.id) };
    });

    return res.status(201).json(usuario);
  },

  // PUT /usuarios/:id { nome?, perfil?, ativo?, senha?, filiais? }
  async update(req, res) {
    const { nome, perfil, ativo, senha, filiais } = req.body || {};
    if (perfil !== undefined && !PERFIS.includes(perfil)) {
      throw new ErroDeNegocio(400, `perfil deve ser: ${PERFIS.join(', ')}`);
    }
    if (senha !== undefined) validarSenha(senha);

    const usuario = await knex.transaction(async (trx) => {
      const antes = await trx('usuarios').where({ id: req.params.id }).forUpdate()
        .first('id', 'nome', 'email', 'perfil', 'ativo');
      if (!antes) throw new ErroDeNegocio(404, 'Usuário não encontrado');

      // Evita a matriz ficar sem acesso por engano
      if (antes.id === req.usuario.id && (ativo === false || (perfil && perfil !== 'admin'))) {
        throw new ErroDeNegocio(400, 'Você não pode desativar nem rebaixar o seu próprio usuário');
      }

      const alteracoes = {};
      if (nome !== undefined) alteracoes.nome = nome;
      if (perfil !== undefined) alteracoes.perfil = perfil;
      if (ativo !== undefined) alteracoes.ativo = Boolean(ativo);
      if (senha !== undefined) alteracoes.senha_hash = await bcrypt.hash(String(senha), 10);

      const perfilFinal = perfil ?? antes.perfil;
      const filiaisAntes = (await filiaisDoUsuario(trx, antes.id)).map((f) => f.id);
      let filiaisDepois = filiaisAntes;
      if (filiais !== undefined || perfil !== undefined) {
        filiaisDepois = await validarFiliais(trx, perfilFinal, filiais ?? filiaisAntes);
        await gravarFiliais(trx, antes.id, filiaisDepois);
      }

      if (!Object.keys(alteracoes).length && filiais === undefined) {
        throw new ErroDeNegocio(400, 'Nenhum campo para alterar');
      }

      let depois = antes;
      if (Object.keys(alteracoes).length) {
        [depois] = await trx('usuarios').where({ id: antes.id })
          .update({ ...alteracoes, updated_at: trx.fn.now() })
          .returning(['id', 'nome', 'email', 'perfil', 'ativo']);
      }
      await auditar(trx, req, {
        acao: 'alterar', tabela: 'usuarios', registro_id: antes.id,
        antes: { ...antes, filiais: filiaisAntes },
        depois: { ...depois, filiais: filiaisDepois, ...(senha !== undefined ? { senha: '[alterada]' } : {}) }
      });
      return { ...depois, filiais: await filiaisDoUsuario(trx, antes.id) };
    });

    return res.json(usuario);
  },

  filiaisDoUsuario
};
