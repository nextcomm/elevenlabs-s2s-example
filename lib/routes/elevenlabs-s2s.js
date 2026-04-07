const { getWeather } = require("../utils");

const service = ({logger, makeService}) => {
  const svc = makeService({path: '/elevenlabs-s2s'});
  

  svc.on('session:new', (session, path) => {
    session.locals = { ...session.locals,
      transcripts: [],
      logger: logger.child({call_sid: session.call_sid})
    };
    session.locals.logger.info({session, path}, `new incoming call: ${session.call_sid}`);

    const agent_id = process.env.ELEVENLABS_AGENT_ID;
    const api_key = process.env.ELEVENLABS_API_KEY;
    session
      .on('/event', onEvent.bind(null, session))
      .on('/toolCall', onToolCall.bind(null, session))
      .on('/final', onFinal.bind(null, session))
      .on('close', onClose.bind(null, session))
      .on('error', onError.bind(null, session));

    if (!agent_id) {
      session.locals.logger.info('missing env ELEVENLABS_AGENT_ID, hanging up');
      session
        .hangup()
        .send();
    }
    else {
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
            //agent setup for input and output sample rate
            input_sample_rate: 16000,
            output_sample_rate: 16000,
            conversation_initiation_client_data: {
              conversation_config_override: {
                agent: {
                  prompt: {
                    prompt: 'Você é um assistente virtual em português brasileiro. Seja cordial e prestativo.',
                  },
                  first_message: 'Olá, como posso te ajudar hoje?',
                  language: 'pt',
                },
                tts: {
                  voice_id: 'Xb7hH8MSUJpSbSDYk0k2'
                }
              },
            }
          }
        })
        .hangup()
        .send();
    }
  });
};

const onFinal = async(session, evt) => {
  const {logger} = session.locals;
  logger.info(`got actionHook: ${JSON.stringify(evt)}`);

  if (['server failure', 'server error'].includes(evt.completion_reason)) {
    if (evt.error.code === 'rate_limit_exceeded') {
      let text = 'Sorry, you have exceeded your open AI rate limits. ';
      const arr = /try again in (\d+)/.exec(evt.error.message);
      if (arr) {
        text += `Please try again in ${arr[1]} seconds.`;
      }
      session
        .say({text});
    }
    else {
      session
        .say({text: 'Sorry, there was an error processing your request.'});
    }
    session.hangup();
  }
  session.reply();
};

const onEvent = async(session, evt) => {
  const {logger} = session.locals;
  logger.info(`got eventHook: ${JSON.stringify(evt)}`);
};

const onToolCall = async(session, evt) => {
  const {logger} = session.locals;

  logger.info({evt}, 'got toolHook');
  const {name, args, tool_call_id} = evt;
  const {location, scale = 'celsius'} = args;
  logger.info({evt}, `got toolHook for ${name} with tool_call_id ${tool_call_id}`);

  try {
    const weather = await getWeather(location, scale, logger);
    logger.info({weather}, 'got response from weather API');

    const data = {
      type: 'client_tool_result',
      tool_call_id,
      result: weather,
      is_error: false
    };

    session.sendToolOutput(tool_call_id, data);

  } catch (err) {
    logger.info({err}, 'error calling geocoding or weather API');
    const data = {
      type: 'client_tool_result',
      tool_call_id,
      result: 'Failed to get weather for location',
      is_error: true
    };
    session.sendToolOutput(tool_call_id, data);
  }
};

const onClose = (session, code, reason) => {
  const {logger} = session.locals;
  logger.info({code, reason}, `session ${session.call_sid} closed`);
};

const onError = (session, err) => {
  const {logger} = session.locals;
  logger.info({err}, `session ${session.call_sid} received error`);
};

module.exports = service;
