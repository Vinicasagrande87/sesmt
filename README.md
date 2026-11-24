# SESMT — Gestão de Segurança do Trabalho

Sistema web para o SESMT (Serviço Especializado em Segurança e Medicina do Trabalho) controlar a entrega de EPIs, o estoque e os custos, além de guardar a **comprovação legal** de tudo o que foi entregue e realizado, pensando em fiscalizações e em futuros processos trabalhistas.

## Sobre mim e o porquê deste projeto

Trabalho há **14 anos como Técnico em Segurança do Trabalho** e estou migrando para a área de tecnologia, cursando **Análise e Desenvolvimento de Sistemas (ADS)**.

Este projeto junta as duas coisas. Ele nasceu de problemas que vivi no dia a dia do SESMT:

- **Fichas de EPI em papel** que se perdem, ficam sem assinatura ou não comprovam a data da troca. Quando chega um processo, anos depois, falta a prova.
- **Controles espalhados em planilhas:** vencimento de treinamentos (NR-10, NR-35...), de ASOs, de extintores e de alvarás de PPCI, cada um num arquivo.
- **Custos sem histórico:** o preço pago por uma luva em 2020 não é o de hoje, e somar e dividir valores esconde o gasto real.

A ideia é usar o conhecimento técnico da área para construir uma ferramenta que um SESMT realmente usaria, e documentar aqui as decisões de desenvolvimento.

## O que já funciona

### Entrega de EPI com valor de prova

- **Assinatura por crachá QR + PIN pessoal.** O QR contém só uma chave aleatória (nunca CPF ou id). O funcionário cria o próprio PIN no primeiro acesso.
  - O PIN é guardado só como hash, e PINs fracos (1234, 1111) são recusados.
  - Após 5 tentativas erradas, o PIN fica bloqueado por 15 minutos.
- **Cada entrega grava as provas:**
  - CA vigente copiado para o registro, com bloqueio se o CA estiver vencido;
  - motivo, técnico, hora do servidor, IP e aparelho;
  - filial, setor e função do funcionário na data;
  - foto opcional, com SHA-256;
  - se havia termo de adesão naquele momento;
  - um código de verificação.
- **Verificação pública:** `/verificar/<código>` confirma que a entrega existe, mostrando só as iniciais do funcionário.
- **Termo de adesão à assinatura eletrônica:** o documento assinado é anexado (PDF ou foto), com hash.
- **Ficha de EPI em PDF (NR-6):** empregador, empregado, declaração, todas as entregas e o código de cada uma.
- **Leitor web** ([public/leitor.html](public/leitor.html)) para celular. Faz login, lê o crachá, cadastra o PIN, mostra só os EPIs com saldo e CA válido, tira a foto (reduzida antes do envio) e exibe o comprovante.

### Estoque com custo histórico

- **Estoque por filial, em lotes:** cada compra guarda o preço pago, o fornecedor, a nota (opcional) e a validade.
- **Custo pelo método PEPS:** cada saída usa o preço do lote de onde saiu. Se sobraram 10 luvas compradas em 2020 a R$ 2 e chegaram outras em 2026 a R$ 5, a entrega de 15 custa 10 × R$ 2 + 5 × R$ 5, e não 15 × a média. O valor gravado nunca muda depois.
- **Movimentações imutáveis:** entrada, entrega, descarte, ajuste de inventário e transferência. Erro se corrige com **estorno**, que devolve ao mesmo lote com o mesmo custo.
- **Lotes vencidos** não são entregues: aparecem separados no saldo, para descarte.
- **Transferência entre filiais:** a origem envia e o destino confirma o recebimento. O custo e a validade do lote original acompanham o material.
- **Saldos valorizados e alerta de estoque mínimo** por filial.
- **Concorrência segura:** os lotes são travados durante a saída, então duas entregas simultâneas não usam o mesmo saldo (há teste para isso).

### Treinamentos

- **Catálogo da matriz:** NR de referência, carga horária, conteúdo programático e validade. Cada **função** tem a sua lista de treinamentos exigidos.
- **Turmas por filial:** datas, local, instrutor e qualificação do instrutor.
- **Lista de presença assinada com o crachá QR + PIN,** no mesmo padrão das entregas:
  - código de verificação, técnico, IP e hora do servidor;
  - uma assinatura por pessoa por dia, para treinamentos de vários dias;
  - listas em papel antigas podem ser lançadas manualmente, com justificativa;
  - presença errada é anulada, nunca apagada.
- **Encerramento da turma:** é aprovado quem esteve em todos os dias, e o instrutor pode marcar reprovação na avaliação. Isso gera o registro de capacitação com o vencimento calculado (31/01 + 1 mês = 28/02).
- **Certificados externos:** curso feito fora, com o PDF anexado (com hash).
- **Pendências por filial e setor:** o que está faltando, vencido ou vencendo em X dias, conforme as exigências da função.
- **PDFs:** lista de presença e certificado com código de verificação.
- **Página de presença** ([public/presenca.html](public/presenca.html)): o técnico escolhe a turma do dia e lê os crachás em sequência. Quem ainda não tem PIN cadastra ali mesmo.
- **`/verificar/<código>`** confirma entregas, presenças e certificados.

### ASOs (NR-7)

- **O PDF da clínica é a fonte:** o perfil saúde anexa o arquivo (com hash) e digita só o essencial:
  - tipo: admissional, periódico, retorno ao trabalho, mudança de riscos ou demissional;
  - data, resultado (apto, apto com restrição, inapto);
  - médico examinador, CRM e clínica; riscos e exames complementares.
- **Vencimento automático:** pela periodicidade que o PCMSO define para a função (1 a 24 meses), ou pela data que o médico indicou no ASO.
- **Sigilo dos dados de saúde (LGPD, art. 11):**
  - só os perfis `saude` e `admin` veem médico, riscos, exames, restrições e o PDF;
  - gestores e técnicos veem só o necessário para organizar o trabalho: apto/inapto e vencimento;
  - cada abertura do PDF fica registrada na auditoria;
  - ASO não entra na verificação pública.
- **Vale o ASO mais recente:** um periódico inapto derruba quem estava em dia.
- **ASO digitado errado é anulado,** nunca apagado.
- **Pendências:** faltando, inapto, vencido, vencendo em X dias e **demissional pendente**:
  - prazo de 10 dias do desligamento;
  - dispensa se o último exame tem menos de 135 dias (grau de risco 1 e 2) ou 90 dias (3 e 4), conforme o grau de risco da filial.

### PGR e ordens de serviço (NR-1)

- **Cada filial carrega o seu PGR:**
  - vigência, responsável técnico e PDF assinado;
  - um PGR pode cobrir mais de um CNPJ.
- **O PGR é organizado em grupos de exposição** (setor + atividade + funções expostas), cada um com:
  - inventário de riscos: só as linhas que existem, sem o checklist vazio;
  - medidas de controle, EPIs por parte do corpo e treinamentos propostos.
- **Classificação de risco pela matriz AIHA:** probabilidade × efeito gera o nível (trivial a muito alto) automaticamente.
- **Importação em lote:** setor e funções podem vir pelo nome, o que facilita carregar a planilha montada a partir do PDF. Vale tudo ou nada: um erro em qualquer grupo cancela o lote inteiro.
- **Publicação congela o PGR** e gera uma **ordem de serviço por grupo**:
  - o conteúdo da OS é "fotografado" (JSON + SHA-256);
  - a ciência do funcionário fica ligada exatamente ao texto que ele viu.
- **A OS de cada funcionário é localizada pelo setor + função:** a mesma função em setores diferentes recebe OS diferentes.
- **Ciência pelo crachá QR + PIN,** com código de verificação público. A OS assinada em papel pode ser lançada pela gestão, com justificativa e digitalização.
- **Revisão:** corrigir ou renovar o PGR gera um novo rascunho copiado do anterior.
  - Ao publicar, o anterior passa a "substituído" e todos precisam dar ciência da nova versão.
  - O histórico das ciências antigas continua guardado.
- **Pendências:** sem PGR, setor/função fora do PGR, ciência pendente, PGR vencido e **EPI exigido pela OS que o funcionário nunca recebeu**.
- **OS em PDF:** em branco (por grupo) ou personalizada, com a ciência e o hash do conteúdo.

### Estrutura e controle
- **Estrutura multi-filial:** matriz → filiais (cada uma com CNPJ próprio, UF, cidade e bairro) → prédios e setores. Funções num catálogo único do grupo.
- **Permissões por perfil e por filial:**

  | Perfil | O que faz |
  |---|---|
  | `admin` (matriz) | Tudo, em todas as filiais |
  | `gestor` | Cadastros da própria filial |
  | `tecnico` | Entregas e estoque |
  | `saude` | Dados de saúde |
  | `consulta` | Só leitura |

  Um usuário de uma filial não vê dados de outra, nem trocando o id na URL.
- **Histórico de lotação:** mudança de setor, função ou filial fecha o período anterior e abre um novo. Isso prova qual era a função do funcionário em cada data.
- **Nada com histórico é apagado:**
  - funcionários são desligados e EPIs, filiais e setores são inativados;
  - o banco recusa exclusões que levariam o histórico junto (`ON DELETE RESTRICT`).
- **Log de auditoria:** quem fez o quê, quando, de qual IP, com os dados antes e depois. Senhas e chaves de crachá nunca aparecem no log.
- **Validações:** CPF, CNPJ e UF; matrícula única por CNPJ; CPF único no grupo.
- **Autenticação com JWT** conferida no banco a cada requisição: um usuário desativado perde o acesso na hora.

## Em construção (roadmap)

O modelo completo está sendo desenhado junto com a rotina real de um SESMT com várias filiais:

1. ~~**Estrutura multi-filial** com permissões por filial~~ ✅ concluída
2. ~~**EPI com valor jurídico** e **estoque com custo histórico (PEPS)**~~ ✅ concluída
3. ~~**Treinamentos:** exigências por função e lista de presença assinada com o crachá~~ ✅ concluída
4. ~~**ASOs (PCMSO):** controle de vencimentos, com acesso restrito aos dados de saúde (LGPD)~~ ✅ concluída
5. ~~**PGR e ordens de serviço:** inventário de riscos por filial e OS com ciência pelo crachá~~ ✅ concluída
6. **PPCI por prédio:**
   - projeto aprovado e alvará;
   - comparação entre o que o projeto prevê e o que está instalado;
   - manutenção de extintores e inspeção mensal por QR no equipamento.
7. **Relatórios em todas as áreas:**
   - exportação em PDF e Excel, com código de verificação;
   - consulta da situação "como estava em uma data";
   - painel de conformidade.
8. **Encadeamento por hash e fechamento mensal:** reforça a prova de que nada foi alterado. A correção por estorno já está pronta.

## Tecnologias

- **Node.js** + **Express 5**
- **PostgreSQL** + **Knex** (migrations)
- **JWT** (`jsonwebtoken`) e **bcrypt** (`bcryptjs`) para autenticação
- **qrcode** para gerar os QR codes e **html5-qrcode** para a leitura pela câmera
- **Testes:** `node:test` + **embedded-postgres**, que roda os testes num PostgreSQL real e temporário, sem depender do banco online

## Como rodar

```bash
npm install
cp .env.example .env          # cole a DATABASE_URL do seu Postgres e gere o JWT_SECRET
npm run db:testar             # confere conexão, SSL e migrations pendentes (nunca mostra a senha)
npx knex migrate:latest
npm run criar-admin -- "Seu Nome" voce@exemplo.com "uma-senha-forte"
npm run dev
```

O leitor fica em `http://localhost:3000/leitor.html`. No celular, a câmera só abre por **HTTPS**: use o ambiente de produção ou um túnel (por exemplo, `npx localtunnel --port 3000`).

### Testes

```bash
npm test
```

O primeiro `npm test` baixa o PostgreSQL embutido. Cada execução:
- sobe um banco temporário;
- roda as migrations;
- testa permissões, filtragem por filial, lotação, auditoria, entregas, estoque, treinamentos, ASOs, PGR e ordens de serviço;
- apaga tudo no fim.

## Principais rotas

| Método | Rota | Descrição |
|---|---|---|
| POST | `/auth/login` | Login, devolve o token JWT e as filiais do usuário |
| GET | `/auth/me` | Usuário logado |
| GET/POST/PUT | `/usuarios` | Usuários e suas filiais (matriz) |
| GET/POST/PUT | `/filiais` | Filiais: CNPJ, UF, cidade, bairro (cadastro pela matriz) |
| GET/POST/PUT | `/predios`, `/setores` | Prédios e setores de cada filial |
| GET/POST/PUT | `/funcoes` | Catálogo de funções (matriz) |
| GET/POST/PUT | `/funcionarios` | Funcionários com filial, setor e função; desligamento via `status` |
| GET | `/funcionarios/:id/lotacoes` | Histórico de filial/setor/função |
| GET | `/funcionarios/:id/qrcode` | PNG do QR do crachá |
| GET | `/funcionarios/qr/:token` | Dados do funcionário, entregas e EPIs vencidos |
| GET/POST/PUT | `/epis` | Catálogo de EPIs com tamanhos e CA (matriz) |
| POST | `/epis/:id/cas`, `/epis/:id/itens` | Renovação de CA e novos tamanhos (matriz) |
| POST | `/funcionarios/qr/:token/pin` | Funcionário cadastra o próprio PIN (primeiro acesso) |
| DELETE | `/funcionarios/:id/pin` | Gestão reseta o PIN |
| POST | `/funcionarios/:id/termo` | Termo de adesão assinado (PDF/foto) |
| GET | `/funcionarios/:id/ficha-epi` | Ficha de EPI em PDF |
| POST | `/entregas/qr` | Entrega por QR + PIN (+ foto), baixa PEPS |
| POST | `/entregas` | Entrega manual com justificativa (gestão) |
| POST | `/entregas/:id/estorno` | Estorno de entrega (gestão) |
| GET | `/verificar/:codigo` | Verificação pública de entrega, presença, certificado ou ciência de OS |
| GET/POST/PUT | `/treinamentos` | Catálogo de treinamentos (matriz) |
| GET/PUT | `/funcoes/:id/treinamentos` | Treinamentos exigidos pela função (matriz) |
| GET | `/treinamentos/pendencias` | Faltando, vencidos e vencendo por filial/setor/funcionário |
| GET/POST/PUT | `/turmas` | Turmas de treinamento |
| POST | `/turmas/:id/presencas` | Presença por QR + PIN (no dia da turma) |
| POST | `/turmas/:id/presencas/manual` | Presença manual com justificativa (gestão) |
| POST | `/presencas/:id/anular` | Anulação de presença (gestão) |
| POST | `/turmas/:id/encerrar`, `/turmas/:id/cancelar` | Encerramento com resultados / cancelamento |
| GET | `/turmas/:id/lista-presenca` | Lista de presença em PDF |
| GET/POST | `/certificados` | Capacitações; POST lança certificado externo com arquivo |
| POST | `/certificados/:id/anular` | Anulação de capacitação (gestão) |
| GET | `/certificados/:id/pdf` | Certificado em PDF (ou o arquivo do externo) |
| GET/POST | `/asos` | ASOs; POST lança com o PDF da clínica (saude/admin) |
| GET | `/asos/pendencias` | Faltando, inapto, vencido, vencendo e demissional pendente |
| POST | `/asos/:id/anular` | Anulação de ASO (saude/admin) |
| GET | `/asos/:id/arquivo` | PDF do ASO (saude/admin, registrado na auditoria) |
| GET/POST/PUT | `/pgrs` | PGR da filial (rascunho, vigente, substituído) com PDF assinado |
| POST | `/pgrs/:id/grupos` | Grupo de exposição, ou `{ grupos: [...] }` para importar em lote |
| PUT/DELETE | `/pgr-grupos/:id` | Alterar ou remover grupo (só rascunho) |
| POST | `/pgrs/:id/publicar`, `/pgrs/:id/revisar` | Publicar (gera as OS) / abrir revisão |
| GET | `/funcionarios/:id/ordem-servico` | OS vigente do funcionário, ciência e histórico |
| POST | `/ordens-servico/ciencia` | Ciência da OS por QR + PIN |
| POST | `/ordens-servico/:id/ciencias/manual` | Ciência de OS assinada em papel (gestão) |
| POST | `/os-ciencias/:id/anular` | Anulação de ciência (gestão) |
| GET | `/ordens-servico/:id/pdf` | OS em PDF (`?funcionario_id=` personaliza) |
| GET | `/ordens-servico/pendencias` | Sem PGR, sem grupo, ciência pendente, EPI nunca entregue |
| POST | `/estoque/entradas` | Entrada de lote com preço pago |
| GET | `/estoque/saldos`, `/estoque/lotes`, `/estoque/movimentacoes` | Saldos valorizados, lotes e extrato |
| POST | `/estoque/descartes`, `/estoque/ajustes` | Descarte e ajuste de inventário |
| POST | `/estoque/movimentacoes/:id/estorno` | Estorno de entrada, descarte ou ajuste |
| PUT | `/estoque/minimos` | Estoque mínimo por filial |
| GET/POST | `/transferencias` (+ `/receber`, `/cancelar`) | Transferência entre filiais |
| GET/POST/PUT | `/fornecedores` | Fornecedores da filial |
| GET | `/auditoria` | Log de auditoria (matriz) |
| GET | `/status` | Saúde da API e do banco (público, para monitoramento) |
| GET/POST | `/acidentes` | Acidentes de trabalho |

Todas as rotas, exceto `/ping` e `/auth/login`, exigem o cabeçalho `Authorization: Bearer <token>`.

## Autor

**[@Vinicasagrande87](https://github.com/Vinicasagrande87)**: Técnico em Segurança do Trabalho há 14 anos, estudante de Análise e Desenvolvimento de Sistemas.
