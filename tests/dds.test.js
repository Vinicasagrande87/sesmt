// DDS: banco de temas, registro, presença pelo crachá (QR + PIN) no dia, presença manual pela gestão, anulação,
// encerramento com resumo, metas de frequência por setor, indicadores do mês, PDF, verificação e integrações.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { iniciarAmbiente } = require('./ambiente');
const { hoje, somarDias } = require('../src/utils/datas');
const { diaUtilAnterior } = require('../src/services/dds');

let amb;
const tk = {};
const ids = {};
const api = (...args) => amb.chamar(...args);
const HOJE = hoje();
const qr = async (id) => (await amb.knex('funcionarios').where({ id }).first('qr_token')).qr_token;

before(async () => {
  amb = await iniciarAmbiente();
  await amb.criarUsuarioNoBanco({ nome: 'Matriz', email: 'admin@exemplo.com', senha: 'senha-admin', perfil: 'admin' });
  tk.admin = await amb.login('admin@exemplo.com', 'senha-admin');
  const filial = async (nome, cnpj) => (await api('POST', '/filiais', { token: tk.admin, body: { nome, cnpj, uf: 'RS', cidade: 'Guaíba', bairro: 'Centro' } })).body.id;
  ids.A = await filial('Campus Exemplo', '11222333000181');
  ids.B = await filial('Colégio Exemplo', '11444777000161');
  const setor = async (f, nome) => (await api('POST', '/setores', { token: tk.admin, body: { filial_id: f, nome } })).body.id;
  ids.manut = await setor(ids.A, 'Manutenção');
  ids.limpeza = await setor(ids.A, 'Limpeza');
  ids.vazio = await setor(ids.A, 'Almoxarifado');
  ids.setorB = await setor(ids.B, 'Administrativo');
  ids.funcao = (await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'Auxiliar' } })).body.id;
  for (const [nome, perfil, filiais] of [['gestorA', 'gestor', [ids.A]], ['tecA', 'tecnico', [ids.A]], ['consultaA', 'consulta', [ids.A]], ['tecB', 'tecnico', [ids.B]]]) {
    await api('POST', '/usuarios', { token: tk.admin, body: { nome: `Usuário ${nome}`, email: `${nome}@exemplo.com`, senha: 'senha1234', perfil, filiais } });
    tk[nome] = await amb.login(`${nome}@exemplo.com`, 'senha1234');
  }
  const pin = await bcrypt.hash('7395', 4);
  const pessoas = [['ana', ids.manut, ids.A, '52998224725'], ['bruno', ids.manut, ids.A, '12345678909'], ['caio', ids.manut, ids.A, '11144477735'],
    ['dora', ids.limpeza, ids.A, '39053344705'], ['eva', ids.limpeza, ids.A, '15350946056'], ['fred', ids.setorB, ids.B, '86288366757']];
  for (const [i, [nome, s, f, cpf]] of pessoas.entries()) {
    const r = await api('POST', '/funcionarios', { token: tk.admin, body: { matricula: String(9100 + i), nome: nome[0].toUpperCase() + nome.slice(1), cpf,
      data_nascimento: '1990-01-01', data_admissao: '2022-01-10', filial_id: f, setor_id: s, funcao_id: ids.funcao } });
    ids[nome] = r.body.id;
    await amb.knex('funcionarios').where({ id: r.body.id }).update({ pin_hash: pin });
  }
});

after(async () => { if (amb) await amb.encerrar(); });

test('banco de temas', async () => {
  const tema = (token, body) => api('POST', '/dds/temas', { token, body });
  assert.equal((await tema(tk.consultaA, { titulo: 'X' })).status, 403);
  const r = await tema(tk.tecA, { titulo: 'Protetor auricular: quando e como usar', nr_referencia: 'NR-6', conteudo: 'Colocação correta; higienização; troca.' });
  assert.equal(r.status, 201);
  ids.tema = r.body.id;
  assert.equal((await tema(tk.tecA, { titulo: 'PROTETOR AURICULAR: QUANDO E COMO USAR' })).status, 409);
  assert.equal((await api('GET', '/dds/temas', { token: tk.consultaA })).body.length, 1);
});

test('DDS: registro, presença pelo crachá no dia, manual pela gestão e anulação', async () => {
  const novo = (body, token = tk.tecA) => api('POST', '/dds', { token, body: { filial_id: ids.A, ...body } });
  assert.equal((await novo({ tema: 'X' }, tk.consultaA)).status, 403);
  assert.equal((await novo({ tema: 'X', data: somarDias(HOJE, 1) })).status, 400, 'futuro');
  assert.equal((await novo({ tema: 'X', data: somarDias(HOJE, -31) })).status, 400, 'mais de 30 dias');
  assert.equal((await novo({ tema: 'X', setor_id: ids.setorB })).status, 400, 'setor de outra filial');
  assert.equal((await novo({})).status, 400, 'sem tema');
  const r = await novo({ tema_id: ids.tema, setor_id: ids.manut, local: 'Oficina' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.dds1 = r.body.id;
  assert.equal(r.body.tema, 'Protetor auricular: quando e como usar');
  assert.equal(r.body.numero, `${HOJE.slice(0, 4)}/0001`);
  assert.equal(r.body.condutor, 'Usuário tecA');

  const assinar = async (f, pin = '7395', token = tk.tecA) => api('POST', `/dds/${ids.dds1}/presencas`, { token, body: { token: await qr(ids[f]), pin } });
  const p = await assinar('ana');
  assert.equal(p.status, 201, JSON.stringify(p.body));
  ids.codigoAna = p.body.codigo_verificacao;
  assert.equal((await assinar('ana')).status, 409, 'já assinou');
  assert.notEqual((await assinar('bruno', '1111')).status, 201, 'PIN errado');
  assert.equal((await assinar('bruno')).status, 201);
  assert.equal((await assinar('fred')).status, 404, 'crachá de outra filial');
  await assert.rejects(amb.knex('dds_presencas').update({ metodo: 'manual' }), /só aceita inclusão/);

  const manual = (token, body) => api('POST', `/dds/${ids.dds1}/presencas/manual`, { token, body });
  assert.equal((await manual(tk.tecA, { funcionario_id: ids.caio, observacao: 'Assinou a lista em papel' })).status, 403);
  assert.equal((await manual(tk.gestorA, { funcionario_id: ids.caio, observacao: 'papel' })).status, 400);
  const m = await manual(tk.gestorA, { funcionario_id: ids.caio, observacao: 'Assinou a lista em papel (celular sem bateria)' });
  assert.equal(m.status, 201);
  assert.equal((await api('POST', `/dds-presencas/${m.body.id}/anular`, { token: tk.gestorA, body: { motivo: 'Caio estava de folga' } })).status, 201);
  assert.equal((await manual(tk.gestorA, { funcionario_id: ids.caio, observacao: 'Assinou a lista em papel (de novo)' })).status, 409, 'anulada: não volta neste DDS');

  // DDS lançado depois do dia: crachá não vale, só a gestão
  const antigo = await novo({ tema: 'Ordem e limpeza', data: somarDias(HOJE, -2) });
  const tarde = await api('POST', `/dds/${antigo.body.id}/presencas`, { token: tk.tecA, body: { token: await qr(ids.ana), pin: '7395' } });
  assert.equal(tarde.status, 409);
  assert.match(tarde.body.error, /só no dia do DDS/);
  assert.equal((await api('POST', `/dds/${antigo.body.id}/encerrar`, { token: tk.tecA, body: { resumo: 'Ninguém assinou ainda' } })).status, 409, 'sem presença não encerra');
  assert.equal((await api('POST', `/dds/${antigo.body.id}/cancelar`, { token: tk.gestorA, body: { motivo: 'Lançado por engano' } })).body.status, 'cancelado');
});

test('encerramento com resumo; depois não entra mais ninguém', async () => {
  const encerrar = (body) => api('POST', `/dds/${ids.dds1}/encerrar`, { token: tk.tecA, body });
  assert.equal((await encerrar({ resumo: 'curto' })).status, 400);
  const r = await encerrar({ resumo: 'Uso do protetor auricular na roçada e na oficina; troca a cada 3 meses.', duracao_min: 12 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'encerrado');
  assert.equal(r.body.presentes, 2);
  assert.equal((await api('POST', `/dds/${ids.dds1}/presencas`, { token: tk.tecA, body: { token: await qr(ids.caio), pin: '7395' } })).status, 409);

  const v = await api('GET', `/verificar/${ids.codigoAna}`);
  assert.equal(v.body.tipo, 'presenca_dds');
  assert.equal(v.body.funcionario, 'A.');
  const doc = await fetch(`${amb.base}/dds/${ids.dds1}/pdf`, { headers: { Authorization: `Bearer ${tk.consultaA}` } });
  assert.equal(doc.status, 200);
  assert.equal(Buffer.from(await doc.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});

test('metas de frequência: setor em dia, setor sem DDS, DDS da filial inteira vale para todos', async () => {
  assert.equal(diaUtilAnterior('2026-11-23'), '2026-11-20', 'segunda -> sexta');
  const meta = (token, body) => api('PUT', '/dds/metas', { token, body: { filial_id: ids.A, ...body } });
  assert.equal((await meta(tk.tecA, { setor_id: ids.manut, frequencia: 'semanal' })).status, 403);
  assert.equal((await meta(tk.gestorA, { setor_id: ids.manut, frequencia: 'toda_hora' })).status, 400);
  assert.equal((await meta(tk.gestorA, { setor_id: ids.setorB, frequencia: 'semanal' })).status, 400, 'setor de outra filial');
  for (const s of [ids.manut, ids.limpeza, ids.vazio]) assert.equal((await meta(tk.gestorA, { setor_id: s, frequencia: 'semanal' })).status, 200);
  assert.equal((await meta(tk.gestorA, { setor_id: ids.manut, frequencia: 'semanal' })).status, 200, 'redefinir não duplica');
  assert.equal((await api('GET', '/dds/metas', { token: tk.consultaA })).body.length, 3);

  const pend = async (q = '') => (await api('GET', `/dds/pendencias?todas=true&filial_id=${ids.A}${q}`, { token: tk.consultaA })).body.itens;
  let itens = await pend();
  assert.deepEqual(itens.map((i) => `${i.setor}:${i.situacao}`).sort(), ['Limpeza:sem_dds', 'Manutenção:em_dia'], 'setor sem empregados não é cobrado');
  const manut = itens.find((i) => i.setor === 'Manutenção');
  assert.equal(manut.participantes_30_dias, 2);
  assert.equal(manut.participacao_30_dias, 66.7);
  assert.equal(manut.proximo, somarDias(HOJE, 7));

  const geral = await api('POST', '/dds', { token: tk.tecA, body: { filial_id: ids.A, tema: 'Ordem e limpeza no campus' } });
  await api('POST', `/dds/${geral.body.id}/presencas`, { token: tk.tecA, body: { token: await qr(ids.dora), pin: '7395' } });
  await api('POST', `/dds/${geral.body.id}/encerrar`, { token: tk.tecA, body: { resumo: 'Descarte correto de resíduos e piso molhado sinalizado.' } });
  itens = await pend();
  assert.equal(itens.find((i) => i.setor === 'Limpeza').situacao, 'em_dia', 'DDS da filial inteira conta para o setor');
  assert.equal((await pend(`&data_base=${somarDias(HOJE, -1)}`)).find((i) => i.setor === 'Manutenção').situacao, 'sem_dds', 'ontem ainda não havia DDS');

  const painel = (await api('GET', `/painel/conformidade?filial_id=${ids.A}`, { token: tk.consultaA })).body.filiais[0];
  assert.equal(painel.modulos.dds.cor, 'verde');
  assert.equal((await fetch(`${amb.base}/relatorios/dds?todas=true`, { headers: { Authorization: `Bearer ${tk.gestorA}` } })).status, 200);
});

test('indicadores do mês: participação por setor e quem não participou', async () => {
  const r = await api('GET', `/dds/indicadores?filial_id=${ids.A}&detalhar=true`, { token: tk.consultaA });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.body[0];
  assert.equal(a.dds, 2, 'o cancelado não conta');
  assert.equal(a.empregados, 5);
  assert.equal(a.participantes, 3);
  assert.equal(a.participacao, 60);
  assert.equal(a.minutos, 12);
  const manut = a.setores.find((s) => s.setor === 'Manutenção');
  assert.deepEqual(manut.sem_participacao.map((p) => p.nome), ['Caio']);
  assert.equal((await api('GET', `/dds/indicadores?filial_id=${ids.B}`, { token: tk.consultaA })).status, 404);
  assert.equal((await api('GET', '/dds/indicadores?mes=2026-13', { token: tk.consultaA })).status, 400);
});
