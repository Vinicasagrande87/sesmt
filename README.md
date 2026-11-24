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
- **Importação em lote:** setor e funções podem vir pelo nome, sem diferenciar maiúsculas e acentos ("ESTAGIARIO" = "Estagiário"). Vale tudo ou nada: um erro em qualquer grupo cancela o lote inteiro.
- **Planilha de importação (Excel):** abas Grupos, Riscos, EPIs e Treinamentos, ligadas pelo Nº do grupo, com listas de valores válidos. A leitura aponta todos os problemas de uma vez (linha e aba), inclusive a mesma função repetida no mesmo setor.
  ```bash
  npm run pgr:planilha -- modelo pgr-modelo.xlsx            # planilha em branco para preencher
  npm run pgr:planilha -- converter pgr.xlsx grupos.json    # valida e gera o JSON da API
  SESMT_SENHA=... npm run pgr:planilha -- importar pgr.xlsx --url http://localhost:3000 --pgr 12 --email tecnico@empresa.com
  ```
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

### PPCI por prédio
- **Projeto aprovado (PPCI)** de cada prédio: PDF, número do processo, responsável técnico e as **medidas previstas** (extintores por agente, hidrantes, iluminação de emergência, saídas, brigada...).
- **Alvará** (APPCI, AVCB ou outro) com validade: aviso de renovação 90 dias antes.
- **Projeto x instalado:** o sistema compara o que o projeto prevê com os equipamentos ativos do prédio (ex.: 3 extintores PQS ABC previstos, 2 instalados = faltando) e aponta o que está instalado fora do projeto.
- **Equipamentos com QR próprio:** a etiqueta colada no extintor ou hidrante abre o checklist do tipo de equipamento.
- **Manutenções:**
  - extintor: recarga (anual) e teste hidrostático (5 anos), com selo e empresa;
  - sem teste registrado, o vencimento é estimado pelo ano de fabricação;
  - hidrante e mangotinho: manutenção anual das mangueiras.
- **Inspeção mensal pelo QR** em `/inspecao.html`, pelo celular:
  - checklist Sim / Não / Não se aplica, foto opcional;
  - item "Não" exige descrever o problema;
  - uma inspeção por equipamento por dia, com código de verificação público;
  - sem QR (etiqueta arrancada), só com justificativa.
- **Pendências:** prédio sem PPCI ou alvará, alvará vencido ou vencendo, divergência com o projeto, recarga/teste/manutenção vencidos ou sem registro, inspeção atrasada e equipamento não conforme.
- **Equipamento retirado é baixado pela gestão, com motivo:** o histórico de inspeções e manutenções continua guardado. Cada inspeção registra onde o equipamento estava naquele dia.

### Relatórios e painel de conformidade
- **Painel de conformidade (semáforo)** por filial e por módulo (treinamentos, ASOs, ordens de serviço e PPCI):
  - vermelho: algo vencido, faltando ou sem registro;
  - amarelo: só itens vencendo ou para conferir;
  - verde: tudo em dia;
  - cinza: nada a verificar.

  Cada módulo mostra quantos itens foram verificados e o percentual em dia.
- **"Como estava em uma data":** `?data_base=AAAA-MM-DD` no painel, nas pendências e nos relatórios.
  - Cada documento vale pela data do fato (realização, exame, ciência, aprovação, serviço, inspeção).
  - Quem estava em cada filial e função sai do histórico de lotações.
  - As exigências de treinamento por função e o local de cada equipamento também têm histórico.
  - Registro anulado não conta. Documento lançado depois da data-base aparece marcado com `*`.
- **Relatórios em PDF e Excel**, nas pendências de cada módulo e no painel:
  - o cabeçalho traz a data-base, quem emitiu e o código de verificação com QR;
  - cada emissão fica registrada com o SHA-256 do conteúdo e do arquivo;
  - a verificação pública mostra só o resumo (contagens), nunca a lista de pessoas.

### Integridade: cadeia de hash e fechamento mensal
- **Tabelas de prova só aceitam inclusão:** presenças, ciências, ASOs, inspeções, manutenções, estornos, anulações, relatórios emitidos e fechamentos.
  - O próprio banco recusa `UPDATE`, `DELETE` e `TRUNCATE`.
  - A correção continua sendo por anulação ou estorno, que também é inclusão.
- **Auditoria encadeada por hash:** cada linha recebe uma sequência e o SHA-256 da linha anterior junto com o seu próprio conteúdo.
  - A selagem roda logo depois de cada requisição e, por garantia, a cada minuto.
  - A matriz confere a cadeia inteira em `GET /auditoria/integridade`.
  - Uma linha alterada, apagada ou inserida no meio quebra a cadeia, e a conferência aponta onde.
- **Fechamento mensal por filial** (pela gestão, só de mês já encerrado). Ele congela:
  - a situação de cada módulo no último dia do mês, com o semáforo e a lista completa;
  - a impressão digital (SHA-256) de cada registro de prova lançado no mês;
  - a âncora na cadeia da auditoria.

  Os fechamentos da filial são encadeados entre si e têm código de verificação público.
- **Conferência do fechamento:** recalcula tudo e aponta cada registro alterado, apagado ou lançado depois com data retroativa.
- **Recomendação para produção:** o usuário do banco usado pela aplicação não deve ser dono das tabelas nem superusuário. Assim ele não consegue desligar as travas.

### Ocorrências: acidentes, CAT e investigação
- **Tipos:** acidente típico, de trajeto, doença ocupacional, incidente (dano sem lesão) e quase-acidente.
  - Numeração própria por filial e ano (ex.: 2026/0003).
  - Vítimas de qualquer vínculo: empregado, terceiro (com a empresa), estudante e visitante.
  - Do empregado, ficam gravados o setor e a função da época.
- **Campos do eSocial S-2210** já guardados: tipo de local, horas trabalhadas antes, parte do corpo e lateralidade, natureza da lesão, agente causador, situação geradora, comunicação à polícia e atestado.
- **CAT por vítima empregada:**
  - prazo legal do 1º dia útil seguinte e, no óbito, imediato (Lei 8.213, art. 22);
  - CAT inicial, reabertura e óbito, com arquivo;
  - só aceita inclusão (correção por anulação) e mostra se foi emitida no prazo.
- **Sigilo médico:** CID, atestado e médico só para saúde/admin, inclusive na leitura e no PDF. O CID não vai para o log de auditoria.
- **Investigação:**
  - método (árvore de causas, 5 porquês, Ishikawa), equipe, fatos, causas e conclusão;
  - causas classificadas como imediata, raiz ou contribuinte e por categoria (6M + gestão);
  - prazo de 30 dias para concluir;
  - só conclui com causas, conclusão escrita e a CAT de cada empregado registrada;
  - depois de concluída, fica travada, e só afastamento, retorno, óbito e dados médicos continuam sendo atualizados.
- **Cancelamento** pela gestão, com motivo. A ocorrência cancelada continua guardada.
- **Indicadores da NBR 14280** por filial e mês:
  - taxa de frequência e de gravidade, com dias perdidos e debitados;
  - horas-homem informadas pela filial ou, se não houver, estimadas pelo número de empregados;
  - trajeto fica fora das taxas;
  - dias sem acidente com afastamento.
- **Integrações:**
  - e-mail na hora do registro, com o prazo da CAT;
  - CAT e investigação no resumo semanal de avisos;
  - módulo próprio no semáforo e relatório PDF/Excel;
  - PDF da ocorrência;
  - CAT, testemunhas e anexos na impressão digital do fechamento mensal.
- Os registros da tabela antiga de acidentes foram copiados como ocorrências de legado. A tabela antiga ficou guardada.

### Plano de ação (NR-1)
- **Cada ação tem:**
  - o quê e como;
  - a origem: ocorrência, PGR, inspeção de incêndio, prédio (PPCI) ou outra (visita, auditoria, reunião);
  - a hierarquia de controle da NR-1 (eliminação, substituição, engenharia, administrativa, EPI);
  - prioridade, prazo e custo estimado/real;
  - o responsável: um usuário da filial ou um nome sem login, como uma empresa contratada.
- **Ciclo PDCA:**
  - aberta → em andamento → concluída **com evidência** (texto + foto ou documento) → **verificação de eficácia**;
  - quem verifica é outra pessoa da equipe de SST, não quem concluiu;
  - ação ineficaz reabre.
- **O responsável registra o andamento e conclui a própria ação**, mesmo com perfil consulta, e recebe e-mail quando ganha uma ação.
- **Prazo:** só a gestão reprograma, com motivo. O prazo original e cada reprogramação ficam guardados.
- **Só inclusão:** a linha do tempo e o histórico de prazos não se alteram nem se apagam.
- **Na ocorrência:** se a investigação recomenda medidas, a ocorrência só conclui com ao menos uma ação aberta no plano.
- **Integrações:**
  - pendências com situação "como estava em uma data";
  - módulo no semáforo e relatório PDF/Excel;
  - resumo semanal por e-mail, em que cada responsável recebe as suas ações;
  - linha do tempo e reprogramações na impressão digital do fechamento mensal.

### Permissão de trabalho (NR-35, NR-33, trabalho a quente, NR-10)
- **Quatro tipos**, cada um com papéis obrigatórios e checklist próprio:
  - trabalho em altura (NR-35);
  - espaço confinado (PET, NR-33): executante, vigia e supervisor de entrada;
  - trabalho a quente: executante e observador de fogo;
  - eletricidade (NR-10): checklist com a sequência de desenergização do item 10.5.1.
- **O sistema recusa quem não pode executar:**
  - treinamento faltando ou vencido até o fim do trabalho (pela NR do tipo, ou pelos cursos que a matriz definir para cada papel);
  - ASO faltando, vencido, inapto ou apto com restrição;
  - item do checklist não atendido.

  A resposta lista o problema de cada pessoa, e a tentativa recusada fica na auditoria. A conferência aprovada fica guardada na permissão.
- **Espaço confinado:**
  - medição inicial da atmosfera obrigatória (O₂ 19,5–23%, LIE < 10%, H₂S < 8 ppm, CO < 39 ppm);
  - uma medição fora do limite durante o trabalho **suspende a permissão na hora**.
- **Validade:** no máximo 12 horas (um turno).
- **Liberação:** a permissão só é liberada depois que **cada participante assina com crachá + PIN**. A gestão pode registrar a assinatura em papel, com justificativa.
- **PDF para afixar no local** com QR. A verificação pública diz se a permissão está válida agora (`pode_trabalhar`).
- **Encerramento** com registro de como a área ficou, ou cancelamento com motivo.
- **Pendências e integrações:** permissão vencida sem encerramento fica vermelha no semáforo, e há relatório PDF/Excel. Assinaturas e medições só aceitam inclusão e entram no fechamento mensal.

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
- **Contas protegidas:**
  - login bloqueado por 15 minutos após 5 erros na mesma conta, ou 30 erros pelo mesmo IP;
  - o usuário troca a própria senha, e as outras sessões abertas caem;
  - "esqueci a senha": link por e-mail que vale 1 hora e uma vez (o banco guarda só o hash do token);
  - a matriz pode encerrar todas as sessões de alguém, por exemplo se o celular foi perdido.
- **Cabeçalhos de segurança** (`helmet`, com política de conteúdo) e **CORS fechado**: só os sites listados em `CORS_ORIGINS` chamam a API pelo navegador.

### Avisos de vencimento por e-mail
- **Toda semana** (segunda, 7h, configurável), sai um e-mail com o que já venceu e o que vence **no próximo mês**:
  - treinamentos e ASOs (inclusive o prazo do demissional);
  - alvará, recarga, teste hidrostático, manutenção e inspeção mensal dos equipamentos;
  - vigência do PGR;
  - CA dos EPIs e lotes em estoque com validade.
- **Quem recebe:** todos os admins ativos (todas as filiais), mais os destinatários que a matriz cadastrar. Cada destinatário pode receber todas as filiais ou só algumas.
- **E-mails só no banco:** os endereços nunca ficam no código. Prévia, envio manual e histórico ficam em `/avisos`. A mesma semana nunca é enviada duas vezes.

## Em construção (roadmap)

O modelo completo está sendo desenhado junto com a rotina real de um SESMT com várias filiais:

1. ~~**Estrutura multi-filial** com permissões por filial~~ ✅ concluída
2. ~~**EPI com valor jurídico** e **estoque com custo histórico (PEPS)**~~ ✅ concluída
3. ~~**Treinamentos:** exigências por função e lista de presença assinada com o crachá~~ ✅ concluída
4. ~~**ASOs (PCMSO):** controle de vencimentos, com acesso restrito aos dados de saúde (LGPD)~~ ✅ concluída
5. ~~**PGR e ordens de serviço:** inventário de riscos por filial e OS com ciência pelo crachá~~ ✅ concluída
6. ~~**PPCI por prédio:** projeto aprovado, alvará, projeto x instalado, manutenção de extintores e inspeção mensal por QR~~ ✅ concluída
7. ~~**Relatórios:** PDF e Excel com código de verificação, situação "como estava em uma data" e painel de conformidade~~ ✅ concluída
8. ~~**Encadeamento por hash e fechamento mensal:** prova de que nada foi alterado depois~~ ✅ concluída

## Tecnologias

- **Node.js** + **Express 5**
- **PostgreSQL** + **Knex** (migrations)
- **JWT** (`jsonwebtoken`) e **bcrypt** (`bcryptjs`) para autenticação
- **qrcode** para gerar os QR codes e **html5-qrcode** para a leitura pela câmera
- **pdfkit** e **exceljs** para os PDFs e planilhas
- **nodemailer** (SMTP) para os e-mails e **helmet** para os cabeçalhos de segurança
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

Para os e-mails (avisos e "esqueci a senha"), preencha `SMTP_*`, `EMAIL_REMETENTE` e `APP_URL` no `.env`. Todo admin recebe os avisos. Outras pessoas são cadastradas em `POST /avisos/destinatarios`.

O leitor fica em `http://localhost:3000/leitor.html`. No celular, a câmera só abre por **HTTPS**: use o ambiente de produção ou um túnel (por exemplo, `npx localtunnel --port 3000`).

### Testes

```bash
npm test
```

O primeiro `npm test` baixa o PostgreSQL embutido. Cada execução:
- sobe um banco temporário;
- roda as migrations;
- testa permissões, filtragem por filial, lotação, auditoria, entregas, estoque, treinamentos, ASOs, PGR, ordens de serviço, PPCI, relatórios, integridade (travas do banco, cadeia de hash e fechamento mensal), contas, avisos por e-mail ocorrências (CAT, investigação e indicadores), plano de ação e permissão de trabalho;
- apaga tudo no fim.

## Principais rotas

| Método | Rota | Descrição |
|---|---|---|
| POST | `/auth/login` | Login, devolve o token JWT e as filiais do usuário (com limite de tentativas) |
| GET | `/auth/me` | Usuário logado |
| POST | `/auth/senha` | O usuário troca a própria senha (as outras sessões caem) |
| POST | `/auth/esqueci`, `/auth/redefinir` | Link de redefinição por e-mail / criar a nova senha (`/redefinir-senha.html`) |
| GET/POST/PUT | `/usuarios` | Usuários e suas filiais (matriz) |
| POST | `/usuarios/:id/encerrar-sessoes` | Derruba todos os logins abertos do usuário (matriz) |
| GET/POST/PUT | `/avisos/destinatarios` | Quem recebe os avisos além dos admins (matriz) |
| GET | `/avisos/previa`, `/avisos/envios` | O que seria enviado hoje / histórico de envios (matriz) |
| POST | `/avisos/enviar` | Envia os avisos agora (matriz) |
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
| GET | `/verificar/:codigo` | Verificação pública de entrega, presença, certificado, ciência de OS, inspeção de incêndio, relatório, fechamento ou permissão de trabalho |
| GET | `/painel/conformidade` | Semáforo por filial e módulo (`?filial_id=&data_base=`) |
| GET | `/relatorios/:tipo` | PDF ou Excel (`?formato=pdf\|xlsx&data_base=&todas=true`): `conformidade`, `treinamentos`, `asos`, `ordens_servico`, `ppci`, `ocorrencias`, `acoes`, `permissoes` |
| GET | `/relatorios-emitidos` | Relatórios emitidos nas filiais do usuário, com código e SHA-256 |
| GET/POST | `/fechamentos` | Fechamento mensal da filial (POST pela gestão); `?filial_id=` lista também os meses em aberto |
| GET | `/fechamentos/:id`, `/fechamentos/:id/conferencia` | Situação congelada / conferência do que mudou desde o fechamento |
| GET | `/auditoria/integridade` | Confere a cadeia de hash da auditoria (matriz) |
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
| GET/POST | `/ppcis` | Projeto aprovado do prédio com as medidas previstas (+ `/:id/arquivo`, `/:id/anular`) |
| GET/POST | `/alvaras` | Alvarás com validade e situação (+ `/:id/arquivo`, `/:id/anular`) |
| GET | `/predios/:id/ppci` | Painel do prédio: PPCI, alvará, projeto x instalado e equipamentos |
| GET | `/ppci/pendencias` | Sem PPCI/alvará, divergência, recarga/teste vencidos, inspeção atrasada, não conforme |
| GET/POST/PUT | `/equipamentos-incendio` | Extintores, hidrantes... por prédio; baixa pela gestão |
| GET | `/equipamentos-incendio/:id/qrcode` | PNG do QR para colar no equipamento |
| POST | `/equipamentos-incendio/inspecao` | Inspeção mensal pelo QR (checklist + foto) |
| POST | `/equipamentos-incendio/:id/manutencoes` | Recarga, teste hidrostático ou manutenção |
| POST | `/estoque/entradas` | Entrada de lote com preço pago |
| GET | `/estoque/saldos`, `/estoque/lotes`, `/estoque/movimentacoes` | Saldos valorizados, lotes e extrato |
| POST | `/estoque/descartes`, `/estoque/ajustes` | Descarte e ajuste de inventário |
| POST | `/estoque/movimentacoes/:id/estorno` | Estorno de entrada, descarte ou ajuste |
| PUT | `/estoque/minimos` | Estoque mínimo por filial |
| GET/POST | `/transferencias` (+ `/receber`, `/cancelar`) | Transferência entre filiais |
| GET/POST/PUT | `/fornecedores` | Fornecedores da filial |
| GET | `/auditoria` | Log de auditoria (matriz) |
| GET | `/status` | Saúde da API e do banco (público, para monitoramento) |
| GET/POST/PUT | `/ocorrencias` | Acidentes, doença ocupacional, incidentes e quase-acidentes (+ `/:id/pdf`, `/:id/cancelar`) |
| POST/PUT | `/ocorrencias/:id/vitimas`, `/ocorrencia-vitimas/:id` | Vítimas: lesão, afastamento, retorno, óbito, dados médicos (saude) |
| POST | `/ocorrencias/:id/testemunhas`, `/ocorrencias/:id/anexos` | Testemunhas e anexos (fotos, laudos) |
| POST | `/ocorrencia-vitimas/:id/cats`, `/cats/:id/anular` | CAT inicial, reabertura ou óbito / anulação (gestão) |
| PUT/POST | `/ocorrencias/:id/investigacao`, `/ocorrencias/:id/concluir` | Investigação com causas / conclusão |
| GET | `/ocorrencias/pendencias` | CAT fora do prazo ou a emitir, investigação atrasada (`?data_base=`) |
| GET | `/ocorrencias/indicadores` | Taxa de frequência e de gravidade (NBR 14280) por filial e mês |
| GET/PUT | `/horas-trabalhadas` | Horas-homem do mês por filial (base das taxas) |
| GET/POST/PUT | `/acoes` | Plano de ação: origem, medida, responsável, prazo (+ `/minhas`) |
| POST | `/acoes/:id/andamento`, `/acoes/:id/concluir` | Andamento e conclusão com evidência (responsável ou equipe) |
| POST | `/acoes/:id/verificar` | Verificação de eficácia por outra pessoa (ineficaz reabre) |
| POST | `/acoes/:id/prazo`, `/acoes/:id/cancelar` | Reprogramação com motivo / cancelamento (gestão) |
| GET | `/acoes/pendencias` | Atrasadas e vencendo (`?data_base=`, `?responsavel_id=`) |
| POST | `/permissoes-trabalho/conferir` | Confere treinamento e ASO de cada participante, sem emitir |
| GET/POST | `/permissoes-trabalho` | Permissões de trabalho; POST emite (recusa quem não pode) (+ `/:id/pdf`) |
| POST | `/permissoes-trabalho/:id/assinar` | Ciência do participante por crachá + PIN (libera quando todos assinam) |
| POST | `/permissoes-trabalho/:id/medicoes` | Medição da atmosfera (fora do limite suspende) |
| POST | `/permissoes-trabalho/:id/encerrar`, `/:id/cancelar` | Encerramento / cancelamento |
| GET/PUT | `/permissoes-trabalho/exigencias` | Cursos exigidos por tipo e papel (matriz) |
| GET | `/permissoes-trabalho/pendencias` | Vencidas sem encerramento e sem todas as assinaturas |

Todas as rotas, exceto `/ping` e `/auth/login`, exigem o cabeçalho `Authorization: Bearer <token>`.

## Autor

**[@Vinicasagrande87](https://github.com/Vinicasagrande87)**: Técnico em Segurança do Trabalho há 14 anos, estudante de Análise e Desenvolvimento de Sistemas.
