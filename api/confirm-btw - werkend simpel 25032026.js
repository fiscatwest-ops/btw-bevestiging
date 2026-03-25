/**
 * BTW-Bevestiging API Route
 * Vercel Serverless Function
 * 
 * Flow:
 * 1. Ontvang BTW-nummer van frontend
 * 2. Zoek relatie in AdminPulse (via VAT number)
 * 3. Zoek actieve BTW-aangifte taak voor die relatie
 * 4. Update subtaak "Alle documenten binnen..." naar In Progress
 * 5. Stuur bevestigingsmail (optioneel)
 */

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { vatNumber, message, fileUrls, recaptchaToken } = req.body;

  // Validatie
  if (!vatNumber) {
    return res.status(400).json({ error: 'BTW-nummer is verplicht' });
  }

  // Verwijder formattering van BTW-nummer (punten, spaties, BE prefix)
  const cleanVat = vatNumber.replace(/[^0-9]/g, '');
  
  if (cleanVat.length < 9 || cleanVat.length > 10) {
    return res.status(400).json({ error: 'Ongeldig BTW-nummer formaat' });
  }

  const API_KEY = process.env.ADMINPULSE_API_KEY;
  const API_BASE = 'https://api.adminpulse.be';

  if (!API_KEY) {
    console.error('ADMINPULSE_API_KEY niet geconfigureerd');
    return res.status(500).json({ error: 'Server configuratie fout' });
  }

  try {
    // ============================================
    // STAP 1: Zoek relatie op BTW-nummer
    // ============================================
    const searchResponse = await fetch(
      `${API_BASE}/relations?vatNumber=${cleanVat}&pageSize=1`,
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!searchResponse.ok) {
      console.error('AdminPulse search error:', await searchResponse.text());
      return res.status(502).json({ error: 'Kon relatie niet zoeken in AdminPulse' });
    }

    const searchData = await searchResponse.json();
    
    if (!searchData.results || searchData.results.length === 0) {
      return res.status(404).json({ 
        error: 'Relatie niet gevonden',
        detail: `Geen klant gevonden met BTW-nummer ${cleanVat}`
      });
    }

    const relation = searchData.results[0];
    const relationId = relation.id;
    const relationName = relation.name || relation.companyName || 'Onbekend';
    const uniqueIdentifier = relation.uniqueIdentifier; // APR code

    console.log(`Relatie gevonden: ${relationName} (${uniqueIdentifier})`);

    // ============================================
    // STAP 2: Zoek actieve BTW-aangifte taak
    // ============================================
    // Haal taken op voor deze relatie, filter op BTW-aangifte
    const tasksResponse = await fetch(
      `${API_BASE}/tasks?relationId=${relationId}&pageSize=50`,
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!tasksResponse.ok) {
      console.error('AdminPulse tasks error:', await tasksResponse.text());
      return res.status(502).json({ error: 'Kon taken niet ophalen uit AdminPulse' });
    }

    const tasksData = await tasksResponse.json();
    
    // Zoek de BTW-aangifte taak (niet BTW listing of IC listing)
    // Filter op "btw-aangifte" of "btw aangifte" en sorteer op deadline
    const btwTasks = (tasksData.results || [])
      .filter(task => {
        const name = (task.name || task.templateName || '').toLowerCase();
        // Moet "btw" bevatten maar NIET "listing" (dat is IC opgave)
        const isBtwTask = name.includes('btw') && !name.includes('listing');
        // Of specifiek "aangifte" bevatten
        const isAangifte = name.includes('aangifte');
        return (isBtwTask || isAangifte) && task.status !== 2; // status 2 = Done
      })
      .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

    if (btwTasks.length === 0) {
      return res.status(404).json({ 
        error: 'Geen actieve BTW-taak gevonden',
        detail: `Geen openstaande BTW-aangifte gevonden voor ${relationName}`
      });
    }

    const btwTask = btwTasks[0];
    console.log(`BTW-taak gevonden: ${btwTask.name}, deadline: ${btwTask.deadline}`);

    // ============================================
    // STAP 3: Zoek de juiste subtaak
    // ============================================
    // Haal taakdetails op met subtaken
    const taskDetailResponse = await fetch(
      `${API_BASE}/tasks/${btwTask.id}`,
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!taskDetailResponse.ok) {
      console.error('AdminPulse task detail error:', await taskDetailResponse.text());
      return res.status(502).json({ error: 'Kon taakdetails niet ophalen' });
    }

    const taskDetail = await taskDetailResponse.json();
    
    console.log(`Subtaken gevonden: ${(taskDetail.subtasks || []).length}`);
    (taskDetail.subtasks || []).forEach((st, i) => {
      console.log(`  ${i+1}. ${st.name} (priority: ${st.priority}, status: ${st.status})`);
    });
    
    // Zoek de subtaak - meerdere strategieën:
    // 1. Eerst zoeken op naam met "documenten" + "bevestiging" of "opgeladen"
    // 2. Dan zoeken op priority 3 (derde subtaak in de template)
    // 3. Fallback: eerste subtaak met "document" in de naam
    
    let targetSubtask = (taskDetail.subtasks || []).find(st => {
      const name = (st.name || '').toLowerCase();
      return (name.includes('documenten') && (name.includes('bevestiging') || name.includes('opgeladen')));
    });
    
    if (!targetSubtask) {
      // Probeer priority 3 (check zowel string als nummer)
      targetSubtask = (taskDetail.subtasks || []).find(st => 
        st.priority === 3 || st.priority === '3' || st.priority === "3"
      );
    }
    
    if (!targetSubtask) {
      // Fallback: zoek subtaak met "document" in de naam
      targetSubtask = (taskDetail.subtasks || []).find(st => {
        const name = (st.name || '').toLowerCase();
        return name.includes('document');
      });
    }

    if (!targetSubtask) {
      return res.status(404).json({ 
        error: 'Subtaak niet gevonden',
        detail: 'Kon de bevestigings-subtaak niet vinden in de BTW-taak',
        availableSubtasks: (taskDetail.subtasks || []).map(st => st.name)
      });
    }

    console.log(`Subtaak gevonden: ${targetSubtask.name}, huidige status: ${targetSubtask.status}`);

    // ============================================
    // STAP 4: Update subtaak naar "In Progress"
    // ============================================
    // Status: 0 = To-do, 1 = In Progress, 2 = Done
    const updateResponse = await fetch(
      `${API_BASE}/tasks/${targetSubtask.id}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          status: 1 // In Progress
        })
      }
    );

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      console.error('AdminPulse update error:', errorText);
      return res.status(502).json({ 
        error: 'Kon taakstatus niet bijwerken',
        detail: errorText
      });
    }

    console.log(`✅ Subtaak bijgewerkt naar In Progress`);

    // ============================================
    // STAP 5: Log de bevestiging (optioneel: stuur email)
    // ============================================
    const result = {
      success: true,
      message: 'Bevestiging succesvol verwerkt',
      relation: {
        name: relationName,
        uniqueIdentifier: uniqueIdentifier,
        vatNumber: cleanVat
      },
      task: {
        name: btwTask.name,
        deadline: btwTask.deadline,
        subtask: targetSubtask.name,
        newStatus: 'In Progress'
      },
      receivedData: {
        message: message || null,
        fileCount: fileUrls ? fileUrls.length : 0
      },
      timestamp: new Date().toISOString()
    };

    // Optioneel: stuur email notificatie naar kantoor
    // Dit kan via een aparte email service (SendGrid, Resend, etc.)
    // of via AdminPulse interactions API
    
    return res.status(200).json(result);

  } catch (error) {
    console.error('Unexpected error:', error);
    return res.status(500).json({ 
      error: 'Interne serverfout',
      detail: error.message
    });
  }
}