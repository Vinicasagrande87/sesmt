// Registros de capacitação: gerados no encerramento das turmas ou lançados como certificado externo.
// Não são editados: registro errado se anula.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { ehAdmin, podeAcessarFilial, noEscopo } = require('../utils/escopo');
const { hoje, dataValida, somarMeses } = require('../utils/datas');
const { exigirCampos, idValido } = require('../utils/validacao');
const { salvarArquivo } = require('../utils/arquivos');
const { gerarCodigo } = require('../utils/codigo');
const { situacaoTreinamentos, SITUACOES } = require('../services/treinamentos');
const { lerDataBase, lerDias, filtrarPendencias } = require('../services/historico');
const { buscarNoEscopo } = require('./FuncionarioController');
const { gerarCertificado } = require('../relatorios/certificado');

async function certificadoNoEscopo(trx, req, id) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'Registro não encontrado');
  const c = await trx('certificados_treinamentos as c')
    .join('funcionarios as f', 'f.id', 'c.funcionario_id')
    .where('c.id', id)
    .first('c.*', 'f.filial_id');
  const visivel = c && (c.filial_id ? podeAcessarFilial(req, c.filial_id) : ehAdmin(req));
  if (!visivel) throw new ErroDeNegocio(404, 'Registro não encontrado');
  return c;
}

module.exports = {
  // GET /certificados?funcionario_id=&treinamento_id=&incluir_anulados=true
  async index(req, res) {
    const query = noEscopo(knex('certificados_treinamentos as c'), req, 'f.filial_id')
      .join('funcionarios as f', 'f.id', 'c.funcionario_id')
      .join('treinamentos as t', 't.id', 'c.treinamento_id')
      .leftJoin('certificado_anulacoes as a', 'a.certificado_id', 'c.id')
      .select('c.*', 'f.nome as funcionario', 'f.matricula', 't.nome_treinamento', 't.nr_referencia as nr',
        knex.raw('(a.id is not null) as anulado'), 'a.motivo as anulacao_motivo')
      .orderBy([{ column: 'c.data_realizacao', order: 'desc' }, { column: 'c.id', order: 'desc' }]);
    if (req.query.funcionario_id) query.where('c.funcionario_id', req.query.funcionario_id);
    if (req.query.treinamento_id) query.where('c.treinamento_id', req.query.treinamento_id);
    if (req.query.incluir_anulados !== 'true') query.whereNull('a.id');
    return res.json(await query);
  },

  // POST /certificados — curso feito fora: { funcionario_id, treinamento_id, data_realizacao, instituicao, arquivo, carga_horaria?, instrutor? }
  async createExterno(req, res) {
    exigirCampos(req.body, ['funcionario_id', 'treinamento_id', 'data_realizacao', 'instituicao', 'arquivo']);
    const b = req.body;
    if (!idValido(b.treinamento_id)) throw new ErroDeNegocio(400, 'treinamento_id inválido');
    if (!dataValida(b.data_realizacao) || b.data_realizacao > hoje()) throw new ErroDeNegocio(400, 'data_realizacao inválida ou futura');

    const resultado = await knex.transaction(async (trx) => {
      const funcionario = await buscarNoEscopo(req, b.funcionario_id, trx);
      const treinamento = await trx('treinamentos').where({ id: b.treinamento_id }).first();
      if (!treinamento) throw new ErroDeNegocio(404, 'Treinamento não encontrado');
      const carga = b.carga_horaria !== undefined ? Number(b.carga_horaria) : treinamento.carga_horaria;
      if (!Number.isInteger(carga) || carga < 1) throw new ErroDeNegocio(400, 'carga_horaria inválida');

      const arquivo = await salvarArquivo(trx, req, {
        base64: b.arquivo, contexto: 'certificado_externo', tipos: ['application/pdf', 'image/jpeg', 'image/png'],
        maxBytes: 10 * 1024 * 1024, filial_id: funcionario.filial_id, funcionario_id: funcionario.id
      });
      const [novo] = await trx('certificados_treinamentos').insert({
        funcionario_id: funcionario.id,
        treinamento_id: treinamento.id,
        origem: 'externo',
        data_realizacao: b.data_realizacao,
        data_vencimento: treinamento.validade_meses ? somarMeses(b.data_realizacao, treinamento.validade_meses) : null,
        carga_horaria: carga,
        instituicao: b.instituicao,
        instrutor: b.instrutor || null,
        status: 'Aprovado',
        arquivo_id: arquivo.id,
        registrado_por: req.usuario.id,
        codigo_verificacao: gerarCodigo()
      }).returning('*');
      await auditar(trx, req, { acao: 'certificado_externo', tabela: 'certificados_treinamentos', registro_id: novo.id, filial_id: funcionario.filial_id, depois: { ...novo, sha256: arquivo.sha256 } });
      return novo;
    });
    return res.status(201).json(resultado);
  },

  // POST /certificados/:id/anular { motivo } — gestão
  async anular(req, res) {
    const motivo = req.body && req.body.motivo;
    if (!motivo || String(motivo).trim().length < 5) throw new ErroDeNegocio(400, 'Informe o motivo (pelo menos 5 caracteres)');
    const resultado = await knex.transaction(async (trx) => {
      const c = await certificadoNoEscopo(trx, req, req.params.id);
      if (await trx('certificado_anulacoes').where({ certificado_id: c.id }).first('id')) throw new ErroDeNegocio(409, 'Registro já anulado');
      const [anulacao] = await trx('certificado_anulacoes')
        .insert({ certificado_id: c.id, motivo: String(motivo).trim(), usuario_id: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'anular_certificado', tabela: 'certificados_treinamentos', registro_id: c.id, filial_id: c.filial_id, antes: c, depois: anulacao });
      return anulacao;
    });
    return res.status(201).json(resultado);
  },

  // GET /certificados/:id/pdf — certificado da turma (externo: devolve o arquivo enviado)
  async pdf(req, res) {
    const c = await certificadoNoEscopo(knex, req, req.params.id);
    if (await knex('certificado_anulacoes').where({ certificado_id: c.id }).first('id')) throw new ErroDeNegocio(409, 'Registro anulado');
    if (c.status !== 'Aprovado') throw new ErroDeNegocio(409, 'Participante reprovado: não há certificado');

    if (c.origem !== 'turma') {
      if (!c.arquivo_id) throw new ErroDeNegocio(404, 'Registro sem arquivo');
      const arquivo = await knex('arquivos').where({ id: c.arquivo_id }).first();
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('X-Arquivo-SHA256', arquivo.sha256);
      return res.type(arquivo.tipo_mime).send(arquivo.conteudo);
    }

    const [funcionario, treinamento, turma] = await Promise.all([
      knex('funcionarios').where({ id: c.funcionario_id }).first('nome', 'cpf'),
      knex('treinamentos').where({ id: c.treinamento_id }).first(),
      knex('turmas').where({ id: c.turma_id }).first()
    ]);
    const filial = await knex('filiais').where({ id: turma.filial_id }).first();
    const doc = gerarCertificado({
      certificado: c, funcionario, treinamento, turma, filial, emitidoPor: req.usuario.nome,
      urlVerificacao: `${req.protocol}://${req.get('host')}/verificar/`
    });
    await auditar(knex, req, { acao: 'emitir_certificado', tabela: 'certificados_treinamentos', registro_id: c.id, filial_id: c.filial_id });
    res.type('application/pdf');
    res.set('Content-Disposition', `inline; filename="certificado-${c.codigo_verificacao}.pdf"`);
    doc.pipe(res);
  },

  // GET /treinamentos/pendencias?filial_id=&setor_id=&situacao=vencido&dias=30
  // Por padrão lista só o que precisa de ação (faltando, vencido, vencendo).
  // ?data_base=AAAA-MM-DD: como estava naquela data
  async pendencias(req, res) {
    const dias = lerDias(req.query, 'dias', 30);
    const { dataBase } = lerDataBase(req.query);
    if (req.query.situacao && !SITUACOES.includes(req.query.situacao)) {
      throw new ErroDeNegocio(400, `situacao deve ser: ${SITUACOES.join(', ')}`);
    }
    const linhas = await situacaoTreinamentos(knex, req, req.query, { dias, dataBase });
    return res.json({ data_base: dataBase || hoje(), ...filtrarPendencias(linhas, SITUACOES, req.query) });
  }
};
