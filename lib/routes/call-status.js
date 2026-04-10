const { google } = require('googleapis');
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const SHEET_NAME = 'Discagem';

const getStatusFromCall = (callStatus, sipStatus, terminationReason) => {
  if (terminationReason === 'amd' || terminationReason === 'voicemail')
    return 'caixa_postal';
  if (sipStatus === 486 || sipStatus === 600)
    return 'ocupado';
  if (sipStatus === 480 || sipStatus === 408 || terminationReason === 'no answer')
    return 'nao_atendeu';
  if (callStatus === 'completed' && terminationReason !== 'failed')
    return 'atendeu';
  return 'erro';
};

const updateSheet = async (logger, call_sid, call_status, sip_status, termination_reason, duration) => {
  try {
    const status = getStatusFromCall(call_status, sip_status, termination_reason);
    const duracao = duration || 0;

    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!G:G`,
    });

    const rows = response.data.values || [];
    let rowIndex = -1;

    for (let i = 0; i < rows.length; i++) {
      const cell = rows[i][0] || '';
      if (cell.includes(call_sid)) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex === -1) {
      logger.info({ call_sid }, 'call_sid not found in spreadsheet');
      return;
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!C${rowIndex}:E${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[status, new Date().toISOString(), duracao]]
      }
    });

    logger.info({ call_sid, status, duracao, rowIndex }, 'updated spreadsheet');
  } catch (err) {
    logger.error({ err }, 'error updating spreadsheet');
  }
};

module.exports = ({ logger, makeService }) => {
  const svc = makeService({ path: '/call-status' });

  svc.on('session:new', (session) => {
    const { call_sid } = session;
    logger.info({ call_sid }, 'call-status session new');

    session.on('call:status', async (evt) => {
      logger.info({ evt }, 'received call:status event');
      const { call_status, sip_status, termination_reason, duration } = evt;
      await updateSheet(logger, call_sid, call_status, sip_status, termination_reason, duration);
    });

    session.on('close', () => {
      logger.info({ call_sid }, 'call-status session closed');
    });

    session.on('error', (err) => {
      logger.error({ err, call_sid }, 'call-status session error');
    });
  });
};
