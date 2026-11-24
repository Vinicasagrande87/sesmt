// Regras da permissão de trabalho: tipos, papéis obrigatórios, checklist de cada tipo, limites da atmosfera
// (espaço confinado), conferência de treinamento e ASO de cada participante e situação das permissões.
const { hoje, dataLocal, fimDoDia, somarDias } = require('../utils/datas');
const { noEscopo } = require('../utils/escopo');

const PAPEIS = { executante: 'Executante', vigia: 'Vigia', supervisor_entrada: 'Supervisor de entrada', observador: 'Observador de fogo' };

// nr: treinamento que vale quando a matriz não definiu os cursos por papel; papeis: mínimo de pessoas em cada papel
const TIPOS = {
  altura: {
    nome: 'Trabalho em altura', nr: 'NR-35', papeis: { executante: 1 },
    checklist: [
      ['analise_risco', 'Análise de risco da tarefa feita e comunicada à equipe'],
      ['ancoragem', 'Ponto de ancoragem inspecionado e adequado'],
      ['equipamentos', 'Cinto paraquedista, talabarte e trava-quedas inspecionados'],
      ['isolamento', 'Área abaixo isolada e sinalizada'],
      ['clima', 'Condições climáticas adequadas (sem chuva forte, ventos ou raios)'],
      ['resgate', 'Plano de resgate com equipe e material disponíveis'],
      ['queda_objetos', 'Ferramentas presas e sem risco de queda de objetos']
    ]
  },
  espaco_confinado: {
    nome: 'Espaço confinado (PET)', nr: 'NR-33', papeis: { executante: 1, vigia: 1, supervisor_entrada: 1 }, medicao: true,
    checklist: [
      ['identificacao', 'Espaço confinado identificado e sinalizado'],
      ['bloqueio_energias', 'Energias e fluidos bloqueados e etiquetados'],
      ['ventilacao', 'Ventilação / purga realizada'],
      ['monitoramento_continuo', 'Monitoramento contínuo da atmosfera durante o trabalho'],
      ['comunicacao', 'Comunicação entre vigia e trabalhadores testada'],
      ['resgate', 'Equipamento e equipe de resgate disponíveis'],
      ['equipamentos_atmosfera', 'Iluminação e equipamentos adequados à atmosfera']
    ]
  },
  quente: {
    nome: 'Trabalho a quente', nr: null, papeis: { executante: 1, observador: 1 },
    checklist: [
      ['inflamaveis', 'Raio de 11 m livre de combustíveis/inflamáveis, ou protegido'],
      ['extintor', 'Extintor adequado no local'],
      ['atmosfera', 'Sem atmosfera explosiva (medir quando houver suspeita)'],
      ['aberturas', 'Aberturas, pisos e paredes protegidos contra fagulhas'],
      ['equipamento', 'Máquina de solda / maçarico, mangueiras e válvulas inspecionados'],
      ['observacao_final', 'Observador de fogo até 30 minutos após o término']
    ]
  },
  eletricidade: {
    nome: 'Serviço em eletricidade', nr: 'NR-10', papeis: { executante: 1 },
    // NR-10, 10.5.1: sequência de desenergização
    checklist: [
      ['seccionamento', 'Seccionamento'],
      ['impedimento', 'Impedimento de reenergização (bloqueio e etiqueta)'],
      ['ausencia_tensao', 'Constatação da ausência de tensão'],
      ['aterramento', 'Aterramento temporário com equipotencialização'],
      ['protecao_energizados', 'Proteção dos elementos energizados na zona controlada'],
      ['sinalizacao', 'Sinalização de impedimento de reenergização'],
      ['epi_ferramentas', 'EPIs e ferramentas isoladas adequados à tensão']
    ]
  }
};

const VALIDADE_MAX_HORAS = 12;
// O2 entre 19,5% e 23%; LIE abaixo de 10%; H2S e CO abaixo dos limites de tolerância da NR-15 (8 e 39 ppm)
const LIMITES = { o2: [19.5, 23], lie: [null, 10], h2s: [null, 8], co: [null, 39] };
const SITUACOES = ['vencida_sem_encerramento', 'aguardando_assinaturas', 'liberada', 'programada', 'encerrada'];

const numero = (p) => `${p.ano}/${String(p.sequencial).padStart(4, '0')}`;
const nr = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Medição: { o2, lie, h2s?, co? } -> { valores, dentro, fora: ['O2 18% (mín. 19,5)'] }
function avaliarMedicao(m, { exigir = true } = {}) {
  const valores = {};
  const fora = [];
  const faltando = [];
  for (const [campo, [min, max]] of Object.entries(LIMITES)) {
    const v = m && m[campo];
    if (v === undefined || v === null || v === '') {
      if (exigir && (campo === 'o2' || campo === 'lie')) faltando.push(campo.toUpperCase());
      valores[campo] = null;
      continue;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100000) return { erro: `${campo} inválido` };
    valores[campo] = n;
    const rotulo = campo === 'o2' || campo === 'lie' ? `${campo.toUpperCase()} ${n}%` : `${campo.toUpperCase()} ${n} ppm`;
    if (min !== null && n < min) fora.push(`${rotulo} (mínimo ${String(min).replace('.', ',')})`);
    if (max !== null && n >= max && !(campo === 'o2' && n === max)) fora.push(`${rotulo} (limite ${String(max).replace('.', ',')})`);
  }
  if (faltando.length) return { erro: `Medição incompleta: informe ${faltando.join(' e ')}` };
  return { valores, dentro: !fora.length, fora };
}

// Confere cada participante para o tipo de permissão, válido até a data do fim do trabalho.
// participantes: [{ funcionario: {id, nome, matricula, status}, papel }]
async function conferirParticipantes(db, tipo, participantes, dataFim) {
  const config = TIPOS[tipo];
  const ids = participantes.map((p) => p.funcionario.id);
  const exigencias = await db('pt_exigencias as e').join('treinamentos as t', 't.id', 'e.treinamento_id').where('e.tipo', tipo)
    .select('e.papel', 't.id', 't.nome_treinamento', 't.nr_referencia');
  const doNr = config.nr ? (await db('treinamentos').where('ativo', true).select('id', 'nome_treinamento', 'nr_referencia')).filter((t) => nr(t.nr_referencia) === nr(config.nr)) : [];
  const certs = ids.length ? await db('certificados_treinamentos as c').leftJoin('certificado_anulacoes as a', 'a.certificado_id', 'c.id')
    .whereIn('c.funcionario_id', ids).whereNull('a.id').where('c.status', 'Aprovado').where('c.data_realizacao', '<=', hoje())
    .select('c.id', 'c.funcionario_id', 'c.treinamento_id', 'c.data_realizacao', 'c.data_vencimento') : [];
  const asos = ids.length ? await db('asos as a').leftJoin('aso_anulacoes as n', 'n.aso_id', 'a.id').whereIn('a.funcionario_id', ids).whereNull('n.id')
    .whereNot('a.tipo', 'demissional').orderBy([{ column: 'a.data_exame', order: 'desc' }, { column: 'a.id', order: 'desc' }])
    .select('a.id', 'a.funcionario_id', 'a.data_exame', 'a.resultado', 'a.data_vencimento') : [];

  const valido = (c) => !c.data_vencimento || c.data_vencimento >= dataFim;
  const melhor = (lista) => lista.sort((a, b) => String(b.data_vencimento || '9999').localeCompare(String(a.data_vencimento || '9999')))[0];

  return participantes.map(({ funcionario: f, papel }) => {
    const problemas = [];
    const treinamentos = [];
    if (f.status !== 'Ativo') problemas.push(`funcionário ${String(f.status).toLowerCase()}`);
    const configurados = exigencias.filter((e) => e.papel === papel);
    if (configurados.length) {
      for (const t of configurados) {
        const c = melhor(certs.filter((x) => x.funcionario_id === f.id && x.treinamento_id === t.id));
        treinamentos.push({ treinamento: t.nome_treinamento, nr: t.nr_referencia, certificado_id: c ? c.id : null, vencimento: c ? c.data_vencimento : null });
        if (!c) problemas.push(`sem ${t.nome_treinamento}`);
        else if (!valido(c)) problemas.push(`${t.nome_treinamento} vencido em ${c.data_vencimento.split('-').reverse().join('/')}`);
      }
    } else if (config.nr && papel !== 'observador') {
      if (!doNr.length) problemas.push(`não há treinamento ${config.nr} no catálogo da matriz`);
      else {
        const c = melhor(certs.filter((x) => x.funcionario_id === f.id && doNr.some((t) => t.id === x.treinamento_id)));
        const t = c && doNr.find((x) => x.id === c.treinamento_id);
        treinamentos.push({ treinamento: t ? t.nome_treinamento : config.nr, nr: config.nr, certificado_id: c ? c.id : null, vencimento: c ? c.data_vencimento : null });
        if (!c) problemas.push(`sem treinamento ${config.nr}`);
        else if (!valido(c)) problemas.push(`${config.nr} vencido em ${c.data_vencimento.split('-').reverse().join('/')}`);
      }
    }
    const aso = asos.find((a) => a.funcionario_id === f.id);
    if (!aso) problemas.push('sem ASO');
    else if (aso.resultado === 'inapto') problemas.push('ASO inapto');
    else if (aso.resultado === 'apto_restricao') problemas.push('ASO apto com restrição (avaliar com o médico antes de liberar)');
    else if (aso.data_vencimento && aso.data_vencimento < dataFim) problemas.push(`ASO vencido em ${aso.data_vencimento.split('-').reverse().join('/')}`);
    return {
      funcionario_id: f.id, funcionario: f.nome, matricula: f.matricula, papel, ok: !problemas.length, problemas,
      conferencia: { em: new Date().toISOString(), valido_ate: dataFim, treinamentos, aso: aso ? { id: aso.id, data_exame: aso.data_exame, resultado: aso.resultado, vencimento: aso.data_vencimento } : null }
    };
  });
}

// Situação das permissões (dos últimos 30 dias ou ainda em aberto). Hoje: no instante atual; data-base: no fim daquele dia.
async function situacaoPermissoes(db, req, filtros = {}, { dataBase = null } = {}) {
  const dataRef = dataBase || hoje();
  const ref = dataBase ? fimDoDia(dataBase) : new Date();
  const q = noEscopo(db('permissoes_trabalho as p'), req, 'p.filial_id').join('filiais as f', 'f.id', 'p.filial_id')
    .where('p.inicio', '>=', new Date(`${somarDias(dataRef, -30)}T00:00:00-03:00`)).where('p.created_at', '<', ref)
    .orderBy('p.inicio', 'desc').select('p.*', 'f.nome as filial',
      db.raw('(select count(*)::int from pt_participantes x where x.pt_id = p.id) as participantes'),
      db.raw('(select count(*)::int from pt_participantes x join pt_assinaturas s on s.participante_id = x.id where x.pt_id = p.id and s.assinado_em < ?) as assinaturas', [ref]));
  if (filtros.filial_id) q.where('p.filial_id', filtros.filial_id);
  const itens = [];
  for (const p of await q) {
    if (p.cancelada_em && new Date(p.cancelada_em) < ref) continue;
    let situacao;
    if (p.encerrada_em && new Date(p.encerrada_em) < ref) situacao = 'encerrada';
    else if (new Date(p.fim) < ref) situacao = 'vencida_sem_encerramento';
    else if (new Date(p.inicio) > ref) situacao = 'programada';
    else situacao = p.assinaturas < p.participantes ? 'aguardando_assinaturas' : 'liberada';
    itens.push({
      pt_id: p.id, numero: numero(p), filial_id: p.filial_id, filial: p.filial, tipo: p.tipo, local: p.local_descricao,
      inicio: p.inicio, fim: p.fim, data: dataLocal(p.inicio), status: p.status, situacao, participantes: p.participantes, assinaturas: p.assinaturas
    });
  }
  return itens.sort((a, b) => SITUACOES.indexOf(a.situacao) - SITUACOES.indexOf(b.situacao) || new Date(b.inicio) - new Date(a.inicio));
}

module.exports = { PAPEIS, TIPOS, VALIDADE_MAX_HORAS, LIMITES, SITUACOES, numero, avaliarMedicao, conferirParticipantes, situacaoPermissoes };
