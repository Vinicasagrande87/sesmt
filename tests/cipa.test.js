// CIPA (NR-5): dimensionamento pelo Quadro I, mandato com dimensionamento gravado, eleição (prazos, quórum, desempate,
// limite de reeleição), membros e cargos, treinamento, reuniões, designado, estabilidade no desligamento e integrações.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./ambiente');
const { hoje, somarDias, somarMeses } = require('../src/utils/datas');
const { dimensionar } = require('../src/services/cipa');

let amb;
const tk = {};
const ids = { A: [], B: [] };
const api = (...args) => amb.chamar(...args);
const HOJE = hoje();
const INICIO = somarDias(HOJE, -100);           // início do mandato atual
const pdf = () => 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% documento de exemplo\n%%EOF').toString('base64');

// CPF válido a partir de um número (só para os testes)
function cpf(n) {
  const base = String(100000000 + n).slice(-9).split('').map(Number);
  for (const t of [9, 10]) {
    const soma = base.reduce((s, d, i) => s + d * (t + 1 - i), 0);
    base.push(((soma * 10) % 11) % 10);
  }
  return base.join('');
}

before(async () => {
  amb = await iniciarAmbiente();
  await amb.criarUsuarioNoBanco({ nome: 'Matriz', email: 'admin@exemplo.com', senha: 'senha-admin', perfil: 'admin' });
  tk.admin = await amb.login('admin@exemplo.com', 'senha-admin');
  const filial = async (nome, cnpj, grau) => (await api('POST', '/filiais', { token: tk.admin, body: { nome, cnpj, uf: 'RS', cidade: 'Guaíba', bairro: 'Centro', ...(grau ? { grau_risco: grau } : {}) } })).body.id;
  ids.filA = await filial('Campus Exemplo', '11222333000181', 2);
  ids.filB = await filial('Colégio Exemplo', '11444777000161', 1);
  ids.filC = await filial('Polo Exemplo', '11222333000262');
  ids.setorA = (await api('POST', '/setores', { token: tk.admin, body: { filial_id: ids.filA, nome: 'Administrativo' } })).body.id;
  ids.setorB = (await api('POST', '/setores', { token: tk.admin, body: { filial_id: ids.filB, nome: 'Administrativo' } })).body.id;
  ids.funcao = (await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'Assistente' } })).body.id;
  ids.nr5 = (await api('POST', '/treinamentos', { token: tk.admin, body: { nome_treinamento: 'CIPA', nr_referencia: 'NR-05', carga_horaria: 12, validade_meses: 0 } })).body.id;
  for (const [nome, perfil, filiais] of [['gestorA', 'gestor', [ids.filA]], ['tecA', 'tecnico', [ids.filA]], ['gestorB', 'gestor', [ids.filB]], ['consultaA', 'consulta', [ids.filA]]]) {
    await api('POST', '/usuarios', { token: tk.admin, body: { nome: `Usuário ${nome}`, email: `${nome}@exemplo.com`, senha: 'senha1234', perfil, filiais } });
    tk[nome] = await amb.login(`${nome}@exemplo.com`, 'senha1234');
  }
  // 22 empregados no Campus (GR 2: 1 titular e 1 suplente) e 3 no Colégio (GR 1: designado)
  for (let i = 0; i < 25; i++) {
    const noA = i < 22;
    const r = await api('POST', '/funcionarios', { token: tk.admin, body: {
      matricula: String(8000 + i), nome: `Pessoa ${String(i).padStart(2, '0')}`, cpf: cpf(i + 1), data_nascimento: '1990-01-01',
      data_admissao: i === 3 ? '2015-01-10' : '2020-01-10', filial_id: noA ? ids.filA : ids.filB, setor_id: noA ? ids.setorA : ids.setorB, funcao_id: ids.funcao } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids[noA ? 'A' : 'B'].push(r.body.id);
  }
});

after(async () => { if (amb) await amb.encerrar(); });

test('dimensionamento pelo Quadro I da NR-5', async () => {
  assert.deepEqual(dimensionar(2, 22), { tipo: 'cipa', efetivos: 1, suplentes: 1, carga_horaria: 12 });
  assert.equal(dimensionar(1, 3).tipo, 'designado');
  assert.equal(dimensionar(3, 0).tipo, 'nenhum');
  assert.equal(dimensionar(4, 12500).efetivos, 15, 'acima de 10.000: +2 a cada 2.500 no grau 4');
  assert.equal(dimensionar(null, 10).tipo, null);
  const r = (await api('GET', '/cipa/dimensionamento', { token: tk.admin })).body;
  assert.deepEqual(r.map((f) => [f.filial, f.empregados, f.tipo]), [['Campus Exemplo', 22, 'cipa'], ['Colégio Exemplo', 3, 'designado'], ['Polo Exemplo', 0, null]]);
  const pend = (await api('GET', '/cipa/pendencias', { token: tk.admin })).body.itens.map((i) => `${i.filial}:${i.situacao}`);
  assert.deepEqual(pend.sort(), ['Campus Exemplo:sem_cipa', 'Colégio Exemplo:sem_designado', 'Polo Exemplo:grau_risco_nao_informado']);
});

test('mandato: gestão abre, dimensionamento gravado, sem sobreposição', async () => {
  const abrir = (token, body) => api('POST', '/cipa/mandatos', { token, body });
  assert.equal((await abrir(tk.tecA, { filial_id: ids.filA, inicio: INICIO })).status, 403);
  assert.equal((await abrir(tk.gestorA, { filial_id: ids.filA, inicio: INICIO, tipo: 'designado' })).status, 409, 'a filial precisa de CIPA');
  assert.equal((await abrir(tk.gestorA, { filial_id: ids.filA, inicio: INICIO, fim: somarMeses(INICIO, 14) })).status, 400, 'mandato é de 1 ano');
  const r = await abrir(tk.gestorA, { filial_id: ids.filA, inicio: INICIO });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.mandato = r.body.id;
  assert.equal(r.body.fim, somarDias(somarMeses(INICIO, 12), -1));
  assert.equal(r.body.efetivos_exigidos, 1);
  assert.equal(r.body.carga_treinamento, 12);
  assert.equal((await abrir(tk.gestorA, { filial_id: ids.filA, inicio: HOJE })).status, 409, 'sobrepõe');
  // Dois mandatos anteriores (histórico) para testar o limite de reeleição
  ids.ant1 = (await abrir(tk.admin, { filial_id: ids.filA, inicio: somarMeses(INICIO, -12), fim: somarDias(INICIO, -1) })).body.id;
  ids.ant2 = (await abrir(tk.admin, { filial_id: ids.filA, inicio: somarMeses(INICIO, -24), fim: somarDias(somarMeses(INICIO, -12), -1) })).body.id;
  for (const m of [ids.ant1, ids.ant2]) {
    await amb.knex('cipa_membros').insert({ mandato_id: m, funcionario_id: ids.A[5], representacao: 'empregados', condicao: 'titular', inicio: somarMeses(INICIO, m === ids.ant1 ? -12 : -24) });
  }
});

test('eleição: prazos, inscrição, limite de reeleição, quórum e desempate por tempo de casa', async () => {
  const eleicao = await api('POST', `/cipa/mandatos/${ids.mandato}/eleicao`, { token: tk.gestorA, body: {
    edital_em: somarDias(INICIO, -70), inscricoes_inicio: somarDias(INICIO, -65), inscricoes_fim: somarDias(INICIO, -45), data_eleicao: somarDias(INICIO, -40) } });
  assert.equal(eleicao.status, 201, JSON.stringify(eleicao.body));
  assert.deepEqual(eleicao.body.alertas, [], 'prazos da NR-5 atendidos');
  const idEleicao = eleicao.body.mandato.eleicao.id;
  const inscrever = (f, dia = somarDias(INICIO, -60)) => api('POST', `/cipa/eleicoes/${idEleicao}/candidatos`, { token: tk.tecA, body: { funcionario_id: f, inscrito_em: dia } });
  assert.equal((await inscrever(ids.A[0], somarDias(INICIO, -30))).status, 409, 'fora do período de inscrição');
  assert.equal((await inscrever(ids.B[0])).status, 404, 'empregado de outra filial: o técnico do Campus nem enxerga');
  const outraFilial = await api('POST', `/cipa/eleicoes/${idEleicao}/candidatos`, { token: tk.admin, body: { funcionario_id: ids.B[0], inscrito_em: somarDias(INICIO, -60) } });
  assert.equal(outraFilial.status, 400, 'nem a matriz inscreve empregado de outra filial');
  const reeleito = await inscrever(ids.A[5]);
  assert.equal(reeleito.status, 409, 'eleito e reeleito nos dois últimos mandatos');
  assert.match(reeleito.body.error, /uma reeleição/);
  for (const i of [1, 2, 3]) assert.equal((await inscrever(ids.A[i])).status, 201);

  const apurar = (body) => api('POST', `/cipa/eleicoes/${idEleicao}/apuracao`, { token: tk.gestorA, body });
  const cands = (await api('GET', `/cipa/mandatos/${ids.mandato}`, { token: tk.gestorA })).body.eleicao.candidatos;
  const de = (i) => cands.find((c) => c.funcionario_id === ids.A[i]).id;
  const semQuorum = await apurar({ total_empregados: 22, votantes: 10, votos: [] });
  assert.equal(semQuorum.body.resultado, 'sem_quorum', 'menos de 50% de participação');
  assert.equal((await apurar({ total_empregados: 22, votantes: 15, votos: [{ candidato_id: de(1), votos: 8 }, { candidato_id: de(2), votos: 4 }, { candidato_id: de(3), votos: 4 }] })).status, 400, 'mais votos que votantes');
  const r = await apurar({ total_empregados: 22, votantes: 16, ata: pdf(), votos: [{ candidato_id: de(1), votos: 8 }, { candidato_id: de(2), votos: 4 }, { candidato_id: de(3), votos: 4 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.eleitos, [{ funcionario: 'Pessoa 01', condicao: 'titular', votos: 8 }, { funcionario: 'Pessoa 03', condicao: 'suplente', votos: 4 }], 'empate: mais tempo de casa');
  assert.equal((await apurar({ total_empregados: 22, votantes: 15, votos: [] })).status, 409, 'já apurada');
  await assert.rejects(amb.knex('cipa_votos').update({ votos: 99 }), /só aceita inclusão/);
});

test('membros, cargos, treinamento e reunião mensal', async () => {
  const membro = (body, token = tk.gestorA) => api('POST', `/cipa/mandatos/${ids.mandato}/membros`, { token, body });
  assert.equal((await membro({ funcionario_id: ids.A[10], representacao: 'empregados' })).status, 409, 'empregados só se foi candidato');
  assert.equal((await membro({ funcionario_id: ids.A[10], representacao: 'empregados', cargo: 'presidente' })).status, 400, 'presidente é do empregador');
  assert.equal((await membro({ funcionario_id: ids.A[10], representacao: 'empregador', cargo: 'presidente' })).status, 201);
  assert.equal((await membro({ funcionario_id: ids.A[11], representacao: 'empregador', cargo: 'presidente' })).status, 409, 'cargo ocupado');
  assert.equal((await membro({ funcionario_id: ids.A[11], representacao: 'empregador', condicao: 'suplente', cargo: 'secretario' })).status, 201);
  const m = (await api('GET', `/cipa/mandatos/${ids.mandato}`, { token: tk.gestorA })).body;
  const eleito = m.membros.find((x) => x.funcionario_id === ids.A[1]);
  assert.equal((await api('PUT', `/cipa-membros/${eleito.id}`, { token: tk.gestorA, body: { cargo: 'vice_presidente' } })).status, 200);

  const pend = async () => (await api('GET', `/cipa/pendencias?filial_id=${ids.filA}`, { token: tk.consultaA })).body;
  let p = await pend();
  assert.equal(p.resumo.composicao_incompleta, 0, 'composição completa');
  assert.equal(p.resumo.membro_sem_treinamento, 4);
  assert.equal(p.resumo.reuniao_atrasada, 1);
  const previa = (await api('GET', '/avisos/previa', { token: tk.admin })).body;
  assert.ok(previa.itens.some((i) => i.modulo === 'CIPA' && i.descricao.includes('reunião ordinária')));

  const cert = (f, carga) => api('POST', '/certificados', { token: tk.tecA, body: { funcionario_id: f, treinamento_id: ids.nr5, data_realizacao: somarDias(INICIO, -5), instituicao: 'SESMT', carga_horaria: carga, arquivo: pdf() } });
  for (const i of [1, 3, 10]) await cert(ids.A[i], 12);
  await cert(ids.A[11], 8);
  p = await pend();
  assert.deepEqual(p.itens.filter((i) => i.situacao === 'membro_sem_treinamento').map((i) => i.membro), ['Pessoa 11'], '8 h não bastam no grau de risco 2');

  const presentes = m.membros.map((x) => x.id);
  assert.equal((await api('POST', `/cipa/mandatos/${ids.mandato}/reunioes`, { token: tk.tecA, body: { tipo: 'ordinaria', data: HOJE, pauta: 'x', ata: 'y', presentes: [99999] } })).status, 400);
  const reu = await api('POST', `/cipa/mandatos/${ids.mandato}/reunioes`, { token: tk.tecA, body: { tipo: 'ordinaria', data: HOJE, pauta: 'Mapa de riscos; acidentes do mês',
    ata: 'Aprovada a atualização do mapa de riscos do setor administrativo.', presentes, arquivo: pdf() } });
  assert.equal(reu.status, 201, JSON.stringify(reu.body));
  assert.equal((await pend()).resumo.reuniao_atrasada, 0);
});

test('estabilidade do cipeiro: desligamento só com confirmação explícita', async () => {
  const est = (await api('GET', `/cipa/estabilidades?filial_id=${ids.filA}`, { token: tk.gestorA })).body;
  const nomes = est.map((e) => e.funcionario).sort();
  assert.deepEqual(nomes, ['Pessoa 01', 'Pessoa 03', 'Pessoa 05'],
    'eleitos atuais e quem foi titular no mandato anterior (até 1 ano depois); candidato não eleito perdeu a estabilidade na eleição');
  assert.equal(est.find((e) => e.funcionario === 'Pessoa 01').ate, somarMeses(somarDias(somarMeses(INICIO, 12), -1), 12));
  const desligar = (body) => api('PUT', `/funcionarios/${ids.A[1]}`, { token: tk.gestorA, body: { status: 'Desligado', data_demissao: HOJE, ...body } });
  const bloqueio = await desligar({});
  assert.equal(bloqueio.status, 409);
  assert.match(bloqueio.body.error, /estabilidade provisória/);
  assert.equal((await desligar({ ciente_estabilidade_cipa: true })).status, 200, 'justa causa ou pedido de demissão');
  const log = await amb.knex('auditoria').where({ acao: 'desligar', registro_id: String(ids.A[1]) }).first();
  assert.ok(log.depois.desligado_com_estabilidade_cipa, 'a confirmação fica no log');
  assert.equal((await api('GET', `/cipa/pendencias?filial_id=${ids.filA}`, { token: tk.consultaA })).body.resumo.composicao_incompleta, 1, 'saiu um titular');
});

test('designado na filial pequena, semáforo e relatório', async () => {
  const r = await api('POST', '/cipa/mandatos', { token: tk.gestorB, body: { filial_id: ids.filB, inicio: HOJE } });
  assert.equal(r.status, 201);
  assert.equal(r.body.tipo, 'designado');
  assert.equal((await api('POST', `/cipa/mandatos/${r.body.id}/membros`, { token: tk.gestorB, body: { funcionario_id: ids.B[0], representacao: 'empregados' } })).status, 400);
  assert.equal((await api('POST', `/cipa/mandatos/${r.body.id}/membros`, { token: tk.gestorB, body: { funcionario_id: ids.B[0], representacao: 'designado' } })).status, 201);
  assert.equal((await api('POST', `/cipa/mandatos/${r.body.id}/membros`, { token: tk.gestorB, body: { funcionario_id: ids.B[1], representacao: 'designado' } })).status, 409, 'um designado só');
  assert.equal((await api('POST', `/cipa/mandatos/${r.body.id}/reunioes`, { token: tk.gestorB, body: { tipo: 'ordinaria', data: HOJE, pauta: 'x', ata: 'y', presentes: [1] } })).status, 409);
  const p = (await api('GET', `/cipa/pendencias?filial_id=${ids.filB}`, { token: tk.gestorB })).body.itens.map((i) => i.situacao);
  assert.deepEqual(p, ['membro_sem_treinamento'], 'o designado também precisa do treinamento');

  const painel = (await api('GET', '/painel/conformidade', { token: tk.admin })).body.filiais;
  assert.equal(painel.find((f) => f.filial === 'Campus Exemplo').modulos.cipa.cor, 'vermelho');
  assert.equal(painel.find((f) => f.filial === 'Polo Exemplo').modulos.cipa.cor, 'amarelo', 'grau de risco não informado');
  assert.equal((await fetch(`${amb.base}/relatorios/cipa?todas=true`, { headers: { Authorization: `Bearer ${tk.admin}` } })).status, 200);
});
