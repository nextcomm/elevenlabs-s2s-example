// Cache em memória: call_sid → { nome, empresa }
const contactCache = new Map();

// Limite de minutos (entrada): consulta saldo e reporta uso ao app NextVoice.
const QUOTA_BASE = process.env.NEXTVOICE_API_URL; // ex.: https://voice.nextcomm.com.br
const QUOTA_SECRET = process.env.QUOTA_API_SECRET;

// ---------------------------------------------------------------------------
// Receptivo: agente e saudação por DID.
// Na ENTRADA não existe `tag` (ele só vem no createCall), então a chamada não
// diz qual agente usar — quem resolve isso é o número chamado (session.to).
// Configurável por env, com os defaults abaixo:
//   INBOUND_AGENT_MAP={"554135146137":"agent_xxx"}
//   INBOUND_GREETING_MAP={"554135146137":"Oi! Como posso ajudar?"}
// A saudação vai como first_message override — o MESMO canal já usado para
// injetar o nome nas campanhas. Assim o agente no portal fica INTOCADO e o
// mesmo agente serve para ligar e para receber.
// O Jambonz entrega o `to` em formato nacional ("4135146137"), então as chaves
// são normalizadas dos dois lados (com ou sem o DDI 55).
// ---------------------------------------------------------------------------
// Vazios de proposito: quem manda e a tela de Numeros do NextVoice (via
// /api/quota/check). As envs abaixo sao so escape hatch se o app estiver fora.
const DEFAULT_INBOUND_AGENTS = {};
const DEFAULT_INBOUND_GREETINGS = {};

const normalizeDid = (n) => {
  const d = String(n || '').replace(/\D/g, '');
  return d.length >= 12 && d.startsWith('55') ? d.slice(2) : d;
};

const parseDidMap = (raw, defaults) => {
  const merged = { ...defaults };
  try {
    if (raw) Object.assign(merged, JSON.parse(raw));
  } catch (err) {
    // JSON inválido na env: mantém os defaults em vez de derrubar o processo.
  }
  const out = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v) out[normalizeDid(k)] = v;
  }
  return out;
};

const INBOUND_AGENTS = parseDidMap(process.env.INBOUND_AGENT_MAP, DEFAULT_INBOUND_AGENTS);
const INBOUND_GREETINGS = parseDidMap(process.env.INBOUND_GREETING_MAP, DEFAULT_INBOUND_GREETINGS);

const inboundAgentFor = (to) => INBOUND_AGENTS[normalizeDid(to)] || null;
const inboundGreetingFor = (to) => INBOUND_GREETINGS[normalizeDid(to)] || null;

async function quotaCheck(number) {
  if (!QUOTA_BASE || !QUOTA_SECRET || !number) return null;
  try {
    const r = await fetch(`${QUOTA_BASE}/api/quota/check?number=${encodeURIComponent(number)}`, {
      headers: { 'x-quota-secret': QUOTA_SECRET },
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (err) {
    return null; // fail open — não bloqueia entrada se o app estiver fora
  }
}

// Transcrição ao vivo: cada fala (cliente/agente) vai pro app NextVoice, que
// alimenta o painel "Chamadas ao vivo". Fire-and-forget, nunca bloqueia o áudio.
function extractTurn(evt) {
  if (!evt || typeof evt !== 'object') return null;
  if (evt.type === 'user_transcript') {
    const text = evt.user_transcription_event && evt.user_transcription_event.user_transcript;
    if (text && String(text).trim()) return { role: 'user', text: String(text).trim() };
  }
  if (evt.type === 'agent_response') {
    const text = evt.agent_response_event && evt.agent_response_event.agent_response;
    if (text && String(text).trim()) return { role: 'agent', text: String(text).trim() };
  }
  return null;
}

function pushLiveTranscript(callSid, turn) {
  if (!QUOTA_BASE || !QUOTA_SECRET || !callSid || !turn) return;
  fetch(`${QUOTA_BASE}/api/live-transcript`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-quota-secret': QUOTA_SECRET },
    body: JSON.stringify({ call_sid: callSid, role: turn.role, text: turn.text }),
    signal: AbortSignal.timeout(3000)
  }).catch(() => { /* fail open */ });
}

async function quotaReport(callSid, number, seconds) {
  if (!QUOTA_BASE || !QUOTA_SECRET || !(seconds > 0) || (!callSid && !number)) return;
  try {
    await fetch(`${QUOTA_BASE}/api/quota/usage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-quota-secret': QUOTA_SECRET },
      body: JSON.stringify({ call_sid: callSid, number, seconds }),
      signal: AbortSignal.timeout(5000)
    });
  } catch (err) { /* fail open */ }
}

const service = ({logger, makeService, app}) => {
  const svc = makeService({path: '/elevenlabs-s2s'});

  // Endpoint HTTP para receber dados do contato antes da chamada
  app.post('/contact-data', (req, res) => {
    const { call_sid, nome, empresa } = req.body;
    if (!call_sid) return res.sendStatus(400);
    contactCache.set(call_sid, { nome, empresa });
    logger.info({ call_sid, nome, empresa }, 'contact-data registrado');
    res.sendStatus(200);
  });

  // Sonda de deploy (sem segredos): confirma qual build está no ar e quais DIDs
  // têm agente de entrada configurado.
  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      inbound_dids: Object.keys(INBOUND_AGENTS),
      fallback_agent: process.env.ELEVENLABS_AGENT_ID ? 'set' : 'unset'
    });
  });

  svc.on('session:new', async (session, path) => {
    session.locals = { ...session.locals,
      transcripts: [],
      logger: logger.child({call_sid: session.call_sid})
    };
    session.locals.logger.info({session, path}, `new incoming call: ${session.call_sid}`);

    const isInbound = session.direction === 'inbound';

    // ENTRADA: uma unica consulta ao app traz o receptivo do numero (agente +
    // saudacao, configurados na tela de Numeros) E o saldo de minutos.
    let inbound = null;
    if (isInbound) {
      inbound = await quotaCheck(session.to);
      if (inbound && inbound.ownerFound && inbound.allowed === false) {
        session.locals.logger.info({ to: session.to }, 'limite de minutos esgotado — recusando entrada');
        session.hangup().send();
        return;
      }
      if (inbound && inbound.ownerFound &&
          typeof inbound.remainingSeconds === 'number' && inbound.remainingSeconds > 0) {
        session.locals.remainingSeconds = inbound.remainingSeconds; // agendar corte
      }
    }

    // Dados por chamada chegam via `tag` no createCall → expostos como
    // session.customerData (NÃO env_vars, que é config da aplicação no portal).
    // Ordem: agente da chamada (saida) → receptivo configurado no app (entrada)
    // → mapa por env → agente fixo.
    const agentDoApp = isInbound && inbound ? inbound.inboundAgentId : null;
    const agentDoEnv = isInbound ? inboundAgentFor(session.to) : null;
    const agent_id = session.customerData?.agent_id || agentDoApp || agentDoEnv ||
      process.env.ELEVENLABS_AGENT_ID;
    const api_key = process.env.ELEVENLABS_API_KEY;

    if (isInbound) {
      session.locals.logger.info(
        {to: session.to, agent_id, origem: agentDoApp ? 'app' : (agentDoEnv ? 'env' : 'fixo')},
        'chamada de entrada: agente resolvido'
      );
    }

    // Busca dados do contato pelo call_sid (registrado pelo CampaignManager)
    const contactData = contactCache.get(session.call_sid) || {};
    const nome = contactData.nome || session.customerData?.nome || 'cliente';
    const empresa = contactData.empresa || session.customerData?.empresa || '';

    // Variáveis dinâmicas: repassa TODO o customerData (menos o agent_id de controle)
    // como dynamic_variables pro agente, sobrepondo nome/empresa já resolvidos.
    const cd = session.customerData || {};
    // eslint-disable-next-line no-unused-vars
    const { agent_id: _ctrlAgentId, ...extraVars } = cd;
    const dynamicVars = { ...extraVars, nome, empresa };

    // Workaround: por este caminho (Jambonz → ElevenLabs) a ElevenLabs recebe as
    // dynamic_variables mas NÃO substitui {{nome}} no prompt do agente. Então,
    // quando a chamada traz um nome de verdade, injetamos a saudação já pronta via
    // first_message override (permitido no agente) — pelo mesmo canal
    // (conversation_initiation_client_data) que comprovadamente chega. Sem nome,
    // não sobrescreve: mantém o fluxo padrão do agente.
    const clientData = { dynamic_variables: dynamicVars };
    const hasName = nome && nome !== 'cliente';
    if (hasName) {
      const saudacao = empresa
        ? `Olá! Falo com ${nome}, da ${empresa}?`
        : `Olá! Falo com ${nome}?`;
      clientData.conversation_config_override = { agent: { first_message: saudacao } };
    } else if (isInbound) {
      // Entrada: quem ligou foi o cliente. O first_message do agente é escrito
      // para SAÍDA ("desculpa ligar de surpresa"), o que soa quebrado no receptivo.
      // Trocamos a abertura só NESTA chamada — o agente no portal continua
      // idêntico e segue servindo para ligar.
      const saudacao = (inbound && inbound.inboundGreeting) || inboundGreetingFor(session.to);
      if (saudacao) {
        clientData.conversation_config_override = { agent: { first_message: saudacao } };
      }
    }

    // Remove do cache após usar
    contactCache.delete(session.call_sid);

    session.locals.logger.info({ clientData }, 'dados de inicialização para esta chamada');

    session
      .on('/event', onEvent.bind(null, session))
      .on('/toolCall', onToolCall.bind(null, session))
      .on('/final', onFinal.bind(null, session))
      .on('close', onClose.bind(null, session))
      .on('error', onError.bind(null, session));

    // Mede TODA chamada: entrada pelo número chamado (to), saída pela bina (from).
    session.locals.meterNumber = session.direction === 'inbound' ? session.to : session.from;
    session.locals.startedAt = Date.now();

    if (!agent_id) {
      session.locals.logger.info('missing env ELEVENLABS_AGENT_ID, hanging up');
      session.hangup().send();
    } else {
      session
        .answer()
        .pause({length: 1})
        .llm({
          vendor: 'elevenlabs',
          model: 'eleven_turbo_v2_5',
          auth: {
            agent_id,
            ...(api_key && {api_key})
          },
          actionHook: '/final',
          eventHook: '/event',
          toolHook: '/toolCall',
          llmOptions: {
            input_sample_rate: 16000,
            output_sample_rate: 16000,
            conversation_initiation_client_data: clientData
          }
        })
        .hangup()
        .send();

      // Corte por saldo: encerra a ligação quando os minutos restantes acabam.
      if (session.locals.remainingSeconds) {
        session.locals.hangupTimer = setTimeout(() => {
          try {
            session.locals.logger.info('limite de minutos atingido — encerrando ligação');
            session.hangup().send();
          } catch (e) { /* já encerrada */ }
        }, session.locals.remainingSeconds * 1000);
      }
    }
  });
};

const onFinal = async(session, evt) => {
  const {logger} = session.locals;
  logger.info(`got actionHook: ${JSON.stringify(evt)}`);
  if (['server failure', 'server error'].includes(evt.completion_reason)) {
    session.say({text: 'Desculpe, ocorreu um erro. Tente novamente.'});
    session.hangup();
  }
  session.reply();
};

const onEvent = async(session, evt) => {
  const {logger} = session.locals;
  logger.info(`got eventHook: ${JSON.stringify(evt)}`);
  const turn = extractTurn(evt);
  if (turn) pushLiveTranscript(session.call_sid, turn);
};

const onToolCall = async(session, evt) => {
  const {logger} = session.locals;
  logger.info({evt}, 'got toolHook');
  const {name, args, tool_call_id} = evt || {};

  // Client tool `registrar_dado`: o agente registra um campo coletado NO MEIO da
  // conversa (extração EL-nativa). Repassa pro app e confirma pro agente seguir.
  if (name === 'registrar_dado') {
    let ok = false;
    try {
      if (QUOTA_BASE && QUOTA_SECRET) {
        const r = await fetch(`${QUOTA_BASE}/api/live-data`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-quota-secret': QUOTA_SECRET },
          body: JSON.stringify({
            call_sid: session.call_sid,
            campo: args && args.campo,
            valor: args && args.valor
          }),
          signal: AbortSignal.timeout(4000)
        });
        ok = r.ok;
      }
    } catch (err) {
      logger.info({err}, 'registrar_dado: falha ao repassar pro app');
    }
    session.sendToolOutput(tool_call_id, {
      type: 'client_tool_result',
      tool_call_id,
      result: ok ? 'registrado' : 'falha ao registrar (siga a conversa normalmente)',
      is_error: false
    });
    return;
  }

  // Tool desconhecida: responde pra conversa não travar.
  if (tool_call_id) {
    session.sendToolOutput(tool_call_id, {
      type: 'client_tool_result',
      tool_call_id,
      result: 'tool não suportada neste canal',
      is_error: true
    });
  }
};

const onClose = (session, code, reason) => {
  const {logger} = session.locals;
  logger.info({code, reason}, `session ${session.call_sid} closed`);
  // Cancela o timer de corte e reporta os minutos consumidos (entrada).
  if (session.locals.hangupTimer) {
    clearTimeout(session.locals.hangupTimer);
    session.locals.hangupTimer = null;
  }
  if (session.locals.startedAt) {
    const seconds = Math.round((Date.now() - session.locals.startedAt) / 1000);
    quotaReport(session.call_sid, session.locals.meterNumber, seconds);
  }
};

const onError = (session, err) => {
  const {logger} = session.locals;
  logger.info({err}, `session ${session.call_sid} received error`);
};

module.exports = service;
