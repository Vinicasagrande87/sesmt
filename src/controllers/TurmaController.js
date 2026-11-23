// Turmas de treinamento e lista de presença assinada pelo crachá (QR + PIN).
// Presença nunca é editada nem apagada: erro se anula. No encerramento, cada participante
// recebe o registro de capacitação (aprovado/reprovado) com o vencimento calculado.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { noEscopo, ehAdmin, podeAcessarFilial, exigirFilial } = require('../utils/escopo');
const { hoje, dataValida, somarMeses, diasEntre } = require('../utils/datas');
const { exigirCampos, idValido, pegar } = require('../utils/validacao');
const { gerarCodigo } = require('../utils/codigo');
const { conferirPin } = require('../services/pin');
const { buscarNoEscopo } = require('./FuncionarioController');
const { gerarListaPresenca } = require('../relatorios/listaPresenca');

const CAMPOS_EDITAVEIS = ['data_fim', 'carga_horaria', 'local', 'instrutor_nome', 'instrutor_qualificacao', 'observacao'];

async function turmaNoEscopo(trx, req, id, { travar = false } = {}) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'Turma não encontrada');
  const q = trx('turmas').where({ id });
  if (travar) q.forUpdate();
  const turma = await q.first();
  if (!turma || !podeAcessarFilial(req, turma.filial_id)) throw new ErroDeNegocio(404, 'Turma não encontrada');
  return turma;
}

function exigirAberta(turma) {
  if (turma.status !== 'aberta') throw new ErroDeNegocio(409, `Turma ${turma.status}`);
}

// Presenças válidas (não anuladas) da turma, com o funcionário
function presencasValidas(trx, turmaId) {
  return trx('turma_presencas as p')
    .leftJoin('presenca_anulacoes as a', 'a.presenca_id', 'p.id')
    .where('p.turma_id', turmaId)
    .whereNull('a.id');
}

async function registrarPresenca(trx, req, { turma, funcionario, data_presenca, metodo, pinValidado, observacao }) {
  if (funcionario.status !== 'Ativo') {
    throw new ErroDeNegocio(409, `Funcionário com status "${funcionario.status}" não pode assinar presença`);
  }
  const ja = await presencasValidas(trx, turma.id)
    .where({ 'p.funcionario_id': funcionario.id, 'p.data_presenca': data_presenca })
    .first('p.id');
  if (ja) throw new ErroDeNegocio(409, `${funcionario.nome} já assinou a presença deste dia`);

  const [presenca] = await trx('turma_presencas').insert({
    turma_id: turma.id,
    funcionario_id: funcionario.id,
    data_presenca,
    assinado_em: trx.fn.now(),
    metodo_assinatura: metodo,
    pin_validado: pinValidado,
    setor_id: funcionario.setor_id,
    funcao_id: funcionario.funcao_id,
    usuario_id: req.usuario.id,
    ip: req.ip || null,
    user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
    codigo_verificacao: gerarCodigo(),
    observacao: observacao || null
  }).returning('*');
  await auditar(trx, req, {
    acao: metodo === 'qr_pin' ? 'assinar_presenca' : 'presenca_manual', tabela: 'turma_presencas',
    registro_id: presenca.id, filial_id: turma.filial_id, depois: presenca
  });
  return {
    id: presenca.id,
    funcionario: funcionario.nome,
    matricula: funcionario.matricula,
    data_presenca,
    codigo_verificacao: presenca.codigo_verificacao
  };
}

module.exports = {
  // GET /turmas?filial_id=&status=&treinamento_id=&de=&ate=&hoje=true
  async index(req, res) {
    const presentes = knex('turma_presencas as p')
      .leftJoin('presenca_anulacoes as a', 'a.presenca_id', 'p.id')
      .whereNull('a.id')
      .whereRaw('p.turma_id = turmas.id')
      .countDistinct('p.funcionario_id');
    const query = noEscopo(knex('turmas'), req, 'turmas.filial_id')
      .join('treinamentos as t', 't.id', 'turmas.treinamento_id')
      .join('filiais as f', 'f.id', 'turmas.filial_id')
      .select('turmas.*', 't.nome_treinamento as treinamento', 't.nr_referencia as nr', 'f.nome as filial',
        presentes.as('participantes'))
      .orderBy([{ column: 'turmas.data_inicio', order: 'desc' }, { column: 'turmas.id', order: 'desc' }]);
    for (const filtro of ['filial_id', 'status', 'treinamento_id']) {
      if (req.query[filtro]) query.where(`turmas.${filtro}`, req.query[filtro]);
    }
    if (req.query.de) query.where('turmas.data_fim', '>=', req.query.de);
    if (req.query.ate) query.where('turmas.data_inicio', '<=', req.query.ate);
    if (req.query.hoje === 'true') {
      query.where('turmas.data_inicio', '<=', hoje()).where('turmas.data_fim', '>=', hoje()).where('turmas.status', 'aberta');
    }
    const turmas = await query;
    return res.json(turmas.map((t) => ({ ...t, participantes: Number(t.participantes) })));
  },

  // GET /turmas/:id — com presenças (inclusive anuladas) e resultados
  async show(req, res) {
    const turma = await turmaNoEscopo(knex, req, req.params.id);
    const treinamento = await knex('treinamentos').where({ id: turma.treinamento_id }).first();
    const presencas = await knex('turma_presencas as p')
      .join('funcionarios as f', 'f.id', 'p.funcionario_id')
      .join('usuarios as u', 'u.id', 'p.usuario_id')
      .leftJoin('presenca_anulacoes as a', 'a.presenca_id', 'p.id')
      .where('p.turma_id', turma.id)
      .orderBy([{ column: 'p.data_presenca' }, { column: 'p.assinado_em' }])
      .select('p.id', 'p.funcionario_id', 'f.nome as funcionario', 'f.matricula', 'p.data_presenca', 'p.assinado_em',
        'p.metodo_assinatura', 'p.codigo_verificacao', 'u.nome as registrado_por',
        knex.raw('(a.id is not null) as anulada'), 'a.motivo as anulacao_motivo');
    const resultados = await knex('certificados_treinamentos as c')
      .join('funcionarios as f', 'f.id', 'c.funcionario_id')
      .leftJoin('certificado_anulacoes as a', 'a.certificado_id', 'c.id')
      .where('c.turma_id', turma.id)
      .select('c.id', 'c.funcionario_id', 'f.nome as funcionario', 'c.status', 'c.data_vencimento',
        'c.codigo_verificacao', knex.raw('(a.id is not null) as anulado'));
    return res.json({ ...turma, treinamento, presencas, resultados });
  },

  // POST /turmas { treinamento_id, filial_id, data_inicio, data_fim, instrutor_nome, carga_horaria?, local?, instrutor_qualificacao?, observacao? }
  async create(req, res) {
    exigirCampos(req.body, ['treinamento_id', 'filial_id', 'data_inicio', 'data_fim', 'instrutor_nome']);
    const b = req.body;
    if (!idValido(b.treinamento_id) || !idValido(b.filial_id)) throw new ErroDeNegocio(400, 'treinamento_id e filial_id inválidos');
    if (!dataValida(b.data_inicio) || !dataValida(b.data_fim)) throw new ErroDeNegocio(400, 'Datas no formato AAAA-MM-DD');
    if (b.data_fim < b.data_inicio) throw new ErroDeNegocio(400, 'data_fim não pode ser antes de data_inicio');
    exigirFilial(req, b.filial_id);

    const turma = await knex.transaction(async (trx) => {
      const treinamento = await trx('treinamentos').where({ id: b.treinamento_id }).first();
      if (!treinamento || !treinamento.ativo) throw new ErroDeNegocio(404, 'Treinamento não encontrado ou inativo');
      const filial = await trx('filiais').where({ id: b.filial_id }).first('ativa');
      if (!filial || !filial.ativa) throw new ErroDeNegocio(400, 'Filial não encontrada ou inativa');

      const carga = b.carga_horaria !== undefined ? Number(b.carga_horaria) : treinamento.carga_horaria;
      if (!Number.isInteger(carga) || carga < 1) throw new ErroDeNegocio(400, 'carga_horaria deve ser um inteiro maior que zero');

      const [nova] = await trx('turmas').insert({
        treinamento_id: treinamento.id,
        filial_id: Number(b.filial_id),
        data_inicio: b.data_inicio,
        data_fim: b.data_fim,
        carga_horaria: carga,
        local: b.local || null,
        instrutor_nome: b.instrutor_nome,
        instrutor_qualificacao: b.instrutor_qualificacao || null,
        observacao: b.observacao || null,
        criado_por: req.usuario.id
      }).returning('*');
      await auditar(trx, req, { acao: 'criar', tabela: 'turmas', registro_id: nova.id, filial_id: nova.filial_id, depois: nova });
      return nova;
    });
    return res.status(201).json(turma);
  },

  // PUT /turmas/:id — só enquanto aberta
  async update(req, res) {
    const dados = pegar(req.body, CAMPOS_EDITAVEIS);
    if (!Object.keys(dados).length) throw new ErroDeNegocio(400, 'Nenhum campo para alterar');
    if (dados.carga_horaria !== undefined) {
      dados.carga_horaria = Number(dados.carga_horaria);
      if (!Number.isInteger(dados.carga_horaria) || dados.carga_horaria < 1) throw new ErroDeNegocio(400, 'carga_horaria inválida');
    }
    const turma = await knex.transaction(async (trx) => {
      const antes = await turmaNoEscopo(trx, req, req.params.id, { travar: true });
      exigirAberta(antes);
      if (dados.data_fim !== undefined) {
        if (!dataValida(dados.data_fim) || dados.data_fim < antes.data_inicio) throw new ErroDeNegocio(400, 'data_fim inválida');
        const depoisDoFim = await presencasValidas(trx, antes.id).where('p.data_presenca', '>', dados.data_fim).first('p.id');
        if (depoisDoFim) throw new ErroDeNegocio(409, 'Há presenças depois da nova data_fim');
      }
      const [depois] = await trx('turmas').where({ id: antes.id }).update({ ...dados, updated_at: trx.fn.now() }).returning('*');
      await auditar(trx, req, { acao: 'alterar', tabela: 'turmas', registro_id: antes.id, filial_id: antes.filial_id, antes, depois });
      return depois;
    });
    return res.json(turma);
  },

  // POST /turmas/:id/presencas { token, pin } — no dia do treinamento
  async presencaQr(req, res) {
    const { token, pin } = req.body || {};
    if (!token) throw new ErroDeNegocio(400, 'token é obrigatório');
    const turmaPrevia = await turmaNoEscopo(knex, req, req.params.id);
    exigirAberta(turmaPrevia);
    const dataHoje = hoje();
    if (dataHoje < turmaPrevia.data_inicio || dataHoje > turmaPrevia.data_fim) {
      throw new ErroDeNegocio(409, 'A assinatura por QR só pode ser feita nos dias da turma');
    }

    const funcionario = await knex('funcionarios').where({ qr_token: String(token) }).first();
    const visivel = funcionario && (funcionario.filial_id ? podeAcessarFilial(req, funcionario.filial_id) : ehAdmin(req));
    if (!visivel) throw new ErroDeNegocio(404, 'QR code não reconhecido');
    await conferirPin(funcionario.id, pin);

    const resultado = await knex.transaction(async (trx) => {
      const turma = await turmaNoEscopo(trx, req, req.params.id, { travar: true }); // serializa assinaturas da turma
      exigirAberta(turma);
      const atual = await trx('funcionarios').where({ id: funcionario.id }).first();
      return registrarPresenca(trx, req, { turma, funcionario: atual, data_presenca: dataHoje, metodo: 'qr_pin', pinValidado: true });
    });
    return res.status(201).json(resultado);
  },

  // POST /turmas/:id/presencas/manual { funcionario_id, data_presenca, observacao } — gestão (ex.: lista em papel)
  async presencaManual(req, res) {
    const { funcionario_id, data_presenca, observacao } = req.body || {};
    if (!observacao || String(observacao).trim().length < 10) {
      throw new ErroDeNegocio(400, 'Presença sem QR/PIN exige justificativa na observação (pelo menos 10 caracteres)');
    }
    if (!dataValida(data_presenca)) throw new ErroDeNegocio(400, 'data_presenca no formato AAAA-MM-DD');
    if (data_presenca > hoje()) throw new ErroDeNegocio(400, 'data_presenca não pode ser futura');

    const resultado = await knex.transaction(async (trx) => {
      const turma = await turmaNoEscopo(trx, req, req.params.id, { travar: true });
      exigirAberta(turma);
      if (data_presenca < turma.data_inicio || data_presenca > turma.data_fim) {
        throw new ErroDeNegocio(400, 'data_presenca fora do período da turma');
      }
      const funcionario = await buscarNoEscopo(req, funcionario_id, trx);
      return registrarPresenca(trx, req, {
        turma, funcionario, data_presenca, metodo: 'manual', pinValidado: false, observacao: String(observacao).trim()
      });
    });
    return res.status(201).json(resultado);
  },

  // POST /presencas/:id/anular { motivo } — gestão, enquanto a turma estiver aberta
  async anularPresenca(req, res) {
    const motivo = req.body && req.body.motivo;
    if (!motivo || String(motivo).trim().length < 5) throw new ErroDeNegocio(400, 'Informe o motivo (pelo menos 5 caracteres)');
    const resultado = await knex.transaction(async (trx) => {
      const presenca = await trx('turma_presencas').where({ id: req.params.id }).first();
      if (!presenca) throw new ErroDeNegocio(404, 'Presença não encontrada');
      const turma = await turmaNoEscopo(trx, req, presenca.turma_id, { travar: true });
      exigirAberta(turma);
      if (await trx('presenca_anulacoes').where({ presenca_id: presenca.id }).first('id')) {
        throw new ErroDeNegocio(409, 'Presença já anulada');
      }
      const [anulacao] = await trx('presenca_anulacoes')
        .insert({ presenca_id: presenca.id, motivo: String(motivo).trim(), usuario_id: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'anular_presenca', tabela: 'turma_presencas', registro_id: presenca.id, filial_id: turma.filial_id, antes: presenca, depois: anulacao });
      return anulacao;
    });
    return res.status(201).json(resultado);
  },

  // POST /turmas/:id/cancelar { motivo } — gestão; presenças já assinadas continuam registradas
  async cancelar(req, res) {
    const motivo = req.body && req.body.motivo;
    if (!motivo || String(motivo).trim().length < 5) throw new ErroDeNegocio(400, 'Informe o motivo (pelo menos 5 caracteres)');
    const turma = await knex.transaction(async (trx) => {
      const antes = await turmaNoEscopo(trx, req, req.params.id, { travar: true });
      exigirAberta(antes);
      const [depois] = await trx('turmas').where({ id: antes.id }).update({
        status: 'cancelada', encerrado_por: req.usuario.id, encerrado_em: trx.fn.now(),
        observacao: [antes.observacao, `Cancelada: ${String(motivo).trim()}`].filter(Boolean).join('\n'),
        updated_at: trx.fn.now()
      }).returning('*');
      await auditar(trx, req, { acao: 'cancelar', tabela: 'turmas', registro_id: antes.id, filial_id: antes.filial_id, antes, depois });
      return depois;
    });
    return res.json(turma);
  },

  // POST /turmas/:id/encerrar { resultados?: [{ funcionario_id, aprovado }] }
  // Padrão: aprovado quem esteve em todos os dias da turma. "resultados" sobrepõe (ex.: reprovado na avaliação).
  async encerrar(req, res) {
    const resultados = (req.body && req.body.resultados) || [];
    if (!Array.isArray(resultados) || !resultados.every((r) => idValido(r.funcionario_id) && typeof r.aprovado === 'boolean')) {
      throw new ErroDeNegocio(400, 'resultados deve ser uma lista de { funcionario_id, aprovado: true/false }');
    }

    const resposta = await knex.transaction(async (trx) => {
      const turma = await turmaNoEscopo(trx, req, req.params.id, { travar: true });
      exigirAberta(turma);
      if (hoje() < turma.data_fim) throw new ErroDeNegocio(409, `A turma só pode ser encerrada a partir de ${turma.data_fim}`);

      const treinamento = await trx('treinamentos').where({ id: turma.treinamento_id }).first();
      const presencas = await presencasValidas(trx, turma.id).select('p.funcionario_id', 'p.data_presenca');
      if (!presencas.length) throw new ErroDeNegocio(409, 'Turma sem presenças: cancele em vez de encerrar');

      const totalDias = diasEntre(turma.data_inicio, turma.data_fim);
      const diasPorFuncionario = new Map();
      for (const p of presencas) {
        if (!diasPorFuncionario.has(p.funcionario_id)) diasPorFuncionario.set(p.funcionario_id, new Set());
        diasPorFuncionario.get(p.funcionario_id).add(p.data_presenca);
      }
      const definidos = new Map(resultados.map((r) => [Number(r.funcionario_id), r.aprovado]));
      for (const id of definidos.keys()) {
        if (!diasPorFuncionario.has(id)) throw new ErroDeNegocio(400, `Funcionário ${id} não tem presença nesta turma`);
      }

      const data_vencimento = treinamento.validade_meses ? somarMeses(turma.data_fim, treinamento.validade_meses) : null;
      const registros = [];
      for (const [funcionarioId, dias] of diasPorFuncionario) {
        const frequencia = Math.round((dias.size / totalDias) * 100);
        const aprovado = definidos.has(funcionarioId) ? definidos.get(funcionarioId) : frequencia === 100;
        registros.push({
          funcionario_id: funcionarioId,
          treinamento_id: turma.treinamento_id,
          turma_id: turma.id,
          origem: 'turma',
          data_realizacao: turma.data_fim,
          data_vencimento: aprovado ? data_vencimento : null,
          carga_horaria: turma.carga_horaria,
          instrutor: turma.instrutor_nome,
          status: aprovado ? 'Aprovado' : 'Reprovado',
          registrado_por: req.usuario.id,
          codigo_verificacao: gerarCodigo(),
          frequencia
        });
      }
      const gravados = await trx('certificados_treinamentos')
        .insert(registros.map(({ frequencia, ...r }) => r)).returning('*');

      const [depois] = await trx('turmas').where({ id: turma.id }).update({
        status: 'encerrada', encerrado_por: req.usuario.id, encerrado_em: trx.fn.now(), updated_at: trx.fn.now()
      }).returning('*');
      await auditar(trx, req, {
        acao: 'encerrar', tabela: 'turmas', registro_id: turma.id, filial_id: turma.filial_id, antes: turma,
        depois: { ...depois, resultados: registros.map(({ funcionario_id, status, frequencia }) => ({ funcionario_id, status, frequencia })) }
      });
      return {
        ...depois,
        resultados: gravados.map((g) => ({
          certificado_id: g.id, funcionario_id: g.funcionario_id, status: g.status, data_vencimento: g.data_vencimento,
          codigo_verificacao: g.codigo_verificacao, frequencia: registros.find((r) => r.funcionario_id === g.funcionario_id).frequencia
        }))
      };
    });
    return res.json(resposta);
  },

  // GET /turmas/:id/lista-presenca — PDF
  async listaPresencaPdf(req, res) {
    const turma = await turmaNoEscopo(knex, req, req.params.id);
    const [treinamento, filial] = await Promise.all([
      knex('treinamentos').where({ id: turma.treinamento_id }).first(),
      knex('filiais').where({ id: turma.filial_id }).first()
    ]);
    const presencas = await knex('turma_presencas as p')
      .join('funcionarios as f', 'f.id', 'p.funcionario_id')
      .leftJoin('funcoes as fn', 'fn.id', 'p.funcao_id')
      .leftJoin('presenca_anulacoes as a', 'a.presenca_id', 'p.id')
      .where('p.turma_id', turma.id)
      .orderBy([{ column: 'p.data_presenca' }, { column: 'f.nome' }])
      .select('p.*', 'f.nome as funcionario', 'f.matricula', 'fn.nome as funcao', knex.raw('(a.id is not null) as anulada'));
    const resultados = await knex('certificados_treinamentos as c')
      .leftJoin('certificado_anulacoes as a', 'a.certificado_id', 'c.id')
      .where('c.turma_id', turma.id).whereNull('a.id')
      .select('c.funcionario_id', 'c.status');

    const pdf = gerarListaPresenca({
      turma, treinamento, filial, presencas, resultados,
      emitidoPor: req.usuario.nome,
      urlVerificacao: `${req.protocol}://${req.get('host')}/verificar/`
    });
    await auditar(knex, req, { acao: 'emitir_lista_presenca', tabela: 'turmas', registro_id: turma.id, filial_id: turma.filial_id });
    res.type('application/pdf');
    res.set('Content-Disposition', `inline; filename="lista-presenca-turma-${turma.id}.pdf"`);
    pdf.pipe(res);
  }
};
