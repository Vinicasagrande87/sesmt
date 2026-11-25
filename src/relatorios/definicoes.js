// Relatórios emitidos em PDF/Excel: título, colunas e como cada item vira uma linha.
// Toda coluna tem { titulo, largura (pontos no PDF paisagem, total até 762), valor(item), tipo? ('data') }.
const { MODULOS } = require('../services/conformidade');
const { EQUIPAMENTOS, AGENTES, nomeDaMedida } = require('../services/ppci');
const { dataHoraBR } = require('./formatos');
const { TIPOS: TIPOS_OCORRENCIA, GRAVIDADES } = require('../services/ocorrencias');
const { TIPOS_MEDIDA } = require('../services/acoes');
const { TIPOS: TIPOS_PT } = require('../services/permissoes');

const SITUACOES = {
  // treinamentos / ASO
  faltando: 'Faltando', vencido: 'Vencido', vencendo: 'Vencendo', em_dia: 'Em dia', inapto: 'Inapto',
  demissional_pendente: 'Demissional pendente',
  // ordens de serviço
  sem_pgr: 'Filial sem PGR vigente', sem_grupo: 'Setor/função fora do PGR', ciencia_pendente: 'Ciência pendente',
  // PPCI
  sem_ppci: 'Prédio sem PPCI', sem_alvara: 'Prédio sem alvará', alvara_vencido: 'Alvará vencido', alvara_vencendo: 'Alvará vencendo',
  divergencia_projeto: 'Projeto x instalado: faltando equipamento', inspecao_atrasada: 'Inspeção mensal atrasada', nao_conforme: 'Última inspeção não conforme',
  recarga_vencida: 'Recarga vencida', recarga_vencendo: 'Recarga vencendo', recarga_nao_registrada: 'Recarga sem registro',
  teste_hidrostatico_vencida: 'Teste hidrostático vencido', teste_hidrostatico_vencendo: 'Teste hidrostático vencendo',
  teste_hidrostatico_nao_registrada: 'Teste hidrostático sem registro',
  manutencao_vencida: 'Manutenção vencida', manutencao_vencendo: 'Manutenção vencendo', manutencao_nao_registrada: 'Manutenção sem registro',
  // ocorrências
  cat_pendente: 'CAT fora do prazo', cat_a_emitir: 'CAT a emitir (no prazo)', investigacao_atrasada: 'Investigação atrasada',
  em_investigacao: 'Em investigação (no prazo)',
  // plano de ação
  atrasada: 'Atrasada', vence_em_breve: 'Vence em breve', no_prazo: 'No prazo', concluida: 'Concluída (aguarda verificação)', verificada: 'Verificada (eficaz)',
  // permissões de trabalho
  vencida_sem_encerramento: 'Vencida sem encerramento', aguardando_assinaturas: 'Começou sem todas as assinaturas', liberada: 'Liberada',
  programada: 'Programada', encerrada: 'Encerrada',
  // CIPA
  grau_risco_nao_informado: 'Grau de risco da filial não informado', sem_cipa: 'Precisa de CIPA e não tem mandato',
  sem_designado: 'Precisa de designado e não tem', composicao_incompleta: 'Composição incompleta', membro_sem_treinamento: 'Membro sem treinamento NR-5',
  reuniao_atrasada: 'Reunião mensal atrasada', edital_atrasado: 'Edital da eleição atrasado', edital_proximo: 'Edital da eleição: prazo chegando'
};
const rotulo = (s) => SITUACOES[s] || s;
const CORES = { verde: 'Verde', amarelo: 'Amarelo', vermelho: 'Vermelho', cinza: 'Sem dados' };
const TIPOS_ASO = { admissional: 'Admissional', periodico: 'Periódico', retorno_trabalho: 'Retorno ao trabalho', mudanca_risco: 'Mudança de risco', demissional: 'Demissional' };
const comMarca = (i) => rotulo(i.situacao) + (i.lancado_depois ? ' *' : '');

const NOTA_LANCADO_DEPOIS = '* documento com data anterior à data-base, mas lançado no sistema depois dela.';

const RELATORIOS = {
  conformidade: {
    titulo: 'Painel de conformidade SST',
    colunas: [
      { titulo: 'Filial', largura: 200, valor: (l) => l.filial },
      { titulo: 'Módulo', largura: 130, valor: (l) => l.modulo },
      { titulo: 'Semáforo', largura: 70, valor: (l) => CORES[l.cor] },
      { titulo: 'Verificados', largura: 70, valor: (l) => l.total },
      { titulo: 'Em dia', largura: 60, valor: (l) => l.em_dia },
      { titulo: 'Atenção', largura: 60, valor: (l) => l.amarelo },
      { titulo: 'Crítico', largura: 60, valor: (l) => l.vermelho },
      { titulo: '% em dia', largura: 60, valor: (l) => (l.percentual === null ? '—' : `${String(l.percentual).replace('.', ',')}%`) }
    ],
    gravidade: (l) => (l.cor === 'vermelho' || l.cor === 'amarelo' ? l.cor : null)
  },
  treinamentos: {
    titulo: 'Treinamentos exigidos por função',
    modulo: MODULOS.treinamentos,
    colunas: [
      { titulo: 'Filial', largura: 90, valor: (i) => i.filial },
      { titulo: 'Setor', largura: 80, valor: (i) => i.setor },
      { titulo: 'Funcionário', largura: 130, valor: (i) => i.funcionario },
      { titulo: 'Matrícula', largura: 45, valor: (i) => i.matricula },
      { titulo: 'Função', largura: 90, valor: (i) => i.funcao },
      { titulo: 'Treinamento', largura: 140, valor: (i) => (i.nr ? `${i.treinamento} (${i.nr})` : i.treinamento) },
      { titulo: 'Situação', largura: 65, valor: comMarca },
      { titulo: 'Realização', largura: 55, valor: (i) => i.ultima_realizacao, tipo: 'data' },
      { titulo: 'Vencimento', largura: 55, valor: (i) => i.vencimento, tipo: 'data' }
    ]
  },
  asos: {
    titulo: 'ASOs (NR-7)',
    modulo: MODULOS.asos,
    colunas: [
      { titulo: 'Filial', largura: 100, valor: (i) => i.filial },
      { titulo: 'Setor', largura: 90, valor: (i) => i.setor },
      { titulo: 'Funcionário', largura: 150, valor: (i) => i.funcionario },
      { titulo: 'Matrícula', largura: 50, valor: (i) => i.matricula },
      { titulo: 'Função', largura: 105, valor: (i) => i.funcao },
      { titulo: 'Situação', largura: 95, valor: (i) => comMarca(i) + (i.com_restricao ? ' (com restrição)' : '') },
      { titulo: 'Último exame', largura: 55, valor: (i) => i.ultimo_exame, tipo: 'data' },
      { titulo: 'Tipo', largura: 60, valor: (i) => TIPOS_ASO[i.ultimo_tipo] || '' },
      { titulo: 'Vencimento / prazo', largura: 55, valor: (i) => i.vencimento, tipo: 'data' }
    ]
  },
  ordens_servico: {
    titulo: 'Ordens de serviço (NR-1)',
    modulo: MODULOS.ordens_servico,
    colunas: [
      { titulo: 'Filial', largura: 95, valor: (i) => i.filial },
      { titulo: 'Setor', largura: 85, valor: (i) => i.setor },
      { titulo: 'Funcionário', largura: 140, valor: (i) => i.funcionario },
      { titulo: 'Matrícula', largura: 45, valor: (i) => i.matricula },
      { titulo: 'Função', largura: 95, valor: (i) => i.funcao },
      { titulo: 'Situação', largura: 85, valor: comMarca },
      { titulo: 'Ciência em', largura: 70, valor: (i) => (i.ciencia_em ? dataHoraBR(i.ciencia_em) : '') },
      { titulo: 'PGR vencido', largura: 45, valor: (i) => (i.pgr_vencido === null || i.pgr_vencido === undefined ? '' : i.pgr_vencido ? 'Sim' : 'Não') },
      { titulo: 'EPIs da OS nunca entregues', largura: 100, valor: (i) => (i.epis_nunca_entregues || []).join('; ') }
    ]
  },
  ppci: {
    titulo: 'PPCI — prédios e equipamentos de combate a incêndio',
    modulo: MODULOS.ppci,
    colunas: [
      { titulo: 'Filial', largura: 90, valor: (i) => i.filial },
      { titulo: 'Prédio', largura: 80, valor: (i) => i.predio },
      { titulo: 'Equipamento', largura: 70, valor: (i) => i.identificacao || '' },
      { titulo: 'Tipo', largura: 75, valor: (i) => (i.tipo ? (EQUIPAMENTOS[i.tipo] ? EQUIPAMENTOS[i.tipo].nome : i.tipo) + (i.agente ? ` ${AGENTES[i.agente] || i.agente}` : '') : '') },
      { titulo: 'Localização', largura: 120, valor: (i) => i.localizacao || '' },
      { titulo: 'Situação', largura: 120, valor: (i) => rotulo(i.situacao) },
      { titulo: 'Data limite', largura: 55, valor: (i) => i.data_limite || i.data_validade || null, tipo: 'data' },
      { titulo: 'Detalhe', largura: 150, valor: (i) => {
        if (i.detalhe) return i.detalhe.map((d) => `${nomeDaMedida(d.tipo)}${d.agente ? ` ${AGENTES[d.agente] || d.agente}` : ''}: ${d.instalado} de ${d.previsto}`).join('; ');
        if (i.nao_conformes) return [i.nao_conformes.join(', '), i.observacao].filter(Boolean).join(' — ');
        return '';
      } }
    ]
  },
  ocorrencias: {
    titulo: 'Ocorrências — CAT e investigação',
    modulo: MODULOS.ocorrencias,
    colunas: [
      { titulo: 'Filial', largura: 105, valor: (i) => i.filial },
      { titulo: 'Número', largura: 50, valor: (i) => i.numero },
      { titulo: 'Tipo', largura: 90, valor: (i) => TIPOS_OCORRENCIA[i.tipo] },
      { titulo: 'Data', largura: 50, valor: (i) => i.data, tipo: 'data' },
      { titulo: 'Gravidade', largura: 50, valor: (i) => GRAVIDADES[i.gravidade] || '' },
      { titulo: 'Local', largura: 115, valor: (i) => i.local },
      { titulo: 'Situação', largura: 95, valor: (i) => rotulo(i.situacao) },
      { titulo: 'Prazo da CAT', largura: 55, valor: (i) => i.prazo_cat, tipo: 'data' },
      { titulo: 'CAT pendente de', largura: 95, valor: (i) => (i.cat_pendente_de || []).join(', ') },
      { titulo: 'Prazo investigação', largura: 55, valor: (i) => i.prazo_investigacao, tipo: 'data' }
    ]
  },
  acoes: {
    titulo: 'Plano de ação',
    modulo: MODULOS.acoes,
    colunas: [
      { titulo: 'Filial', largura: 90, valor: (i) => i.filial },
      { titulo: 'Nº', largura: 45, valor: (i) => i.numero },
      { titulo: 'Ação', largura: 165, valor: (i) => i.titulo },
      { titulo: 'Origem', largura: 120, valor: (i) => i.origem },
      { titulo: 'Medida', largura: 70, valor: (i) => TIPOS_MEDIDA[i.tipo_medida] || '' },
      { titulo: 'Responsável', largura: 90, valor: (i) => i.responsavel },
      { titulo: 'Prazo', largura: 50, valor: (i) => i.prazo, tipo: 'data' },
      { titulo: 'Situação', largura: 80, valor: (i) => rotulo(i.situacao) + (i.dias_atraso ? ` (${i.dias_atraso} dias)` : '') },
      { titulo: 'Reprog.', largura: 40, valor: (i) => i.reprogramacoes || '' }
    ]
  },
  permissoes: {
    titulo: 'Permissões de trabalho (últimos 30 dias)',
    modulo: MODULOS.permissoes,
    colunas: [
      { titulo: 'Filial', largura: 110, valor: (i) => i.filial },
      { titulo: 'Nº', largura: 50, valor: (i) => i.numero },
      { titulo: 'Trabalho', largura: 110, valor: (i) => TIPOS_PT[i.tipo].nome },
      { titulo: 'Local', largura: 170, valor: (i) => i.local },
      { titulo: 'Início', largura: 75, valor: (i) => dataHoraBR(i.inicio) },
      { titulo: 'Fim', largura: 75, valor: (i) => dataHoraBR(i.fim) },
      { titulo: 'Situação', largura: 110, valor: (i) => rotulo(i.situacao) },
      { titulo: 'Assinaturas', largura: 55, valor: (i) => `${i.assinaturas}/${i.participantes}` }
    ]
  },
  terceiros: {
    titulo: 'Terceirizadas — documentos de SST',
    modulo: MODULOS.terceiros,
    colunas: [
      { titulo: 'Filial', largura: 100, valor: (i) => i.filial },
      { titulo: 'Empresa', largura: 130, valor: (i) => i.empresa },
      { titulo: 'Contrato', largura: 140, valor: (i) => i.contrato },
      { titulo: 'Trabalhador', largura: 120, valor: (i) => i.trabalhador || '(empresa)' },
      { titulo: 'Exigência', largura: 120, valor: (i) => i.exigencia },
      { titulo: 'Situação', largura: 85, valor: (i) => rotulo(i.situacao) + (i.com_restricao ? ' (com restrição)' : '') },
      { titulo: 'Vencimento', largura: 60, valor: (i) => i.vencimento, tipo: 'data' }
    ]
  },
  cipa: {
    titulo: 'CIPA (NR-5)',
    modulo: MODULOS.cipa,
    colunas: [
      { titulo: 'Filial', largura: 130, valor: (i) => i.filial },
      { titulo: 'Empregados', largura: 60, valor: (i) => i.empregados },
      { titulo: 'Exigido', largura: 70, valor: (i) => ({ cipa: 'CIPA', designado: 'Designado', nenhum: '—' }[i.exigido] || '?') },
      { titulo: 'Situação', largura: 140, valor: (i) => rotulo(i.situacao) },
      { titulo: 'Membro', largura: 120, valor: (i) => i.membro || '' },
      { titulo: 'Detalhe', largura: 180, valor: (i) => i.detalhe || '' },
      { titulo: 'Prazo', largura: 60, valor: (i) => i.vencimento, tipo: 'data' }
    ]
  }
};

module.exports = { RELATORIOS, SITUACOES, rotulo, CORES, NOTA_LANCADO_DEPOIS };
