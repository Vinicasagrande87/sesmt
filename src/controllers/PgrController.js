// PGR da filial: cadastro (rascunho), grupos de exposição, publicação (gera as OS) e revisão.
// Publicado não se edita: corrigir = abrir revisão, ajustar e publicar de novo (a anterior fica "substituído").
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { ehAdmin, podeAcessarFilial, exigirFilial } = require('../utils/escopo');
const { hoje, dataValida } = require('../utils/datas');
const { exigirCampos, idValido } = require('../utils/validacao');
const { salvarArquivo } = require('../utils/arquivos');
const { validarGrupo, gravarGrupo, carregarGrupo, conteudoDaOS, hashDoConteudo } = require('../services/pgr');

async function pgrNoEscopo(trx, req, id, { travar = false, editar = false } = {}) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'PGR não encontrado');
  const q = trx('pgrs').where({ id });
  if (travar) q.forUpdate();
  const pgr = await q.first();
  if (!pgr) throw new ErroDeNegocio(404, 'PGR não encontrado');
  pgr.filial_ids = (await trx('pgr_filiais').where({ pgr_id: pgr.id }).orderBy('filial_id')).map((f) => f.filial_id);
  if (!ehAdmin(req) && !pgr.filial_ids.some((f) => podeAcessarFilial(req, f))) throw new ErroDeNegocio(404, 'PGR não encontrado');
  // Para alterar, o usuário precisa atuar em todas as filiais que o PGR cobre
  if (editar) pgr.filial_ids.forEach((f) => exigirFilial(req, f));
  return pgr;
}

function exigirRascunho(pgr) {
  if (pgr.status !== 'rascunho') throw new ErroDeNegocio(409, `PGR ${pgr.status}: abra uma revisão para alterar`);
}

async function validarFiliais(trx, req, filialIds) {
  if (!Array.isArray(filialIds) || !filialIds.length || !filialIds.every(idValido)) {
    throw new ErroDeNegocio(400, 'filial_ids deve ser uma lista com pelo menos uma filial');
  }
  const ids = [...new Set(filialIds.map(Number))];
  ids.forEach((f) => exigirFilial(req, f));
  const ativas = await trx('filiais').whereIn('id', ids).where('ativa', true).pluck('id');
  if (ativas.length !== ids.length) throw new ErroDeNegocio(400, 'Filial não encontrada ou inativa');
  return ids;
}

function validarVigencia(inicio, fim) {
  if (!dataValida(inicio) || !dataValida(fim)) throw new ErroDeNegocio(400, 'data_inicio e data_fim no formato AAAA-MM-DD');
  if (fim < inicio) throw new ErroDeNegocio(400, 'data_fim não pode ser antes de data_inicio');
}

const ARQUIVO_PGR = { contexto: 'pgr', tipos: ['application/pdf'], maxBytes: 12 * 1024 * 1024 };

module.exports = {
  // GET /pgrs?filial_id=&status=
  async index(req, res) {
    const query = knex('pgrs as p')
      .select('p.id', 'p.titulo', 'p.data_inicio', 'p.data_fim', 'p.status', 'p.responsavel_nome', 'p.revisao_de', 'p.publicado_em',
        knex.raw('(select count(*) from pgr_grupos g where g.pgr_id = p.id)::int as grupos'),
        knex.raw("(select string_agg(f.nome, ', ' order by f.nome) from pgr_filiais pf join filiais f on f.id = pf.filial_id where pf.pgr_id = p.id) as filiais"))
      .orderBy([{ column: 'p.data_inicio', order: 'desc' }, { column: 'p.id', order: 'desc' }]);
    if (!ehAdmin(req)) query.whereExists(knex('pgr_filiais as pf').whereRaw('pf.pgr_id = p.id').whereIn('pf.filial_id', req.usuario.filiais));
    if (req.query.filial_id) query.whereExists(knex('pgr_filiais as pf').whereRaw('pf.pgr_id = p.id').where('pf.filial_id', req.query.filial_id));
    if (req.query.status) query.where('p.status', req.query.status);
    return res.json(await query);
  },

  // GET /pgrs/:id — completo, com grupos, riscos, EPIs, treinamentos e a OS de cada grupo
  async show(req, res) {
    const pgr = await pgrNoEscopo(knex, req, req.params.id);
    const filiais = await knex('filiais').whereIn('id', pgr.filial_ids).select('id', 'nome', 'cnpj');
    const ids = await knex('pgr_grupos').where({ pgr_id: pgr.id }).orderBy([{ column: 'ordem' }, { column: 'id' }]).pluck('id');
    const grupos = [];
    for (const id of ids) grupos.push(await carregarGrupo(knex, id));
    const oss = await knex('ordens_servico').where({ pgr_id: pgr.id }).select('id', 'grupo_id', 'hash');
    const osPorGrupo = new Map(oss.map((o) => [o.grupo_id, o]));
    return res.json({ ...pgr, filiais, grupos: grupos.map((g) => ({ ...g, ordem_servico: osPorGrupo.get(g.id) || null })) });
  },

  // POST /pgrs { titulo, data_inicio, data_fim, filial_ids, responsavel_nome, responsavel_registro, responsavel_titulacao?, arquivo }
  async create(req, res) {
    exigirCampos(req.body, ['titulo', 'data_inicio', 'data_fim', 'filial_ids', 'responsavel_nome', 'responsavel_registro', 'arquivo']);
    const b = req.body;
    validarVigencia(b.data_inicio, b.data_fim);
    const pgr = await knex.transaction(async (trx) => {
      const filialIds = await validarFiliais(trx, req, b.filial_ids);
      const arquivo = await salvarArquivo(trx, req, { ...ARQUIVO_PGR, base64: b.arquivo, filial_id: filialIds[0] });
      const [novo] = await trx('pgrs').insert({
        titulo: String(b.titulo).trim(), data_inicio: b.data_inicio, data_fim: b.data_fim,
        responsavel_nome: String(b.responsavel_nome).trim(), responsavel_registro: String(b.responsavel_registro).trim(),
        responsavel_titulacao: b.responsavel_titulacao ? String(b.responsavel_titulacao).trim() : null,
        arquivo_id: arquivo.id, criado_por: req.usuario.id
      }).returning('*');
      await trx('pgr_filiais').insert(filialIds.map((filial_id) => ({ pgr_id: novo.id, filial_id })));
      await auditar(trx, req, { acao: 'criar', tabela: 'pgrs', registro_id: novo.id, filial_id: filialIds[0], depois: { ...novo, filial_ids: filialIds, sha256: arquivo.sha256 } });
      return { ...novo, filial_ids: filialIds };
    });
    return res.status(201).json(pgr);
  },

  // PUT /pgrs/:id — só rascunho. Campos: titulo, datas, responsável, arquivo; filial_ids só sem grupos.
  async update(req, res) {
    const b = req.body || {};
    const resultado = await knex.transaction(async (trx) => {
      const antes = await pgrNoEscopo(trx, req, req.params.id, { travar: true, editar: true });
      exigirRascunho(antes);
      const dados = {};
      for (const c of ['titulo', 'responsavel_nome', 'responsavel_registro', 'responsavel_titulacao', 'data_inicio', 'data_fim']) {
        if (b[c] !== undefined) dados[c] = b[c] === null ? null : String(b[c]).trim();
      }
      validarVigencia(dados.data_inicio || antes.data_inicio, dados.data_fim || antes.data_fim);
      if (b.arquivo) dados.arquivo_id = (await salvarArquivo(trx, req, { ...ARQUIVO_PGR, base64: b.arquivo, filial_id: antes.filial_ids[0] })).id;
      let filialIds = antes.filial_ids;
      if (b.filial_ids !== undefined) {
        if (await trx('pgr_grupos').where({ pgr_id: antes.id }).first('id')) throw new ErroDeNegocio(409, 'Remova os grupos antes de trocar as filiais do PGR');
        filialIds = await validarFiliais(trx, req, b.filial_ids);
        await trx('pgr_filiais').where({ pgr_id: antes.id }).del();
        await trx('pgr_filiais').insert(filialIds.map((filial_id) => ({ pgr_id: antes.id, filial_id })));
      }
      if (!Object.keys(dados).length && b.filial_ids === undefined) throw new ErroDeNegocio(400, 'Nenhum campo para alterar');
      const [depois] = await trx('pgrs').where({ id: antes.id }).update({ ...dados, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar', tabela: 'pgrs', registro_id: antes.id, filial_id: filialIds[0], antes, depois: { ...depois, filial_ids: filialIds } });
      return { ...depois, filial_ids: filialIds };
    });
    return res.json(resultado);
  },

  // POST /pgrs/:id/grupos — um grupo, ou { grupos: [...] } para importar a planilha de uma vez (tudo ou nada)
  async adicionarGrupos(req, res) {
    const lote = Array.isArray(req.body && req.body.grupos) ? req.body.grupos : [req.body];
    const ids = await knex.transaction(async (trx) => {
      const pgr = await pgrNoEscopo(trx, req, req.params.id, { travar: true, editar: true });
      exigirRascunho(pgr);
      const criados = [];
      for (const [i, item] of lote.entries()) {
        try {
          criados.push(await gravarGrupo(trx, pgr.id, await validarGrupo(trx, pgr, item)));
        } catch (erro) {
          if (lote.length > 1 && erro instanceof ErroDeNegocio) erro.message = `Grupo ${i + 1} (${item && item.atividade || 'sem atividade'}): ${erro.message}`;
          throw erro;
        }
      }
      await auditar(trx, req, { acao: 'adicionar_grupos', tabela: 'pgrs', registro_id: pgr.id, filial_id: pgr.filial_ids[0], depois: { grupos: criados } });
      return criados;
    });
    const grupos = [];
    for (const id of ids) grupos.push(await carregarGrupo(knex, id));
    return res.status(201).json(lote.length === 1 && !Array.isArray(req.body.grupos) ? grupos[0] : grupos);
  },

  // PUT /pgr-grupos/:id — substitui o grupo inteiro (só rascunho)
  async alterarGrupo(req, res) {
    const id = await knex.transaction(async (trx) => {
      const grupo = idValido(req.params.id) && await trx('pgr_grupos').where({ id: req.params.id }).first();
      if (!grupo) throw new ErroDeNegocio(404, 'Grupo não encontrado');
      const pgr = await pgrNoEscopo(trx, req, grupo.pgr_id, { travar: true, editar: true });
      exigirRascunho(pgr);
      const antes = await carregarGrupo(trx, grupo.id);
      await gravarGrupo(trx, pgr.id, await validarGrupo(trx, pgr, req.body), grupo.id);
      await auditar(trx, req, { acao: 'alterar_grupo', tabela: 'pgr_grupos', registro_id: grupo.id, filial_id: pgr.filial_ids[0], antes, depois: req.body });
      return grupo.id;
    });
    return res.json(await carregarGrupo(knex, id));
  },

  // DELETE /pgr-grupos/:id — só rascunho (nada publicado é apagado)
  async removerGrupo(req, res) {
    await knex.transaction(async (trx) => {
      const grupo = idValido(req.params.id) && await trx('pgr_grupos').where({ id: req.params.id }).first();
      if (!grupo) throw new ErroDeNegocio(404, 'Grupo não encontrado');
      const pgr = await pgrNoEscopo(trx, req, grupo.pgr_id, { travar: true, editar: true });
      exigirRascunho(pgr);
      const antes = await carregarGrupo(trx, grupo.id);
      for (const t of ['pgr_grupo_funcoes', 'pgr_riscos', 'pgr_epis', 'pgr_treinamentos']) await trx(t).where({ grupo_id: grupo.id }).del();
      await trx('pgr_grupos').where({ id: grupo.id }).del();
      await auditar(trx, req, { acao: 'remover_grupo', tabela: 'pgr_grupos', registro_id: grupo.id, filial_id: pgr.filial_ids[0], antes });
    });
    return res.status(204).end();
  },

  // POST /pgrs/:id/publicar — congela o PGR, gera as OS e substitui o PGR vigente das mesmas filiais
  async publicar(req, res) {
    const resultado = await knex.transaction(async (trx) => {
      const pgr = await pgrNoEscopo(trx, req, req.params.id, { travar: true, editar: true });
      exigirRascunho(pgr);
      if (pgr.data_fim < hoje()) throw new ErroDeNegocio(409, 'Vigência já encerrada: confira data_fim');
      const grupoIds = await trx('pgr_grupos').where({ pgr_id: pgr.id }).orderBy([{ column: 'ordem' }, { column: 'id' }]).pluck('id');
      if (!grupoIds.length) throw new ErroDeNegocio(409, 'PGR sem grupos de exposição');

      // PGRs vigentes que dividem alguma filial com este passam a "substituído"
      const anteriores = await trx('pgrs as p').join('pgr_filiais as pf', 'pf.pgr_id', 'p.id')
        .where('p.status', 'vigente').whereIn('pf.filial_id', pgr.filial_ids).distinct('p.id').pluck('p.id');
      if (anteriores.length) {
        await trx('pgrs').whereIn('id', anteriores).update({ status: 'substituido', substituido_em: trx.fn.now(), updated_at: trx.fn.now() });
      }
      const [publicado] = await trx('pgrs').where({ id: pgr.id })
        .update({ status: 'vigente', publicado_por: req.usuario.id, publicado_em: trx.fn.now(), updated_at: trx.fn.now() }).returning('*');

      const ordens = [];
      for (const grupoId of grupoIds) {
        const conteudo = await conteudoDaOS(trx, { ...publicado, filial_ids: pgr.filial_ids }, grupoId);
        const [os] = await trx('ordens_servico').insert({ pgr_id: pgr.id, grupo_id: grupoId, conteudo, hash: hashDoConteudo(conteudo) }).returning(['id', 'grupo_id', 'hash']);
        ordens.push(os);
      }

      // Filiais que ficaram sem PGR (o anterior cobria e o novo não)
      const filiaisAntes = anteriores.length ? await trx('pgr_filiais').whereIn('pgr_id', anteriores).distinct('filial_id').pluck('filial_id') : [];
      const semPgr = filiaisAntes.filter((f) => !pgr.filial_ids.includes(f));

      await auditar(trx, req, {
        acao: 'publicar', tabela: 'pgrs', registro_id: pgr.id, filial_id: pgr.filial_ids[0], antes: pgr,
        depois: { ...publicado, substituiu: anteriores, ordens_servico: ordens }
      });
      return { ...publicado, filial_ids: pgr.filial_ids, substituiu: anteriores, ordens_servico: ordens, filiais_sem_pgr: semPgr };
    });
    return res.json(resultado);
  },

  // POST /pgrs/:id/revisar — copia um PGR publicado para um novo rascunho (corrigir ou renovar)
  async revisar(req, res) {
    const novo = await knex.transaction(async (trx) => {
      const origem = await pgrNoEscopo(trx, req, req.params.id, { editar: true });
      if (origem.status === 'rascunho') throw new ErroDeNegocio(409, 'Este PGR ainda é rascunho: altere-o diretamente');
      const [copia] = await trx('pgrs').insert({
        titulo: origem.titulo, data_inicio: origem.data_inicio, data_fim: origem.data_fim,
        responsavel_nome: origem.responsavel_nome, responsavel_registro: origem.responsavel_registro,
        responsavel_titulacao: origem.responsavel_titulacao, arquivo_id: origem.arquivo_id,
        revisao_de: origem.id, criado_por: req.usuario.id
      }).returning('*');
      await trx('pgr_filiais').insert(origem.filial_ids.map((filial_id) => ({ pgr_id: copia.id, filial_id })));
      const grupoIds = await trx('pgr_grupos').where({ pgr_id: origem.id }).orderBy('id').pluck('id');
      for (const id of grupoIds) {
        const g = await carregarGrupo(trx, id);
        await gravarGrupo(trx, copia.id, {
          grupo: {
            setor_id: g.setor_id, atividade: g.atividade, descricao_atividades: g.descricao_atividades, medidas_controle: g.medidas_controle,
            observacao_epi: g.observacao_epi, unidade_fisica: g.unidade_fisica, conclusao_gfip: g.conclusao_gfip, ordem: g.ordem
          },
          funcaoIds: g.funcoes.map((f) => f.id),
          riscos: g.riscos.map(({ id: _i, grupo_id: _g, ...r }) => r),
          epis: g.epis.map((e) => ({ parte_corpo: e.parte_corpo, descricao: e.descricao, epi_id: e.epi_id })),
          treinamentos: g.treinamentos.map((t) => ({ descricao: t.descricao, treinamento_id: t.treinamento_id }))
        });
      }
      await auditar(trx, req, { acao: 'revisar', tabela: 'pgrs', registro_id: copia.id, filial_id: origem.filial_ids[0], depois: { ...copia, revisao_de: origem.id } });
      return { ...copia, filial_ids: origem.filial_ids, grupos: grupoIds.length };
    });
    return res.status(201).json(novo);
  },

  // GET /pgrs/:id/arquivo — PDF assinado do PGR
  async arquivo(req, res) {
    const pgr = await pgrNoEscopo(knex, req, req.params.id);
    const arquivo = await knex('arquivos').where({ id: pgr.arquivo_id }).first();
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Arquivo-SHA256', arquivo.sha256);
    res.set('Content-Disposition', `inline; filename="pgr-${pgr.id}.pdf"`);
    return res.type(arquivo.tipo_mime).send(arquivo.conteudo);
  }
};
