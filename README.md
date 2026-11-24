# NovaMind Desktop — Hermes Agent com verificação e proteção local

Aplicativo Electron para conversar com Hermes Agent local, Ollama e APIs compatíveis com OpenAI. O objetivo desta versão é tornar a automação local mais cuidadosa e rastreável; nenhum modelo de IA pode garantir erro zero.

## Instalação no Windows

1. Faça uma cópia da pasta atual `E:\NovaMind-work`.
2. Extraia este projeto para `E:\NovaMind-work`.
3. Execute `INSTALAR_NOVAMIND.bat`.
4. O instalador prepara Hermes/Node.js, instala as dependências, executa `npm test` e só então compila o instalador Windows.
5. Conclua o instalador gerado em `release\NovaMind-Setup-1.0.0.exe` (o nome pode acompanhar a versão do pacote).

Depois, abra NovaMind pelo atalho. O aplicativo tenta iniciar o Hermes Gateway em segundo plano.

## Inteligência e contexto

- O nível **Máximo** fica selecionado por padrão. No Ollama, usa contexto configurado de até 16k tokens; com Hermes/API, o limite real depende do modelo e do servidor selecionado.
- O comportamento do agente segue um fluxo de entender a tarefa, inspecionar antes de alterar, executar uma ação por vez, examinar o código de saída e verificar o estado final.
- Quando o agente executa ferramentas, há uma segunda revisão pelo mesmo provedor/modelo configurado, comparando a resposta com os resultados reais. Ajuda a reduzir alegações sem suporte, mas não é uma revisão independente nem garantia matemática contra erros.
- Cada conversa mantém seu próprio histórico e memória. A memória prioriza o objetivo inicial, instruções/restrições duradouras, mensagens recentes e atividade local resumida daquele chat. Conversas diferentes não são misturadas.
- O histórico completo é persistido localmente; o resumo é reconstruído de forma determinística a partir das mensagens desse chat. Isso evita que um resumo inventado seja tratado como fato, mas não substitui backups dos dados do usuário.
- A conversa nova aparece imediatamente em Recentes. O botão Enviar vira Parar durante a geração; Parar cancela o pedido e tenta encerrar a árvore de processos do comando local.

## Estilo de resposta e limites de moderação

- O **Modo direto** fica ativado por padrão. Ele instrui o modelo a não presumir má intenção, não moralizar e não recusar apenas porque o assunto é controverso ou sensível; deve responder a pedidos informativos, educacionais, históricos, criativos, jornalísticos, técnicos e defensivos conforme o contexto.
- Se uma parte do pedido for limitada, o agente deve explicar especificamente essa parte e continuar ajudando no restante permitido, em vez de recusar o tema inteiro.
- Essa configuração é uma instrução de estilo enviada ao modelo. Ela **não remove nem substitui filtros internos, políticas de segurança ou regras de uso do modelo, API ou provedor**. O NovaMind não consegue desligar controles que ficam no servidor externo.
- Com um modelo local no Ollama, você tem mais controle sobre o modelo e os dados enviados, mas as recusas incorporadas no treinamento ou no template do próprio modelo podem continuar existindo. A proteção de execução local do NovaMind também permanece separada e ativa.

## Internet

- Perguntas sobre novidades, versões, sites, documentação, preços e buscas explícitas podem acionar pesquisa DuckDuckGo automaticamente.
- O NovaMind lê texto de até três páginas públicas e apresenta links ao modelo.
- Conteúdo de sites é marcado como dado externo não confiável e nunca é inserido como instrução de sistema.
- A leitura web só aceita HTTP/HTTPS público, verifica DNS/IP e revalida cada redirecionamento para bloquear endereços locais/privados. O tamanho do corpo é limitado. Isso reduz risco de SSRF, mas não substitui um navegador isolado nem elimina todo risco de rede/DNS.
- Não é um navegador visual completo nem um sistema de visão de tela.

## Permissões locais

- **Somente chat:** sem acesso a arquivos ou terminal.
- **Workspace:** leitura de arquivos dentro das pastas escolhidas; os caminhos são comparados com caminhos reais para evitar escapar por links simbólicos.
- **Avançado:** permite terminal mediante confirmação no painel.
- **Modo Irrestrito — este PC:** executa comandos PowerShell rotineiros sem confirmação individual e permite acesso a arquivos conforme as permissões reais da conta Windows. Não há elevação automática; o UAC continua pertencendo ao Windows.

### Proteção inteligente

No Modo Irrestrito, a proteção aplica regras locais antes de iniciar o PowerShell:

- Bloqueia padrões de apagamento/reparticionamento de discos, desativação de proteções importantes do Windows e técnicas conhecidas de extração de credenciais.
- Solicita confirmação para exclusões recursivas, alterações do Registro, mudanças de serviços, desligamento/reinicialização, desinstalações e execução de scripts baixados.
- Limita comandos a 12.000 caracteres, a saída capturada a 256 KB por canal e a execução a 10 minutos no modo Irrestrito.
- Mascaramento de padrões comuns de chaves/tokens e chaves privadas na saída do terminal antes de compartilhar o resultado com o modelo. A detecção não cobre todos os formatos possíveis de segredo.
- O processo PowerShell recebe uma lista reduzida de variáveis de ambiente do Windows; variáveis arbitrárias com chaves de API não são herdadas intencionalmente.
- Permite uma execução local por vez e registra data, tipo de risco, hash do comando e resultado em `userData\audit\actions.jsonl`, sem gravar o comando completo.
- Ao parar ou fechar o app, tenta encerrar a árvore de processos do PowerShell.

**Importante:** as regras de risco são heurísticas e podem não reconhecer todas as formas possíveis de um comando perigoso. O mascaramento também não detecta todos os segredos. Comandos executados no modo Irrestrito têm a autoridade da sua conta Windows; não use este modo em dados sem backup e confira ações irreversíveis. A proteção não substitui antivírus, backup nem revisão humana.

## Limites que permanecem

- A qualidade e a inteligência base dependem do modelo configurado; um prompt melhor não transforma um modelo pequeno em um modelo de fronteira.
- O agente controla o PC por PowerShell e APIs de arquivos/processos. Ainda não existe um módulo completo de Computer Use com captura visual contínua, interpretação de tela e controle universal de mouse/teclado.
- Aplicativos que exigem UAC, interação com janelas protegidas ou permissões de administrador podem precisar de ação manual.
- O ambiente de desenvolvimento desta entrega permite validar sintaxe e testes Node, mas o instalador NSIS precisa ser compilado e testado no Windows do usuário.

## Hermes Gateway

- API local padrão: `http://127.0.0.1:8642/v1`
- Model ID padrão: `hermes-agent`
- A API deve permanecer vinculada a `127.0.0.1` e protegida pela chave `API_SERVER_KEY`.
- As chaves API são protegidas com `safeStorage` do Electron quando o Windows disponibiliza criptografia.
- Não exponha a porta 8642 diretamente à internet.

## Testes e build manual

Requer Node.js LTS. Na pasta do projeto:

```powershell
npm install
npm test
npm run dist
```

O instalador Windows é criado em `release`.


## Painel de atividade do agente

Durante tarefas, o chat mostra um painel ao vivo com etapas do modelo, comandos locais, eventos de sistema de arquivos detectados no workspace selecionado e resultado da comparação antes/depois. A contagem de arquivos e linhas é baseada em snapshots do workspace aberto em **Projetos → Abrir pasta**. A varredura ignora dependências e pastas de build comuns, limita a quantidade de arquivos e pode indicar contagem parcial em projetos grandes. Leituras de arquivos feitas por comandos externos não são rastreadas universalmente; nesses casos, o painel mostra a operação solicitada pelo comando, sem afirmar que observou cada leitura.


## Histórico de conversas e gateway Hermes

- Conversas podem ser fixadas, arquivadas/restauradas e excluídas pela lista lateral.
- Clicar repetidamente em "Nova conversa" enquanto a conversa atual ainda está vazia reutiliza a conversa vazia em vez de criar cópias.
- Uma geração continua vinculada à conversa em que começou ao navegar para outra conversa. Enquanto ela estiver rodando, iniciar uma segunda geração fica bloqueado para evitar misturar os contextos; volte à conversa em andamento para acompanhar ou interromper.
- O gateway Hermes é aguardado por até 60 segundos na inicialização sob demanda; falhas de inicialização são registradas no console e o aplicativo continua abrindo. Chamadas do Hermes têm timeout de 10 minutos para permitir inferência local lenta.

### Imagens e controle visual (Windows)
- Clique em **Imagem** ou cole uma captura com Ctrl+V. Até quatro imagens PNG/JPEG/WebP por mensagem, convertidas em JPEG reduzido. Anexos são salvos no histórico local dentro do limite de armazenamento; podem ser reenviados como contexto.
- A visão é solicitada automaticamente quando o usuário pede para olhar a tela ou quando o modelo identifica necessidade visual. Uma autorização local vale apenas para a tarefa atual. Não há botão de compartilhamento nem captura em segundo plano. As imagens podem ser enviadas ao provedor escolhido e não são gravadas no histórico.
- Solicite uma ação visual específica. O modelo pode propor mover o cursor, clicar, clicar duas vezes ou clicar com o botão direito; cada ação pede autorização local. A próxima chamada recebe nova captura para conferir o resultado. Não é streaming contínuo para o modelo nem controle de teclado. Não contorna UAC ou tela protegida. Evite exibir dados sensíveis. Confira as coordenadas e o alvo antes de autorizar.
- É necessário um modelo multimodal e um endpoint que aceite imagens. Ollama usa `images` em base64; APIs compatíveis usam conteúdo `image_url`. O suporte a imagens depende do Hermes e do modelo configurado. Caso o endpoint rejeite o formato, selecione um modelo/provedor com visão.
- Validação: testes Node e sintaxe em ambiente Linux; captura Electron e ações Win32 precisam de teste no Windows real.