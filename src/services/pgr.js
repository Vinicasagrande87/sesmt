// Regras do PGR: classificação de risco (matriz AIHA), validação dos grupos de exposição,
// "fotografia" do conteúdo da ordem de serviço e localização da OS de cada funcionário.
const crypto = require('crypto');
const { ErroDeNegocio } = require('../utils/erros');
const { idValido } = require('../utils/validacao');

const CATEGORIAS = { fisico: 'Físico', quimico: 'Químico', biologico: 'Biológico', acidente: 'Acidente', ergonomico: 'Ergonômico' };
const PARTES_CORPO = {
  cabeca: 'Cabeça', visao: 'Visão', facial: 'Facial', respiratoria: 'Respiratória', auditiva: 'Auditiva',
  cervical: 'Cervical', maos: 'Mãos', membros_superiores: 'Membros superiores', pes: 'Pés',
  membros_inferiores: 'Membros inferiores', corpo: 'Corpo'
};
const NIVEIS = { trivial: 'Trivial', baixo: 'Baixo', moderado: 'Moderado', alto: 'Alto', muito_alto: 'Muito alto' };

// Matriz AIHA (linhas = efeito 1..5, colunas = probabilidade 1..5), como no capítulo 7.3 do PGR
const T = 'trivial', B = 'baixo', M = 'moderado', A = 'alto', MA = 'muito_alto';
const MATRIZ = [
  [T, T, T, T, B],
  [T, B, B, B, M],
  [T, B, M, M, M],
  [T, M, M, A, A],
  [B, M, M, A, MA]
];

function nivelDoRisco(probabilidade, efeito) {
  if (probabilidade == null && efeito == null) return null;
  const p = Number(probabilidade), e = Number(efeito);
  if (![p, e].every((v) => Number.isInteger(v) && v >= 1 && v <= 5)) {
    throw new ErroDeNegocio(400, 'probabilidade e efeito devem ser informados juntos, de 1 a 5');
  }
  return MATRIZ[e - 1][p - 1];
}

const texto = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
const chave = (v) => String(v || '').trim().toLocaleLowerCase('pt-BR');

// Normaliza e valida um grupo de exposição. Setor e funções podem vir por id ou por nome
// (facilita importar a planilha montada a partir do PDF).
async function validarGrupo(trx, pgr, b) {
  if (!b || typeof b !== 'object') throw new ErroDeNegocio(400, 'Grupo inválido');
  const atividade = texto(b.atividade);
  if (!atividade) throw new ErroDeNegocio(400, 'atividade é obrigatória');

  const setores = await trx('setores').whereIn('filial_id', pgr.filial_ids).select('id', 'nome', 'filial_id');
  let setor;
  if (b.setor_id !== undefined) setor = setores.find((s) => s.id === Number(b.setor_id));
  else if (b.setor !== undefined) {
    const achados = setores.filter((s) => chave(s.nome) === chave(b.setor));
    if (achados.length > 1) throw new ErroDeNegocio(400, `Setor "${b.setor}" existe em mais de uma filial deste PGR: informe setor_id`);
    setor = achados[0];
  }
  if (!setor) throw new ErroDeNegocio(400, `Setor ${b.setor_id || `"${b.setor}"`} não encontrado nas filiais deste PGR`);

  const pedidas = Array.isArray(b.funcoes) ? b.funcoes : Array.isArray(b.funcao_ids) ? b.funcao_ids : [];
  if (!pedidas.length) throw new ErroDeNegocio(400, 'Informe as funções expostas (funcoes: nomes ou funcao_ids)');
  const catalogo = await trx('funcoes').select('id', 'nome', 'ativa');
  const funcaoIds = new Set();
  const faltando = [];
  for (const f of pedidas) {
    const achada = typeof f === 'number' || /^\d+$/.test(String(f))
      ? catalogo.find((c) => c.id === Number(f))
      : catalogo.find((c) => chave(c.nome) === chave(f));
    if (!achada) faltando.push(String(f));
    else funcaoIds.add(achada.id);
  }
  if (faltando.length) {
    throw new ErroDeNegocio(400, 'Funções não cadastradas no catálogo da matriz', { funcoes: faltando });
  }

  const riscos = (b.riscos || []).map((r, i) => {
    if (!CATEGORIAS[r.categoria]) throw new ErroDeNegocio(400, `riscos[${i}].categoria deve ser: ${Object.keys(CATEGORIAS).join(', ')}`);
    if (!texto(r.agente)) throw new ErroDeNegocio(400, `riscos[${i}].agente é obrigatório`);
    return {
      categoria: r.categoria, agente: texto(r.agente), referencia: texto(r.referencia), fonte_geradora: texto(r.fonte_geradora),
      exposicao: texto(r.exposicao), medicao: texto(r.medicao), epc: texto(r.epc),
      probabilidade: r.probabilidade ?? null, efeito: r.efeito ?? null, nivel: nivelDoRisco(r.probabilidade, r.efeito)
    };
  });

  const epiIds = new Set((await trx('epis').select('id')).map((e) => e.id));
  const epis = (b.epis || []).map((e, i) => {
    if (!PARTES_CORPO[e.parte_corpo]) throw new ErroDeNegocio(400, `epis[${i}].parte_corpo deve ser: ${Object.keys(PARTES_CORPO).join(', ')}`);
    if (!texto(e.descricao)) throw new ErroDeNegocio(400, `epis[${i}].descricao é obrigatória`);
    if (e.epi_id != null && (!idValido(e.epi_id) || !epiIds.has(Number(e.epi_id)))) throw new ErroDeNegocio(400, `epis[${i}].epi_id não existe no catálogo`);
    return { parte_corpo: e.parte_corpo, descricao: texto(e.descricao), epi_id: e.epi_id != null ? Number(e.epi_id) : null };
  });

  const treinamentoIds = new Set((await trx('treinamentos').select('id')).map((t) => t.id));
  const treinamentos = (b.treinamentos || []).map((t, i) => {
    const item = typeof t === 'string' ? { descricao: t } : t;
    if (!texto(item.descricao)) throw new ErroDeNegocio(400, `treinamentos[${i}].descricao é obrigatória`);
    if (item.treinamento_id != null && (!idValido(item.treinamento_id) || !treinamentoIds.has(Number(item.treinamento_id)))) {
      throw new ErroDeNegocio(400, `treinamentos[${i}].treinamento_id não existe no catálogo`);
    }
    return { descricao: texto(item.descricao), treinamento_id: item.treinamento_id != null ? Number(item.treinamento_id) : null };
  });

  if (b.conclusao_gfip != null && !/^\d{2}$/.test(String(b.conclusao_gfip))) throw new ErroDeNegocio(400, 'conclusao_gfip deve ter 2 dígitos (ex.: 01, 04)');

  return {
    grupo: {
      setor_id: setor.id, atividade,
      descricao_atividades: texto(b.descricao_atividades), medidas_controle: texto(b.medidas_controle),
      observacao_epi: texto(b.observacao_epi), unidade_fisica: texto(b.unidade_fisica),
      conclusao_gfip: b.conclusao_gfip != null ? String(b.conclusao_gfip) : null,
      ordem: Number.isInteger(Number(b.ordem)) ? Number(b.ordem) : 0
    },
    funcaoIds: [...funcaoIds], riscos, epis, treinamentos
  };
}

// Grava o grupo e seus itens. Recusa (setor, função) repetidos no mesmo PGR com mensagem clara.
async function gravarGrupo(trx, pgrId, dados, grupoId = null) {
  const conflito = await trx('pgr_grupo_funcoes as gf')
    .join('funcoes as f', 'f.id', 'gf.funcao_id')
    .where({ 'gf.pgr_id': pgrId, 'gf.setor_id': dados.grupo.setor_id })
    .whereIn('gf.funcao_id', dados.funcaoIds)
    .modify((q) => { if (grupoId) q.whereNot('gf.grupo_id', grupoId); })
    .select('f.nome');
  if (conflito.length) {
    throw new ErroDeNegocio(409, 'Função já está em outro grupo do mesmo setor neste PGR', { funcoes: conflito.map((c) => c.nome) });
  }

  let id = grupoId;
  if (id) {
    await trx('pgr_grupos').where({ id }).update(dados.grupo);
    for (const t of ['pgr_grupo_funcoes', 'pgr_riscos', 'pgr_epis', 'pgr_treinamentos']) await trx(t).where({ grupo_id: id }).del();
  } else {
    [{ id }] = await trx('pgr_grupos').insert({ ...dados.grupo, pgr_id: pgrId }).returning('id');
  }
  await trx('pgr_grupo_funcoes').insert(dados.funcaoIds.map((funcao_id) => ({ grupo_id: id, pgr_id: pgrId, setor_id: dados.grupo.setor_id, funcao_id })));
  if (dados.riscos.length) await trx('pgr_riscos').insert(dados.riscos.map((r) => ({ ...r, grupo_id: id })));
  if (dados.epis.length) await trx('pgr_epis').insert(dados.epis.map((e) => ({ ...e, grupo_id: id })));
  if (dados.treinamentos.length) await trx('pgr_treinamentos').insert(dados.treinamentos.map((t) => ({ ...t, grupo_id: id })));
  return id;
}

// Carrega o grupo completo (para exibir, clonar ou fotografar)
async function carregarGrupo(trx, grupoId) {
  const grupo = await trx('pgr_grupos as g').join('setores as s', 's.id', 'g.setor_id')
    .where('g.id', grupoId).first('g.*', 's.nome as setor', 's.filial_id');
  // Em sequência: dentro de transação há uma conexão só (consultas em paralelo nela são inválidas)
  const funcoes = await trx('pgr_grupo_funcoes as gf').join('funcoes as f', 'f.id', 'gf.funcao_id').where('gf.grupo_id', grupoId)
    .orderBy('f.nome').select('f.id', 'f.nome');
  const riscos = await trx('pgr_riscos').where({ grupo_id: grupoId }).orderBy('id');
  const epis = await trx('pgr_epis as e').leftJoin('epis', 'epis.id', 'e.epi_id').where('e.grupo_id', grupoId).orderBy('e.id')
    .select('e.*', 'epis.nome as epi_catalogo');
  const treinamentos = await trx('pgr_treinamentos as t').leftJoin('treinamentos as tr', 'tr.id', 't.treinamento_id')
    .where('t.grupo_id', grupoId).orderBy('t.id').select('t.*', 'tr.nome_treinamento as treinamento_catalogo', 'tr.nr_referencia');
  return { ...grupo, funcoes, riscos, epis, treinamentos };
}

// Textos fixos da OS (NR-1, itens 1.4.1 a 1.4.4; CLT art. 158)
const TEXTOS_OS = {
  obrigacoes: [
    'Cumprir as disposições legais e regulamentares sobre segurança e saúde no trabalho, inclusive esta ordem de serviço.',
    'Usar os EPIs fornecidos somente para a finalidade a que se destinam, responsabilizar-se pela guarda e conservação e comunicar qualquer alteração que os torne impróprios para uso.',
    'Submeter-se aos exames médicos ocupacionais previstos no PCMSO.',
    'Participar dos treinamentos de segurança indicados para a sua atividade.',
    'Colaborar com a organização na aplicação das Normas Regulamentadoras.'
  ],
  proibicoes: [
    'Executar atividade para a qual não tenha recebido treinamento ou autorização, quando exigidos.',
    'Trabalhar sem os EPIs indicados nesta ordem de serviço.',
    'Remover, desativar ou inutilizar proteções de máquinas, equipamentos e instalações.',
    'Improvisar ferramentas, escadas ou meios de acesso.'
  ],
  acidente: [
    'Interromper a atividade e comunicar imediatamente a chefia imediata e o SESMT.',
    'Procurar atendimento médico, mesmo em lesões que pareçam leves, e informar que foi acidente de trabalho.',
    'Sempre que possível, preservar o local até a avaliação do SESMT.',
    'Em situação de risco grave e iminente, o trabalhador pode interromper a atividade e comunicar a chefia (NR-1, item 1.4.3).'
  ],
  ciencia: 'Declaro que recebi esta ordem de serviço, que fui informado dos riscos da minha atividade e das medidas de prevenção, ' +
    'e que estou ciente de que a recusa injustificada ao cumprimento das ordens de serviço e ao uso dos EPIs fornecidos ' +
    'constitui ato faltoso (CLT, art. 158, parágrafo único).'
};

async function conteudoDaOS(trx, pgr, grupoId) {
  const g = await carregarGrupo(trx, grupoId);
  const filiais = await trx('filiais').whereIn('id', pgr.filial_ids).orderBy('nome').select('nome', 'razao_social', 'cnpj', 'cidade', 'uf');
  return {
    pgr: {
      id: pgr.id, titulo: pgr.titulo, data_inicio: pgr.data_inicio, data_fim: pgr.data_fim,
      responsavel: [pgr.responsavel_nome, pgr.responsavel_titulacao, pgr.responsavel_registro].filter(Boolean).join(' — ')
    },
    filiais,
    setor: g.setor,
    atividade: g.atividade,
    descricao_atividades: g.descricao_atividades,
    funcoes: g.funcoes.map((f) => f.nome),
    riscos: g.riscos.map((r) => ({
      categoria: CATEGORIAS[r.categoria], agente: r.agente, referencia: r.referencia, fonte_geradora: r.fonte_geradora,
      exposicao: r.exposicao, medicao: r.medicao, epc: r.epc, nivel: r.nivel ? NIVEIS[r.nivel] : null
    })),
    medidas_controle: g.medidas_controle,
    epis: g.epis.map((e) => ({ parte_corpo: PARTES_CORPO[e.parte_corpo], descricao: e.descricao, epi_id: e.epi_id })),
    observacao_epi: g.observacao_epi,
    treinamentos: g.treinamentos.map((t) => t.descricao),
    ...TEXTOS_OS
  };
}

const hashDoConteudo = (conteudo) => crypto.createHash('sha256').update(JSON.stringify(conteudo)).digest('hex');

// OS que vale hoje para o funcionário: PGR vigente da filial + grupo do setor/função atuais
async function osVigenteDoFuncionario(trx, funcionario) {
  const pgr = await trx('pgrs as p').join('pgr_filiais as pf', 'pf.pgr_id', 'p.id')
    .where({ 'pf.filial_id': funcionario.filial_id, 'p.status': 'vigente' })
    .orderBy('p.publicado_em', 'desc').first('p.*');
  if (!pgr) return { situacao: 'sem_pgr' };
  const os = await trx('pgr_grupo_funcoes as gf')
    .join('ordens_servico as os', 'os.grupo_id', 'gf.grupo_id')
    .where({ 'gf.pgr_id': pgr.id, 'gf.setor_id': funcionario.setor_id, 'gf.funcao_id': funcionario.funcao_id })
    .first('os.*');
  if (!os) return { situacao: 'sem_grupo', pgr };
  return { situacao: 'ok', pgr, os };
}

module.exports = {
  CATEGORIAS, PARTES_CORPO, NIVEIS, TEXTOS_OS,
  nivelDoRisco, validarGrupo, gravarGrupo, carregarGrupo, conteudoDaOS, hashDoConteudo, osVigenteDoFuncionario
};
