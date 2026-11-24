// Equipamentos de combate a incêndio de cada prédio (extintores, hidrantes...), com QR colado no equipamento,
// manutenções (recarga, teste hidrostático) e inspeção mensal pelo QR.
const crypto = require('crypto');
const QRCode = require('qrcode');
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { podeAcessarFilial, noEscopo } = require('../utils/escopo');
const { hoje, dataValida, somarMeses, dataLocal } = require('../utils/datas');
const { exigirCampos, idValido } = require('../utils/validacao');
const { salvarArquivo } = require('../utils/arquivos');
const { gerarCodigo } = require('../utils/codigo');
const P = require('../services/ppci');

const CAMPOS_EDITAVEIS = ['identificacao', 'localizacao', 'agente', 'capacidade', 'fabricante', 'numero_serie', 'ano_fabricacao'];
const ehGestao = (req) => ['admin', 'gestor'].includes(req.usuario.perfil);

function texto(valor, max) {
  if (valor === undefined || valor === null) return null;
  const t = String(valor).trim();
  if (max && t.length > max) throw new ErroDeNegocio(400, `Texto muito longo (máximo ${max} caracteres)`);
  return t.length ? t : null;
}

async function equipamentoNoEscopo(db, req, id, { travar } = {}) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'Equipamento não encontrado');
  const q = db('equipamentos_incendio').where({ id });
  if (travar) q.forUpdate();
  const eq = await q.first();
  if (!eq || !podeAcessarFilial(req, eq.filial_id)) throw new ErroDeNegocio(404, 'Equipamento não encontrado');
  return eq;
}

async function porToken(db, req, token, { travar } = {}) {
  const t = String(token || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(t)) throw new ErroDeNegocio(404, 'QR code não reconhecido');
  const q = db('equipamentos_incendio').where({ qr_token: t });
  if (travar) q.forUpdate();
  const eq = await q.first();
  if (!eq || !podeAcessarFilial(req, eq.filial_id)) throw new ErroDeNegocio(404, 'QR code não reconhecido');
  return eq;
}

async function predioDaFilial(db, req, predioId, filialId) {
  if (!idValido(predioId)) throw new ErroDeNegocio(400, 'predio_id inválido');
  const predio = await db('predios').where({ id: predioId }).first();
  if (!predio || !podeAcessarFilial(req, predio.filial_id)) throw new ErroDeNegocio(404, 'Prédio não encontrado');
  if (filialId && predio.filial_id !== filialId) throw new ErroDeNegocio(400, 'O equipamento só pode mudar para um prédio da mesma filial');
  if (!predio.ativo) throw new ErroDeNegocio(409, 'Prédio inativo');
  return predio;
}

// Valida os campos descritivos; devolve só o que veio
function validarCampos(b, tipo) {
  const dados = {};
  if (b.identificacao !== undefined) {
    dados.identificacao = texto(b.identificacao, 40);
    if (!dados.identificacao) throw new ErroDeNegocio(400, 'identificacao obrigatória (ex.: EXT-011)');
  }
  if (b.localizacao !== undefined) {
    dados.localizacao = texto(b.localizacao, 250);
    if (!dados.localizacao) throw new ErroDeNegocio(400, 'localizacao obrigatória (ex.: 2º andar, ao lado do elevador)');
  }
  if (b.agente !== undefined) {
    dados.agente = texto(b.agente);
    if (dados.agente && tipo !== 'extintor') throw new ErroDeNegocio(400, 'agente só se aplica a extintor');
    if (dados.agente && !P.AGENTES[dados.agente]) throw new ErroDeNegocio(400, `agente deve ser: ${Object.keys(P.AGENTES).join(', ')}`);
  }
  for (const [campo, max] of [['capacidade', 20], ['fabricante', 80], ['numero_serie', 60]]) {
    if (b[campo] !== undefined) dados[campo] = texto(b[campo], max);
  }
  if (b.ano_fabricacao !== undefined) {
    const ano = b.ano_fabricacao === null || b.ano_fabricacao === '' ? null : Number(b.ano_fabricacao);
    if (ano !== null && (!Number.isInteger(ano) || ano < 1950 || ano > Number(hoje().slice(0, 4)))) throw new ErroDeNegocio(400, 'ano_fabricacao inválido');
    dados.ano_fabricacao = ano;
  }
  return dados;
}

async function gravarManutencao(trx, req, eq, b) {
  exigirCampos(b, ['tipo', 'data_servico']);
  const meses = P.EQUIPAMENTOS[eq.tipo].manutencoes[b.tipo];
  if (!meses) throw new ErroDeNegocio(400, `Para ${P.nomeDaMedida(eq.tipo).toLowerCase()}, tipo de manutenção deve ser: ${Object.keys(P.EQUIPAMENTOS[eq.tipo].manutencoes).join(', ')}`);
  if (!dataValida(b.data_servico) || b.data_servico > hoje()) throw new ErroDeNegocio(400, 'data_servico inválida ou futura');
  let proxima = somarMeses(b.data_servico, meses);
  if (b.data_proxima !== undefined && b.data_proxima !== null && b.data_proxima !== '') {
    if (!dataValida(b.data_proxima) || b.data_proxima <= b.data_servico) throw new ErroDeNegocio(400, 'data_proxima inválida: deve ser posterior ao serviço');
    proxima = b.data_proxima;
  }
  let arquivo = null;
  if (b.arquivo) {
    arquivo = await salvarArquivo(trx, req, { base64: b.arquivo, contexto: 'manutencao_incendio', tipos: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 10 * 1024 * 1024, filial_id: eq.filial_id });
  }
  const [m] = await trx('equipamento_manutencoes').insert({
    equipamento_id: eq.id, filial_id: eq.filial_id, tipo: b.tipo, data_servico: b.data_servico, data_proxima: proxima,
    empresa: texto(b.empresa, 160), numero_selo: texto(b.numero_selo, 60), arquivo_id: arquivo ? arquivo.id : null,
    observacao: texto(b.observacao), registrado_por: req.usuario.id
  }).returning('*');
  await auditar(trx, req, { acao: 'registrar_manutencao_incendio', tabela: 'equipamento_manutencoes', registro_id: m.id, filial_id: eq.filial_id, depois: { ...m, sha256: arquivo && arquivo.sha256 } });
  return m;
}

async function gravarInspecao(trx, req, eq, b, metodo) {
  if (!eq.ativo) throw new ErroDeNegocio(409, 'Equipamento baixado: não recebe inspeção');
  const checklist = P.EQUIPAMENTOS[eq.tipo].checklist;
  const itens = b.itens;
  if (!itens || typeof itens !== 'object' || Array.isArray(itens)) throw new ErroDeNegocio(400, 'Informe os itens do checklist (itens: { chave: true | false | null })');
  const chaves = checklist.map(([k]) => k);
  const faltando = chaves.filter((k) => !(k in itens));
  const desconhecidos = Object.keys(itens).filter((k) => !chaves.includes(k));
  const invalidos = chaves.filter((k) => k in itens && ![true, false, null].includes(itens[k]));
  if (faltando.length || desconhecidos.length || invalidos.length) {
    throw new ErroDeNegocio(400, 'Checklist incompleto ou inválido (use true, false ou null = não se aplica)', { faltando, desconhecidos, invalidos });
  }
  const conforme = !chaves.some((k) => itens[k] === false);
  const observacao = texto(b.observacao, 2000);
  if (!conforme && !observacao) throw new ErroDeNegocio(400, 'Item não conforme: descreva o problema na observação');
  if (metodo === 'manual' && (!observacao || observacao.length < 10)) {
    throw new ErroDeNegocio(400, 'Inspeção sem leitura do QR: explique na observação por que o QR não foi lido (pelo menos 10 caracteres)');
  }

  // Uma inspeção por equipamento por dia
  const ultima = await trx('equipamento_inspecoes as i').leftJoin('inspecao_anulacoes as n', 'n.inspecao_id', 'i.id')
    .whereNull('n.id').where('i.equipamento_id', eq.id).orderBy('i.data_hora', 'desc').first('i.data_hora');
  if (ultima && dataLocal(ultima.data_hora) === hoje()) throw new ErroDeNegocio(409, 'Este equipamento já foi inspecionado hoje');

  let foto = null;
  if (b.foto) {
    foto = await salvarArquivo(trx, req, { base64: b.foto, contexto: 'inspecao_incendio', tipos: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 8 * 1024 * 1024, filial_id: eq.filial_id });
  }
  const itensOrdenados = Object.fromEntries(chaves.map((k) => [k, itens[k]]));
  const [insp] = await trx('equipamento_inspecoes').insert({
    equipamento_id: eq.id, filial_id: eq.filial_id, predio_id: eq.predio_id, localizacao: eq.localizacao, metodo,
    itens: JSON.stringify(itensOrdenados), conforme, observacao, foto_id: foto ? foto.id : null, usuario_id: req.usuario.id,
    ip: req.ip || null, user_agent: texto(req.get('user-agent'), 300), codigo_verificacao: gerarCodigo()
  }).returning('*');
  await auditar(trx, req, { acao: 'inspecionar_equip_incendio', tabela: 'equipamento_inspecoes', registro_id: insp.id, filial_id: eq.filial_id, depois: insp });
  return { ...insp, identificacao: eq.identificacao, tipo: eq.tipo };
}

async function anular(req, res, { tabela, anulacoes, fk, nome, acao }) {
  const motivo = texto(req.body && req.body.motivo);
  if (!motivo || motivo.length < 5) throw new ErroDeNegocio(400, 'Informe o motivo (pelo menos 5 caracteres)');
  const resultado = await knex.transaction(async (trx) => {
    const r = idValido(req.params.id) && await trx(tabela).where({ id: req.params.id }).first();
    if (!r || !podeAcessarFilial(req, r.filial_id)) throw new ErroDeNegocio(404, `${nome} não encontrada`);
    if (await trx(anulacoes).where({ [fk]: r.id }).first('id')) throw new ErroDeNegocio(409, `${nome} já anulada`);
    const [a] = await trx(anulacoes).insert({ [fk]: r.id, motivo, usuario_id: req.usuario.id }).returning('*');
    await auditar(trx, req, { acao, tabela, registro_id: r.id, filial_id: r.filial_id, antes: r, depois: a });
    return a;
  });
  return res.status(201).json(resultado);
}

const semToken = ({ qr_token, ...resto }) => resto;  // o token só sai no QR (quem tem o QR na mão)

module.exports = {
  // GET /equipamentos-incendio?filial_id=&predio_id=&tipo=&incluir_baixados=true
  async index(req, res) {
    const q = noEscopo(knex('equipamentos_incendio as e'), req, 'e.filial_id')
      .join('predios as p', 'p.id', 'e.predio_id')
      .select('e.*', 'p.nome as predio').orderBy(['p.nome', 'e.identificacao']);
    if (req.query.filial_id) q.where('e.filial_id', req.query.filial_id);
    if (req.query.predio_id) q.where('e.predio_id', req.query.predio_id);
    if (req.query.tipo) q.where('e.tipo', req.query.tipo);
    if (req.query.incluir_baixados !== 'true') q.where('e.ativo', true);
    const lista = await P.situacaoDosEquipamentos(knex, await q);
    return res.json(lista.map(semToken));
  },

  async show(req, res) {
    const eq = await equipamentoNoEscopo(knex, req, req.params.id);
    const [comSituacao] = await P.situacaoDosEquipamentos(knex, [eq]);
    const manutencoes = await knex('equipamento_manutencoes as m').leftJoin('manutencao_anulacoes as n', 'n.manutencao_id', 'm.id')
      .where('m.equipamento_id', eq.id).select('m.*', knex.raw('(n.id is not null) as anulada'), 'n.motivo as anulacao_motivo')
      .orderBy([{ column: 'm.data_servico', order: 'desc' }, { column: 'm.id', order: 'desc' }]);
    const inspecoes = await knex('equipamento_inspecoes as i').leftJoin('inspecao_anulacoes as n', 'n.inspecao_id', 'i.id')
      .join('usuarios as u', 'u.id', 'i.usuario_id').where('i.equipamento_id', eq.id)
      .select('i.id', 'i.data_hora', 'i.metodo', 'i.localizacao', 'i.itens', 'i.conforme', 'i.observacao', 'i.foto_id', 'i.codigo_verificacao',
        'u.nome as inspetor', knex.raw('(n.id is not null) as anulada'), 'n.motivo as anulacao_motivo')
      .orderBy('i.data_hora', 'desc').limit(36);
    return res.json({ ...semToken(comSituacao), checklist: P.EQUIPAMENTOS[eq.tipo].checklist.map(([chave, descricao]) => ({ chave, descricao })), manutencoes, inspecoes });
  },

  // POST /equipamentos-incendio { predio_id, tipo, identificacao, localizacao, agente?, capacidade?, fabricante?,
  //   numero_serie?, ano_fabricacao?, manutencoes?: [{ tipo, data_servico, data_proxima?, empresa?, numero_selo? }] }
  async create(req, res) {
    exigirCampos(req.body, ['predio_id', 'tipo', 'identificacao', 'localizacao']);
    const b = req.body;
    if (!P.EQUIPAMENTOS[b.tipo]) throw new ErroDeNegocio(400, `tipo deve ser: ${Object.keys(P.EQUIPAMENTOS).join(', ')}`);
    const dados = validarCampos(b, b.tipo);
    if (b.tipo === 'extintor' && !dados.agente) throw new ErroDeNegocio(400, `Extintor: informe o agente (${Object.keys(P.AGENTES).join(', ')})`);
    if (b.manutencoes !== undefined && !Array.isArray(b.manutencoes)) throw new ErroDeNegocio(400, 'manutencoes deve ser uma lista');

    const resultado = await knex.transaction(async (trx) => {
      const predio = await predioDaFilial(trx, req, b.predio_id);
      const [eq] = await trx('equipamentos_incendio').insert({
        ...dados, filial_id: predio.filial_id, predio_id: predio.id, tipo: b.tipo, qr_token: crypto.randomUUID()
      }).returning('*');
      await auditar(trx, req, { acao: 'cadastrar_equipamento_incendio', tabela: 'equipamentos_incendio', registro_id: eq.id, filial_id: eq.filial_id, depois: eq });
      const manutencoes = [];
      for (const [i, m] of (b.manutencoes || []).entries()) {
        try { manutencoes.push(await gravarManutencao(trx, req, eq, m || {})); } catch (e) {
          if (e instanceof ErroDeNegocio) e.message = `Manutenção ${i + 1}: ${e.message}`;
          throw e;
        }
      }
      return { ...eq, manutencoes };
    });
    return res.status(201).json(semToken(resultado));
  },

  // PUT /equipamentos-incendio/:id { localizacao?, predio_id?, identificacao?, ..., ativo?: false, motivo_baixa? }
  // Mudar de lugar/prédio: operação. Baixar ou reativar: só gestão, com motivo.
  async update(req, res) {
    const b = req.body || {};
    const resultado = await knex.transaction(async (trx) => {
      const eq = await equipamentoNoEscopo(trx, req, req.params.id, { travar: true });
      const dados = validarCampos(Object.fromEntries(CAMPOS_EDITAVEIS.filter((c) => b[c] !== undefined).map((c) => [c, b[c]])), eq.tipo);
      if (eq.tipo === 'extintor' && 'agente' in dados && !dados.agente) throw new ErroDeNegocio(400, 'Extintor precisa de agente');
      if (b.predio_id !== undefined && Number(b.predio_id) !== eq.predio_id) dados.predio_id = (await predioDaFilial(trx, req, b.predio_id, eq.filial_id)).id;
      if (b.ativo !== undefined && b.ativo !== eq.ativo) {
        if (typeof b.ativo !== 'boolean') throw new ErroDeNegocio(400, 'ativo deve ser true ou false');
        if (!ehGestao(req)) throw new ErroDeNegocio(403, 'Baixar ou reativar equipamento é com a gestão');
        const motivo = texto(b.motivo_baixa);
        if (!b.ativo && (!motivo || motivo.length < 5)) throw new ErroDeNegocio(400, 'Informe o motivo da baixa (pelo menos 5 caracteres)');
        dados.ativo = b.ativo;
        dados.motivo_baixa = b.ativo ? null : motivo;
      }
      if (!Object.keys(dados).length) throw new ErroDeNegocio(400, 'Nada para alterar');
      const [depois] = await trx('equipamentos_incendio').where({ id: eq.id }).update({ ...dados, updated_at: knex.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar_equipamento_incendio', tabela: 'equipamentos_incendio', registro_id: eq.id, filial_id: eq.filial_id, antes: eq, depois });
      return depois;
    });
    return res.json(semToken(resultado));
  },

  // GET /equipamentos-incendio/:id/qrcode — PNG para imprimir e colar no equipamento
  async qrcode(req, res) {
    const eq = await equipamentoNoEscopo(knex, req, req.params.id);
    const png = await QRCode.toBuffer(eq.qr_token, { type: 'png', width: 400, margin: 2, errorCorrectionLevel: 'M' });
    res.set('Content-Disposition', `inline; filename="qr-${eq.identificacao.replace(/[^\w-]/g, '_')}.png"`);
    return res.type('image/png').send(png);
  },

  // GET /equipamentos-incendio/qr/:token — o que o inspetor vê ao ler o QR
  async buscarPorToken(req, res) {
    const eq = await porToken(knex, req, req.params.token);
    const [comSituacao] = await P.situacaoDosEquipamentos(knex, [eq]);
    const predio = await knex('predios').where({ id: eq.predio_id }).first('nome');
    return res.json({
      ...semToken(comSituacao), predio: predio.nome, nome_tipo: P.nomeDaMedida(eq.tipo), agente_nome: eq.agente ? P.AGENTES[eq.agente] : null,
      checklist: P.EQUIPAMENTOS[eq.tipo].checklist.map(([chave, descricao]) => ({ chave, descricao })),
      inspecionado_hoje: !!(comSituacao.inspecao && comSituacao.inspecao.data === hoje())
    });
  },

  // POST /equipamentos-incendio/inspecao { token, itens, observacao?, foto? }
  async inspecaoQr(req, res) {
    exigirCampos(req.body, ['token']);
    const resultado = await knex.transaction(async (trx) => gravarInspecao(trx, req, await porToken(trx, req, req.body.token, { travar: true }), req.body, 'qr'));
    return res.status(201).json(resultado);
  },

  // POST /equipamentos-incendio/:id/inspecoes { itens, observacao } — QR ilegível/arrancado: exige explicação
  async inspecaoManual(req, res) {
    const resultado = await knex.transaction(async (trx) => gravarInspecao(trx, req, await equipamentoNoEscopo(trx, req, req.params.id, { travar: true }), req.body || {}, 'manual'));
    return res.status(201).json(resultado);
  },

  // POST /equipamentos-incendio/:id/manutencoes { tipo, data_servico, data_proxima?, empresa?, numero_selo?, arquivo?, observacao? }
  async manutencao(req, res) {
    const resultado = await knex.transaction(async (trx) => {
      const eq = await equipamentoNoEscopo(trx, req, req.params.id, { travar: true });
      if (!eq.ativo) throw new ErroDeNegocio(409, 'Equipamento baixado');
      return gravarManutencao(trx, req, eq, req.body || {});
    });
    return res.status(201).json(resultado);
  },

  anularManutencao: (req, res) => anular(req, res, { tabela: 'equipamento_manutencoes', anulacoes: 'manutencao_anulacoes', fk: 'manutencao_id', nome: 'Manutenção', acao: 'anular_manutencao_incendio' }),
  anularInspecao: (req, res) => anular(req, res, { tabela: 'equipamento_inspecoes', anulacoes: 'inspecao_anulacoes', fk: 'inspecao_id', nome: 'Inspeção', acao: 'anular_inspecao_incendio' })
};
