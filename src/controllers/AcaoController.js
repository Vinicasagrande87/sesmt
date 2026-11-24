// Plano de ação: abrir, acompanhar, concluir com evidência, verificar a eficácia, reprogramar e cancelar.
// Quem executa: o responsável (mesmo com perfil consulta) ou a equipe de SST (admin, gestor, técnico).
// Quem verifica a eficácia é outra pessoa (o admin pode, se for o único).
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { podeAcessarFilial, noEscopo } = require('../utils/escopo');
const { hoje, dataValida } = require('../utils/datas');
const { idValido } = require('../utils/validacao');
const { salvarArquivo } = require('../utils/arquivos');
const { lerDataBase, lerDias, filtrarPendencias } = require('../services/historico');
const { notificarResponsavel } = require('../services/avisos');
const A = require('../services/acoes');

const EQUIPE_SST = ['admin', 'gestor', 'tecnico'];
const ehEquipe = (req) => EQUIPE_SST.includes(req.usuario.perfil);
const TIPOS_ARQUIVO = ['application/pdf', 'image/jpeg', 'image/png'];

function texto(valor, max = 2000) {
  if (valor === undefined || valor === null) return null;
  const t = String(valor).trim();
  if (t.length > max) throw new ErroDeNegocio(400, `Texto muito longo (máximo ${max} caracteres)`);
  return t.length ? t : null;
}

function lerValor(valor, nome) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0) throw new ErroDeNegocio(400, `${nome} deve ser um valor positivo`);
  return Math.round(n * 100) / 100;
}

async function acaoNoEscopo(db, req, id, { travar = false } = {}) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'Ação não encontrada');
  const q = db('acoes').where({ id: Number(id) });
  if (travar) q.forUpdate();
  const a = await q.first();
  if (!a || !podeAcessarFilial(req, a.filial_id)) throw new ErroDeNegocio(404, 'Ação não encontrada');
  return a;
}

// Responsável: usuário ativo que atua na filial, ou um nome (quem não tem login)
async function validarResponsavel(db, { responsavel_id: id, responsavel_nome: nome }, filialId) {
  if (id !== undefined && id !== null) {
    const u = idValido(id) && await db('usuarios').where({ id: Number(id), ativo: true }).first('id', 'nome', 'email', 'perfil');
    if (!u) throw new ErroDeNegocio(400, 'Responsável não encontrado ou inativo');
    if (u.perfil !== 'admin' && !(await db('usuario_filiais').where({ usuario_id: u.id, filial_id: filialId }).first('usuario_id'))) {
      throw new ErroDeNegocio(400, 'O responsável não atua nesta filial');
    }
    return { responsavel_id: u.id, responsavel_nome: null, usuario: u };
  }
  const n = texto(nome, 200);
  if (!n) throw new ErroDeNegocio(400, 'Informe o responsável (responsavel_id de um usuário ou responsavel_nome)');
  return { responsavel_id: null, responsavel_nome: n, usuario: null };
}

function exigirAberta(a) {
  if (!A.ABERTAS.includes(a.status)) throw new ErroDeNegocio(409, `Ação ${A.STATUS[a.status].toLowerCase()}`);
}

function exigirExecutor(req, a) {
  if (!ehEquipe(req) && req.usuario.id !== a.responsavel_id) throw new ErroDeNegocio(403, 'Só o responsável ou a equipe de SST registram o andamento');
}

async function registrar(trx, req, a, { tipo, texto: t, statusNovo = null, arquivo = null }) {
  const arq = arquivo ? await salvarArquivo(trx, req, { base64: arquivo, contexto: 'acao', tipos: TIPOS_ARQUIVO, maxBytes: 10 * 1024 * 1024, filial_id: a.filial_id }) : null;
  const [r] = await trx('acao_registros').insert({ acao_id: a.id, tipo, texto: t, status_novo: statusNovo, arquivo_id: arq ? arq.id : null, usuario_id: req.usuario.id }).returning('*');
  return { ...r, sha256: arq ? arq.sha256 : null };
}

async function carregar(db, a) {
  const responsavel = a.responsavel_id ? await db('usuarios').where({ id: a.responsavel_id }).first('id', 'nome', 'email') : null;
  const registros = await db('acao_registros as r').join('usuarios as u', 'u.id', 'r.usuario_id').where('r.acao_id', a.id).orderBy('r.id')
    .select('r.id', 'r.tipo', 'r.texto', 'r.status_novo', 'r.arquivo_id', 'r.created_at', 'u.nome as usuario');
  const prazos = await db('acao_prazos as p').join('usuarios as u', 'u.id', 'p.usuario_id').where('p.acao_id', a.id).orderBy('p.id')
    .select('p.prazo_anterior', 'p.prazo_novo', 'p.motivo', 'p.created_at', 'u.nome as usuario');
  const filial = await db('filiais').where({ id: a.filial_id }).first('nome');
  const dataHoje = hoje();
  return {
    ...a, numero: A.numero(a), filial: filial.nome, custo_estimado: a.custo_estimado === null ? null : Number(a.custo_estimado),
    custo_real: a.custo_real === null ? null : Number(a.custo_real),
    responsavel: responsavel ? responsavel.nome : a.responsavel_nome,
    atrasada: A.ABERTAS.includes(a.status) && a.prazo < dataHoje,
    registros, prazos
  };
}

const lerData = (valor, nome) => {
  if (!dataValida(valor)) throw new ErroDeNegocio(400, `${nome} no formato AAAA-MM-DD`);
  if (valor < hoje()) throw new ErroDeNegocio(400, `${nome} não pode ser no passado`);
  return valor;
};

module.exports = {
  // GET /acoes?filial_id=&status=&responsavel_id=&origem_tipo=&origem_id=
  async index(req, res) {
    const q = noEscopo(knex('acoes as a'), req, 'a.filial_id').join('filiais as f', 'f.id', 'a.filial_id').leftJoin('usuarios as u', 'u.id', 'a.responsavel_id')
      .orderBy([{ column: 'a.prazo' }, { column: 'a.id' }]).limit(1000)
      .select('a.id', 'a.filial_id', 'f.nome as filial', 'a.ano', 'a.sequencial', 'a.titulo', 'a.origem_tipo', 'a.origem_id', 'a.origem_descricao',
        'a.tipo_medida', 'a.prioridade', 'a.responsavel_id', knex.raw('coalesce(u.nome, a.responsavel_nome) as responsavel'), 'a.prazo', 'a.status');
    for (const c of ['filial_id', 'status', 'responsavel_id', 'origem_tipo', 'origem_id']) if (req.query[c]) q.where(`a.${c}`, req.query[c]);
    const dataHoje = hoje();
    return res.json((await q).map((a) => ({ ...a, numero: A.numero(a), atrasada: A.ABERTAS.includes(a.status) && a.prazo < dataHoje })));
  },

  // GET /acoes/minhas — ações abertas em que o usuário é o responsável
  async minhas(req, res) {
    const itens = await A.situacaoAcoes(knex, req, { responsavel_id: req.usuario.id });
    return res.json(itens.filter((i) => A.ABERTAS.includes(i.status)));
  },

  async show(req, res) {
    return res.json(await carregar(knex, await acaoNoEscopo(knex, req, req.params.id)));
  },

  // POST /acoes { filial_id, titulo, prazo, origem_tipo, origem_id? | origem_descricao, responsavel_id | responsavel_nome,
  //               descricao?, tipo_medida?, prioridade?, custo_estimado? }
  async create(req, res) {
    const b = req.body || {};
    if (!idValido(b.filial_id) || !podeAcessarFilial(req, b.filial_id)) throw new ErroDeNegocio(404, 'Filial não encontrada');
    const titulo = texto(b.titulo, 200);
    if (!titulo) throw new ErroDeNegocio(400, 'Informe o título da ação (o que será feito)');
    const prazo = lerData(b.prazo, 'prazo');
    if (b.tipo_medida && !A.TIPOS_MEDIDA[b.tipo_medida]) throw new ErroDeNegocio(400, `tipo_medida deve ser: ${Object.keys(A.TIPOS_MEDIDA).join(', ')}`);
    const prioridade = b.prioridade || 'media';
    if (!A.PRIORIDADES[prioridade]) throw new ErroDeNegocio(400, `prioridade deve ser: ${Object.keys(A.PRIORIDADES).join(', ')}`);

    const { acao, responsavel } = await knex.transaction(async (trx) => {
      const filial = await trx('filiais').where({ id: Number(b.filial_id) }).forUpdate().first('id');
      if (!filial) throw new ErroDeNegocio(404, 'Filial não encontrada');
      const origem = await A.descreverOrigem(trx, { tipo: b.origem_tipo, id: b.origem_id, filialId: filial.id, descricao: b.origem_descricao });
      const resp = await validarResponsavel(trx, b, filial.id);
      const ano = Number(hoje().slice(0, 4));
      const { max } = await trx('acoes').where({ filial_id: filial.id, ano }).max({ max: 'sequencial' }).first();
      const [a] = await trx('acoes').insert({
        filial_id: filial.id, ano, sequencial: (max || 0) + 1, titulo, descricao: texto(b.descricao, 5000),
        origem_tipo: b.origem_tipo, origem_id: origem.id, origem_descricao: origem.descricao, tipo_medida: b.tipo_medida || null, prioridade,
        responsavel_id: resp.responsavel_id, responsavel_nome: resp.responsavel_nome, prazo_original: prazo, prazo,
        custo_estimado: lerValor(b.custo_estimado, 'custo_estimado'), criado_por: req.usuario.id
      }).returning('*');
      await registrar(trx, req, a, { tipo: 'abertura', texto: `Ação aberta. Origem: ${origem.descricao}`, statusNovo: 'aberta' });
      await auditar(trx, req, { acao: 'abrir_acao', tabela: 'acoes', registro_id: a.id, filial_id: a.filial_id, depois: a });
      return { acao: a, responsavel: resp.usuario };
    });
    const completo = await carregar(knex, acao);
    if (responsavel && responsavel.id !== req.usuario.id) {
      try { await notificarResponsavel(knex, completo, responsavel, 'atribuida'); } catch (e) { console.warn(`Aviso ao responsável não enviado: ${e.message}`); }
    }
    return res.status(201).json(completo);
  },

  // PUT /acoes/:id { titulo?, descricao?, tipo_medida?, prioridade?, responsavel_id? | responsavel_nome?, custo_estimado? } — equipe de SST
  async update(req, res) {
    const b = req.body || {};
    if (b.prazo !== undefined) throw new ErroDeNegocio(400, 'Prazo se reprograma em POST /acoes/:id/prazo (com motivo)');
    let novoResponsavel = null;
    const atual = await knex.transaction(async (trx) => {
      const a = await acaoNoEscopo(trx, req, req.params.id, { travar: true });
      exigirAberta(a);
      const d = {};
      if (b.titulo !== undefined) { d.titulo = texto(b.titulo, 200); if (!d.titulo) throw new ErroDeNegocio(400, 'titulo não pode ser vazio'); }
      if (b.descricao !== undefined) d.descricao = texto(b.descricao, 5000);
      if (b.tipo_medida !== undefined) {
        if (b.tipo_medida && !A.TIPOS_MEDIDA[b.tipo_medida]) throw new ErroDeNegocio(400, `tipo_medida deve ser: ${Object.keys(A.TIPOS_MEDIDA).join(', ')}`);
        d.tipo_medida = b.tipo_medida || null;
      }
      if (b.prioridade !== undefined) {
        if (!A.PRIORIDADES[b.prioridade]) throw new ErroDeNegocio(400, `prioridade deve ser: ${Object.keys(A.PRIORIDADES).join(', ')}`);
        d.prioridade = b.prioridade;
      }
      if (b.custo_estimado !== undefined) d.custo_estimado = lerValor(b.custo_estimado, 'custo_estimado');
      if (b.responsavel_id !== undefined || b.responsavel_nome !== undefined) {
        const r = await validarResponsavel(trx, b, a.filial_id);
        if (r.responsavel_id !== a.responsavel_id || r.responsavel_nome !== a.responsavel_nome) {
          Object.assign(d, { responsavel_id: r.responsavel_id, responsavel_nome: r.responsavel_nome });
          await registrar(trx, req, a, { tipo: 'responsavel', texto: `Responsável alterado para ${r.usuario ? r.usuario.nome : r.responsavel_nome}` });
          novoResponsavel = r.usuario;
        }
      }
      if (!Object.keys(d).length) throw new ErroDeNegocio(400, 'Nada para alterar');
      const [depois] = await trx('acoes').where({ id: a.id }).update({ ...d, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar_acao', tabela: 'acoes', registro_id: a.id, filial_id: a.filial_id, antes: a, depois });
      return depois;
    });
    const completo = await carregar(knex, atual);
    if (novoResponsavel && novoResponsavel.id !== req.usuario.id) {
      try { await notificarResponsavel(knex, completo, novoResponsavel, 'atribuida'); } catch (e) { console.warn(`Aviso ao responsável não enviado: ${e.message}`); }
    }
    return res.json(completo);
  },

  // POST /acoes/:id/andamento { texto, arquivo? } — responsável ou equipe
  async andamento(req, res) {
    const t = texto(req.body && req.body.texto, 5000);
    if (!t) throw new ErroDeNegocio(400, 'Descreva o andamento');
    const a = await knex.transaction(async (trx) => {
      const acao = await acaoNoEscopo(trx, req, req.params.id, { travar: true });
      exigirAberta(acao);
      exigirExecutor(req, acao);
      const muda = acao.status === 'aberta';
      const r = await registrar(trx, req, acao, { tipo: 'andamento', texto: t, statusNovo: muda ? 'em_andamento' : null, arquivo: req.body.arquivo });
      if (muda) await trx('acoes').where({ id: acao.id }).update({ status: 'em_andamento', updated_at: trx.fn.now() });
      await auditar(trx, req, { acao: 'andamento_acao', tabela: 'acao_registros', registro_id: r.id, filial_id: acao.filial_id, depois: r });
      return acao;
    });
    return res.status(201).json(await carregar(knex, await acaoNoEscopo(knex, req, a.id)));
  },

  // POST /acoes/:id/concluir { texto (evidência do que foi feito), arquivo?, custo_real? } — responsável ou equipe
  async concluir(req, res) {
    const t = texto(req.body && req.body.texto, 5000);
    if (!t || t.length < 10) throw new ErroDeNegocio(400, 'Descreva o que foi feito (evidência da conclusão, pelo menos 10 caracteres)');
    const custo = lerValor(req.body.custo_real, 'custo_real');
    const a = await knex.transaction(async (trx) => {
      const acao = await acaoNoEscopo(trx, req, req.params.id, { travar: true });
      exigirAberta(acao);
      exigirExecutor(req, acao);
      const r = await registrar(trx, req, acao, { tipo: 'conclusao', texto: t, statusNovo: 'concluida', arquivo: req.body.arquivo });
      const [depois] = await trx('acoes').where({ id: acao.id })
        .update({ status: 'concluida', concluida_em: trx.fn.now(), concluida_por: req.usuario.id, custo_real: custo, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'concluir_acao', tabela: 'acoes', registro_id: acao.id, filial_id: acao.filial_id, antes: acao, depois: { ...depois, evidencia_sha256: r.sha256 } });
      return depois;
    });
    return res.json(await carregar(knex, a));
  },

  // POST /acoes/:id/verificar { eficaz: true|false, texto } — equipe de SST, outra pessoa que não quem concluiu
  async verificar(req, res) {
    const { eficaz } = req.body || {};
    const t = texto(req.body && req.body.texto, 5000);
    if (typeof eficaz !== 'boolean') throw new ErroDeNegocio(400, 'eficaz deve ser true ou false');
    if (!t) throw new ErroDeNegocio(400, 'Descreva como a eficácia foi verificada');
    if (!ehEquipe(req)) throw new ErroDeNegocio(403, 'A verificação de eficácia é com a equipe de SST');
    const a = await knex.transaction(async (trx) => {
      const acao = await acaoNoEscopo(trx, req, req.params.id, { travar: true });
      if (acao.status !== 'concluida') throw new ErroDeNegocio(409, 'Só se verifica ação concluída');
      if (acao.concluida_por === req.usuario.id && req.usuario.perfil !== 'admin') throw new ErroDeNegocio(409, 'A verificação deve ser feita por outra pessoa, não por quem concluiu');
      const status = eficaz ? 'verificada' : 'em_andamento';
      await registrar(trx, req, acao, { tipo: eficaz ? 'verificacao' : 'reabertura', texto: eficaz ? t : `Ineficaz: ${t}`, statusNovo: status, arquivo: req.body.arquivo });
      const [depois] = await trx('acoes').where({ id: acao.id })
        .update(eficaz ? { status, verificada_em: trx.fn.now(), updated_at: trx.fn.now() } : { status, concluida_em: null, concluida_por: null, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: eficaz ? 'verificar_acao' : 'reabrir_acao', tabela: 'acoes', registro_id: acao.id, filial_id: acao.filial_id, antes: acao, depois });
      return depois;
    });
    return res.json(await carregar(knex, a));
  },

  // POST /acoes/:id/prazo { prazo, motivo } — gestão; fica no histórico
  async reprogramar(req, res) {
    const prazo = lerData(req.body && req.body.prazo, 'prazo');
    const motivo = texto(req.body && req.body.motivo, 2000);
    if (!motivo || motivo.length < 10) throw new ErroDeNegocio(400, 'Informe o motivo da reprogramação (pelo menos 10 caracteres)');
    const a = await knex.transaction(async (trx) => {
      const acao = await acaoNoEscopo(trx, req, req.params.id, { travar: true });
      exigirAberta(acao);
      if (prazo === acao.prazo) throw new ErroDeNegocio(400, 'O prazo é o mesmo');
      await trx('acao_prazos').insert({ acao_id: acao.id, prazo_anterior: acao.prazo, prazo_novo: prazo, motivo, usuario_id: req.usuario.id });
      await registrar(trx, req, acao, { tipo: 'prazo', texto: `Prazo reprogramado de ${acao.prazo.split('-').reverse().join('/')} para ${prazo.split('-').reverse().join('/')}: ${motivo}` });
      const [depois] = await trx('acoes').where({ id: acao.id }).update({ prazo, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'reprogramar_acao', tabela: 'acoes', registro_id: acao.id, filial_id: acao.filial_id, antes: acao, depois });
      return depois;
    });
    return res.json(await carregar(knex, a));
  },

  // POST /acoes/:id/cancelar { motivo } — gestão (ação aberta por engano ou que deixou de fazer sentido)
  async cancelar(req, res) {
    const motivo = texto(req.body && req.body.motivo, 2000);
    if (!motivo || motivo.length < 10) throw new ErroDeNegocio(400, 'Informe o motivo do cancelamento (pelo menos 10 caracteres)');
    const a = await knex.transaction(async (trx) => {
      const acao = await acaoNoEscopo(trx, req, req.params.id, { travar: true });
      if (acao.status === 'cancelada') throw new ErroDeNegocio(409, 'Ação já cancelada');
      if (acao.status === 'verificada') throw new ErroDeNegocio(409, 'Ação verificada não se cancela');
      await registrar(trx, req, acao, { tipo: 'cancelamento', texto: motivo, statusNovo: 'cancelada' });
      const [depois] = await trx('acoes').where({ id: acao.id }).update({ status: 'cancelada', updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'cancelar_acao', tabela: 'acoes', registro_id: acao.id, filial_id: acao.filial_id, antes: acao, depois });
      return depois;
    });
    return res.json(await carregar(knex, a));
  },

  // GET /acao-registros/:id/arquivo — evidência anexada
  async arquivo(req, res) {
    const r = idValido(req.params.id) && await knex('acao_registros').where({ id: Number(req.params.id) }).first();
    if (!r || !r.arquivo_id) throw new ErroDeNegocio(404, 'Arquivo não encontrado');
    await acaoNoEscopo(knex, req, r.acao_id).catch(() => { throw new ErroDeNegocio(404, 'Arquivo não encontrado'); });
    const arq = await knex('arquivos').where({ id: r.arquivo_id }).first();
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Arquivo-SHA256', arq.sha256);
    return res.type(arq.tipo_mime).send(arq.conteudo);
  },

  // GET /acoes/pendencias?filial_id=&responsavel_id=&situacao=&dias=30&todas=true&data_base=
  async pendencias(req, res) {
    const dias = lerDias(req.query, 'dias', 30);
    const { dataBase } = lerDataBase(req.query);
    const itens = await A.situacaoAcoes(knex, req, req.query, { dias, dataBase });
    return res.json({ data_base: dataBase || hoje(), ...filtrarPendencias(itens, A.SITUACOES, req.query, { emDia: (i) => !['atrasada', 'vence_em_breve'].includes(i.situacao) }) });
  }
};
