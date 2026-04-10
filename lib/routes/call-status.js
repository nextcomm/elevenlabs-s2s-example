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

module.exports = ({ logger, app }) => {
  app.all('/call-status', async (req, res) => {
    res.sendStatus(200);
    
    try {
      const {
        call_sid,
        call_status,
        sip_status,
        termination_reason,
        duration
      } = req.body;

      logger.info({ call_sid, call_status, sip_status, termination_reason }, 'received call status');
      logger.info(`call_sid value: ${call_sid}`);

      const status = getStatusFromCall(call_status, sip_status, termination_reason);
      const duracao = duration || 0;

      // Autenticar no Google Sheets
      const auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      const sheets = google.sheets({ version: 'v4', auth });

      // Buscar a linha pelo call_sid
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

      // Atualizar status e duração
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
      logger.error({ err }, 'error processing call status');
    }
  });
};
