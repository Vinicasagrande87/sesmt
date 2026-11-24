// Ordens de serviço (NR-1, 1.4.1 "c"): OS vigente de cada funcionário, ciência pelo crachá (QR + PIN)
// ou manual (OS em papel), anulação, PDF e pendências por filial/setor.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { ehAdmin, podeAcessarFilial, noEscopo } = require('../utils/escopo');
const { hoje, dataValida } = require('../utils/datas');
const { idValido } = require('../utils/validacao');
const { gerarCodigo } = require('../utils/codigo');
const { salvarArquivo } = require('../utils/arquivos');
const { conferirPin } = require('../services/pin');
const { osVigenteDoFuncionario } = require('../services/pgr');
const { buscarNoEscopo } = require('./FuncionarioController');
const { gerarOrdemServico } = require('../relatorios/ordemServico');

const SITUACOES = ['sem_pgr', 'sem_grupo', 'ciencia_pendente', 'em_dia'];

function cienciaValida(trx, osId, funcionarioId) {
  return trx('os_ciencias as c')
    .leftJoin('os_ciencia_anulacoes as a', 'a.ciencia_id', 'c.id')
    .where({ 'c.ordem_servico_id': osId, 'c.funcionario_id': funcionarioId })
    .whereNull('a.id')
    .first('c.*');
}

async function registrarCiencia(trx, req, { funcionario, os, pgr, metodo, pinValidado, data_ciencia, observacao, arquivo_id }) {
  if (funcionario.status !== 'Ativo') throw new ErroDeNegocio(409, `Funcionário com status "${funcionario.status}" não pode dar ciência`);
  if (await cienciaValida(trx, os.id, funcionario.id)) throw new ErroDeNegocio(409, `${funcionario.nome} já deu ciência desta ordem de serviço`);
  const [ciencia] = await trx('os_ciencias').insert({
    ordem_servico_id: os.id, funcionario_id: funcionario.id, assinado_em: trx.fn.now(), data_ciencia,
    metodo_assinatura: metodo, pin_validado: pinValidado, setor_id: funcionario.setor_id, funcao_id: funcionario.funcao_id,
    usuario_id: req.usuario.id, ip: req.ip || null, user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
    codigo_verificacao: gerarCodigo(), observacao: observacao || null, arquivo_id: arquivo_id || null
  }).returning('*');
  await auditar(trx, req, {
    acao: metodo === 'qr_pin' ? 'ciencia_os' : 'ciencia_os_manual', tabela: 'os_ciencias', registro_id: ciencia.id,
    filial_id: funcionario.filial_id, depois: { ...ciencia, pgr_id: pgr.id, hash_os: os.hash }
  });
  return {
    id: ciencia.id, funcionario: funcionario.nome, matricula: funcionario.matricula, ordem_servico_id: os.id,
    setor: os.conteudo.setor, atividade: os.conteudo.atividade, assinado_em: ciencia.assinado_em,
    codigo_verificacao: ciencia.codigo_verificacao
  };
}

// EPIs exigidos pela OS (vinculados ao catálogo) que o funcionário nunca recebeu
async function episNuncaEntregues(trx, funcionarioId, conteudo) {
  const exigidos = conteudo.epis.filter((e) => e.epi_id);
  if (!exigidos.length) return [];
  const recebidos = new Set(await trx('entregas as e').leftJoin('entrega_estornos as est', 'est.entrega_id', 'e.id')
    .where('e.funcionario_id', funcionarioId).whereNull('est.id').distinct('e.epi_id').pluck('e.epi_id'));
  return exigidos.filter((e) => !recebidos.has(e.epi_id)).map((e) => `${e.parte_corpo}: ${e.descricao}`);
}

module.exports = {
  // GET /funcionarios/:id/ordem-servico — OS vigente, ciência e histórico de ciências
  async doFuncionario(req, res) {
    const funcionario = await buscarNoEscopo(req, req.params.id);
    const atual = await osVigenteDoFuncionario(knex, funcionario);
    const historico = await knex('os_ciencias as c')
      .join('ordens_servico as os', 'os.id', 'c.ordem_servico_id')
      .join('pgrs as p', 'p.id', 'os.pgr_id')
      .leftJoin('os_ciencia_anulacoes as a', 'a.ciencia_id', 'c.id')
      .where('c.funcionario_id', funcionario.id)
      .orderBy('c.assinado_em', 'desc')
      .select('c.id', 'c.ordem_servico_id', 'c.data_ciencia', 'c.assinado_em', 'c.metodo_assinatura', 'c.codigo_verificacao',
        'p.titulo as pgr', knex.raw("os.conteudo->>'setor' as setor"), knex.raw("os.conteudo->>'atividade' as atividade"),
        knex.raw('(a.id is not null) as anulada'));
    if (atual.situacao !== 'ok') return res.json({ situacao: atual.situacao, pgr_id: atual.pgr ? atual.pgr.id : null, historico });
    const ciencia = await cienciaValida(knex, atual.os.id, funcionario.id);
    return res.json({
      situacao: ciencia ? 'em_dia' : 'ciencia_pendente',
      ordem_servico: { id: atual.os.id, pgr_id: atual.pgr.id, hash: atual.os.hash, ...atual.os.conteudo },
      ciencia: ciencia ? { id: ciencia.id, assinado_em: ciencia.assinado_em, metodo_assinatura: ciencia.metodo_assinatura, codigo_verificacao: ciencia.codigo_verificacao } : null,
      epis_nunca_entregues: await episNuncaEntregues(knex, funcionario.id, atual.os.conteudo),
      historico
    });
  },

  // POST /ordens-servico/ciencia { token, pin } — o funcionário lê a OS e confirma com crachá + PIN
  async cienciaQr(req, res) {
    const { token, pin } = req.body || {};
    if (!token) throw new ErroDeNegocio(400, 'token é obrigatório');
    const funcionario = await knex('funcionarios').where({ qr_token: String(token) }).first();
    const visivel = funcionario && (funcionario.filial_id ? podeAcessarFilial(req, funcionario.filial_id) : ehAdmin(req));
    if (!visivel) throw new ErroDeNegocio(404, 'QR code não reconhecido');
    await conferirPin(funcionario.id, pin);

    const resultado = await knex.transaction(async (trx) => {
      const atual = await trx('funcionarios').where({ id: funcionario.id }).forUpdate().first(); // serializa ciências do funcionário
      const os = await osVigenteDoFuncionario(trx, atual);
      if (os.situacao === 'sem_pgr') throw new ErroDeNegocio(409, 'A filial não tem PGR vigente publicado');
      if (os.situacao === 'sem_grupo') throw new ErroDeNegocio(409, 'O setor/função do funcionário não está em nenhum grupo do PGR vigente');
      return registrarCiencia(trx, req, { funcionario: atual, os: os.os, pgr: os.pgr, metodo: 'qr_pin', pinValidado: true, data_ciencia: hoje() });
    });
    return res.status(201).json(resultado);
  },

  // POST /ordens-servico/:id/ciencias/manual { funcionario_id, data_ciencia, observacao, arquivo? } — gestão (OS assinada em papel)
  async cienciaManual(req, res) {
    const { funcionario_id, data_ciencia, observacao, arquivo } = req.body || {};
    if (!observacao || String(observacao).trim().length < 10) {
      throw new ErroDeNegocio(400, 'Ciência sem QR/PIN exige justificativa na observação (pelo menos 10 caracteres)');
    }
    if (!dataValida(data_ciencia) || data_ciencia > hoje()) throw new ErroDeNegocio(400, 'data_ciencia inválida ou futura');
    const resultado = await knex.transaction(async (trx) => {
      const previo = await buscarNoEscopo(req, funcionario_id, trx);
      const funcionario = await trx('funcionarios').where({ id: previo.id }).forUpdate().first();
      const atual = await osVigenteDoFuncionario(trx, funcionario);
      if (atual.situacao !== 'ok' || atual.os.id !== Number(req.params.id)) {
        throw new ErroDeNegocio(409, 'Esta não é a ordem de serviço vigente do funcionário');
      }
      if (data_ciencia < atual.pgr.data_inicio) throw new ErroDeNegocio(400, 'data_ciencia anterior à vigência do PGR');
      const arq = arquivo ? await salvarArquivo(trx, req, {
        base64: arquivo, contexto: 'os_papel', tipos: ['application/pdf', 'image/jpeg', 'image/png'],
        maxBytes: 10 * 1024 * 1024, filial_id: funcionario.filial_id, funcionario_id: funcionario.id
      }) : null;
      return registrarCiencia(trx, req, {
        funcionario, os: atual.os, pgr: atual.pgr, metodo: 'manual', pinValidado: false,
        data_ciencia, observacao: String(observacao).trim(), arquivo_id: arq && arq.id
      });
    });
    return res.status(201).json(resultado);
  },

  // POST /os-ciencias/:id/anular { motivo } — gestão
  async anularCiencia(req, res) {
    const motivo = req.body && req.body.motivo;
    if (!motivo || String(motivo).trim().length < 5) throw new ErroDeNegocio(400, 'Informe o motivo (pelo menos 5 caracteres)');
    const resultado = await knex.transaction(async (trx) => {
      const ciencia = idValido(req.params.id) && await trx('os_ciencias').where({ id: req.params.id }).first();
      if (!ciencia) throw new ErroDeNegocio(404, 'Ciência não encontrada');
      const funcionario = await buscarNoEscopo(req, ciencia.funcionario_id, trx).catch(() => { throw new ErroDeNegocio(404, 'Ciência não encontrada'); });
      if (await trx('os_ciencia_anulacoes').where({ ciencia_id: ciencia.id }).first('id')) throw new ErroDeNegocio(409, 'Ciência já anulada');
      const [anulacao] = await trx('os_ciencia_anulacoes').insert({ ciencia_id: ciencia.id, motivo: String(motivo).trim(), usuario_id: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'anular_ciencia_os', tabela: 'os_ciencias', registro_id: ciencia.id, filial_id: funcionario.filial_id, antes: ciencia, depois: anulacao });
      return anulacao;
    });
    return res.status(201).json(resultado);
  },

  // GET /ordens-servico/:id/pdf?funcionario_id= — OS em branco do grupo ou personalizada (com a ciência, se houver)
  async pdf(req, res) {
    const os = idValido(req.params.id) && await knex('ordens_servico').where({ id: req.params.id }).first();
    if (!os) throw new ErroDeNegocio(404, 'Ordem de serviço não encontrada');
    const filialIds = await knex('pgr_filiais').where({ pgr_id: os.pgr_id }).pluck('filial_id');
    if (!ehAdmin(req) && !filialIds.some((f) => podeAcessarFilial(req, f))) throw new ErroDeNegocio(404, 'Ordem de serviço não encontrada');

    let funcionario = null;
    let ciencia = null;
    if (req.query.funcionario_id) {
      const f = await buscarNoEscopo(req, req.query.funcionario_id);
      funcionario = await knex('funcionarios as f').leftJoin('funcoes as fn', 'fn.id', 'f.funcao_id').leftJoin('setores as s', 's.id', 'f.setor_id')
        .where('f.id', f.id).first('f.nome', 'f.matricula', 'f.cpf', 'fn.nome as funcao', 's.nome as setor');
      ciencia = await cienciaValida(knex, os.id, f.id);
    }
    const doc = gerarOrdemServico({
      os, funcionario, ciencia, emitidoPor: req.usuario.nome,
      urlVerificacao: `${req.protocol}://${req.get('host')}/verificar/`
    });
    await auditar(knex, req, { acao: 'emitir_os', tabela: 'ordens_servico', registro_id: os.id, filial_id: filialIds[0] });
    res.type('application/pdf');
    res.set('Content-Disposition', `inline; filename="ordem-servico-${os.id}.pdf"`);
    doc.pipe(res);
  },

  // GET /ordens-servico/pendencias?filial_id=&setor_id=&funcionario_id=&situacao=&todas=true
  async pendencias(req, res) {
    if (req.query.situacao && !SITUACOES.includes(req.query.situacao)) throw new ErroDeNegocio(400, `situacao deve ser: ${SITUACOES.join(', ')}`);
    const query = noEscopo(knex('funcionarios as f'), req, 'f.filial_id')
      .join('filiais as fi', 'fi.id', 'f.filial_id')
      .leftJoin('setores as s', 's.id', 'f.setor_id')
      .leftJoin('funcoes as fn', 'fn.id', 'f.funcao_id')
      .where('f.status', 'Ativo')
      .orderBy('f.nome')
      .select('f.id', 'f.nome', 'f.matricula', 'f.filial_id', 'f.setor_id', 'f.funcao_id', 'f.status',
        'fi.nome as filial', 's.nome as setor', 'fn.nome as funcao');
    if (req.query.filial_id) query.where('f.filial_id', req.query.filial_id);
    if (req.query.setor_id) query.where('f.setor_id', req.query.setor_id);
    if (req.query.funcionario_id) query.where('f.id', req.query.funcionario_id);

    const dataHoje = hoje();
    let itens = [];
    for (const f of await query) {
      const atual = await osVigenteDoFuncionario(knex, f);
      const base = { funcionario_id: f.id, funcionario: f.nome, matricula: f.matricula, filial: f.filial, setor: f.setor, funcao: f.funcao };
      if (atual.situacao !== 'ok') {
        itens.push({ ...base, situacao: atual.situacao, pgr_vencido: atual.pgr ? atual.pgr.data_fim < dataHoje : null });
        continue;
      }
      const ciencia = await cienciaValida(knex, atual.os.id, f.id);
      itens.push({
        ...base, situacao: ciencia ? 'em_dia' : 'ciencia_pendente', ordem_servico_id: atual.os.id,
        pgr_vencido: atual.pgr.data_fim < dataHoje, ciencia_em: ciencia ? ciencia.assinado_em : null,
        epis_nunca_entregues: await episNuncaEntregues(knex, f.id, atual.os.conteudo)
      });
    }
    if (req.query.situacao) itens = itens.filter((i) => i.situacao === req.query.situacao);
    else if (req.query.todas !== 'true') itens = itens.filter((i) => i.situacao !== 'em_dia' || i.pgr_vencido || (i.epis_nunca_entregues || []).length);
    itens.sort((a, b) => SITUACOES.indexOf(a.situacao) - SITUACOES.indexOf(b.situacao) || a.funcionario.localeCompare(b.funcionario));
    const resumo = Object.fromEntries(SITUACOES.map((s) => [s, itens.filter((i) => i.situacao === s).length]));
    return res.json({ resumo, itens });
  }
};
