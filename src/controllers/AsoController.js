// ASOs: lançamento do essencial do PDF da clínica, anulação, arquivo e pendências.
// LGPD: médico, riscos, exames, restrições e o PDF só para saude/admin. Os demais perfis
// enxergam o mínimo para organizar o trabalho: tipo, data, apto/inapto e vencimento.
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');
const { auditar } = require('../utils/auditoria');
const { podeAcessarFilial, noEscopo } = require('../utils/escopo');
const { hoje, dataValida, somarMeses } = require('../utils/datas');
const { UFS, exigirCampos, idValido } = require('../utils/validacao');
const { salvarArquivo } = require('../utils/arquivos');
const { situacaoDosAsos, TIPOS, RESULTADOS, SITUACOES } = require('../services/asos');
const { buscarNoEscopo } = require('./FuncionarioController');

const PERFIS_SAUDE = ['admin', 'saude'];
const veDetalhes = (req) => PERFIS_SAUDE.includes(req.usuario.perfil);
const CAMPOS_RESUMO = ['id', 'funcionario_id', 'filial_id', 'funcao_id', 'tipo', 'data_exame', 'resultado', 'data_vencimento', 'created_at'];

async function asoNoEscopo(trx, req, id) {
  if (!idValido(id)) throw new ErroDeNegocio(404, 'ASO não encontrado');
  const aso = await trx('asos').where({ id }).first();
  if (!aso || !podeAcessarFilial(req, aso.filial_id)) throw new ErroDeNegocio(404, 'ASO não encontrado');
  return aso;
}

function texto(valor) {
  if (valor === undefined || valor === null) return null;
  const t = String(valor).trim();
  return t.length ? t : null;
}

module.exports = {
  // GET /asos?funcionario_id=&tipo=&incluir_anulados=true
  async index(req, res) {
    const colunas = veDetalhes(req) ? ['a.*'] : CAMPOS_RESUMO.map((c) => `a.${c}`);
    const query = noEscopo(knex('asos as a'), req, 'a.filial_id')
      .join('funcionarios as f', 'f.id', 'a.funcionario_id')
      .leftJoin('aso_anulacoes as n', 'n.aso_id', 'a.id')
      .select(...colunas, 'f.nome as funcionario', 'f.matricula', knex.raw('(n.id is not null) as anulado'))
      .orderBy([{ column: 'a.data_exame', order: 'desc' }, { column: 'a.id', order: 'desc' }]);
    if (veDetalhes(req)) query.select('n.motivo as anulacao_motivo');
    if (req.query.funcionario_id) query.where('a.funcionario_id', req.query.funcionario_id);
    if (req.query.tipo) query.where('a.tipo', req.query.tipo);
    if (req.query.incluir_anulados !== 'true') query.whereNull('n.id');
    return res.json(await query);
  },

  // POST /asos { funcionario_id, tipo, data_exame, resultado, medico_nome, medico_crm, arquivo,
  //              medico_uf?, clinica?, riscos?, exames_complementares?, restricoes?, data_proximo_exame?, observacao? }
  async create(req, res) {
    exigirCampos(req.body, ['funcionario_id', 'tipo', 'data_exame', 'resultado', 'medico_nome', 'medico_crm', 'arquivo']);
    const b = req.body;
    if (!TIPOS.includes(b.tipo)) throw new ErroDeNegocio(400, `tipo deve ser: ${TIPOS.join(', ')}`);
    if (!RESULTADOS.includes(b.resultado)) throw new ErroDeNegocio(400, `resultado deve ser: ${RESULTADOS.join(', ')}`);
    if (!dataValida(b.data_exame) || b.data_exame > hoje()) throw new ErroDeNegocio(400, 'data_exame inválida ou futura');
    if (b.resultado === 'apto_restricao' && !texto(b.restricoes)) {
      throw new ErroDeNegocio(400, 'Apto com restrição: descreva as restrições');
    }
    const medicoUf = texto(b.medico_uf) && texto(b.medico_uf).toUpperCase();
    if (medicoUf && !UFS.includes(medicoUf)) throw new ErroDeNegocio(400, 'medico_uf inválida');

    // Vencimento: o que o médico indicou no ASO, ou a periodicidade da função no PCMSO
    const semVencimento = b.tipo === 'demissional' || b.resultado === 'inapto';
    if (b.data_proximo_exame !== undefined && b.data_proximo_exame !== null && b.data_proximo_exame !== '') {
      if (semVencimento) throw new ErroDeNegocio(400, 'ASO demissional ou inapto não tem próximo exame');
      if (!dataValida(b.data_proximo_exame) || b.data_proximo_exame <= b.data_exame) {
        throw new ErroDeNegocio(400, 'data_proximo_exame inválida: deve ser posterior à data do exame');
      }
    }

    const resultado = await knex.transaction(async (trx) => {
      const funcionario = await buscarNoEscopo(req, b.funcionario_id, trx);
      const funcao = funcionario.funcao_id
        ? await trx('funcoes').where({ id: funcionario.funcao_id }).first('periodicidade_aso_meses')
        : null;
      const periodicidade = (funcao && funcao.periodicidade_aso_meses) || 12;
      const vencimento = semVencimento ? null : (texto(b.data_proximo_exame) || somarMeses(b.data_exame, periodicidade));

      const arquivo = await salvarArquivo(trx, req, {
        base64: b.arquivo, contexto: 'aso', tipos: ['application/pdf', 'image/jpeg', 'image/png'],
        maxBytes: 10 * 1024 * 1024, filial_id: funcionario.filial_id, funcionario_id: funcionario.id
      });
      const [novo] = await trx('asos').insert({
        funcionario_id: funcionario.id,
        filial_id: funcionario.filial_id,
        funcao_id: funcionario.funcao_id,
        tipo: b.tipo,
        data_exame: b.data_exame,
        resultado: b.resultado,
        data_vencimento: vencimento,
        medico_nome: texto(b.medico_nome),
        medico_crm: texto(b.medico_crm),
        medico_uf: medicoUf || null,
        clinica: texto(b.clinica),
        riscos: texto(b.riscos),
        exames_complementares: texto(b.exames_complementares),
        restricoes: texto(b.restricoes),
        observacao: texto(b.observacao),
        arquivo_id: arquivo.id,
        registrado_por: req.usuario.id
      }).returning('*');
      await auditar(trx, req, { acao: 'registrar_aso', tabela: 'asos', registro_id: novo.id, filial_id: novo.filial_id, depois: { ...novo, sha256: arquivo.sha256 } });
      return novo;
    });
    return res.status(201).json(resultado);
  },

  // POST /asos/:id/anular { motivo }
  async anular(req, res) {
    const motivo = req.body && req.body.motivo;
    if (!motivo || String(motivo).trim().length < 5) throw new ErroDeNegocio(400, 'Informe o motivo (pelo menos 5 caracteres)');
    const resultado = await knex.transaction(async (trx) => {
      const aso = await asoNoEscopo(trx, req, req.params.id);
      if (await trx('aso_anulacoes').where({ aso_id: aso.id }).first('id')) throw new ErroDeNegocio(409, 'ASO já anulado');
      const [anulacao] = await trx('aso_anulacoes')
        .insert({ aso_id: aso.id, motivo: String(motivo).trim(), usuario_id: req.usuario.id }).returning('*');
      await auditar(trx, req, { acao: 'anular_aso', tabela: 'asos', registro_id: aso.id, filial_id: aso.filial_id, antes: aso, depois: anulacao });
      return anulacao;
    });
    return res.status(201).json(resultado);
  },

  // GET /asos/:id/arquivo — o PDF/imagem enviado pela clínica (saude/admin; cada acesso fica na auditoria)
  async arquivo(req, res) {
    const aso = await asoNoEscopo(knex, req, req.params.id);
    const arquivo = await knex('arquivos').where({ id: aso.arquivo_id }).first();
    await auditar(knex, req, { acao: 'baixar_aso', tabela: 'asos', registro_id: aso.id, filial_id: aso.filial_id });
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Arquivo-SHA256', arquivo.sha256);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Disposition', `inline; filename="aso-${aso.id}.${arquivo.tipo_mime === 'application/pdf' ? 'pdf' : 'img'}"`);
    return res.type(arquivo.tipo_mime).send(arquivo.conteudo);
  },

  // GET /asos/pendencias?filial_id=&setor_id=&funcionario_id=&situacao=&dias=30&todas=true
  async pendencias(req, res) {
    const dias = req.query.dias !== undefined ? Number(req.query.dias) : 30;
    if (!Number.isInteger(dias) || dias < 0 || dias > 365) throw new ErroDeNegocio(400, 'dias deve ser um inteiro entre 0 e 365');
    if (req.query.situacao && !SITUACOES.includes(req.query.situacao)) {
      throw new ErroDeNegocio(400, `situacao deve ser: ${SITUACOES.join(', ')}`);
    }

    const query = noEscopo(knex('funcionarios as f'), req, 'f.filial_id')
      .join('filiais as fi', 'fi.id', 'f.filial_id')
      .leftJoin('setores as s', 's.id', 'f.setor_id')
      .leftJoin('funcoes as fn', 'fn.id', 'f.funcao_id')
      .select('f.id', 'f.nome', 'f.matricula', 'f.status', 'f.data_demissao', 'f.filial_id',
        'fi.nome as filial', 'fi.grau_risco', 's.nome as setor', 'fn.nome as funcao');
    if (req.query.filial_id) query.where('f.filial_id', req.query.filial_id);
    if (req.query.setor_id) query.where('f.setor_id', req.query.setor_id);
    if (req.query.funcionario_id) query.where('f.id', req.query.funcionario_id);

    let linhas = await situacaoDosAsos(knex, await query, { dias });
    if (req.query.situacao) linhas = linhas.filter((l) => l.situacao === req.query.situacao);
    else if (req.query.todas !== 'true') linhas = linhas.filter((l) => l.situacao !== 'em_dia');

    const resumo = Object.fromEntries(SITUACOES.map((s) => [s, linhas.filter((l) => l.situacao === s).length]));
    return res.json({ resumo, itens: linhas });
  }
};
