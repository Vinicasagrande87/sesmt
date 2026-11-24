// Etapa 8: integridade. Tabelas de prova só aceitam inclusão, auditoria encadeada por hash e
// fechamento mensal por filial (situação congelada + impressão digital dos registros do mês).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarAmbiente } = require('./ambiente');
const { hoje, somarDias, somarMeses } = require('../src/utils/datas');

let amb;
const tk = {};
const ids = {};
const api = (...args) => amb.chamar(...args);
const HOJE = hoje();
const MES_ATUAL = HOJE.slice(0, 7);
const ULTIMO = somarMeses(`${MES_ATUAL}-01`, -1).slice(0, 7);      // mês passado
const PENULTIMO = somarMeses(`${MES_ATUAL}-01`, -2).slice(0, 7);
const noMesPassado = new Date(`${ULTIMO}-15T10:00:00-03:00`);
const pdf = () => 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% documento de exemplo\n%%EOF').toString('base64');

before(async () => {
  amb = await iniciarAmbiente();
  await amb.criarUsuarioNoBanco({ nome: 'Matriz', email: 'admin@t.com', senha: 'senha-admin', perfil: 'admin' });
  tk.admin = await amb.login('admin@t.com', 'senha-admin');
  const filial = async (nome, cnpj) => (await api('POST', '/filiais', { token: tk.admin, body: { nome, cnpj, uf: 'RS', cidade: 'Guaíba', bairro: 'Centro' } })).body.id;
  ids.A = await filial('Campus Exemplo', '11222333000181');
  ids.B = await filial('Colégio Exemplo', '11444777000161');
  await amb.knex('filiais').update({ created_at: new Date(`${somarMeses(`${MES_ATUAL}-01`, -3)}T09:00:00-03:00`) });
  ids.setor = (await api('POST', '/setores', { token: tk.admin, body: { filial_id: ids.A, nome: 'Manutenção' } })).body.id;
  ids.funcao = (await api('POST', '/funcoes', { token: tk.admin, body: { nome: 'Eletricista' } })).body.id;
  ids.nr35 = (await api('POST', '/treinamentos', { token: tk.admin, body: { nome_treinamento: 'Trabalho em altura', nr_referencia: 'NR-35', carga_horaria: 8, validade_meses: 24 } })).body.id;
  await api('PUT', `/funcoes/${ids.funcao}/treinamentos`, { token: tk.admin, body: { treinamento_ids: [ids.nr35] } });
  await amb.knex('funcao_treinamento_vigencias').update({ inicio: new Date('2020-01-01T00:00:00-03:00') });
  ids.predio = (await api('POST', '/predios', { token: tk.admin, body: { filial_id: ids.A, nome: 'Prédio 1' } })).body.id;
  await amb.knex('predios').update({ created_at: new Date('2020-01-01T00:00:00-03:00') });

  for (const [nome, perfil, filiais] of [['gestorA', 'gestor', [ids.A]], ['tecA', 'tecnico', [ids.A]], ['saudeA', 'saude', [ids.A]], ['consultaA', 'consulta', [ids.A]], ['gestorB', 'gestor', [ids.B]]]) {
    await api('POST', '/usuarios', { token: tk.admin, body: { nome: `Usuário ${nome}`, email: `${nome}@t.com`, senha: 'senha1234', perfil, filiais } });
    tk[nome] = await amb.login(`${nome}@t.com`, 'senha1234');
  }
  const r = await api('POST', '/funcionarios', { token: tk.admin, body: { matricula: '4001', nome: 'Ana Exemplo', cpf: '52998224725', data_nascimento: '1990-01-01', data_admissao: '2022-01-10', filial_id: ids.A, setor_id: ids.setor, funcao_id: ids.funcao } });
  ids.ana = r.body.id;
});

after(async () => { if (amb) await amb.encerrar(); });

test('tabelas de prova só aceitam inclusão; auditoria não se altera nem se apaga', async () => {
  const aso = await api('POST', '/asos', { token: tk.saudeA, body: {
    funcionario_id: ids.ana, tipo: 'periodico', data_exame: HOJE, resultado: 'apto', medico_nome: 'Dra. Exemplo', medico_crm: '12345', arquivo: pdf()
  } });
  assert.equal(aso.status, 201, JSON.stringify(aso.body));
  await assert.rejects(amb.knex('asos').where({ id: aso.body.id }).update({ resultado: 'inapto' }), /só aceita inclusão/);
  await assert.rejects(amb.knex('asos').where({ id: aso.body.id }).del(), /só aceita inclusão/);
  await assert.rejects(amb.knex.raw('truncate table aso_anulacoes'), /só aceita inclusão/);

  const linha = await amb.knex('auditoria').orderBy('id', 'desc').first('id');
  await assert.rejects(amb.knex('auditoria').where({ id: linha.id }).update({ acao: 'outra' }), /Auditoria não pode ser alterada/);
  await assert.rejects(amb.knex('auditoria').where({ id: linha.id }).del(), /Auditoria não pode ser alterada/);
  // A correção continua sendo pela anulação (inclusão)
  assert.equal((await api('POST', `/asos/${aso.body.id}/anular`, { token: tk.saudeA, body: { motivo: 'lançado em duplicidade' } })).status, 201);
});

test('cadeia da auditoria: selada em ordem, conferida pela matriz e quebrada por adulteração', async () => {
  assert.equal((await api('GET', '/auditoria/integridade', { token: tk.gestorA })).status, 403);
  const r = await api('GET', '/auditoria/integridade', { token: tk.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.pendentes, 0);
  const total = await amb.knex('auditoria').count({ n: '*' }).first();
  assert.equal(r.body.verificados, Number(total.n), 'todas as linhas na cadeia');
  const primeira = await amb.knex('auditoria').where({ sequencia: 1 }).first();
  assert.equal(primeira.hash_anterior, '0'.repeat(64));

  // Alguém com acesso ao banco desliga a trava e altera uma linha antiga
  const alvo = await amb.knex('auditoria').where({ sequencia: 3 }).first();
  await amb.knex.raw('alter table auditoria disable trigger auditoria_selagem');
  await amb.knex('auditoria').where({ id: alvo.id }).update({ ip: '10.9.9.9' });
  await amb.knex.raw('alter table auditoria enable trigger auditoria_selagem');
  const quebrada = (await api('GET', '/auditoria/integridade', { token: tk.admin })).body;
  assert.equal(quebrada.ok, false);
  assert.equal(quebrada.falha.sequencia, 3);
  assert.match(quebrada.falha.motivo, /alterado/);

  await amb.knex.raw('alter table auditoria disable trigger auditoria_selagem');
  await amb.knex('auditoria').where({ id: alvo.id }).update({ ip: alvo.ip });
  await amb.knex.raw('alter table auditoria enable trigger auditoria_selagem');
  assert.equal((await api('GET', '/auditoria/integridade', { token: tk.admin })).body.ok, true, 'desfeita a adulteração, a cadeia volta a conferir');
});

test('fechamento mensal: regras, situação congelada e registros do mês', async () => {
  // Registros lançados no mês passado (no teste, a data de lançamento é ajustada direto no banco)
  const cert = await api('POST', '/certificados', { token: tk.tecA, body: {
    funcionario_id: ids.ana, treinamento_id: ids.nr35, data_realizacao: somarDias(`${ULTIMO}-01`, -10), instituicao: 'Escola Exemplo', arquivo: pdf()
  } });
  assert.equal(cert.status, 201, JSON.stringify(cert.body));
  ids.cert = cert.body.id;
  const ppci = await api('POST', '/ppcis', { token: tk.tecA, body: { predio_id: ids.predio, data_aprovacao: somarDias(`${ULTIMO}-01`, -30), arquivo: pdf(), medidas: [{ tipo: 'extintor', agente: 'pqs_abc', quantidade: 2 }] } });
  assert.equal(ppci.status, 201, JSON.stringify(ppci.body));
  await amb.knex('certificados_treinamentos').where({ id: ids.cert }).update({ created_at: noMesPassado });
  await amb.knex('ppcis').where({ id: ppci.body.id }).update({ created_at: noMesPassado });

  const fechar = (token, body) => api('POST', '/fechamentos', { token, body });
  assert.equal((await fechar(tk.tecA, { filial_id: ids.A, competencia: ULTIMO })).status, 403, 'só a gestão fecha');
  assert.equal((await fechar(tk.gestorB, { filial_id: ids.A, competencia: ULTIMO })).status, 404, 'outra filial');
  assert.equal((await fechar(tk.gestorA, { filial_id: ids.A, competencia: MES_ATUAL })).status, 409, 'mês em andamento');
  assert.equal((await fechar(tk.gestorA, { filial_id: ids.A, competencia: '2026-13' })).status, 400);

  const r = await fechar(tk.gestorA, { filial_id: ids.A, competencia: ULTIMO });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.f1 = r.body.id;
  assert.equal(r.body.hash_anterior, null, 'primeiro fechamento da filial');
  assert.equal(r.body.resumo.registros.certificados_treinamentos, 1);
  assert.equal(r.body.resumo.registros.ppcis, 1);
  assert.equal(r.body.resumo.modulos.treinamentos.em_dia, 1, 'no fim do mês passado o NR-35 estava em dia');
  assert.equal(r.body.resumo.modulos.asos.vermelho, 1, 'ASO só foi feito neste mês (e anulado)');
  assert.equal((await fechar(tk.gestorA, { filial_id: ids.A, competencia: ULTIMO })).status, 409, 'não fecha duas vezes');

  const completo = (await api('GET', `/fechamentos/${ids.f1}`, { token: tk.consultaA })).body;
  assert.equal(completo.conteudo.situacao.treinamentos[0].funcionario, 'Ana Exemplo');
  assert.equal(completo.conteudo.data_base, somarDias(`${MES_ATUAL}-01`, -1));
  assert.ok(completo.auditoria_sequencia > 0, 'ancorado na cadeia da auditoria');
  assert.equal((await api('GET', `/fechamentos/${ids.f1}`, { token: tk.gestorB })).status, 404);

  const lista = (await api('GET', `/fechamentos?filial_id=${ids.A}`, { token: tk.consultaA })).body;
  assert.equal(lista.fechamentos.length, 1);
  assert.ok(!lista.em_aberto.includes(ULTIMO));
  assert.ok(lista.em_aberto.includes(PENULTIMO), 'meses encerrados ainda não fechados');
  assert.ok(!lista.em_aberto.includes(MES_ATUAL));

  const v = await api('GET', `/verificar/${r.body.codigo_verificacao}`);
  assert.equal(v.body.tipo, 'fechamento_mensal');
  assert.equal(v.body.competencia, ULTIMO);
  assert.equal(v.body.sha256, r.body.hash);
  assert.ok(!JSON.stringify(v.body).includes('Ana'), 'sem pessoas na verificação pública');
});

test('conferência do fechamento: aponta registro alterado e lançado com data retroativa; fechamentos encadeados', async () => {
  const conferir = async (id) => (await api('GET', `/fechamentos/${id}/conferencia`, { token: tk.consultaA })).body;
  const ok = await conferir(ids.f1);
  assert.equal(ok.ok, true, JSON.stringify(ok));

  // Alteração direta no banco de um certificado do mês fechado
  const antes = await amb.knex('certificados_treinamentos').where({ id: ids.cert }).first('data_vencimento');
  await amb.knex('certificados_treinamentos').where({ id: ids.cert }).update({ data_vencimento: '2099-12-31' });
  const alterado = await conferir(ids.f1);
  assert.equal(alterado.ok, false);
  assert.deepEqual(alterado.divergencias.certificados_treinamentos.alterados, [ids.cert]);
  await amb.knex('certificados_treinamentos').where({ id: ids.cert }).update({ data_vencimento: antes.data_vencimento });
  assert.equal((await conferir(ids.f1)).ok, true, 'desfeita a alteração, confere de novo');

  // Certificado incluído depois com data de lançamento no mês fechado
  const outro = await api('POST', '/certificados', { token: tk.tecA, body: {
    funcionario_id: ids.ana, treinamento_id: ids.nr35, data_realizacao: somarDias(`${ULTIMO}-01`, -5), instituicao: 'Escola Exemplo', arquivo: pdf()
  } });
  await amb.knex('certificados_treinamentos').where({ id: outro.body.id }).update({ created_at: noMesPassado });
  const incluido = await conferir(ids.f1);
  assert.equal(incluido.ok, false);
  assert.deepEqual(incluido.divergencias.certificados_treinamentos.incluidos_depois, [outro.body.id]);
  await amb.knex('certificados_treinamentos').where({ id: outro.body.id }).update({ created_at: new Date() });

  // Fechar um mês anterior depois: encadeia no fechamento mais recente da filial
  const f2 = await api('POST', '/fechamentos', { token: tk.gestorA, body: { filial_id: ids.A, competencia: PENULTIMO } });
  assert.equal(f2.status, 201, JSON.stringify(f2.body));
  const f1 = (await api('GET', `/fechamentos/${ids.f1}`, { token: tk.gestorA })).body;
  assert.equal(f2.body.hash_anterior, f1.hash);
  assert.equal((await conferir(f2.body.id)).ok, true);
  assert.equal((await conferir(ids.f1)).ok, true);

  // A situação congelada não se altera nem pelo banco
  await assert.rejects(amb.knex('fechamentos').where({ id: ids.f1 }).update({ resumo: '{}' }), /só aceita inclusão/);
  assert.ok(await amb.knex('auditoria').where({ acao: 'fechamento_mensal' }).first());
});
