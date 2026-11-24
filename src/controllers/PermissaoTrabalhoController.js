// Permissão de trabalho: conferir participantes, emitir (recusa quem não pode), assinatura de cada participante
// pelo crachá (QR + PIN), medições de atmosfera (fora do limite suspende), encerramento, cancelamento, PDF e pendências.
const QRCode = require('qrcode');
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { podeAcessarFilial, noEscopo } = require('../utils/escopo');
const { hoje, dataLocal, dataValida } = require('../utils/datas');
const { idValido } = require('../utils/validacao');
const { gerarCodigo } = require('../utils/codigo');
const { conferirPin } = require('../services/pin');
const { lerDataBase, filtrarPendencias } = require('../services/historico');
const { buscarNoEscopo } = require('./FuncionarioController');
const { gerarPermissaoPdf } = require('../relatorios/permissaoPdf');
const P = require('../services/permissoes');

function texto(valor, max = 2000) {
  if (valor === undefined || valor === null) return null;
  const t = String(valor).trim();
  if (t.length > max) throw new ErroDeNegocio(400, `Texto muito longo (máximo ${max} caracteres)`);
  return t.length ? t : null;
}

// "2026-11-24T08:00" (Brasília) ou com fuso
function lerInstante(valor, nome) {
  const s = String(valor || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(s) || !dataValida(s.slice(0, 10))) {
    throw new ErroDeNegocio(400, `${nome} deve estar no formato AAAA-MM-DDTHH:MM`);
  }
  const d = new Date(/(Z|[+-]\d{2}:\d{2})$/.test(s) ? s : `${s.length === 16 ? `${s}:00` : s}-03:00`);
  if (Number.isNaN(d.getTime())) throw new ErroDeNegocio(400, `${nome} inválido`);
  return d;
}

function lerPeriodo(b) {
  const inicio = lerInstante(b.inicio, 'inicio');
  const fim = lerInstante(b.fim, 'fim');
  const agora = Date.now();
  if (inicio.getTime() < agora - 60 * 60 * 1000) throw new ErroDeNegocio(400, 'inicio não pode ser mais de 1 hora no passado');
  if (inicio.getTime() > agora + 7 * 24 * 60 * 60 * 1000) throw new ErroDeNegocio(400, 'inicio: no máximo 7 dias à frente');
  if (fim <= inicio) throw new ErroDeNegocio(400, 'fim deve ser depois do início');
  if (fim - inicio > P.VALIDADE_MAX_HORAS * 60 * 60 * 1000) throw new ErroDeNegocio(400, `A permissão vale no máximo ${P.VALIDADE_MAX_HORAS} horas (um turno)`);
  return { inicio, fim };
}

// Lê e valida a lista de participantes conforme os papéis do tipo
async function lerParticipantes(db, req, tipo, lista) {
  const config = P.TIPOS[tipo];
  if (!Array.isArray(lista) || !lista.length) throw new ErroDeNegocio(400, 'Informe os participantes');
  const lidos = [];
  for (const [i, p] of lista.entries()) {
    if (!p || !config.papeis[p.papel]) throw new ErroDeNegocio(400, `Participante ${i + 1}: papel deve ser ${Object.keys(config.papeis).join(', ')}`);
    if (p.terceiro_trabalhador_id !== undefined && p.terceiro_trabalhador_id !== null) {
      // Terceirizado: a conferência exige contrato ativo na filial com ele alocado
      const t = idValido(p.terceiro_trabalhador_id) && await db('terceiro_trabalhadores').where({ id: Number(p.terceiro_trabalhador_id) }).first();
      if (!t) throw new ErroDeNegocio(400, `Participante ${i + 1}: terceirizado não encontrado`);
      if (lidos.some((x) => x.terceiro && x.terceiro.id === t.id)) throw new ErroDeNegocio(400, `${t.nome} aparece duas vezes: cada pessoa tem um papel só`);
      lidos.push({ terceiro: t, papel: p.papel });
      continue;
    }
    const f = await buscarNoEscopo(req, p.funcionario_id, db).catch(() => { throw new ErroDeNegocio(400, `Participante ${i + 1}: funcionário não encontrado`); });
    if (lidos.some((x) => x.funcionario && x.funcionario.id === f.id)) throw new ErroDeNegocio(400, `${f.nome} aparece duas vezes: cada pessoa tem um papel só`);
    lidos.push({ funcionario: f, papel: p.papel });
  }
  for (const [papel, minimo] of Object.entries(config.papeis)) {
    if (lidos.filter((p) => p.papel === papel).length < minimo) throw new ErroDeNegocio(400, `${config.nome}: é preciso pelo menos ${minimo} ${P.PAPEIS[papel].toLowerCase()}`);
  }
  return lidos;
}

function lerChecklist(tipo, checklist, medidas) {
  const itens = P.TIPOS[tipo].checklist;
  if (!checklist || typeof checklist !== 'object') throw new ErroDeNegocio(400, 'Responda o checklist da permissão');
  const lido = {};
  for (const [chave, descricao] of itens) {
    const v = checklist[chave];
    if (v === undefined) throw new ErroDeNegocio(400, `Checklist: responda "${descricao}"`);
    if (v === false) throw new ErroDeNegocio(409, `Checklist: "${descricao}" não está atendido. Corrija antes de emitir a permissão.`);
    if (v !== true && v !== null) throw new ErroDeNegocio(400, `Checklist: "${descricao}" deve ser true (sim) ou null (não se aplica)`);
    lido[chave] = v;
  }
  if (Object.values(lido).includes(null) && !medidas) throw new ErroDeNegocio(400, 'Há item marcado como "não se aplica": explique em medidas_adicionais');
  return lido;
}

async function ptNoEscopo(db, req, id, { travar = false } = {}) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'Permissão não encontrada');
  const q = db('permissoes_trabalho').where({ id: Number(id) });
  if (travar) q.forUpdate();
  const p = await q.first();
  if (!p || !podeAcessarFilial(req, p.filial_id)) throw new ErroDeNegocio(404, 'Permissão não encontrada');
  return p;
}

async function carregar(db, p) {
  const participantes = await db('pt_participantes as x').leftJoin('funcionarios as f', 'f.id', 'x.funcionario_id')
    .leftJoin('terceiro_trabalhadores as t', 't.id', 'x.terceiro_trabalhador_id').leftJoin('empresas_terceiras as e', 'e.id', 't.empresa_id')
    .leftJoin('pt_assinaturas as s', 's.participante_id', 'x.id').where('x.pt_id', p.id).orderBy('x.id')
    .select('x.id', 'x.funcionario_id', 'x.terceiro_trabalhador_id', db.raw('coalesce(f.nome, t.nome) as nome'), 'f.matricula', 'e.razao_social as empresa',
      'x.papel', 'x.conferencia', 's.assinado_em', 's.metodo as metodo_assinatura', 's.observacao as observacao_assinatura');
  const medicoes = await db('pt_medicoes').where({ pt_id: p.id }).orderBy('medido_em');
  const filial = await db('filiais').where({ id: p.filial_id }).first('nome', 'razao_social', 'cnpj', 'cidade', 'uf');
  const emitente = await db('usuarios').where({ id: p.emitida_por }).first('nome');
  const predio = p.predio_id ? await db('predios').where({ id: p.predio_id }).first('nome') : null;
  const agora = new Date();
  const vencida = ['aguardando_assinaturas', 'liberada'].includes(p.status) && new Date(p.fim) < agora;
  return {
    ...p, numero: P.numero(p), nome_tipo: P.TIPOS[p.tipo].nome, filial: filial.nome, filial_dados: filial, emitida_por_nome: emitente.nome,
    predio: predio && predio.nome, vencida,
    checklist_itens: P.TIPOS[p.tipo].checklist.map(([chave, descricao]) => ({ chave, descricao, resposta: p.checklist[chave] })),
    participantes: participantes.map((x) => ({ ...x, nome_papel: P.PAPEIS[x.papel], assinou: !!x.assinado_em })),
    medicoes: medicoes.map((m) => ({ ...m, o2: m.o2 === null ? null : Number(m.o2), lie: m.lie === null ? null : Number(m.lie), h2s: m.h2s === null ? null : Number(m.h2s), co: m.co === null ? null : Number(m.co) }))
  };
}

// Libera quando todos os participantes assinaram
async function liberarSeCompleta(trx, p) {
  const { faltam } = await trx('pt_participantes as x').leftJoin('pt_assinaturas as s', 's.participante_id', 'x.id')
    .where('x.pt_id', p.id).whereNull('s.id').count({ faltam: '*' }).first();
  if (Number(faltam) === 0 && p.status === 'aguardando_assinaturas') {
    await trx('permissoes_trabalho').where({ id: p.id }).update({ status: 'liberada', liberada_em: trx.fn.now(), updated_at: trx.fn.now() });
    return true;
  }
  return false;
}

function exigirEmAndamento(p) {
  if (!['aguardando_assinaturas', 'liberada'].includes(p.status)) throw new ErroDeNegocio(409, `Permissão ${p.status}`);
  if (new Date(p.fim) < new Date()) throw new ErroDeNegocio(409, 'Permissão vencida: encerre ou cancele e emita outra');
}

module.exports = {
  // POST /permissoes-trabalho/conferir { tipo, fim, participantes } — confere antes de emitir (nada é gravado)
  async conferir(req, res) {
    const b = req.body || {};
    if (!P.TIPOS[b.tipo]) throw new ErroDeNegocio(400, `tipo deve ser: ${Object.keys(P.TIPOS).join(', ')}`);
    const dataFim = b.fim ? dataLocal(lerInstante(b.fim, 'fim')) : hoje();
    if (b.filial_id !== undefined && (!idValido(b.filial_id) || !podeAcessarFilial(req, b.filial_id))) throw new ErroDeNegocio(404, 'Filial não encontrada');
    const participantes = await lerParticipantes(knex, req, b.tipo, b.participantes);
    if (participantes.some((p) => p.terceiro) && !b.filial_id) throw new ErroDeNegocio(400, 'Com terceirizado, informe a filial_id (o contrato é por filial)');
    const conferidos = await P.conferirParticipantes(knex, b.tipo, participantes, dataFim, { filialId: Number(b.filial_id) });
    return res.json({ ok: conferidos.every((c) => c.ok), participantes: conferidos.map(({ conferencia, ...c }) => ({ ...c, treinamentos: conferencia.treinamentos, aso: conferencia.aso })) });
  },

  // POST /permissoes-trabalho { filial_id, tipo, local_descricao, servico, inicio, fim, checklist, participantes,
  //   predio_id?, setor_id?, medidas_adicionais?, epis?, medicao_inicial? (espaço confinado) }
  async create(req, res) {
    const b = req.body || {};
    if (!idValido(b.filial_id) || !podeAcessarFilial(req, b.filial_id)) throw new ErroDeNegocio(404, 'Filial não encontrada');
    if (!P.TIPOS[b.tipo]) throw new ErroDeNegocio(400, `tipo deve ser: ${Object.keys(P.TIPOS).join(', ')}`);
    const config = P.TIPOS[b.tipo];
    const local = texto(b.local_descricao, 300);
    const servico = texto(b.servico, 5000);
    if (!local) throw new ErroDeNegocio(400, 'Informe o local');
    if (!servico) throw new ErroDeNegocio(400, 'Descreva o serviço');
    const { inicio, fim } = lerPeriodo(b);
    const medidas = texto(b.medidas_adicionais, 5000);
    const checklist = lerChecklist(b.tipo, b.checklist, medidas);
    let medicao = null;
    if (config.medicao || b.medicao_inicial) {
      if (!b.medicao_inicial) throw new ErroDeNegocio(400, 'Espaço confinado: informe a medição inicial da atmosfera (medicao_inicial)');
      medicao = P.avaliarMedicao(b.medicao_inicial);
      if (medicao.erro) throw new ErroDeNegocio(400, medicao.erro);
      if (!medicao.dentro) throw new ErroDeNegocio(409, `Atmosfera fora dos limites: ${medicao.fora.join('; ')}. Não é permitido entrar.`, { fora: medicao.fora });
    }
    const participantes = await lerParticipantes(knex, req, b.tipo, b.participantes);
    const conferidos = await P.conferirParticipantes(knex, b.tipo, participantes, dataLocal(fim), { filialId: Number(b.filial_id) });
    const recusados = conferidos.filter((c) => !c.ok);
    if (recusados.length) {
      // A tentativa fica registrada: mostra quem tentou liberar trabalhador sem condição
      await auditar(knex, req, { acao: 'pt_recusada', tabela: 'permissoes_trabalho', filial_id: Number(b.filial_id),
        depois: { tipo: b.tipo, local, recusados: recusados.map((r) => ({ funcionario_id: r.funcionario_id, terceiro_trabalhador_id: r.terceiro_trabalhador_id, problemas: r.problemas })) } });
      throw new ErroDeNegocio(409, 'Há participantes que não podem executar este trabalho', {
        participantes: recusados.map((r) => ({ funcionario_id: r.funcionario_id, terceiro_trabalhador_id: r.terceiro_trabalhador_id, funcionario: r.funcionario,
          empresa: r.empresa, papel: r.papel, problemas: r.problemas }))
      });
    }

    const pt = await knex.transaction(async (trx) => {
      const filial = await trx('filiais').where({ id: Number(b.filial_id) }).forUpdate().first('id');
      for (const [campo, tabela, nome] of [['predio_id', 'predios', 'Prédio'], ['setor_id', 'setores', 'Setor']]) {
        if (b[campo] === undefined || b[campo] === null) continue;
        const r = idValido(b[campo]) && await trx(tabela).where({ id: Number(b[campo]) }).first('filial_id');
        if (!r || r.filial_id !== filial.id) throw new ErroDeNegocio(400, `${nome} não pertence à filial`);
      }
      const ano = Number(dataLocal(inicio).slice(0, 4));
      const { max } = await trx('permissoes_trabalho').where({ filial_id: filial.id, ano }).max({ max: 'sequencial' }).first();
      const [p] = await trx('permissoes_trabalho').insert({
        filial_id: filial.id, ano, sequencial: (max || 0) + 1, tipo: b.tipo, predio_id: b.predio_id || null, setor_id: b.setor_id || null,
        local_descricao: local, servico, inicio, fim, checklist: JSON.stringify(checklist), medidas_adicionais: medidas, epis: texto(b.epis, 2000),
        emitida_por: req.usuario.id, codigo_verificacao: gerarCodigo()
      }).returning('*');
      await trx('pt_participantes').insert(conferidos.map((c) => ({ pt_id: p.id, funcionario_id: c.funcionario_id || null,
        terceiro_trabalhador_id: c.terceiro_trabalhador_id || null, papel: c.papel, conferencia: JSON.stringify(c.conferencia) })));
      if (medicao) {
        await trx('pt_medicoes').insert({ pt_id: p.id, ...medicao.valores, equipamento: texto(b.medicao_inicial.equipamento, 100), dentro_limites: true,
          observacao: 'Medição inicial', usuario_id: req.usuario.id });
      }
      await auditar(trx, req, { acao: 'emitir_pt', tabela: 'permissoes_trabalho', registro_id: p.id, filial_id: p.filial_id,
        depois: { ...p, participantes: conferidos.map((c) => ({ funcionario_id: c.funcionario_id, papel: c.papel })) } });
      return p;
    });
    return res.status(201).json(await carregar(knex, pt));
  },

  // GET /permissoes-trabalho?filial_id=&tipo=&status=
  async index(req, res) {
    const q = noEscopo(knex('permissoes_trabalho as p'), req, 'p.filial_id').join('filiais as f', 'f.id', 'p.filial_id')
      .orderBy('p.inicio', 'desc').limit(500)
      .select('p.id', 'p.filial_id', 'f.nome as filial', 'p.ano', 'p.sequencial', 'p.tipo', 'p.local_descricao', 'p.inicio', 'p.fim', 'p.status', 'p.codigo_verificacao');
    for (const c of ['filial_id', 'tipo', 'status']) if (req.query[c]) q.where(`p.${c}`, req.query[c]);
    const agora = new Date();
    return res.json((await q).map((p) => ({ ...p, numero: P.numero(p), vencida: ['aguardando_assinaturas', 'liberada'].includes(p.status) && new Date(p.fim) < agora })));
  },

  async show(req, res) {
    return res.json(await carregar(knex, await ptNoEscopo(knex, req, req.params.id)));
  },

  // POST /permissoes-trabalho/:id/assinar { token, pin } — o participante assina com o crachá
  async assinar(req, res) {
    const { token, pin } = req.body || {};
    if (!token) throw new ErroDeNegocio(400, 'token é obrigatório');
    const previa = await ptNoEscopo(knex, req, req.params.id);
    exigirEmAndamento(previa);
    const participante = await knex('pt_participantes as x').join('funcionarios as f', 'f.id', 'x.funcionario_id')
      .where({ 'x.pt_id': previa.id, 'f.qr_token': String(token) }).first('x.id', 'x.funcionario_id', 'f.nome');
    if (!participante) throw new ErroDeNegocio(404, 'Este crachá não é de um participante desta permissão');
    await conferirPin(participante.funcionario_id, pin);
    const liberou = await knex.transaction(async (trx) => {
      const p = await ptNoEscopo(trx, req, previa.id, { travar: true });
      exigirEmAndamento(p);
      if (await trx('pt_assinaturas').where({ participante_id: participante.id }).first('id')) throw new ErroDeNegocio(409, `${participante.nome} já assinou`);
      const [s] = await trx('pt_assinaturas').insert({ participante_id: participante.id, metodo: 'qr_pin', pin_validado: true, usuario_id: req.usuario.id,
        ip: req.ip || null, user_agent: String(req.headers['user-agent'] || '').slice(0, 300) }).returning('*');
      await auditar(trx, req, { acao: 'assinar_pt', tabela: 'pt_assinaturas', registro_id: s.id, filial_id: p.filial_id, depois: { ...s, pt_id: p.id, funcionario_id: participante.funcionario_id } });
      return liberarSeCompleta(trx, p);
    });
    const completo = await carregar(knex, await ptNoEscopo(knex, req, previa.id));
    return res.status(201).json({ assinou: participante.nome, liberada: liberou || completo.status === 'liberada', permissao: completo });
  },

  // POST /pt-participantes/:id/assinatura-manual { observacao } — funcionário: gestão (permissão em papel);
  // terceirizado (não tem crachá do grupo): a equipe de SST registra a ciência dada no local
  async assinaturaManual(req, res) {
    const observacao = texto(req.body && req.body.observacao, 2000);
    if (!observacao || observacao.length < 10) throw new ErroDeNegocio(400, 'Assinatura sem crachá exige justificativa (pelo menos 10 caracteres)');
    const x = idValido(req.params.id) && await knex('pt_participantes').where({ id: Number(req.params.id) }).first();
    if (!x) throw new ErroDeNegocio(404, 'Participante não encontrado');
    if (x.funcionario_id && !['admin', 'gestor'].includes(req.usuario.perfil)) throw new ErroDeNegocio(403, 'Funcionário assina com o crachá; sem crachá, só a gestão registra');
    const ptId = (await ptNoEscopo(knex, req, x.pt_id).catch(() => { throw new ErroDeNegocio(404, 'Participante não encontrado'); })).id;
    await knex.transaction(async (trx) => {
      const p = await ptNoEscopo(trx, req, ptId, { travar: true });
      exigirEmAndamento(p);
      if (await trx('pt_assinaturas').where({ participante_id: x.id }).first('id')) throw new ErroDeNegocio(409, 'Participante já assinou');
      const [s] = await trx('pt_assinaturas').insert({ participante_id: x.id, metodo: 'manual', pin_validado: false, observacao, usuario_id: req.usuario.id, ip: req.ip || null }).returning('*');
      await auditar(trx, req, { acao: 'assinar_pt_manual', tabela: 'pt_assinaturas', registro_id: s.id, filial_id: p.filial_id, depois: s });
      await liberarSeCompleta(trx, p);
    });
    return res.status(201).json(await carregar(knex, await ptNoEscopo(knex, req, ptId)));
  },

  // POST /permissoes-trabalho/:id/medicoes { o2, lie, h2s?, co?, equipamento?, observacao? }
  // Fora dos limites: a permissão é suspensa (cancelada) na hora — todos saem do espaço.
  async medicao(req, res) {
    const b = req.body || {};
    const m = P.avaliarMedicao(b);
    if (m.erro) throw new ErroDeNegocio(400, m.erro);
    const resultado = await knex.transaction(async (trx) => {
      const p = await ptNoEscopo(trx, req, req.params.id, { travar: true });
      exigirEmAndamento(p);
      const [med] = await trx('pt_medicoes').insert({ pt_id: p.id, ...m.valores, equipamento: texto(b.equipamento, 100), dentro_limites: m.dentro,
        observacao: texto(b.observacao, 2000), usuario_id: req.usuario.id }).returning('*');
      let suspensa = false;
      if (!m.dentro) {
        const motivo = `Suspensa automaticamente: atmosfera fora dos limites (${m.fora.join('; ')}). Evacuar o espaço e reavaliar antes de nova permissão.`;
        await trx('permissoes_trabalho').where({ id: p.id }).update({ status: 'cancelada', cancelada_em: trx.fn.now(), cancelada_por: req.usuario.id, motivo_cancelamento: motivo, updated_at: trx.fn.now() });
        suspensa = true;
      }
      await auditar(trx, req, { acao: suspensa ? 'pt_suspensa_atmosfera' : 'medir_atmosfera_pt', tabela: 'pt_medicoes', registro_id: med.id, filial_id: p.filial_id, depois: med });
      return { id: p.id, suspensa, fora: m.fora };
    });
    return res.status(201).json({ suspensa: resultado.suspensa, fora: resultado.fora, permissao: await carregar(knex, await ptNoEscopo(knex, req, resultado.id)) });
  },

  // POST /permissoes-trabalho/:id/encerrar { observacao } — trabalho terminado, pessoas fora, área liberada
  async encerrar(req, res) {
    const observacao = texto(req.body && req.body.observacao, 2000);
    if (!observacao || observacao.length < 5) throw new ErroDeNegocio(400, 'Registre como a área foi deixada (ex.: todos saíram, área limpa e liberada)');
    await knex.transaction(async (trx) => {
      const p = await ptNoEscopo(trx, req, req.params.id, { travar: true });
      if (p.status === 'aguardando_assinaturas') throw new ErroDeNegocio(409, 'A permissão nunca foi liberada: cancele em vez de encerrar');
      if (p.status !== 'liberada') throw new ErroDeNegocio(409, `Permissão ${p.status}`);
      const [d] = await trx('permissoes_trabalho').where({ id: p.id })
        .update({ status: 'encerrada', encerrada_em: trx.fn.now(), encerrada_por: req.usuario.id, encerramento_observacao: observacao, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'encerrar_pt', tabela: 'permissoes_trabalho', registro_id: p.id, filial_id: p.filial_id, antes: p, depois: d });
    });
    return res.json(await carregar(knex, await ptNoEscopo(knex, req, req.params.id)));
  },

  // POST /permissoes-trabalho/:id/cancelar { motivo } — interrupção (emergência, mudança de condição) ou emissão indevida
  async cancelar(req, res) {
    const motivo = texto(req.body && req.body.motivo, 2000);
    if (!motivo || motivo.length < 10) throw new ErroDeNegocio(400, 'Informe o motivo (pelo menos 10 caracteres)');
    await knex.transaction(async (trx) => {
      const p = await ptNoEscopo(trx, req, req.params.id, { travar: true });
      if (!['aguardando_assinaturas', 'liberada'].includes(p.status)) throw new ErroDeNegocio(409, `Permissão ${p.status}`);
      const [d] = await trx('permissoes_trabalho').where({ id: p.id })
        .update({ status: 'cancelada', cancelada_em: trx.fn.now(), cancelada_por: req.usuario.id, motivo_cancelamento: motivo, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'cancelar_pt', tabela: 'permissoes_trabalho', registro_id: p.id, filial_id: p.filial_id, antes: p, depois: d });
    });
    return res.json(await carregar(knex, await ptNoEscopo(knex, req, req.params.id)));
  },

  // GET /permissoes-trabalho/:id/pdf — para afixar no local (com QR de verificação)
  async pdf(req, res) {
    const p = await carregar(knex, await ptNoEscopo(knex, req, req.params.id));
    const url = `${req.protocol}://${req.get('host')}/verificar/${p.codigo_verificacao}`;
    const qr = await QRCode.toBuffer(url, { type: 'png', width: 180, margin: 1 });
    const doc = gerarPermissaoPdf({ permissao: p, qr, url, emitidoPor: req.usuario.nome });
    await auditar(knex, req, { acao: 'emitir_pdf_pt', tabela: 'permissoes_trabalho', registro_id: p.id, filial_id: p.filial_id });
    res.type('application/pdf');
    res.set('Content-Disposition', `inline; filename="permissao-${p.numero.replace('/', '-')}.pdf"`);
    doc.pipe(res);
  },

  // GET /permissoes-trabalho/pendencias?filial_id=&todas=true&data_base=
  async pendencias(req, res) {
    const { dataBase } = lerDataBase(req.query);
    const itens = await P.situacaoPermissoes(knex, req, req.query, { dataBase });
    return res.json({ data_base: dataBase || hoje(), ...filtrarPendencias(itens, P.SITUACOES, req.query, { emDia: (i) => !['vencida_sem_encerramento', 'aguardando_assinaturas'].includes(i.situacao) }) });
  },

  // GET /permissoes-trabalho/exigencias — cursos exigidos por tipo e papel (vazio = vale a NR do tipo)
  async exigencias(req, res) {
    const linhas = await knex('pt_exigencias as e').join('treinamentos as t', 't.id', 'e.treinamento_id')
      .select('e.tipo', 'e.papel', 't.id as treinamento_id', 't.nome_treinamento', 't.nr_referencia').orderBy(['e.tipo', 'e.papel']);
    return res.json(Object.entries(P.TIPOS).map(([tipo, c]) => ({
      tipo, nome: c.nome, nr_padrao: c.nr,
      papeis: Object.keys(c.papeis).map((papel) => ({ papel, nome: P.PAPEIS[papel], minimo: c.papeis[papel], treinamentos: linhas.filter((l) => l.tipo === tipo && l.papel === papel) }))
    })));
  },

  // PUT /permissoes-trabalho/exigencias { tipo, papel, treinamento_ids: [] } — matriz
  async definirExigencias(req, res) {
    const { tipo, papel, treinamento_ids: lista } = req.body || {};
    if (!P.TIPOS[tipo]) throw new ErroDeNegocio(400, `tipo deve ser: ${Object.keys(P.TIPOS).join(', ')}`);
    if (!P.TIPOS[tipo].papeis[papel]) throw new ErroDeNegocio(400, `papel deve ser: ${Object.keys(P.TIPOS[tipo].papeis).join(', ')}`);
    if (!Array.isArray(lista) || !lista.every(idValido)) throw new ErroDeNegocio(400, 'treinamento_ids: lista de ids (vazia = volta a valer a NR do tipo)');
    const ids = [...new Set(lista.map(Number))];
    await knex.transaction(async (trx) => {
      if (ids.length && (await trx('treinamentos').whereIn('id', ids).pluck('id')).length !== ids.length) throw new ErroDeNegocio(400, 'Algum treinamento não existe');
      const antes = await trx('pt_exigencias').where({ tipo, papel }).pluck('treinamento_id');
      await trx('pt_exigencias').where({ tipo, papel }).del();
      if (ids.length) await trx('pt_exigencias').insert(ids.map((treinamento_id) => ({ tipo, papel, treinamento_id })));
      await auditar(trx, req, { acao: 'definir_exigencias_pt', tabela: 'pt_exigencias', registro_id: `${tipo}:${papel}`, antes: { treinamentos: antes }, depois: { treinamentos: ids } });
    });
    return module.exports.exigencias(req, res);
  }
};
