// Ocorrências: registro (acidente, trajeto, incidente, quase-acidente), vítimas de todos os vínculos, CAT com prazo legal,
// sigilo dos dados médicos, investigação com causas, conclusão travada, cancelamento, indicadores NBR 14280 e integrações.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./ambiente');
const { hoje, somarDias } = require('../src/utils/datas');

let amb;
const tk = {};
const ids = {};
const enviados = [];
const api = (...args) => amb.chamar(...args);
const HOJE = hoje();
const D = somarDias(HOJE, -10);                // dia do acidente
const ANO = Number(D.slice(0, 4));
const pdf = () => 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% documento de exemplo\n%%EOF').toString('base64');

const acidente = (extra = {}) => ({
  filial_id: ids.A, tipo: 'acidente_tipico', data_hora: `${D}T14:30`, local_descricao: 'Oficina de manutenção', tipo_local: '1',
  descricao: 'Ao cortar um perfil metálico, a lixadeira escapou e atingiu a mão esquerda.', atividade: 'Corte de perfil com lixadeira angular',
  gravidade: 'moderada', horas_trabalhadas_antes: '03:30', comunicou_policia: false,
  vitimas: [{ vinculo: 'empregado', funcionario_id: ids.ana, parte_corpo: 'Mão', lateralidade: 'esquerda', natureza_lesao: 'Corte',
    agente_causador: 'Lixadeira angular', houve_afastamento: true, data_afastamento: somarDias(D, 1) }],
  testemunhas: [{ funcionario_id: ids.bruno, relato: 'Vi a lixadeira escapar; ela estava sem a proteção.' }],
  ...extra
});

before(async () => {
  amb = await iniciarAmbiente();
  require('../src/services/email').definirTransporte({ sendMail: async (m) => { enviados.push(m); return {}; } });
  await amb.criarUsuarioNoBanco({ nome: 'Matriz', email: 'admin@exemplo.com', senha: 'senha-admin', perfil: 'admin' });
  tk.admin = await amb.login('admin@exemplo.com', 'senha-admin');
  const filial = async (nome, cnpj) => (await api('POST', '/filiais', { token: tk.admin, body: { nome, cnpj, uf: 'RS', cidade: 'Guaíba', bairro: 'Centro' } })).body.id;
  ids.A = await filial('Campus Exemplo', '11222333000181');
  ids.B = await filial('Colégio Exemplo', '11444777000161');
  ids.setor = (await api('POST', '/setores', { token: tk.admin, body: { filial_id: ids.A, nome: 'Manutenção' } })).body.id;
  ids.funcao = (await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'Serralheiro' } })).body.id;
  ids.predioB = (await api('POST', '/predios', { token: tk.admin, body: { filial_id: ids.B, nome: 'Prédio do Colégio' } })).body.id;
  for (const [nome, perfil, filiais] of [['gestorA', 'gestor', [ids.A]], ['tecA', 'tecnico', [ids.A]], ['saudeA', 'saude', [ids.A]], ['consultaA', 'consulta', [ids.A]], ['tecB', 'tecnico', [ids.B]]]) {
    await api('POST', '/usuarios', { token: tk.admin, body: { nome: `Usuário ${nome}`, email: `${nome}@exemplo.com`, senha: 'senha1234', perfil, filiais } });
    tk[nome] = await amb.login(`${nome}@exemplo.com`, 'senha1234');
  }
  const pessoa = async (matricula, nome, cpf) => (await api('POST', '/funcionarios', { token: tk.admin, body: {
    matricula, nome, cpf, data_nascimento: '1990-01-01', data_admissao: '2022-01-10', filial_id: ids.A, setor_id: ids.setor, funcao_id: ids.funcao } })).body.id;
  ids.ana = await pessoa('6001', 'Ana Exemplo', '52998224725');
  ids.bruno = await pessoa('6002', 'Bruno Exemplo', '12345678909');
});

after(async () => { if (amb) await amb.encerrar(); });

test('prazo da CAT: 1º dia útil seguinte; óbito, no mesmo dia', () => {
  const { prazoCat, proximoDiaUtil } = require('../src/services/ocorrencias');
  assert.equal(proximoDiaUtil('2026-11-20'), '2026-11-23', 'sexta -> segunda');
  assert.equal(proximoDiaUtil('2026-11-21'), '2026-11-23', 'sábado -> segunda');
  assert.equal(proximoDiaUtil('2026-11-24'), '2026-11-25');
  assert.equal(prazoCat('2026-11-20', true), '2026-11-20');
});

test('registro: validações, permissões, numeração por filial e aviso imediato por e-mail', async () => {
  const criar = (body, token = tk.tecA) => api('POST', '/ocorrencias', { token, body });
  assert.equal((await criar(acidente(), tk.consultaA)).status, 403);
  assert.equal((await criar(acidente(), tk.tecB)).status, 404, 'filial de fora');
  assert.equal((await criar(acidente({ vitimas: [] }))).status, 400, 'acidente sem vítima');
  assert.equal((await criar(acidente({ data_hora: `${somarDias(HOJE, 2)}T10:00` }))).status, 400, 'futuro');
  assert.equal((await criar(acidente({ predio_id: ids.predioB }))).status, 400, 'prédio de outra filial');
  assert.equal((await criar(acidente({ gravidade: undefined }))).status, 400, 'acidente sem gravidade');
  assert.equal((await criar({ ...acidente(), tipo: 'quase_acidente', vitimas: [] })).status, 400, 'quase-acidente com gravidade real');
  const incidenteComLesao = await criar({ ...acidente(), tipo: 'incidente', gravidade: undefined, vitimas: [{ vinculo: 'empregado', funcionario_id: ids.bruno, houve_lesao: true }] });
  assert.equal(incidenteComLesao.status, 400);
  assert.match(incidenteComLesao.body.error, /registre como acidente/);
  const medico = await criar(acidente({ vitimas: [{ ...acidente().vitimas[0], cid: 'S61.0' }] }));
  assert.equal(medico.status, 403, 'CID é lançado pela saúde');
  const terceiroSemEmpresa = await criar(acidente({ vitimas: [{ vinculo: 'terceiro', nome: 'Carlos Terceiro' }] }));
  assert.equal(terceiroSemEmpresa.status, 400);
  assert.match(terceiroSemEmpresa.body.error, /^Vítima 1:/);

  enviados.length = 0;
  const r = await criar(acidente());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.o1 = r.body.id;
  ids.vAna = r.body.vitimas[0].id;
  assert.equal(r.body.numero, `${ANO}/0001`);
  assert.equal(r.body.vitimas[0].nome_vitima, 'Ana Exemplo');
  assert.equal(r.body.vitimas[0].funcao, 'Serralheiro', 'função da época gravada');
  assert.equal(r.body.testemunhas[0].nome, 'Bruno Exemplo');
  assert.equal(r.body.situacao, 'cat_pendente', 'o acidente foi há 10 dias e não há CAT');
  assert.equal(enviados.length, 1, 'admin avisado na hora');
  assert.match(enviados[0].subject, /Acidente típico na Campus Exemplo: CAT até/);

  // Acidente com terceiro (sem CAT da empresa) e com estudante
  const r2 = await criar(acidente({ gravidade: 'leve', vitimas: [
    { vinculo: 'terceiro', nome: 'Carlos Terceiro', empresa: 'Limpeza Exemplo Ltda', parte_corpo: 'Pé' },
    { vinculo: 'estudante', nome: 'Duda Estudante', documento: 'RA 123', parte_corpo: 'Joelho' }
  ], testemunhas: [] }));
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal(r2.body.numero, `${ANO}/0002`);
  assert.deepEqual(r2.body.vitimas.map((v) => v.cats), [[], []]);
  assert.equal(r2.body.situacao, 'em_investigacao', 'sem empregado, não há CAT a cobrar');
  ids.o2 = r2.body.id;

  const quase = await criar({ filial_id: ids.A, tipo: 'quase_acidente', data_hora: `${D}T09:00`, local_descricao: 'Escada do prédio 1',
    descricao: 'Degrau solto; ninguém caiu.', gravidade_potencial: 'grave' });
  assert.equal(quase.status, 201, JSON.stringify(quase.body));
  ids.quase = quase.body.id;
  assert.equal(quase.body.numero, `${ANO}/0003`);
  assert.equal((await api('GET', '/ocorrencias', { token: tk.tecB })).body.length, 0, 'outra filial não vê');
  assert.equal((await api('GET', `/ocorrencias/${ids.o1}`, { token: tk.tecB })).status, 404);
  assert.equal((await api('GET', '/acidentes', { token: tk.admin })).status, 404, 'rota antiga saiu');
});

test('CAT: só para empregado, uma inicial, registro só por inclusão e situação como estava antes', async () => {
  const cat = (vitima, body) => api('POST', `/ocorrencia-vitimas/${vitima}/cats`, { token: tk.tecA, body });
  const o2 = (await api('GET', `/ocorrencias/${ids.o2}`, { token: tk.tecA })).body;
  assert.equal((await cat(o2.vitimas[0].id, { tipo: 'inicial', numero: '1', data_emissao: HOJE })).status, 400, 'terceiro não tem CAT da empresa');
  assert.equal((await cat(ids.vAna, { tipo: 'reabertura', numero: '1', data_emissao: HOJE })).status, 409, 'reabertura sem inicial');
  assert.equal((await cat(ids.vAna, { tipo: 'inicial', numero: '1', data_emissao: somarDias(D, -1) })).status, 400, 'antes do acidente');
  const ok = await cat(ids.vAna, { tipo: 'inicial', numero: '2026.000.123', data_emissao: somarDias(HOJE, -2), arquivo: pdf() });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.no_prazo, false, 'emitida depois do 1º dia útil');
  ids.cat = ok.body.id;
  assert.equal((await cat(ids.vAna, { tipo: 'inicial', numero: 'X', data_emissao: HOJE })).status, 409);
  await assert.rejects(amb.knex('cats').where({ id: ids.cat }).update({ numero: 'outro' }), /só aceita inclusão/);

  const pend = async (q) => (await api('GET', `/ocorrencias/pendencias?todas=true&${q}`, { token: tk.consultaA })).body.itens.find((i) => i.ocorrencia_id === ids.o1);
  assert.equal((await pend('')).situacao, 'em_investigacao', 'CAT registrada; investigação no prazo');
  assert.equal((await pend(`data_base=${somarDias(HOJE, -5)}`)).situacao, 'cat_pendente', 'há 5 dias a CAT ainda não tinha sido emitida');
  assert.equal((await pend(`data_base=${D}`)).situacao, 'cat_a_emitir', 'no dia do acidente ainda estava no prazo');
});

test('dados médicos só para saúde/admin, inclusive na leitura', async () => {
  const altera = (token, body) => api('PUT', `/ocorrencia-vitimas/${ids.vAna}`, { token, body });
  assert.equal((await altera(tk.tecA, { cid: 'S61.0' })).status, 403);
  assert.equal((await altera(tk.saudeA, { cid: 'x' })).status, 400);
  const r = await altera(tk.saudeA, { cid: 's61.0', atestado_data: somarDias(D, 0), atestado_hora: '15:10', medico_nome: 'Dra. Exemplo', medico_crm: '12345', medico_uf: 'RS', duracao_tratamento_dias: 7 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cid, 'S61.0');
  const tec = (await api('GET', `/ocorrencias/${ids.o1}`, { token: tk.tecA })).body.vitimas[0];
  assert.equal(tec.cid, undefined);
  assert.equal(tec.medico_nome, undefined);
  assert.equal((await api('GET', `/ocorrencias/${ids.o1}`, { token: tk.saudeA })).body.vitimas[0].cid, 'S61.0');
  const log = await amb.knex('auditoria').where({ acao: 'alterar_vitima' }).orderBy('id', 'desc').first();
  assert.ok(!JSON.stringify(log.depois).includes('S61'), 'o CID não vai para o log');
});

test('investigação: causas, conclusão exige CAT, depois fica travada', async () => {
  const inv = (id, body) => api('PUT', `/ocorrencias/${id}/investigacao`, { token: tk.tecA, body });
  assert.equal((await api('POST', `/ocorrencias/${ids.o1}/concluir`, { token: tk.tecA })).status, 409, 'sem investigação');
  assert.equal((await inv(ids.o1, { metodo: 'chute', equipe: ['X'] })).status, 400);
  assert.equal((await inv(ids.o1, { metodo: 'arvore_causas', equipe: [] })).status, 400);
  assert.equal((await inv(ids.o1, { metodo: 'arvore_causas', equipe: ['Téc. Exemplo'], causas: [{ tipo: 'raiz', categoria: 'xx', descricao: 'a' }] })).status, 400);
  const corpo = {
    metodo: 'arvore_causas', equipe: ['Téc. Segurança Exemplo', 'Supervisor da manutenção', 'Membro da CIPA'],
    descricao_fatos: 'A lixadeira estava sem a coifa de proteção, retirada para trocar o disco.',
    causas: [
      { tipo: 'imediata', categoria: 'maquina', descricao: 'Lixadeira sem coifa de proteção' },
      { tipo: 'raiz', categoria: 'gestao', descricao: 'Sem inspeção das ferramentas antes do uso' }
    ],
    medidas_recomendadas: ['Inspeção diária das ferramentas portáteis', 'Treinar a equipe em NR-12']
  };
  const r = await inv(ids.o1, corpo);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'em_investigacao');
  assert.equal(r.body.investigacao.causas.length, 2);
  assert.equal((await api('POST', `/ocorrencias/${ids.o1}/concluir`, { token: tk.tecA })).status, 409, 'sem conclusão escrita');
  assert.equal((await inv(ids.o1, { ...corpo, conclusao: 'Retirada da proteção sem controle; ferramenta não inspecionada.' })).status, 200);
  const semAcao = await api('POST', `/ocorrencias/${ids.o1}/concluir`, { token: tk.tecA });
  assert.equal(semAcao.status, 409, 'medida recomendada precisa virar ação');
  assert.match(semAcao.body.error, /plano de ação/);
  const acao = await api('POST', '/acoes', { token: tk.tecA, body: { filial_id: ids.A, titulo: 'Inspeção diária das ferramentas portáteis', prazo: somarDias(HOJE, 15),
    origem_tipo: 'ocorrencia', origem_id: ids.o1, responsavel_nome: 'Supervisor da manutenção', tipo_medida: 'administrativa' } });
  assert.equal(acao.status, 201, JSON.stringify(acao.body));
  const c = await api('POST', `/ocorrencias/${ids.o1}/concluir`, { token: tk.tecA });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.status, 'concluida');
  assert.equal(c.body.situacao, 'em_dia');
  assert.equal(c.body.acoes.length, 1, 'a ocorrência mostra as ações abertas a partir dela');

  assert.equal((await inv(ids.o1, corpo)).status, 409, 'travada');
  assert.equal((await api('PUT', `/ocorrencias/${ids.o1}`, { token: tk.tecA, body: { descricao: 'outra' } })).status, 409);
  assert.equal((await api('PUT', `/ocorrencia-vitimas/${ids.vAna}`, { token: tk.tecA, body: { parte_corpo: 'Braço' } })).status, 409, 'lesão não muda');
  const retorno = await api('PUT', `/ocorrencia-vitimas/${ids.vAna}`, { token: tk.tecA, body: { data_retorno: somarDias(D, 6) } });
  assert.equal(retorno.status, 200, 'o retorno do afastamento se lança depois');

  // Outro acidente com empregado: não conclui sem CAT
  const b = await api('POST', '/ocorrencias', { token: tk.tecA, body: acidente({ data_hora: `${D}T16:00`, gravidade: 'leve', testemunhas: [],
    vitimas: [{ vinculo: 'empregado', funcionario_id: ids.bruno, parte_corpo: 'Olho', lateralidade: 'direita', natureza_lesao: 'Corpo estranho' }] }) });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  ids.o4 = b.body.id;
  await inv(ids.o4, { ...corpo, conclusao: 'Sem óculos de proteção.' });
  const semCat = await api('POST', `/ocorrencias/${ids.o4}/concluir`, { token: tk.tecA });
  assert.equal(semCat.status, 409);
  assert.match(semCat.body.error, /Bruno Exemplo/);

  const doc = await fetch(`${amb.base}/ocorrencias/${ids.o1}/pdf`, { headers: { Authorization: `Bearer ${tk.tecA}` } });
  assert.equal(doc.status, 200);
  assert.equal(Buffer.from(await doc.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});

test('cancelamento pela gestão, com motivo; com CAT, só depois de anular a CAT', async () => {
  assert.equal((await api('POST', `/ocorrencias/${ids.quase}/cancelar`, { token: tk.tecA, body: { motivo: 'registro em duplicidade' } })).status, 403);
  assert.equal((await api('POST', `/ocorrencias/${ids.quase}/cancelar`, { token: tk.gestorA, body: { motivo: 'curto' } })).status, 400);
  assert.equal((await api('POST', `/ocorrencias/${ids.quase}/cancelar`, { token: tk.gestorA, body: { motivo: 'Registro em duplicidade do mesmo fato' } })).status, 200);
  assert.equal((await api('POST', `/ocorrencias/${ids.o1}/cancelar`, { token: tk.gestorA, body: { motivo: 'Teste de cancelamento com CAT' } })).status, 409);
  const pend = (await api('GET', '/ocorrencias/pendencias?todas=true', { token: tk.gestorA })).body.itens;
  assert.ok(!pend.some((i) => i.ocorrencia_id === ids.quase), 'cancelada sai das pendências');
  assert.equal((await api('GET', `/ocorrencias/${ids.quase}`, { token: tk.gestorA })).body.status, 'cancelada', 'mas continua guardada');
});

test('indicadores NBR 14280: taxa de frequência e de gravidade com horas informadas ou estimadas', async () => {
  const competencia = D.slice(0, 7);
  assert.equal((await api('PUT', '/horas-trabalhadas', { token: tk.tecA, body: { filial_id: ids.A, competencia, horas: 10000 } })).status, 403);
  assert.equal((await api('PUT', '/horas-trabalhadas', { token: tk.gestorA, body: { filial_id: ids.A, competencia, horas: -1 } })).status, 400);
  assert.equal((await api('PUT', '/horas-trabalhadas', { token: tk.gestorA, body: { filial_id: ids.A, competencia, horas: 10000 } })).status, 200);

  // Trajeto fica fora das taxas
  const trajeto = await api('POST', '/ocorrencias', { token: tk.tecA, body: acidente({ tipo: 'acidente_trajeto', data_hora: `${D}T07:10`, tipo_local: '4', testemunhas: [],
    vitimas: [{ vinculo: 'empregado', funcionario_id: ids.bruno, parte_corpo: 'Braço', houve_afastamento: true, data_afastamento: D }] }) });
  assert.equal(trajeto.status, 201, JSON.stringify(trajeto.body));

  const r = await api('GET', `/ocorrencias/indicadores?ano=${ANO}&filial_id=${ids.A}`, { token: tk.consultaA });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const mes = r.body.filiais[0].meses.find((m) => m.competencia === competencia);
  assert.equal(mes.hht, 10000);
  assert.equal(mes.hht_estimado, false);
  assert.equal(mes.com_afastamento, 1, 'Ana, afastada');
  assert.equal(mes.sem_afastamento, 1, 'Bruno, olho');
  assert.equal(mes.trajeto, 1);
  assert.equal(mes.dias_perdidos, 5, 'do afastamento até a véspera do retorno');
  assert.equal(mes.taxa_frequencia, 100);
  assert.equal(mes.taxa_gravidade, 500);
  const outro = r.body.filiais[0].meses.find((m) => m.competencia !== competencia);
  if (outro) assert.equal(outro.hht_estimado, true, 'sem horas informadas: estimativa pelo nº de empregados');
  assert.equal(r.body.filiais[0].dias_sem_acidente_com_afastamento, 10);
  assert.equal((await api('GET', `/ocorrencias/indicadores?filial_id=${ids.B}`, { token: tk.consultaA })).status, 404);
});

test('integrações: semáforo, relatório, resumo semanal e fechamento mensal', async () => {
  const painel = (await api('GET', `/painel/conformidade?filial_id=${ids.A}`, { token: tk.consultaA })).body.filiais[0];
  assert.equal(painel.modulos.ocorrencias.cor, 'vermelho', 'acidente do Bruno sem CAT fora do prazo');
  const rel = await fetch(`${amb.base}/relatorios/ocorrencias?formato=xlsx`, { headers: { Authorization: `Bearer ${tk.gestorA}` } });
  assert.equal(rel.status, 200);
  const previa = (await api('GET', '/avisos/previa', { token: tk.admin })).body;
  assert.ok(previa.itens.some((i) => i.modulo === 'CAT' && i.descricao.includes('Bruno Exemplo')));
  assert.ok(previa.itens.some((i) => i.modulo === 'Investigação de ocorrência'));
  const { FONTES } = require('../src/services/fechamento');
  assert.ok(FONTES.cats && FONTES.ocorrencia_testemunhas, 'CAT e testemunhas entram na impressão digital do mês');
});

test('migração: registros da tabela antiga de acidentes viram ocorrências (legado), sem perder nada', async () => {
  await amb.knex.migrate.down({ name: '20261203100000_ocorrencias.js' }); // desfaz só a migration das ocorrências
  await amb.knex('acidentes_trabalho').insert({ funcionario_id: ids.ana, data_hora_acidente: new Date(`${D}T10:00:00-03:00`), local_acidente: 'Pátio',
    descricao_ocorrencia: 'Escorregou no piso molhado', parte_corpo_atingida: 'Tornozelo', houve_afastamento: true, dias_afastado: 3, cat_emitida: true });
  await amb.knex.migrate.latest();
  const o = await amb.knex('ocorrencias').where({ legado: true }).first();
  assert.equal(o.filial_id, ids.A);
  assert.equal(o.local_descricao, 'Pátio');
  const v = await amb.knex('ocorrencia_vitimas').where({ ocorrencia_id: o.id }).first();
  assert.equal(v.funcionario_id, ids.ana);
  assert.equal(v.dias_perdidos, 3);
  assert.ok(await amb.knex.schema.hasTable('acidentes_trabalho_legado'), 'a tabela antiga fica guardada');
  const pend = (await api('GET', '/ocorrencias/pendencias?todas=true', { token: tk.admin })).body.itens;
  assert.ok(!pend.some((i) => i.ocorrencia_id === o.id), 'legado não gera cobrança de CAT/investigação');
});
