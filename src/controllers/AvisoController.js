// Avisos de vencimento por e-mail (matriz): destinatários extras, prévia, envio manual e histórico.
// Os admins ativos sempre recebem; aqui se cadastram as outras pessoas.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { idValido } = require('../utils/validacao');
const { emailAtivo } = require('../services/email');
const { montarAvisos, destinatarios, itensDe, enviarAvisos } = require('../services/avisos');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function validarFiliais(lista) {
  if (lista === undefined || lista === null) return null; // todas
  if (!Array.isArray(lista) || !lista.length || !lista.every(idValido)) throw new ErroDeNegocio(400, 'filial_ids: lista de ids, ou null para todas as filiais');
  const ids = [...new Set(lista.map(Number))];
  if ((await knex('filiais').whereIn('id', ids).pluck('id')).length !== ids.length) throw new ErroDeNegocio(400, 'Alguma filial informada não existe');
  return ids;
}

module.exports = {
  // GET /avisos/destinatarios — admins (automáticos) e extras
  async destinatarios(req, res) {
    const admins = await knex('usuarios').where({ perfil: 'admin', ativo: true }).orderBy('nome').select('id', 'nome', 'email');
    const extras = await knex('aviso_destinatarios').orderBy('nome').select('id', 'nome', 'email', 'filial_ids', 'ativo', 'created_at');
    return res.json({ email_configurado: emailAtivo(), admins, extras });
  },

  // POST /avisos/destinatarios { nome, email, filial_ids? (null/ausente = todas) }
  async criarDestinatario(req, res) {
    const { nome, email } = req.body || {};
    const e = String(email || '').trim().toLowerCase();
    if (!nome || !String(nome).trim()) throw new ErroDeNegocio(400, 'nome é obrigatório');
    if (!EMAIL.test(e)) throw new ErroDeNegocio(400, 'email inválido');
    const filialIds = await validarFiliais(req.body.filial_ids);
    const novo = await knex.transaction(async (trx) => {
      if (await trx('aviso_destinatarios').where({ email: e }).first('id')) throw new ErroDeNegocio(409, 'Este e-mail já recebe os avisos');
      const [d] = await trx('aviso_destinatarios').insert({ nome: String(nome).trim(), email: e, filial_ids: filialIds ? JSON.stringify(filialIds) : null, criado_por: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'incluir_destinatario_aviso', tabela: 'aviso_destinatarios', registro_id: d.id, depois: d });
      return d;
    });
    return res.status(201).json(novo);
  },

  // PUT /avisos/destinatarios/:id { nome?, filial_ids?, ativo? } — parar de receber = ativo: false
  async alterarDestinatario(req, res) {
    if (!idValido(req.params.id)) throw new ErroDeNegocio(404, 'Destinatário não encontrado');
    const b = req.body || {};
    const dados = {};
    if (b.nome !== undefined) {
      if (!String(b.nome).trim()) throw new ErroDeNegocio(400, 'nome não pode ser vazio');
      dados.nome = String(b.nome).trim();
    }
    if (b.filial_ids !== undefined) { const ids = await validarFiliais(b.filial_ids); dados.filial_ids = ids ? JSON.stringify(ids) : null; }
    if (b.ativo !== undefined) {
      if (typeof b.ativo !== 'boolean') throw new ErroDeNegocio(400, 'ativo deve ser true ou false');
      dados.ativo = b.ativo;
    }
    if (!Object.keys(dados).length) throw new ErroDeNegocio(400, 'Nada para alterar');
    const depois = await knex.transaction(async (trx) => {
      const antes = await trx('aviso_destinatarios').where({ id: req.params.id }).first();
      if (!antes) throw new ErroDeNegocio(404, 'Destinatário não encontrado');
      const [d] = await trx('aviso_destinatarios').where({ id: antes.id }).update({ ...dados, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar_destinatario_aviso', tabela: 'aviso_destinatarios', registro_id: d.id, antes, depois: d });
      return d;
    });
    return res.json(depois);
  },

  // GET /avisos/previa — o que iria hoje e para quem, sem enviar
  async previa(req, res) {
    const { limite, itens } = await montarAvisos(knex);
    const dests = (await destinatarios(knex)).map((d) => ({ ...d, itens: itensDe(d, itens).length }));
    return res.json({ email_configurado: emailAtivo(), limite, total_itens: itens.length, destinatarios: dests, itens });
  },

  // POST /avisos/enviar — envia agora, fora do envio semanal
  async enviar(req, res) {
    if (!emailAtivo()) throw new ErroDeNegocio(503, 'Envio de e-mail não configurado (SMTP no .env)');
    const r = await enviarAvisos(knex, { referencia: `manual-${Date.now()}`, tipo: 'manual', usuarioId: req.usuario.id });
    await auditar(knex, req, { acao: 'enviar_avisos', tabela: 'aviso_envios', registro_id: r.id, depois: { referencia: r.referencia, total_itens: r.total_itens } });
    return res.status(201).json(r);
  },

  // GET /avisos/envios — últimos 100 envios
  async envios(req, res) {
    return res.json(await knex('aviso_envios as a').leftJoin('usuarios as u', 'u.id', 'a.usuario_id')
      .orderBy('a.created_at', 'desc').limit(100).select('a.*', 'u.nome as enviado_por'));
  }
};
