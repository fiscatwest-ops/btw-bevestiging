// =====================================================
// BTW-BEVESTIGING — Vercel Serverless Function v2
// Fisc@West BV
//
// 1. reCAPTCHA verificatie
// 2. AdminPulse: relatie opzoeken → subtaak updaten
// 3. AdminPulse: documenten uploaden (Cloudinary URLs)
// 4. Google Apps Script: mails versturen (klant + backup)
// =====================================================

const AP_BASE = 'https://api.adminpulse.be';
const AP_KEY = process.env.ADMINPULSE_API_KEY;
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET_KEY;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

async function verifyRecaptcha(token) {
  const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `secret=${RECAPTCHA_SECRET}&response=${token}`
  });
  const data = await res.json();
  return data.success;
}

async function apFetch(endpoint, options = {}) {
  const res = await fetch(`${AP_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${AP_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AdminPulse ${endpoint}: ${res.status} - ${text}`);
  }
  return res.json();
}

async function findRelationByVat(vatNumber) {
  const cleanVat = vatNumber.replace(/[^0-9]/g, '');
  const data = await apFetch(`/relations?search=${cleanVat}&pageSize=5`);
  if (!data.results || data.results.length === 0) {
    throw new Error(`Geen relatie gevonden voor BTW ${vatNumber}`);
  }
  return data.results[0];
}

async function findBtwTask(relationId) {
  const data = await apFetch(`/tasks?relationId=${relationId}&pageSize=50`);
  if (!data.results) return null;

  for (const task of data.results) {
    if (task.templateName && task.templateName.toLowerCase().includes('btw')) {
      if (task.subtasks) {
        for (const sub of task.subtasks) {
          const name = (sub.name || sub.templateName || '').toLowerCase();
          if ((name.includes('documenten') && (name.includes('ontvangen') || name.includes('binnen') || name.includes('bevestiging')))
              && sub.status !== 2) {
            return { task, subtask: sub };
          }
        }
      }
    }
  }
  return null;
}

async function updateSubtaskStatus(subtaskId, status) {
  return apFetch(`/tasks/${subtaskId}`, {
    method: 'PUT',
    body: JSON.stringify({ status })
  });
}

async function uploadDocumentToAP(fileUrl, fileName, relationIdentifier, taskId) {
  const formBody = new URLSearchParams();
  formBody.append('file', fileUrl);
  formBody.append('fileName', fileName);
  formBody.append('relationIdentifier', relationIdentifier);
  formBody.append('documentType', '13');
  formBody.append('tagNames', 'BTW');
  if (taskId) formBody.append('taskId', taskId);

  const res = await fetch(`${AP_BASE}/documents/add`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AP_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: formBody.toString()
  });

  if (!res.ok) {
    console.error(`Document upload failed: ${res.status}`);
    return null;
  }
  return res.json();
}

async function sendEmailsViaGoogleScript(emailData) {
  if (!GOOGLE_SCRIPT_URL) {
    console.warn('GOOGLE_SCRIPT_URL niet geconfigureerd — mails overgeslagen');
    return;
  }
  try {
    await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(emailData)
    });
    console.log('E-mails verzonden via Google Apps Script');
  } catch (err) {
    console.error('Google Apps Script fout:', err.message);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { vatNumber, email, message, files, sendCopy, recaptchaToken, timestamp } = req.body;

    if (!vatNumber) return res.status(400).json({ error: 'BTW-nummer is verplicht' });

    // reCAPTCHA
    if (recaptchaToken && RECAPTCHA_SECRET) {
      const valid = await verifyRecaptcha(recaptchaToken);
      if (!valid) return res.status(400).json({ error: 'reCAPTCHA verificatie mislukt' });
    }

    // AdminPulse
    let relation = null;
    let adminpulseResult = null;

    try {
      relation = await findRelationByVat(vatNumber);
      console.log(`Relatie: ${relation.uniqueIdentifier} - ${relation.name}`);

      const taskInfo = await findBtwTask(relation.id);
      if (taskInfo) {
        await updateSubtaskStatus(taskInfo.subtask.id, 1);
        adminpulseResult = {
          relationName: relation.name,
          subtaskName: taskInfo.subtask.name || taskInfo.subtask.templateName,
          taskName: taskInfo.task.name || taskInfo.task.templateName
        };
      } else {
        adminpulseResult = { relationName: relation.name, subtaskName: 'Geen actieve subtaak gevonden' };
      }

      // Upload documents
      if (files && files.length > 0 && relation.uniqueIdentifier) {
        for (const file of files) {
          try {
            await uploadDocumentToAP(file.url, file.name || 'document.pdf', relation.uniqueIdentifier, taskInfo ? taskInfo.task.id : null);
          } catch (docErr) {
            console.error(`Doc upload fout: ${docErr.message}`);
          }
        }
      }
    } catch (apErr) {
      console.error(`AdminPulse fout: ${apErr.message}`);
      adminpulseResult = { error: apErr.message };
    }

    // Emails via Google Apps Script
    await sendEmailsViaGoogleScript({
      vatNumber, email, message,
      files: files || [],
      sendCopy: sendCopy || false,
      timestamp: timestamp || new Date().toISOString(),
      adminpulseResult
    });

    return res.status(200).json({
      success: true,
      message: 'Bevestiging ontvangen',
      relation: relation ? { name: relation.name, identifier: relation.uniqueIdentifier } : null,
      adminpulse: adminpulseResult
    });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Er ging iets mis. Probeer opnieuw.' });
  }
};
