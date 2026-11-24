// Ocorrências de SST: registro (acidente, doença, incidente, quase-acidente), vítimas, testemunhas, CAT,
// investigação com causas, conclusão, cancelamento, anexos, pendências, indicadores (NBR 14280) e PDF.
// LGPD: CID, atestado e médico só para saude/admin, como no ASO.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { podeAcessarFilial, noEscopo } = require('../utils/escopo');
const { hoje, dataValida, dataLocal } = require('../utils/datas');
const { UFS, idValido } = require('../utils/validacao');
const { salvarArquivo } = require('../utils/arquivos');
const { lerDataBase, filtrarPendencias } = require('../services/historico');
const { notificarOcorrencia } = require('../services/avisos');
const { buscarNoEscopo } = require('./FuncionarioController');
const { gerarOcorrenciaPdf } = require('../relatorios/ocorrenciaPdf');
const O = require('../services/ocorrencias');

const PERFIS_SAUDE = ['admin', 'saude'];
const veDetalhes = (req) => PERFIS_SAUDE.includes(req.usuario.perfil);
const TIPOS_ARQUIVO = ['application/pdf', 'image/jpeg', 'image/png'];

const CAMPOS_LESAO = ['parte_corpo', 'parte_corpo_codigo', 'lateralidade', 'natureza_lesao', 'natureza_lesao_codigo',
  'agente_causador', 'agente_causador_codigo', 'situacao_geradora', 'situacao_geradora_codigo'];
const CAMPOS_MEDICOS = ['atestado_data', 'atestado_hora', 'internacao', 'duracao_tratamento_dias', 'cid', 'diagnostico', 'medico_nome', 'medico_crm', 'medico_uf'];
const CAMPOS_OCORRENCIA = ['data_hora', 'predio_id', 'setor_id', 'local_descricao', 'tipo_local', 'descricao', 'atividade', 'gravidade',
  'gravidade_potencial', 'horas_trabalhadas_antes', 'comunicou_policia', 'danos_materiais'];

function texto(valor, max = 2000) {
  if (valor === undefined || valor === null) return null;
  const t = String(valor).trim();
  if (t.length > max) throw new ErroDeNegocio(400, `Texto muito longo (máximo ${max} caracteres)`);
  return t.length ? t : null;
}
const semMedicos = (v) => Object.fromEntries(Object.entries(v).filter(([k]) => !CAMPOS_MEDICOS.includes(k)));

// "2026-11-20T14:30" (hora de Brasília) ou com fuso; não pode ser no futuro
function lerDataHora(valor) {
  const s = String(valor || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(s) || !dataValida(s.slice(0, 10))) {
    throw new ErroDeNegocio(400, 'data_hora deve estar no formato AAAA-MM-DDTHH:MM');
  }
  const d = new Date(/(Z|[+-]\d{2}:\d{2})$/.test(s) ? s : `${s.length === 16 ? `${s}:00` : s}-03:00`);
  if (Number.isNaN(d.getTime())) throw new ErroDeNegocio(400, 'data_hora inválida');
  if (d.getTime() > Date.now() + 5 * 60 * 1000) throw new ErroDeNegocio(400, 'data_hora não pode ser no futuro');
  return d;
}

function lerData(valor, nome, { minima } = {}) {
  if (valor === undefined || valor === null || valor === '') return null;
  if (!dataValida(valor) || valor > hoje()) throw new ErroDeNegocio(400, `${nome} inválida ou futura`);
  if (minima && valor < minima) throw new ErroDeNegocio(400, `${nome} não pode ser antes da ocorrência`);
  return valor;
}

function lerInteiro(valor, nome) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw new ErroDeNegocio(400, `${nome} deve ser um inteiro positivo`);
  return n;
}

async function ocorrenciaNoEscopo(db, req, id, { travar = false } = {}) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'Ocorrência não encontrada');
  const q = db('ocorrencias').where({ id: Number(id) });
  if (travar) q.forUpdate();
  const o = await q.first();
  if (!o || !podeAcessarFilial(req, o.filial_id)) throw new ErroDeNegocio(404, 'Ocorrência não encontrada');
  return o;
}

function exigirEditavel(o) {
  if (o.status === 'cancelada') throw new ErroDeNegocio(409, 'Ocorrência cancelada');
  if (o.status === 'concluida') throw new ErroDeNegocio(409, 'Ocorrência concluída: a investigação está travada');
}

// Campos da ocorrência (criação ou alteração). atual = registro existente (na alteração).
async function validarOcorrencia(trx, b, { tipo, filialId, atual = {} }) {
  const d = {};
  if (b.data_hora !== undefined) d.data_hora = lerDataHora(b.data_hora);
  for (const [campo, max] of [['local_descricao', 300], ['descricao', 5000], ['atividade', 2000], ['danos_materiais', 2000]]) {
    if (b[campo] !== undefined) d[campo] = texto(b[campo], max);
  }
  if (b.tipo_local !== undefined) {
    d.tipo_local = b.tipo_local === null || b.tipo_local === '' ? null : String(b.tipo_local);
    if (d.tipo_local && !O.TIPOS_LOCAL[d.tipo_local]) throw new ErroDeNegocio(400, `tipo_local deve ser: ${Object.keys(O.TIPOS_LOCAL).join(', ')} (eSocial)`);
  }
  for (const campo of ['gravidade', 'gravidade_potencial']) {
    if (b[campo] !== undefined) {
      d[campo] = b[campo] || null;
      if (d[campo] && !O.GRAVIDADES[d[campo]]) throw new ErroDeNegocio(400, `${campo} deve ser: ${Object.keys(O.GRAVIDADES).join(', ')}`);
    }
  }
  if (b.horas_trabalhadas_antes !== undefined) {
    d.horas_trabalhadas_antes = b.horas_trabalhadas_antes || null;
    if (d.horas_trabalhadas_antes && !/^\d{2}:[0-5]\d$/.test(d.horas_trabalhadas_antes)) throw new ErroDeNegocio(400, 'horas_trabalhadas_antes no formato HH:MM');
  }
  if (b.comunicou_policia !== undefined) {
    if (b.comunicou_policia !== null && typeof b.comunicou_policia !== 'boolean') throw new ErroDeNegocio(400, 'comunicou_policia deve ser true ou false');
    d.comunicou_policia = b.comunicou_policia;
  }
  for (const [campo, tabela, nome] of [['predio_id', 'predios', 'Prédio'], ['setor_id', 'setores', 'Setor']]) {
    if (b[campo] === undefined) continue;
    if (b[campo] === null) { d[campo] = null; continue; }
    const r = idValido(b[campo]) && await trx(tabela).where({ id: Number(b[campo]) }).first('id', 'filial_id');
    if (!r || r.filial_id !== filialId) throw new ErroDeNegocio(400, `${nome} não pertence à filial da ocorrência`);
    d[campo] = r.id;
  }
  const final = { ...atual, ...d };
  if (!final.local_descricao) throw new ErroDeNegocio(400, 'local_descricao é obrigatório');
  if (!final.descricao) throw new ErroDeNegocio(400, 'descricao é obrigatória (o que aconteceu)');
  if (O.ACIDENTES.includes(tipo) && !final.gravidade) throw new ErroDeNegocio(400, 'Informe a gravidade (leve, moderada, grave, fatal)');
  if (tipo === 'quase_acidente' && final.gravidade) throw new ErroDeNegocio(400, 'Quase-acidente não tem gravidade real: use gravidade_potencial');
  return d;
}

// Vítima: monta e valida o estado final (criação ou alteração parcial)
async function validarVitima(trx, req, o, b, atual = null) {
  const medicosEnviados = CAMPOS_MEDICOS.filter((c) => b[c] !== undefined);
  if (medicosEnviados.length && !veDetalhes(req)) throw new ErroDeNegocio(403, 'Dados médicos (CID, atestado, médico) são lançados pela saúde');
  const dataOcorrencia = dataLocal(o.data_hora);
  const d = {};

  if (!atual) {
    if (!O.VINCULOS[b.vinculo]) throw new ErroDeNegocio(400, `vinculo deve ser: ${Object.keys(O.VINCULOS).join(', ')}`);
    d.vinculo = b.vinculo;
    if (b.vinculo === 'empregado') {
      const f = await buscarNoEscopo(req, b.funcionario_id, trx);
      Object.assign(d, { funcionario_id: f.id, setor_id: f.setor_id, funcao_id: f.funcao_id, nome: null });
    } else {
      d.nome = texto(b.nome, 200);
      if (!d.nome) throw new ErroDeNegocio(400, 'Informe o nome da vítima');
      d.documento = texto(b.documento, 30);
      d.empresa = texto(b.empresa, 200);
      if (b.vinculo === 'terceiro' && !d.empresa) throw new ErroDeNegocio(400, 'Terceiro: informe a empresa contratada');
    }
  }
  if (b.houve_lesao !== undefined) {
    if (typeof b.houve_lesao !== 'boolean') throw new ErroDeNegocio(400, 'houve_lesao deve ser true ou false');
    d.houve_lesao = b.houve_lesao;
  } else if (!atual) d.houve_lesao = O.ACIDENTES.includes(o.tipo);
  for (const c of CAMPOS_LESAO) if (b[c] !== undefined) d[c] = texto(b[c], 200);
  for (const c of ['houve_afastamento', 'obito', 'internacao']) {
    if (b[c] !== undefined && b[c] !== null && typeof b[c] !== 'boolean') throw new ErroDeNegocio(400, `${c} deve ser true ou false`);
    if (b[c] !== undefined) d[c] = c === 'internacao' ? b[c] : !!b[c];
  }
  if (b.data_afastamento !== undefined) d.data_afastamento = lerData(b.data_afastamento, 'data_afastamento', { minima: dataOcorrencia });
  if (b.data_retorno !== undefined) d.data_retorno = lerData(b.data_retorno, 'data_retorno', { minima: dataOcorrencia });
  if (b.data_obito !== undefined) d.data_obito = lerData(b.data_obito, 'data_obito', { minima: dataOcorrencia });
  for (const c of ['dias_perdidos', 'dias_debitados', 'duracao_tratamento_dias']) if (b[c] !== undefined) d[c] = lerInteiro(b[c], c);
  if (b.atestado_data !== undefined) d.atestado_data = lerData(b.atestado_data, 'atestado_data', { minima: dataOcorrencia });
  if (b.atestado_hora !== undefined) {
    d.atestado_hora = b.atestado_hora || null;
    if (d.atestado_hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.atestado_hora)) throw new ErroDeNegocio(400, 'atestado_hora no formato HH:MM');
  }
  if (b.cid !== undefined) {
    d.cid = texto(b.cid, 10);
    if (d.cid && !/^[A-Z]\d{2}(\.?\d{1,2})?$/i.test(d.cid)) throw new ErroDeNegocio(400, 'CID inválido (ex.: S61.0)');
    if (d.cid) d.cid = d.cid.toUpperCase();
  }
  for (const c of ['diagnostico', 'medico_nome', 'medico_crm']) if (b[c] !== undefined) d[c] = texto(b[c], c === 'diagnostico' ? 2000 : 200);
  if (b.medico_uf !== undefined) {
    d.medico_uf = b.medico_uf ? String(b.medico_uf).toUpperCase() : null;
    if (d.medico_uf && !UFS.includes(d.medico_uf)) throw new ErroDeNegocio(400, 'medico_uf inválida');
  }

  const f = { ...(atual || {}), ...d };
  if (f.lateralidade && !O.LATERALIDADES.includes(f.lateralidade)) throw new ErroDeNegocio(400, `lateralidade deve ser: ${O.LATERALIDADES.join(', ')}`);
  if (!O.ACIDENTES.includes(o.tipo) && f.houve_lesao) throw new ErroDeNegocio(400, 'Houve lesão: registre como acidente, não como incidente/quase-acidente');
  if (!f.houve_lesao && (f.houve_afastamento || f.obito || CAMPOS_LESAO.some((c) => f[c]))) {
    throw new ErroDeNegocio(400, 'Sem lesão não há parte do corpo, afastamento ou óbito');
  }
  if (f.houve_afastamento && !f.data_afastamento) throw new ErroDeNegocio(400, 'Informe data_afastamento');
  if (!f.houve_afastamento && (f.data_afastamento || f.data_retorno)) throw new ErroDeNegocio(400, 'Sem afastamento não há data de afastamento/retorno');
  if (f.data_retorno && f.data_afastamento && f.data_retorno <= f.data_afastamento) throw new ErroDeNegocio(400, 'data_retorno deve ser depois do afastamento');
  if (f.obito && !f.data_obito) throw new ErroDeNegocio(400, 'Informe data_obito');
  if (!f.obito && f.data_obito) throw new ErroDeNegocio(400, 'data_obito só com obito: true');
  if (f.obito && o.gravidade !== 'fatal') throw new ErroDeNegocio(400, 'Óbito: a gravidade da ocorrência deve ser "fatal"');
  if (f.obito && (f.dias_debitados === undefined || f.dias_debitados === null)) d.dias_debitados = O.DIAS_DEBITADOS_MORTE;
  return d;
}

async function gravarTestemunha(trx, req, o, t) {
  if (!t || typeof t !== 'object') throw new ErroDeNegocio(400, 'Testemunha inválida');
  let nome = texto(t.nome, 200);
  let funcionarioId = null;
  if (t.funcionario_id !== undefined && t.funcionario_id !== null) {
    const f = await buscarNoEscopo(req, t.funcionario_id, trx);
    funcionarioId = f.id;
    nome = nome || f.nome;
  }
  if (!nome) throw new ErroDeNegocio(400, 'Informe o nome da testemunha');
  const [nova] = await trx('ocorrencia_testemunhas').insert({
    ocorrencia_id: o.id, funcionario_id: funcionarioId, nome, contato: texto(t.contato, 200), relato: texto(t.relato, 5000), registrado_por: req.usuario.id
  }).returning('*');
  return nova;
}

// Ocorrência completa para a tela e o PDF
async function carregar(db, req, o) {
  const vitimas = await db('ocorrencia_vitimas as v').leftJoin('funcionarios as f', 'f.id', 'v.funcionario_id')
    .leftJoin('funcoes as fn', 'fn.id', 'v.funcao_id').leftJoin('setores as s', 's.id', 'v.setor_id')
    .where('v.ocorrencia_id', o.id).orderBy('v.id')
    .select('v.*', db.raw('coalesce(f.nome, v.nome) as nome_vitima'), 'f.matricula', 'fn.nome as funcao', 's.nome as setor');
  const cats = vitimas.length ? await db('cats as c').leftJoin('cat_anulacoes as n', 'n.cat_id', 'c.id').whereIn('c.vitima_id', vitimas.map((v) => v.id))
    .orderBy('c.id').select('c.id', 'c.vitima_id', 'c.tipo', 'c.numero', 'c.data_emissao', 'c.emitente', 'c.arquivo_id', 'c.observacao', 'c.created_at',
      db.raw('(n.id is not null) as anulada'), 'n.motivo as anulacao_motivo') : [];
  const dataOcorrencia = dataLocal(o.data_hora);
  const prazo = O.prazoCat(dataOcorrencia, vitimas.some((v) => v.obito));
  const testemunhas = await db('ocorrencia_testemunhas').where({ ocorrencia_id: o.id }).orderBy('id');
  const investigacao = await db('ocorrencia_investigacoes').where({ ocorrencia_id: o.id }).first();
  const causas = investigacao ? await db('ocorrencia_causas').where({ investigacao_id: investigacao.id }).orderBy(['ordem', 'id']) : [];
  const anexos = await db('ocorrencia_anexos as a').join('arquivos as ar', 'ar.id', 'a.arquivo_id').where('a.ocorrencia_id', o.id).orderBy('a.id')
    .select('a.id', 'a.descricao', 'a.created_at', 'ar.tipo_mime', 'ar.sha256');
  const [situacao] = await O.situacaoOcorrencias(db, req, { filial_id: o.filial_id, ocorrencia_id: o.id });
  const filial = await db('filiais').where({ id: o.filial_id }).first('nome', 'razao_social', 'cnpj', 'cidade', 'uf');
  const predio = o.predio_id ? await db('predios').where({ id: o.predio_id }).first('nome') : null;
  const setor = o.setor_id ? await db('setores').where({ id: o.setor_id }).first('nome') : null;
  return {
    ...o, numero: O.numero(o), filial: filial.nome, filial_dados: filial, predio: predio && predio.nome, setor: setor && setor.nome,
    situacao: situacao ? situacao.situacao : (o.status === 'cancelada' ? 'cancelada' : 'em_dia'),
    prazo_cat: O.EXIGE_CAT.includes(o.tipo) ? prazo : null,
    vitimas: vitimas.map((v) => {
      const linha = { ...v, dias_perdidos_calculados: O.diasPerdidos(v, hoje()), cats: cats.filter((c) => c.vitima_id === v.id)
        .map((c) => ({ ...c, no_prazo: c.data_emissao <= prazo })) };
      return veDetalhes(req) ? linha : semMedicos(linha);
    }),
    testemunhas,
    investigacao: investigacao ? { ...investigacao, causas } : null,
    anexos
  };
}

module.exports = {
  // GET /ocorrencias?filial_id=&tipo=&status=&de=&ate=
  async index(req, res) {
    const q = noEscopo(knex('ocorrencias as o'), req, 'o.filial_id').join('filiais as f', 'f.id', 'o.filial_id')
      .orderBy('o.data_hora', 'desc').limit(500)
      .select('o.id', 'o.filial_id', 'f.nome as filial', 'o.ano', 'o.sequencial', 'o.tipo', 'o.data_hora', 'o.local_descricao', 'o.gravidade',
        'o.gravidade_potencial', 'o.status', 'o.legado',
        knex.raw('(select count(*)::int from ocorrencia_vitimas v where v.ocorrencia_id = o.id) as vitimas'));
    if (req.query.filial_id) q.where('o.filial_id', req.query.filial_id);
    if (req.query.tipo) q.where('o.tipo', req.query.tipo);
    if (req.query.status) q.where('o.status', req.query.status);
    if (req.query.de && dataValida(req.query.de)) q.where('o.data_hora', '>=', new Date(`${req.query.de}T00:00:00-03:00`));
    if (req.query.ate && dataValida(req.query.ate)) q.where('o.data_hora', '<', new Date(`${req.query.ate}T23:59:59.999-03:00`));
    return res.json((await q).map((o) => ({ ...o, numero: O.numero(o) })));
  },

  async show(req, res) {
    const o = await ocorrenciaNoEscopo(knex, req, req.params.id);
    return res.json(await carregar(knex, req, o));
  },

  // POST /ocorrencias { filial_id, tipo, data_hora, local_descricao, descricao, gravidade?, ..., vitimas: [], testemunhas: [] }
  async create(req, res) {
    const b = req.body || {};
    if (!idValido(b.filial_id) || !podeAcessarFilial(req, b.filial_id)) throw new ErroDeNegocio(404, 'Filial não encontrada');
    if (!O.TIPOS[b.tipo]) throw new ErroDeNegocio(400, `tipo deve ser: ${Object.keys(O.TIPOS).join(', ')}`);
    if (!b.data_hora) throw new ErroDeNegocio(400, 'data_hora é obrigatória');
    const vitimas = b.vitimas === undefined ? [] : b.vitimas;
    const testemunhas = b.testemunhas === undefined ? [] : b.testemunhas;
    if (!Array.isArray(vitimas) || !Array.isArray(testemunhas)) throw new ErroDeNegocio(400, 'vitimas e testemunhas devem ser listas');
    if (O.ACIDENTES.includes(b.tipo) && !vitimas.length) throw new ErroDeNegocio(400, 'Acidente ou doença: informe a vítima');

    const resultado = await knex.transaction(async (trx) => {
      const filial = await trx('filiais').where({ id: Number(b.filial_id) }).forUpdate().first('id', 'nome'); // numeração sem repetir
      if (!filial) throw new ErroDeNegocio(404, 'Filial não encontrada');
      const dados = await validarOcorrencia(trx, b, { tipo: b.tipo, filialId: filial.id });
      const ano = Number(dataLocal(dados.data_hora).slice(0, 4));
      const { max } = await trx('ocorrencias').where({ filial_id: filial.id, ano }).max({ max: 'sequencial' }).first();
      const [o] = await trx('ocorrencias').insert({ ...dados, filial_id: filial.id, tipo: b.tipo, ano, sequencial: (max || 0) + 1, registrado_por: req.usuario.id }).returning('*');

      const gravadas = [];
      for (const [i, v] of vitimas.entries()) {
        try {
          const dv = await validarVitima(trx, req, o, v || {});
          const [nova] = await trx('ocorrencia_vitimas').insert({ ...dv, ocorrencia_id: o.id }).returning('*');
          gravadas.push(nova);
        } catch (e) {
          if (e instanceof ErroDeNegocio) e.message = `Vítima ${i + 1}: ${e.message}`;
          throw e;
        }
      }
      if (O.ACIDENTES.includes(o.tipo) && !gravadas.some((v) => v.houve_lesao)) throw new ErroDeNegocio(400, 'Acidente ou doença: ao menos uma vítima com lesão');
      if (gravadas.filter((v) => v.funcionario_id).length !== new Set(gravadas.filter((v) => v.funcionario_id).map((v) => v.funcionario_id)).size) {
        throw new ErroDeNegocio(400, 'O mesmo funcionário aparece duas vezes como vítima');
      }
      for (const [i, t] of testemunhas.entries()) {
        try { await gravarTestemunha(trx, req, o, t); } catch (e) {
          if (e instanceof ErroDeNegocio) e.message = `Testemunha ${i + 1}: ${e.message}`;
          throw e;
        }
      }
      await auditar(trx, req, { acao: 'registrar_ocorrencia', tabela: 'ocorrencias', registro_id: o.id, filial_id: o.filial_id,
        depois: { ...o, vitimas: gravadas.map(semMedicos) } });
      return { o, filial, gravadas };
    });

    const completo = await carregar(knex, req, resultado.o);
    // Aviso imediato: prazo da CAT é curto (1º dia útil) — falha de e-mail não desfaz o registro
    try { await notificarOcorrencia(knex, completo); } catch (erro) { console.warn(`Aviso da ocorrência não enviado: ${erro.message}`); }
    return res.status(201).json(completo);
  },

  // PUT /ocorrencias/:id — corrige os dados enquanto a investigação está aberta (o tipo não muda: cancele e registre de novo)
  async update(req, res) {
    const b = req.body || {};
    if (b.tipo !== undefined || b.filial_id !== undefined) throw new ErroDeNegocio(400, 'Tipo e filial não mudam: cancele e registre de novo');
    await knex.transaction(async (trx) => {
      const o = await ocorrenciaNoEscopo(trx, req, req.params.id, { travar: true });
      exigirEditavel(o);
      const dados = await validarOcorrencia(trx, Object.fromEntries(CAMPOS_OCORRENCIA.filter((c) => b[c] !== undefined).map((c) => [c, b[c]])),
        { tipo: o.tipo, filialId: o.filial_id, atual: o });
      if (!Object.keys(dados).length) throw new ErroDeNegocio(400, 'Nada para alterar');
      if (dados.data_hora && dataLocal(dados.data_hora).slice(0, 4) !== String(o.ano)) throw new ErroDeNegocio(400, 'A data não pode mudar de ano (a numeração é por ano)');
      if (dados.gravidade !== undefined && dados.gravidade !== 'fatal' && await trx('ocorrencia_vitimas').where({ ocorrencia_id: o.id, obito: true }).first('id')) {
        throw new ErroDeNegocio(400, 'Há vítima com óbito: a gravidade deve continuar "fatal"');
      }
      const [depois] = await trx('ocorrencias').where({ id: o.id }).update({ ...dados, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar_ocorrencia', tabela: 'ocorrencias', registro_id: o.id, filial_id: o.filial_id, antes: o, depois });
    });
    return res.json(await carregar(knex, req, await ocorrenciaNoEscopo(knex, req, req.params.id)));
  },

  // POST /ocorrencias/:id/vitimas — vítima identificada depois
  async adicionarVitima(req, res) {
    const nova = await knex.transaction(async (trx) => {
      const o = await ocorrenciaNoEscopo(trx, req, req.params.id, { travar: true });
      exigirEditavel(o);
      const dv = await validarVitima(trx, req, o, req.body || {});
      if (dv.funcionario_id && await trx('ocorrencia_vitimas').where({ ocorrencia_id: o.id, funcionario_id: dv.funcionario_id }).first('id')) {
        throw new ErroDeNegocio(409, 'Este funcionário já é vítima nesta ocorrência');
      }
      const [v] = await trx('ocorrencia_vitimas').insert({ ...dv, ocorrencia_id: o.id }).returning('*');
      await auditar(trx, req, { acao: 'incluir_vitima', tabela: 'ocorrencia_vitimas', registro_id: v.id, filial_id: o.filial_id, depois: semMedicos(v) });
      return v;
    });
    return res.status(201).json(veDetalhes(req) ? nova : semMedicos(nova));
  },

  // PUT /ocorrencia-vitimas/:id — lesão, afastamento/retorno, óbito e (saude) dados médicos. Vale mesmo depois de concluída.
  async alterarVitima(req, res) {
    const b = { ...(req.body || {}) };
    if (b.vinculo !== undefined || b.funcionario_id !== undefined) throw new ErroDeNegocio(400, 'Vínculo e funcionário não mudam: inclua outra vítima');
    const depois = await knex.transaction(async (trx) => {
      const v = idValido(req.params.id) && await trx('ocorrencia_vitimas').where({ id: Number(req.params.id) }).forUpdate().first();
      if (!v) throw new ErroDeNegocio(404, 'Vítima não encontrada');
      const o = await ocorrenciaNoEscopo(trx, req, v.ocorrencia_id).catch(() => { throw new ErroDeNegocio(404, 'Vítima não encontrada'); });
      if (o.status === 'cancelada') throw new ErroDeNegocio(409, 'Ocorrência cancelada');
      if (o.status === 'concluida' && (b.houve_lesao !== undefined || CAMPOS_LESAO.some((c) => b[c] !== undefined))) {
        throw new ErroDeNegocio(409, 'Ocorrência concluída: só afastamento, retorno, óbito e dados médicos podem ser atualizados');
      }
      const dv = await validarVitima(trx, req, o, b, v);
      if (!Object.keys(dv).length) throw new ErroDeNegocio(400, 'Nada para alterar');
      const [novo] = await trx('ocorrencia_vitimas').where({ id: v.id }).update({ ...dv, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar_vitima', tabela: 'ocorrencia_vitimas', registro_id: v.id, filial_id: o.filial_id,
        antes: semMedicos(v), depois: { ...semMedicos(novo), ...(CAMPOS_MEDICOS.some((c) => b[c] !== undefined) ? { dados_medicos: '[alterados]' } : {}) } });
      return novo;
    });
    return res.json(veDetalhes(req) ? depois : semMedicos(depois));
  },

  // POST /ocorrencias/:id/testemunhas { nome | funcionario_id, contato?, relato? }
  async adicionarTestemunha(req, res) {
    const nova = await knex.transaction(async (trx) => {
      const o = await ocorrenciaNoEscopo(trx, req, req.params.id);
      if (o.status === 'cancelada') throw new ErroDeNegocio(409, 'Ocorrência cancelada');
      const t = await gravarTestemunha(trx, req, o, req.body || {});
      await auditar(trx, req, { acao: 'incluir_testemunha', tabela: 'ocorrencia_testemunhas', registro_id: t.id, filial_id: o.filial_id, depois: t });
      return t;
    });
    return res.status(201).json(nova);
  },

  // PUT /ocorrencias/:id/investigacao { metodo, equipe: [..], data_inicio?, descricao_fatos?, causas: [{ tipo, categoria, descricao }], conclusao?, medidas_recomendadas?: [..] }
  async salvarInvestigacao(req, res) {
    const b = req.body || {};
    if (!O.METODOS[b.metodo]) throw new ErroDeNegocio(400, `metodo deve ser: ${Object.keys(O.METODOS).join(', ')}`);
    if (!Array.isArray(b.equipe) || !b.equipe.length || !b.equipe.every((e) => texto(e, 200))) throw new ErroDeNegocio(400, 'equipe: lista com quem investigou (nome e função)');
    const causas = b.causas === undefined ? [] : b.causas;
    if (!Array.isArray(causas)) throw new ErroDeNegocio(400, 'causas deve ser uma lista');
    const lidas = causas.map((c, i) => {
      if (!c || !O.TIPOS_CAUSA[c.tipo]) throw new ErroDeNegocio(400, `Causa ${i + 1}: tipo deve ser ${Object.keys(O.TIPOS_CAUSA).join(', ')}`);
      if (!O.CATEGORIAS_CAUSA[c.categoria]) throw new ErroDeNegocio(400, `Causa ${i + 1}: categoria deve ser ${Object.keys(O.CATEGORIAS_CAUSA).join(', ')}`);
      const descricao = texto(c.descricao, 2000);
      if (!descricao) throw new ErroDeNegocio(400, `Causa ${i + 1}: descreva a causa`);
      return { tipo: c.tipo, categoria: c.categoria, descricao, ordem: i };
    });
    const medidas = b.medidas_recomendadas === undefined ? [] : b.medidas_recomendadas;
    if (!Array.isArray(medidas) || !medidas.every((m) => texto(m, 1000))) throw new ErroDeNegocio(400, 'medidas_recomendadas: lista de textos');
    const resultado = await knex.transaction(async (trx) => {
      const o = await ocorrenciaNoEscopo(trx, req, req.params.id, { travar: true });
      exigirEditavel(o);
      const dataInicio = b.data_inicio ? lerData(b.data_inicio, 'data_inicio', { minima: dataLocal(o.data_hora) }) : hoje();
      const dados = {
        metodo: b.metodo, equipe: JSON.stringify(b.equipe.map((e) => texto(e, 200))), data_inicio: dataInicio,
        descricao_fatos: texto(b.descricao_fatos, 10000), conclusao: texto(b.conclusao, 10000),
        medidas_recomendadas: JSON.stringify(medidas.map((m) => texto(m, 1000))), responsavel_id: req.usuario.id
      };
      const antes = await trx('ocorrencia_investigacoes').where({ ocorrencia_id: o.id }).first();
      let inv;
      if (antes) {
        [inv] = await trx('ocorrencia_investigacoes').where({ id: antes.id }).update({ ...dados, updated_at: trx.fn.now() }).returning('*');
        await trx('ocorrencia_causas').where({ investigacao_id: inv.id }).del();
      } else {
        [inv] = await trx('ocorrencia_investigacoes').insert({ ...dados, ocorrencia_id: o.id }).returning('*');
      }
      if (lidas.length) await trx('ocorrencia_causas').insert(lidas.map((c) => ({ ...c, investigacao_id: inv.id })));
      if (o.status === 'aberta') await trx('ocorrencias').where({ id: o.id }).update({ status: 'em_investigacao', updated_at: trx.fn.now() });
      await auditar(trx, req, { acao: 'salvar_investigacao', tabela: 'ocorrencia_investigacoes', registro_id: inv.id, filial_id: o.filial_id, antes, depois: { ...inv, causas: lidas } });
      return o;
    });
    return res.json(await carregar(knex, req, await ocorrenciaNoEscopo(knex, req, resultado.id)));
  },

  // POST /ocorrencias/:id/concluir — exige causas, conclusão e a CAT de cada vítima empregada
  async concluir(req, res) {
    await knex.transaction(async (trx) => {
      const o = await ocorrenciaNoEscopo(trx, req, req.params.id, { travar: true });
      exigirEditavel(o);
      const inv = await trx('ocorrencia_investigacoes').where({ ocorrencia_id: o.id }).first();
      if (!inv) throw new ErroDeNegocio(409, 'Registre a investigação antes de concluir');
      if (!(await trx('ocorrencia_causas').where({ investigacao_id: inv.id }).first('id'))) throw new ErroDeNegocio(409, 'A investigação precisa apontar ao menos uma causa');
      if (!inv.conclusao) throw new ErroDeNegocio(409, 'Escreva a conclusão da investigação');
      if (O.EXIGE_CAT.includes(o.tipo)) {
        const semCat = await trx('ocorrencia_vitimas as v').leftJoin('funcionarios as f', 'f.id', 'v.funcionario_id')
          .where({ 'v.ocorrencia_id': o.id, 'v.vinculo': 'empregado' }).andWhere((w) => w.where('v.houve_lesao', true).orWhere('v.obito', true))
          .whereNotExists(trx('cats as c').leftJoin('cat_anulacoes as n', 'n.cat_id', 'c.id').whereRaw('c.vitima_id = v.id').whereNull('n.id').whereIn('c.tipo', ['inicial', 'obito']))
          .pluck('f.nome');
        if (semCat.length) throw new ErroDeNegocio(409, `Registre a CAT antes de concluir: ${semCat.join(', ')}`);
      }
      const [depois] = await trx('ocorrencias').where({ id: o.id })
        .update({ status: 'concluida', concluida_em: trx.fn.now(), concluida_por: req.usuario.id, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'concluir_ocorrencia', tabela: 'ocorrencias', registro_id: o.id, filial_id: o.filial_id, antes: o, depois });
    });
    return res.json(await carregar(knex, req, await ocorrenciaNoEscopo(knex, req, req.params.id)));
  },

  // POST /ocorrencias/:id/cancelar { motivo } — gestão; registro indevido (nada é apagado)
  async cancelar(req, res) {
    const motivo = texto(req.body && req.body.motivo, 2000);
    if (!motivo || motivo.length < 10) throw new ErroDeNegocio(400, 'Informe o motivo do cancelamento (pelo menos 10 caracteres)');
    await knex.transaction(async (trx) => {
      const o = await ocorrenciaNoEscopo(trx, req, req.params.id, { travar: true });
      if (o.status === 'cancelada') throw new ErroDeNegocio(409, 'Ocorrência já cancelada');
      const catValida = await trx('cats as c').join('ocorrencia_vitimas as v', 'v.id', 'c.vitima_id').leftJoin('cat_anulacoes as n', 'n.cat_id', 'c.id')
        .where('v.ocorrencia_id', o.id).whereNull('n.id').first('c.id');
      if (catValida) throw new ErroDeNegocio(409, 'Há CAT registrada: anule a CAT antes de cancelar a ocorrência');
      const [depois] = await trx('ocorrencias').where({ id: o.id })
        .update({ status: 'cancelada', motivo_cancelamento: motivo, cancelada_em: trx.fn.now(), updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'cancelar_ocorrencia', tabela: 'ocorrencias', registro_id: o.id, filial_id: o.filial_id, antes: o, depois });
    });
    return res.json(await carregar(knex, req, await ocorrenciaNoEscopo(knex, req, req.params.id)));
  },

  // POST /ocorrencia-vitimas/:id/cats { tipo, numero, data_emissao, emitente?, arquivo?, observacao? }
  async registrarCat(req, res) {
    const b = req.body || {};
    if (!O.TIPOS_CAT[b.tipo]) throw new ErroDeNegocio(400, `tipo deve ser: ${Object.keys(O.TIPOS_CAT).join(', ')}`);
    const numeroCat = texto(b.numero, 40);
    if (!numeroCat) throw new ErroDeNegocio(400, 'Informe o número da CAT (ou do recibo do eSocial)');
    const emitente = b.emitente || 'empregador';
    if (!O.EMITENTES.includes(emitente)) throw new ErroDeNegocio(400, `emitente deve ser: ${O.EMITENTES.join(', ')}`);
    const cat = await knex.transaction(async (trx) => {
      const v = idValido(req.params.id) && await trx('ocorrencia_vitimas').where({ id: Number(req.params.id) }).forUpdate().first();
      if (!v) throw new ErroDeNegocio(404, 'Vítima não encontrada');
      const o = await ocorrenciaNoEscopo(trx, req, v.ocorrencia_id).catch(() => { throw new ErroDeNegocio(404, 'Vítima não encontrada'); });
      if (o.status === 'cancelada') throw new ErroDeNegocio(409, 'Ocorrência cancelada');
      if (!O.EXIGE_CAT.includes(o.tipo)) throw new ErroDeNegocio(400, 'Incidente e quase-acidente não têm CAT');
      if (v.vinculo !== 'empregado') throw new ErroDeNegocio(400, 'CAT é do empregado: terceiro, estudante e visitante não têm CAT da empresa');
      const dataEmissao = lerData(b.data_emissao, 'data_emissao', { minima: dataLocal(o.data_hora) });
      if (!dataEmissao) throw new ErroDeNegocio(400, 'data_emissao é obrigatória');
      const validas = await trx('cats as c').leftJoin('cat_anulacoes as n', 'n.cat_id', 'c.id').where('c.vitima_id', v.id).whereNull('n.id').pluck('c.tipo');
      if (b.tipo === 'inicial' && validas.includes('inicial')) throw new ErroDeNegocio(409, 'Já há CAT inicial: use reabertura ou óbito');
      if (b.tipo === 'reabertura' && !validas.includes('inicial')) throw new ErroDeNegocio(409, 'Reabertura precisa de uma CAT inicial');
      if (b.tipo === 'obito' && !v.obito) throw new ErroDeNegocio(409, 'CAT de óbito: registre o óbito na vítima primeiro');
      if (b.tipo === 'obito' && validas.includes('obito')) throw new ErroDeNegocio(409, 'Já há CAT de óbito');
      const arquivo = b.arquivo ? await salvarArquivo(trx, req, { base64: b.arquivo, contexto: 'cat', tipos: TIPOS_ARQUIVO, maxBytes: 10 * 1024 * 1024, filial_id: o.filial_id, funcionario_id: v.funcionario_id }) : null;
      const [nova] = await trx('cats').insert({
        vitima_id: v.id, filial_id: o.filial_id, tipo: b.tipo, numero: numeroCat, data_emissao: dataEmissao, emitente,
        arquivo_id: arquivo ? arquivo.id : null, observacao: texto(b.observacao, 2000), registrado_por: req.usuario.id
      }).returning('*');
      await auditar(trx, req, { acao: 'registrar_cat', tabela: 'cats', registro_id: nova.id, filial_id: o.filial_id, depois: { ...nova, sha256: arquivo && arquivo.sha256 } });
      const prazo = O.prazoCat(dataLocal(o.data_hora), v.obito);
      return { ...nova, no_prazo: dataEmissao <= prazo, prazo };
    });
    return res.status(201).json(cat);
  },

  // POST /cats/:id/anular { motivo } — gestão
  async anularCat(req, res) {
    const motivo = texto(req.body && req.body.motivo, 2000);
    if (!motivo || motivo.length < 5) throw new ErroDeNegocio(400, 'Informe o motivo (pelo menos 5 caracteres)');
    const a = await knex.transaction(async (trx) => {
      const c = idValido(req.params.id) && await trx('cats').where({ id: Number(req.params.id) }).first();
      if (!c || !podeAcessarFilial(req, c.filial_id)) throw new ErroDeNegocio(404, 'CAT não encontrada');
      if (await trx('cat_anulacoes').where({ cat_id: c.id }).first('id')) throw new ErroDeNegocio(409, 'CAT já anulada');
      const [an] = await trx('cat_anulacoes').insert({ cat_id: c.id, motivo, usuario_id: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'anular_cat', tabela: 'cats', registro_id: c.id, filial_id: c.filial_id, antes: c, depois: an });
      return an;
    });
    return res.status(201).json(a);
  },

  // GET /cats/:id/arquivo
  async arquivoCat(req, res) {
    const c = idValido(req.params.id) && await knex('cats').where({ id: Number(req.params.id) }).first();
    if (!c || !podeAcessarFilial(req, c.filial_id) || !c.arquivo_id) throw new ErroDeNegocio(404, 'Arquivo não encontrado');
    const arq = await knex('arquivos').where({ id: c.arquivo_id }).first();
    await auditar(knex, req, { acao: 'baixar_cat', tabela: 'cats', registro_id: c.id, filial_id: c.filial_id });
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Arquivo-SHA256', arq.sha256);
    res.set('Cache-Control', 'no-store');
    return res.type(arq.tipo_mime).send(arq.conteudo);
  },

  // POST /ocorrencias/:id/anexos { arquivo, descricao } — fotos do local, laudos, boletim de ocorrência...
  async anexar(req, res) {
    const descricao = texto(req.body && req.body.descricao, 300);
    if (!descricao) throw new ErroDeNegocio(400, 'Descreva o anexo');
    if (!req.body.arquivo) throw new ErroDeNegocio(400, 'arquivo é obrigatório');
    const anexo = await knex.transaction(async (trx) => {
      const o = await ocorrenciaNoEscopo(trx, req, req.params.id);
      if (o.status === 'cancelada') throw new ErroDeNegocio(409, 'Ocorrência cancelada');
      const arq = await salvarArquivo(trx, req, { base64: req.body.arquivo, contexto: 'ocorrencia', tipos: TIPOS_ARQUIVO, maxBytes: 10 * 1024 * 1024, filial_id: o.filial_id });
      const [a] = await trx('ocorrencia_anexos').insert({ ocorrencia_id: o.id, arquivo_id: arq.id, descricao, registrado_por: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'anexar_ocorrencia', tabela: 'ocorrencia_anexos', registro_id: a.id, filial_id: o.filial_id, depois: { ...a, sha256: arq.sha256 } });
      return { ...a, sha256: arq.sha256 };
    });
    return res.status(201).json(anexo);
  },

  // GET /ocorrencia-anexos/:id
  async anexo(req, res) {
    const a = idValido(req.params.id) && await knex('ocorrencia_anexos').where({ id: Number(req.params.id) }).first();
    if (!a) throw new ErroDeNegocio(404, 'Anexo não encontrado');
    await ocorrenciaNoEscopo(knex, req, a.ocorrencia_id).catch(() => { throw new ErroDeNegocio(404, 'Anexo não encontrado'); });
    const arq = await knex('arquivos').where({ id: a.arquivo_id }).first();
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Arquivo-SHA256', arq.sha256);
    return res.type(arq.tipo_mime).send(arq.conteudo);
  },

  // GET /ocorrencias/pendencias?filial_id=&situacao=&todas=true&data_base=
  async pendencias(req, res) {
    const { dataBase } = lerDataBase(req.query);
    const itens = await O.situacaoOcorrencias(knex, req, req.query, { dataBase });
    return res.json({ data_base: dataBase || hoje(), ...filtrarPendencias(itens, O.SITUACOES, req.query, { emDia: (i) => ['em_dia', 'em_investigacao'].includes(i.situacao) }) });
  },

  // GET /ocorrencias/indicadores?ano=&filial_id= — NBR 14280
  async indicadores(req, res) {
    const ano = req.query.ano !== undefined ? Number(req.query.ano) : Number(hoje().slice(0, 4));
    if (!Number.isInteger(ano) || ano < 2000 || ano > Number(hoje().slice(0, 4))) throw new ErroDeNegocio(400, 'ano inválido');
    const q = noEscopo(knex('filiais'), req, 'id').where('ativa', true).orderBy('nome').select('id', 'nome');
    if (req.query.filial_id !== undefined) {
      if (!idValido(req.query.filial_id) || !podeAcessarFilial(req, req.query.filial_id)) throw new ErroDeNegocio(404, 'Filial não encontrada');
      q.where('id', Number(req.query.filial_id));
    }
    return res.json({ ano, horas_mes_padrao: O.HORAS_MES_PADRAO, filiais: await O.indicadores(knex, await q, ano) });
  },

  // PUT /horas-trabalhadas { filial_id, competencia: 'AAAA-MM', horas } — gestão
  async definirHoras(req, res) {
    const { filial_id: filialId, competencia, horas } = req.body || {};
    if (!idValido(filialId) || !podeAcessarFilial(req, filialId)) throw new ErroDeNegocio(404, 'Filial não encontrada');
    if (typeof competencia !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(competencia) || competencia > hoje().slice(0, 7)) {
      throw new ErroDeNegocio(400, 'competencia no formato AAAA-MM (até o mês atual)');
    }
    const h = Number(horas);
    if (!Number.isFinite(h) || h <= 0 || h > 1e9) throw new ErroDeNegocio(400, 'horas deve ser um número positivo');
    const registro = await knex.transaction(async (trx) => {
      const antes = await trx('horas_trabalhadas').where({ filial_id: Number(filialId), competencia }).first();
      const [r] = antes
        ? await trx('horas_trabalhadas').where({ id: antes.id }).update({ horas: h, informado_por: req.usuario.id, updated_at: trx.fn.now() }).returning('*')
        : await trx('horas_trabalhadas').insert({ filial_id: Number(filialId), competencia, horas: h, informado_por: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'informar_horas', tabela: 'horas_trabalhadas', registro_id: r.id, filial_id: r.filial_id, antes, depois: r });
      return r;
    });
    return res.json({ ...registro, horas: Number(registro.horas) });
  },

  // GET /horas-trabalhadas?filial_id=&ano=
  async horas(req, res) {
    const ano = String(req.query.ano || hoje().slice(0, 4));
    const q = noEscopo(knex('horas_trabalhadas'), req, 'filial_id').where('competencia', 'like', `${ano}-%`).orderBy(['filial_id', 'competencia']);
    if (req.query.filial_id) q.where('filial_id', req.query.filial_id);
    return res.json((await q).map((r) => ({ ...r, horas: Number(r.horas) })));
  },

  // GET /ocorrencias/:id/pdf — relatório da ocorrência e da investigação
  async pdf(req, res) {
    const o = await ocorrenciaNoEscopo(knex, req, req.params.id);
    const completo = await carregar(knex, req, o);
    const doc = gerarOcorrenciaPdf({ ocorrencia: completo, comDadosMedicos: veDetalhes(req), emitidoPor: req.usuario.nome });
    await auditar(knex, req, { acao: 'emitir_pdf_ocorrencia', tabela: 'ocorrencias', registro_id: o.id, filial_id: o.filial_id });
    res.type('application/pdf');
    res.set('Content-Disposition', `inline; filename="ocorrencia-${completo.numero.replace('/', '-')}.pdf"`);
    doc.pipe(res);
  }
};
