// PPCI por prédio: projeto aprovado (com as medidas previstas), alvará, painel do prédio e pendências.
// Vale o registro mais recente que não foi anulado; nada é apagado.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { podeAcessarFilial, noEscopo } = require('../utils/escopo');
const { hoje, dataValida, paraISO } = require('../utils/datas');
const { exigirCampos, idValido } = require('../utils/validacao');
const { salvarArquivo } = require('../utils/arquivos');
const P = require('../services/ppci');

const TIPOS_ARQUIVO = ['application/pdf', 'image/jpeg', 'image/png'];
const MAX_ARQUIVO = 12 * 1024 * 1024;

function texto(valor, max) {
  if (valor === undefined || valor === null) return null;
  const t = String(valor).trim();
  if (max && t.length > max) throw new ErroDeNegocio(400, `Texto muito longo (máximo ${max} caracteres)`);
  return t.length ? t : null;
}

async function predioNoEscopo(db, req, id) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'Prédio não encontrado');
  const predio = await db('predios').where({ id }).first();
  if (!predio || !podeAcessarFilial(req, predio.filial_id)) throw new ErroDeNegocio(404, 'Prédio não encontrado');
  return predio;
}

async function registroNoEscopo(db, req, tabela, id, nome) {
  if (!idValido(id)) throw new ErroDeNegocio(404, `${nome} não encontrado`);
  const r = await db(tabela).where({ id }).first();
  if (!r || !podeAcessarFilial(req, r.filial_id)) throw new ErroDeNegocio(404, `${nome} não encontrado`);
  return r;
}

function validarMedidas(medidas) {
  if (!Array.isArray(medidas) || !medidas.length) throw new ErroDeNegocio(400, 'Informe as medidas previstas no projeto (medidas: [...])');
  return medidas.map((m, i) => {
    const n = `Medida ${i + 1}`;
    if (!m || !P.TIPOS_MEDIDA.includes(m.tipo)) throw new ErroDeNegocio(400, `${n}: tipo deve ser um de: ${P.TIPOS_MEDIDA.join(', ')}`);
    const agente = texto(m.agente);
    if (agente && m.tipo !== 'extintor') throw new ErroDeNegocio(400, `${n}: agente só se aplica a extintor`);
    if (agente && !P.AGENTES[agente]) throw new ErroDeNegocio(400, `${n}: agente deve ser um de: ${Object.keys(P.AGENTES).join(', ')}`);
    let quantidade = null;
    if (m.quantidade !== undefined && m.quantidade !== null && m.quantidade !== '') {
      quantidade = Number(m.quantidade);
      if (!Number.isInteger(quantidade) || quantidade < 0 || quantidade > 10000) throw new ErroDeNegocio(400, `${n}: quantidade inválida`);
    }
    if (quantidade === null && P.EQUIPAMENTOS[m.tipo]) throw new ErroDeNegocio(400, `${n}: informe a quantidade de ${P.nomeDaMedida(m.tipo).toLowerCase()} prevista`);
    return { tipo: m.tipo, agente, quantidade, especificacao: texto(m.especificacao, 1000) };
  });
}

async function anular(req, res, { tabela, anulacoes, fk, nome, acao }) {
  const motivo = texto(req.body && req.body.motivo);
  if (!motivo || motivo.length < 5) throw new ErroDeNegocio(400, 'Informe o motivo (pelo menos 5 caracteres)');
  const resultado = await knex.transaction(async (trx) => {
    const r = await registroNoEscopo(trx, req, tabela, req.params.id, nome);
    if (await trx(anulacoes).where({ [fk]: r.id }).first('id')) throw new ErroDeNegocio(409, `${nome} já anulado`);
    const [a] = await trx(anulacoes).insert({ [fk]: r.id, motivo, usuario_id: req.usuario.id }).returning('*');
    await auditar(trx, req, { acao, tabela, registro_id: r.id, filial_id: r.filial_id, antes: r, depois: a });
    return a;
  });
  return res.status(201).json(resultado);
}

async function enviarArquivo(req, res, { tabela, nome, prefixo }) {
  const r = await registroNoEscopo(knex, req, tabela, req.params.id, nome);
  const arquivo = await knex('arquivos').where({ id: r.arquivo_id }).first();
  await auditar(knex, req, { acao: `baixar_${prefixo}`, tabela, registro_id: r.id, filial_id: r.filial_id });
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Arquivo-SHA256', arquivo.sha256);
  res.set('Content-Disposition', `inline; filename="${prefixo}-${r.id}.${arquivo.tipo_mime === 'application/pdf' ? 'pdf' : arquivo.tipo_mime.split('/')[1]}"`);
  return res.type(arquivo.tipo_mime).send(arquivo.conteudo);
}

function listar(req, { tabela, anulacoes, fk, ordem }) {
  const q = noEscopo(knex(`${tabela} as t`), req, 't.filial_id')
    .join('predios as p', 'p.id', 't.predio_id')
    .leftJoin(`${anulacoes} as n`, `n.${fk}`, 't.id')
    .select('t.*', 'p.nome as predio', knex.raw('(n.id is not null) as anulado'), 'n.motivo as anulacao_motivo')
    .orderBy([{ column: `t.${ordem}`, order: 'desc' }, { column: 't.id', order: 'desc' }]);
  if (req.query.predio_id) q.where('t.predio_id', req.query.predio_id);
  if (req.query.filial_id) q.where('t.filial_id', req.query.filial_id);
  if (req.query.incluir_anulados !== 'true') q.whereNull('n.id');
  return q;
}

// Painel de um prédio: PPCI e alvará que valem hoje, comparação e equipamentos com a situação
async function painel(db, predio, { dias, diasAlvara } = {}) {
  const ppci = (await P.ppcisVigentes(db, [predio.id])).get(predio.id) || null;
  const alvara = (await P.alvarasVigentes(db, [predio.id])).get(predio.id) || null;
  const medidas = ppci ? await db('ppci_medidas').where({ ppci_id: ppci.id }).orderBy('id') : [];
  const equipamentos = await db('equipamentos_incendio').where({ predio_id: predio.id, ativo: true }).orderBy('identificacao');
  const situacao = await P.situacaoDosEquipamentos(db, equipamentos, { dias });
  const comparacao = ppci ? P.compararProjeto(medidas, equipamentos) : [];
  return {
    ppci: ppci && { ...ppci, data_aprovacao: paraISO(ppci.data_aprovacao), medidas },
    alvara: alvara && { ...alvara, data_emissao: paraISO(alvara.data_emissao), data_validade: paraISO(alvara.data_validade) },
    situacao_alvara: P.situacaoDoAlvara(alvara, { dias: diasAlvara }),
    comparacao,
    equipamentos: situacao
  };
}

function diasDaQuery(req) {
  const ler = (nome, padrao) => {
    if (req.query[nome] === undefined) return padrao;
    const n = Number(req.query[nome]);
    if (!Number.isInteger(n) || n < 0 || n > 365) throw new ErroDeNegocio(400, `${nome} deve ser um inteiro entre 0 e 365`);
    return n;
  };
  return { dias: ler('dias', P.DIAS_EQUIPAMENTO), diasAlvara: ler('dias_alvara', P.DIAS_ALVARA) };
}

module.exports = {
  // GET /ppcis?predio_id=&filial_id=&incluir_anulados=true
  async index(req, res) {
    return res.json(await listar(req, { tabela: 'ppcis', anulacoes: 'ppci_anulacoes', fk: 'ppci_id', ordem: 'data_aprovacao' }));
  },

  async show(req, res) {
    const ppci = await registroNoEscopo(knex, req, 'ppcis', req.params.id, 'PPCI');
    const medidas = await knex('ppci_medidas').where({ ppci_id: ppci.id }).orderBy('id');
    const anulacao = await knex('ppci_anulacoes').where({ ppci_id: ppci.id }).first();
    return res.json({ ...ppci, medidas, anulacao: anulacao || null });
  },

  // POST /ppcis { predio_id, data_aprovacao, arquivo, medidas: [{ tipo, agente?, quantidade?, especificacao? }],
  //               numero_processo?, orgao?, responsavel_nome?, responsavel_registro?, observacao? }
  async create(req, res) {
    exigirCampos(req.body, ['predio_id', 'data_aprovacao', 'arquivo']);
    const b = req.body;
    if (!dataValida(b.data_aprovacao) || b.data_aprovacao > hoje()) throw new ErroDeNegocio(400, 'data_aprovacao inválida ou futura');
    const medidas = validarMedidas(b.medidas);
    const resultado = await knex.transaction(async (trx) => {
      const predio = await predioNoEscopo(trx, req, b.predio_id);
      if (!predio.ativo) throw new ErroDeNegocio(409, 'Prédio inativo');
      const arquivo = await salvarArquivo(trx, req, { base64: b.arquivo, contexto: 'ppci', tipos: TIPOS_ARQUIVO, maxBytes: MAX_ARQUIVO, filial_id: predio.filial_id });
      const [ppci] = await trx('ppcis').insert({
        predio_id: predio.id, filial_id: predio.filial_id, numero_processo: texto(b.numero_processo, 60), data_aprovacao: b.data_aprovacao,
        orgao: texto(b.orgao, 120) || 'Corpo de Bombeiros', responsavel_nome: texto(b.responsavel_nome, 160),
        responsavel_registro: texto(b.responsavel_registro, 60), arquivo_id: arquivo.id, observacao: texto(b.observacao), registrado_por: req.usuario.id
      }).returning('*');
      const gravadas = await trx('ppci_medidas').insert(medidas.map((m) => ({ ...m, ppci_id: ppci.id }))).returning('*');
      await auditar(trx, req, { acao: 'registrar_ppci', tabela: 'ppcis', registro_id: ppci.id, filial_id: ppci.filial_id, depois: { ...ppci, medidas: gravadas, sha256: arquivo.sha256 } });
      return { ...ppci, medidas: gravadas };
    });
    return res.status(201).json(resultado);
  },

  anular: (req, res) => anular(req, res, { tabela: 'ppcis', anulacoes: 'ppci_anulacoes', fk: 'ppci_id', nome: 'PPCI', acao: 'anular_ppci' }),
  arquivo: (req, res) => enviarArquivo(req, res, { tabela: 'ppcis', nome: 'PPCI', prefixo: 'ppci' }),

  // GET /alvaras?predio_id=&filial_id=&incluir_anulados=true
  async alvaras(req, res) {
    const linhas = await listar(req, { tabela: 'alvaras', anulacoes: 'alvara_anulacoes', fk: 'alvara_id', ordem: 'data_emissao' });
    return res.json(linhas.map((a) => ({ ...a, situacao: a.anulado ? 'anulado' : P.situacaoDoAlvara(a) })));
  },

  // POST /alvaras { predio_id, data_emissao, data_validade, arquivo, tipo_documento?, numero?, ppci_id?, observacao? }
  async criarAlvara(req, res) {
    exigirCampos(req.body, ['predio_id', 'data_emissao', 'data_validade', 'arquivo']);
    const b = req.body;
    if (!dataValida(b.data_emissao) || b.data_emissao > hoje()) throw new ErroDeNegocio(400, 'data_emissao inválida ou futura');
    if (!dataValida(b.data_validade) || b.data_validade <= b.data_emissao) throw new ErroDeNegocio(400, 'data_validade inválida: deve ser posterior à emissão');
    const resultado = await knex.transaction(async (trx) => {
      const predio = await predioNoEscopo(trx, req, b.predio_id);
      if (!predio.ativo) throw new ErroDeNegocio(409, 'Prédio inativo');
      let ppciId = null;
      if (b.ppci_id !== undefined && b.ppci_id !== null && b.ppci_id !== '') {
        const ppci = idValido(b.ppci_id) && await trx('ppcis').where({ id: b.ppci_id, predio_id: predio.id }).first('id');
        if (!ppci) throw new ErroDeNegocio(400, 'ppci_id não pertence a este prédio');
        ppciId = ppci.id;
      }
      const arquivo = await salvarArquivo(trx, req, { base64: b.arquivo, contexto: 'alvara', tipos: TIPOS_ARQUIVO, maxBytes: MAX_ARQUIVO, filial_id: predio.filial_id });
      const [alvara] = await trx('alvaras').insert({
        predio_id: predio.id, filial_id: predio.filial_id, ppci_id: ppciId, tipo_documento: texto(b.tipo_documento, 40) || 'Alvará',
        numero: texto(b.numero, 60), data_emissao: b.data_emissao, data_validade: b.data_validade, arquivo_id: arquivo.id,
        observacao: texto(b.observacao), registrado_por: req.usuario.id
      }).returning('*');
      await auditar(trx, req, { acao: 'registrar_alvara', tabela: 'alvaras', registro_id: alvara.id, filial_id: alvara.filial_id, depois: { ...alvara, sha256: arquivo.sha256 } });
      return alvara;
    });
    return res.status(201).json({ ...resultado, situacao: P.situacaoDoAlvara(resultado) });
  },

  anularAlvara: (req, res) => anular(req, res, { tabela: 'alvaras', anulacoes: 'alvara_anulacoes', fk: 'alvara_id', nome: 'Alvará', acao: 'anular_alvara' }),
  arquivoAlvara: (req, res) => enviarArquivo(req, res, { tabela: 'alvaras', nome: 'Alvará', prefixo: 'alvara' }),

  // GET /predios/:id/ppci?dias=30&dias_alvara=90 — painel do prédio
  async painelDoPredio(req, res) {
    const predio = await predioNoEscopo(knex, req, req.params.id);
    return res.json({ predio, ...(await painel(knex, predio, diasDaQuery(req))) });
  },

  // GET /ppci/pendencias?filial_id=&predio_id=&situacao=&dias=30&dias_alvara=90
  async pendencias(req, res) {
    const { dias, diasAlvara } = diasDaQuery(req);
    const situacoes = [...P.SITUACOES_PREDIO, ...P.SITUACOES_EQUIPAMENTO];
    if (req.query.situacao && !situacoes.includes(req.query.situacao)) throw new ErroDeNegocio(400, `situacao deve ser: ${situacoes.join(', ')}`);

    const q = noEscopo(knex('predios as p'), req, 'p.filial_id').join('filiais as f', 'f.id', 'p.filial_id')
      .where('p.ativo', true).select('p.*', 'f.nome as filial').orderBy(['f.nome', 'p.nome']);
    if (req.query.filial_id) q.where('p.filial_id', req.query.filial_id);
    if (req.query.predio_id) q.where('p.id', req.query.predio_id);
    const predios = await q;

    const itens = [];
    for (const predio of predios) {
      const pn = await painel(knex, predio, { dias, diasAlvara });
      const base = { filial_id: predio.filial_id, filial: predio.filial, predio_id: predio.id, predio: predio.nome };
      if (!pn.ppci) itens.push({ ...base, nivel: 'predio', situacao: 'sem_ppci' });
      if (pn.situacao_alvara !== 'vigente') {
        itens.push({ ...base, nivel: 'predio', situacao: pn.situacao_alvara === 'sem_alvara' ? 'sem_alvara' : `alvara_${pn.situacao_alvara}`,
          data_validade: pn.alvara ? pn.alvara.data_validade : null });
      }
      const faltando = pn.comparacao.filter((c) => c.situacao === 'faltando');
      if (faltando.length) {
        itens.push({ ...base, nivel: 'predio', situacao: 'divergencia_projeto',
          detalhe: faltando.map((c) => ({ tipo: c.tipo, agente: c.agente, previsto: c.previsto, instalado: c.instalado })) });
      }
      for (const eq of pn.equipamentos) {
        for (const situacao of eq.pendencias) {
          const manut = eq.manutencoes[situacao.replace(/_(vencida|vencendo|nao_registrada)$/, '')];
          itens.push({ ...base, nivel: 'equipamento', situacao, equipamento_id: eq.id, identificacao: eq.identificacao, tipo: eq.tipo,
            agente: eq.agente, localizacao: eq.localizacao,
            data_limite: situacao.startsWith('inspecao') ? (eq.inspecao ? eq.inspecao.proxima : null) : (manut ? manut.data_proxima : null),
            ...(situacao === 'nao_conforme' ? { nao_conformes: eq.inspecao.nao_conformes, observacao: eq.inspecao.observacao } : {}) });
        }
      }
    }
    const filtrados = req.query.situacao ? itens.filter((i) => i.situacao === req.query.situacao) : itens;
    const resumo = Object.fromEntries(situacoes.map((s) => [s, filtrados.filter((i) => i.situacao === s).length]).filter(([, n]) => n));
    return res.json({ resumo, itens: filtrados });
  }
};
