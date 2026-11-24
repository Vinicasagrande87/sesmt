// Plano de ação: abertura com origem e responsável, ciclo andamento -> conclusão com evidência -> verificação de eficácia
// por outra pessoa (ineficaz reabre), reprogramação com motivo e histórico, cancelamento, pendências e integrações.
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
const ANO = HOJE.slice(0, 4);
const foto = () => 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

before(async () => {
  amb = await iniciarAmbiente();
  require('../src/services/email').definirTransporte({ sendMail: async (m) => { enviados.push(m); return {}; } });
  await amb.criarUsuarioNoBanco({ nome: 'Matriz', email: 'admin@exemplo.com', senha: 'senha-admin', perfil: 'admin' });
  tk.admin = await amb.login('admin@exemplo.com', 'senha-admin');
  const filial = async (nome, cnpj) => (await api('POST', '/filiais', { token: tk.admin, body: { nome, cnpj, uf: 'RS', cidade: 'Guaíba', bairro: 'Centro' } })).body.id;
  ids.A = await filial('Campus Exemplo', '11222333000181');
  ids.B = await filial('Colégio Exemplo', '11444777000161');
  ids.predio = (await api('POST', '/predios', { token: tk.admin, body: { filial_id: ids.A, nome: 'Prédio 1' } })).body.id;
  ids.predioB = (await api('POST', '/predios', { token: tk.admin, body: { filial_id: ids.B, nome: 'Prédio do Colégio' } })).body.id;
  for (const [nome, perfil, filiais] of [['gestorA', 'gestor', [ids.A]], ['tecA', 'tecnico', [ids.A]], ['tecA2', 'tecnico', [ids.A]],
    ['coordA', 'consulta', [ids.A]], ['outroA', 'consulta', [ids.A]], ['tecB', 'tecnico', [ids.B]]]) {
    const r = await api('POST', '/usuarios', { token: tk.admin, body: { nome: `Usuário ${nome}`, email: `${nome}@exemplo.com`, senha: 'senha1234', perfil, filiais } });
    ids[nome] = r.body.id;
    tk[nome] = await amb.login(`${nome}@exemplo.com`, 'senha1234');
  }
});

after(async () => { if (amb) await amb.encerrar(); });

const nova = (extra = {}, token = tk.tecA) => api('POST', '/acoes', { token, body: {
  filial_id: ids.A, titulo: 'Instalar guarda-corpo na escada de acesso ao telhado', descricao: 'Guarda-corpo metálico de 1,10 m com rodapé',
  prazo: somarDias(HOJE, 20), origem_tipo: 'predio', origem_id: ids.predio, tipo_medida: 'engenharia', prioridade: 'alta', responsavel_id: ids.coordA, ...extra
} });

test('abrir ação: origem da filial, responsável que atua nela e aviso por e-mail', async () => {
  assert.equal((await nova({}, tk.coordA)).status, 403, 'consulta não abre ação');
  assert.equal((await nova({}, tk.tecB)).status, 404, 'filial de fora');
  assert.equal((await nova({ prazo: somarDias(HOJE, -1) })).status, 400, 'prazo no passado');
  assert.equal((await nova({ origem_tipo: 'predio', origem_id: ids.predioB })).status, 400, 'origem de outra filial');
  assert.equal((await nova({ origem_tipo: 'manual', origem_id: undefined })).status, 400, 'manual sem descrição');
  assert.equal((await nova({ origem_tipo: 'chute' })).status, 400);
  assert.equal((await nova({ responsavel_id: ids.tecB })).status, 400, 'responsável não atua na filial');
  assert.equal((await nova({ responsavel_id: undefined })).status, 400, 'sem responsável');
  assert.equal((await nova({ tipo_medida: 'reza' })).status, 400);

  enviados.length = 0;
  const r = await nova();
  assert.equal(r.status, 201, JSON.stringify(r.body));
  ids.a1 = r.body.id;
  assert.equal(r.body.numero, `${ANO}/0001`);
  assert.equal(r.body.origem_descricao, 'Prédio Prédio 1');
  assert.equal(r.body.responsavel, 'Usuário coordA');
  assert.equal(r.body.registros[0].tipo, 'abertura');
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].to, 'coorda@exemplo.com');
  assert.match(enviados[0].subject, new RegExp(`ação ${ANO}/0001 sob sua responsabilidade`));

  const manual = await nova({ origem_tipo: 'manual', origem_id: undefined, origem_descricao: 'Visita técnica de 20/11', responsavel_id: undefined,
    responsavel_nome: 'Empresa de manutenção predial', titulo: 'Trocar luminárias de emergência queimadas', tipo_medida: undefined });
  assert.equal(manual.status, 201, JSON.stringify(manual.body));
  assert.equal(manual.body.responsavel, 'Empresa de manutenção predial');
  ids.manual = manual.body.id;
  assert.equal((await api('GET', '/acoes', { token: tk.tecB })).body.length, 0, 'outra filial não vê');
});

test('ciclo: responsável registra andamento e conclui com evidência; outra pessoa verifica a eficácia', async () => {
  const fazer = (id, rota, token, body) => api('POST', `/acoes/${id}/${rota}`, { token, body });
  assert.equal((await fazer(ids.a1, 'andamento', tk.outroA, { texto: 'x' })).status, 403, 'consulta que não é o responsável');
  assert.equal((await fazer(ids.a1, 'andamento', tk.tecB, { texto: 'x' })).status, 404);
  const and = await fazer(ids.a1, 'andamento', tk.coordA, { texto: 'Orçamento aprovado; serralheria contratada.' });
  assert.equal(and.status, 201, JSON.stringify(and.body));
  assert.equal(and.body.status, 'em_andamento');
  assert.deepEqual((await api('GET', '/acoes/minhas', { token: tk.coordA })).body.map((a) => a.acao_id), [ids.a1]);

  assert.equal((await fazer(ids.a1, 'concluir', tk.coordA, { texto: 'feito' })).status, 400, 'evidência curta');
  const fim = await fazer(ids.a1, 'concluir', tk.coordA, { texto: 'Guarda-corpo instalado e fixado; foto anexa.', arquivo: foto(), custo_real: 3200.5 });
  assert.equal(fim.status, 200, JSON.stringify(fim.body));
  assert.equal(fim.body.status, 'concluida');
  assert.equal(fim.body.custo_real, 3200.5);
  const evid = fim.body.registros.find((r) => r.tipo === 'conclusao');
  const arq = await fetch(`${amb.base}/acao-registros/${evid.id}/arquivo`, { headers: { Authorization: `Bearer ${tk.gestorA}` } });
  assert.equal(arq.status, 200);
  assert.equal(arq.headers.get('content-type'), 'image/png');

  assert.equal((await fazer(ids.a1, 'verificar', tk.coordA, { eficaz: true, texto: 'ok' })).status, 403, 'verificação é com a equipe de SST');
  const ok = await fazer(ids.a1, 'verificar', tk.tecA, { eficaz: true, texto: 'Inspecionado no local: firme e na altura certa.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'verificada');
  assert.equal((await fazer(ids.a1, 'andamento', tk.coordA, { texto: 'mais' })).status, 409, 'verificada não reabre por andamento');
  assert.equal((await fazer(ids.a1, 'cancelar', tk.gestorA, { motivo: 'Tentando cancelar uma ação já verificada' })).status, 409);

  // Quem concluiu não verifica; ineficaz reabre
  const b = (await nova({ titulo: 'Sinalizar o piso molhado na cozinha', responsavel_id: ids.tecA })).body.id;
  await fazer(b, 'concluir', tk.tecA, { texto: 'Placas de piso molhado compradas e em uso.' });
  assert.equal((await fazer(b, 'verificar', tk.tecA, { eficaz: true, texto: 'ok' })).status, 409, 'quem concluiu não verifica');
  const reab = await fazer(b, 'verificar', tk.tecA2, { eficaz: false, texto: 'As placas ficam guardadas; o piso segue sem sinalização.' });
  assert.equal(reab.body.status, 'em_andamento');
  assert.equal(reab.body.registros.at(-1).tipo, 'reabertura');
  await fazer(b, 'concluir', tk.tecA, { texto: 'Suporte fixo para as placas ao lado da pia.' });
  assert.equal((await fazer(b, 'verificar', tk.tecA2, { eficaz: true, texto: 'Placas em uso nas duas visitas.' })).body.status, 'verificada');
});

test('prazo: só a gestão reprograma, com motivo, e o histórico fica guardado', async () => {
  const prazo = (token, body) => api('POST', `/acoes/${ids.manual}/prazo`, { token, body });
  assert.equal((await prazo(tk.tecA, { prazo: somarDias(HOJE, 40), motivo: 'Peça em falta no fornecedor' })).status, 403);
  assert.equal((await prazo(tk.gestorA, { prazo: somarDias(HOJE, 40), motivo: 'curto' })).status, 400);
  assert.equal((await prazo(tk.gestorA, { prazo: somarDias(HOJE, -1), motivo: 'Peça em falta no fornecedor' })).status, 400);
  const r = await prazo(tk.gestorA, { prazo: somarDias(HOJE, 40), motivo: 'Peça em falta no fornecedor' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.prazo, somarDias(HOJE, 40));
  assert.equal(r.body.prazo_original, somarDias(HOJE, 20));
  assert.equal(r.body.prazos.length, 1);
  assert.equal((await api('PUT', `/acoes/${ids.manual}`, { token: tk.tecA, body: { prazo: somarDias(HOJE, 50) } })).status, 400, 'PUT não mexe no prazo');
  await assert.rejects(amb.knex('acao_prazos').update({ motivo: 'outro' }), /só aceita inclusão/);
  await assert.rejects(amb.knex('acao_registros').del(), /só aceita inclusão/);
});

test('pendências, semáforo, relatório e aviso semanal (o responsável recebe as suas)', async () => {
  // Uma ação atrasada (no teste, o prazo é ajustado direto no banco)
  const atrasada = (await nova({ titulo: 'Proteger a polia do exaustor', responsavel_id: ids.coordA, tipo_medida: 'engenharia' })).body.id;
  assert.equal((await nova({ titulo: 'Revisar os extintores do almoxarifado', responsavel_id: ids.tecA, prazo: somarDias(HOJE, 10) })).status, 201);
  await amb.knex('acoes').where({ id: atrasada }).update({ prazo: somarDias(HOJE, -5), prazo_original: somarDias(HOJE, -5) });

  const pend = (await api('GET', '/acoes/pendencias', { token: tk.outroA })).body;
  const item = pend.itens.find((i) => i.acao_id === atrasada);
  assert.equal(item.situacao, 'atrasada');
  assert.equal(item.dias_atraso, 5);
  assert.ok(pend.itens.every((i) => ['atrasada', 'vence_em_breve'].includes(i.situacao)));
  assert.equal((await api('GET', `/acoes/pendencias?todas=true&data_base=${somarDias(HOJE, -1)}`, { token: tk.outroA })).body.itens.length, 0, 'ontem nenhuma ação existia');

  const painel = (await api('GET', `/painel/conformidade?filial_id=${ids.A}`, { token: tk.outroA })).body.filiais[0];
  assert.equal(painel.modulos.acoes.cor, 'vermelho');
  const rel = await fetch(`${amb.base}/relatorios/acoes?todas=true`, { headers: { Authorization: `Bearer ${tk.gestorA}` } });
  assert.equal(rel.status, 200);

  const previa = (await api('GET', '/avisos/previa', { token: tk.admin })).body;
  assert.ok(previa.itens.some((i) => i.modulo === 'Plano de ação' && i.descricao.includes('polia')));
  const coord = previa.destinatarios.find((d) => d.email === 'coorda@exemplo.com');
  assert.equal(coord.origem, 'responsavel');
  enviados.length = 0;
  assert.equal((await api('POST', '/avisos/enviar', { token: tk.admin })).status, 201);
  const doCoord = enviados.find((m) => m.to === 'coorda@exemplo.com');
  assert.ok(doCoord.text.includes('polia'), 'recebe as próprias ações');
  assert.ok(!doCoord.text.includes('almoxarifado'), 'e só as próprias');
  const doAdmin = enviados.find((m) => m.to === 'admin@exemplo.com');
  assert.ok(doAdmin.text.includes('polia') && doAdmin.text.includes('almoxarifado'), 'o admin recebe todas');
  assert.ok(!doAdmin.text.includes('luminárias'), 'prazo reprogramado para 40 dias: fora da janela de 1 mês');

  assert.equal((await api('POST', `/acoes/${atrasada}/cancelar`, { token: tk.tecA, body: { motivo: 'Exaustor foi desativado' } })).status, 403);
  const c = await api('POST', `/acoes/${atrasada}/cancelar`, { token: tk.gestorA, body: { motivo: 'Exaustor desativado e retirado do prédio' } });
  assert.equal(c.body.status, 'cancelada');
  assert.ok(!(await api('GET', '/acoes/pendencias?todas=true', { token: tk.outroA })).body.itens.some((i) => i.acao_id === atrasada));
});
