// BTW-bevestiging API v3
// Features: subtask update, remark, email copy, backup notification

const ADMINPULSE_API = 'https://api.adminpulse.be';
const BACKUP_EMAIL = 'fiscatwest@gmail.com';

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const apiKey = process.env.ADMINPULSE_API_KEY;
    const resendApiKey = process.env.RESEND_API_KEY;

    if (!apiKey) {
        console.error('Missing ADMINPULSE_API_KEY');
        return res.status(500).json({ error: 'Server configuration error' });
    }

    try {
        const { 
            vatNumber, 
            clientEmail,      // Klant e-mailadres
            sendCopy,         // Boolean: stuur kopie naar klant
            clientRemark,     // Opmerking van klant
            recaptchaToken,   // reCAPTCHA response
            uploadedFiles     // Array van Cloudinary URLs
        } = req.body;

        if (!vatNumber) {
            return res.status(400).json({ error: 'BTW-nummer is verplicht' });
        }

        // Verify reCAPTCHA
        if (recaptchaToken) {
            const recaptchaSecret = process.env.RECAPTCHA_SECRET_KEY;
            if (recaptchaSecret) {
                const recaptchaRes = await fetch('https://www.google.com/recaptcha/api/siteverify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `secret=${recaptchaSecret}&response=${recaptchaToken}`
                });
                const recaptchaData = await recaptchaRes.json();
                if (!recaptchaData.success) {
                    return res.status(400).json({ error: 'reCAPTCHA verificatie mislukt' });
                }
            }
        }

        const cleanVat = vatNumber.replace(/[^0-9]/g, '');
        console.log(`Processing confirmation for VAT: ${cleanVat}`);

        // 1. Zoek relatie op BTW-nummer
        const relationRes = await fetch(
            `${ADMINPULSE_API}/relations?vatNumber=${cleanVat}&pageSize=1`,
            { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );

        if (!relationRes.ok) {
            throw new Error(`AdminPulse relations lookup failed: ${relationRes.status}`);
        }

        const relationData = await relationRes.json();
        if (!relationData.results || relationData.results.length === 0) {
            return res.status(404).json({ error: 'Relatie niet gevonden' });
        }

        const relation = relationData.results[0];
        const relationId = relation.id;
        const relationName = relation.name || relation.commercialName || 'Onbekend';
        console.log(`Found relation: ${relationName} (${relation.uniqueIdentifier})`);

        // 2. Zoek actieve BTW-aangifte taak
        const tasksRes = await fetch(
            `${ADMINPULSE_API}/tasks?relationId=${relationId}&pageSize=50`,
            { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );

        if (!tasksRes.ok) {
            throw new Error(`AdminPulse tasks lookup failed: ${tasksRes.status}`);
        }

        const tasksData = await tasksRes.json();
        const btwTask = tasksData.results?.find(task => {
            const name = (task.name || '').toLowerCase();
            return task.status !== 2 && name.includes('btw') && name.includes('aangifte');
        });

        if (!btwTask) {
            return res.status(404).json({ error: 'Geen actieve BTW-aangifte taak gevonden' });
        }

        console.log(`Found BTW task: ${btwTask.name} (${btwTask.id})`);

        // 3. Haal taak details op met subtaken
        const taskDetailRes = await fetch(
            `${ADMINPULSE_API}/tasks/${btwTask.id}`,
            { headers: { 'Authorization': `Bearer ${apiKey}` } }
        );

        if (!taskDetailRes.ok) {
            throw new Error(`AdminPulse task detail failed: ${taskDetailRes.status}`);
        }

        const taskDetail = await taskDetailRes.json();
        
        // Zoek subtaak met priority 3 OF naam bevat "documenten"
        const targetSubtask = taskDetail.subtasks?.find(st => 
            st.priority === 3 || 
            (st.name || '').toLowerCase().includes('documenten')
        );

        if (!targetSubtask) {
            return res.status(404).json({ error: 'Subtaak voor documentbevestiging niet gevonden' });
        }

        console.log(`Found subtask: ${targetSubtask.name} (${targetSubtask.id})`);

        // 4. Maak opmerking tekst
        const now = new Date();
        const dateStr = now.toLocaleDateString('nl-BE', { 
            day: '2-digit', 
            month: '2-digit', 
            year: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        const fileCount = uploadedFiles?.length || 0;
        let newRemarkText = `✓ Bevestigd via CTA knop op ${dateStr}`;
        
        if (clientEmail) {
            newRemarkText += ` | E-mail: ${clientEmail}`;
        }

        if (clientRemark && clientRemark.trim()) {
            newRemarkText += `\nOpmerking klant: ${clientRemark.trim()}`;
        }
        
        if (fileCount > 0) {
            newRemarkText += `\nBestanden (${fileCount}):`;
            uploadedFiles.forEach((file, i) => {
                newRemarkText += `\n• ${file.name || 'bestand'}: ${file.url}`;
            });
        }

        // Combineer met bestaande opmerking (indien aanwezig)
        const existingRemark = targetSubtask.remark || '';
        const finalRemark = existingRemark 
            ? `${existingRemark}\n\n---\n${newRemarkText}`
            : newRemarkText;

        // 5. Update subtaak: status = 1 (In Progress) + remark
        const updateRes = await fetch(
            `${ADMINPULSE_API}/tasks/${targetSubtask.id}`,
            {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    status: 1,  // In Progress
                    remark: finalRemark
                })
            }
        );

        if (!updateRes.ok) {
            const errorText = await updateRes.text();
            throw new Error(`AdminPulse task update failed: ${updateRes.status} - ${errorText}`);
        }

        console.log('Subtask updated successfully');

        // 6. Stuur e-mail notificaties
        if (resendApiKey) {
            const emailResults = await sendNotificationEmails({
                resendApiKey,
                relationName,
                vatNumber: cleanVat,
                clientEmail,
                sendCopy,
                uploadedFiles,
                dateStr,
                taskName: btwTask.name
            });
            console.log('Email results:', emailResults);
        } else {
            console.log('No RESEND_API_KEY configured, skipping emails');
        }

        return res.status(200).json({
            success: true,
            message: 'Bevestiging succesvol verwerkt',
            relation: relationName,
            task: btwTask.name,
            subtask: targetSubtask.name,
            filesCount: fileCount
        });

    } catch (error) {
        console.error('Error processing confirmation:', error);
        return res.status(500).json({ 
            error: 'Fout bij verwerken van bevestiging',
            details: error.message 
        });
    }
}

async function sendNotificationEmails({ 
    resendApiKey, 
    relationName, 
    vatNumber, 
    clientEmail, 
    sendCopy, 
    uploadedFiles, 
    dateStr, 
    taskName 
}) {
    const results = { backup: null, client: null };
    
    const fileCount = uploadedFiles?.length || 0;
    const fileList = uploadedFiles?.map((f, i) => 
        `<li><a href="${f.url}">${f.name || `Bestand ${i + 1}`}</a></li>`
    ).join('') || '<li>Geen bestanden</li>';

    // HTML template voor kantoor
    const backupHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2 style="color: #2c3e50;">📋 BTW Documenten Bevestigd</h2>
        <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Klant:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${relationName}</td></tr>
            <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>BTW-nummer:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">BE ${vatNumber}</td></tr>
            <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Taak:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${taskName}</td></tr>
            <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Datum/tijd:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${dateStr}</td></tr>
            <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>E-mail klant:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${clientEmail || 'Niet opgegeven'}</td></tr>
        </table>
        <h3 style="color: #2c3e50; margin-top: 20px;">Opgeladen bestanden (${fileCount}):</h3>
        <ul>${fileList}</ul>
        <p style="color: #7f8c8d; font-size: 12px; margin-top: 30px;">
            Dit is een automatische notificatie van het BTW-bevestigingsformulier.
        </p>
    </div>`;

    // Stuur backup e-mail naar kantoor
    try {
        const backupRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${resendApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: 'BTW Bevestiging <noreply@fiscatwest.be>',
                to: [BACKUP_EMAIL],
                subject: `BTW Docs bevestigd: ${relationName} (${vatNumber})`,
                html: backupHtml
            })
        });
        results.backup = backupRes.ok ? 'sent' : 'failed';
    } catch (e) {
        results.backup = 'error: ' + e.message;
    }

    // Stuur kopie naar klant indien gewenst
    if (sendCopy && clientEmail) {
        const clientHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
            <h2 style="color: #2c3e50;">✅ Bevestiging ontvangen</h2>
            <p>Beste klant,</p>
            <p>Wij hebben uw bevestiging voor de BTW-documenten goed ontvangen.</p>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>BTW-nummer:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">BE ${vatNumber}</td></tr>
                <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Datum/tijd:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${dateStr}</td></tr>
                <tr><td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Aantal bestanden:</strong></td><td style="padding: 8px; border-bottom: 1px solid #eee;">${fileCount}</td></tr>
            </table>
            <p>Wij verwerken uw aangifte zo snel mogelijk.</p>
            <p>Met vriendelijke groeten,<br><strong>Fisc@West BV</strong></p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            <p style="color: #7f8c8d; font-size: 12px;">
                Fisc@West BV | BE 0562.845.171<br>
                Dit is een automatisch gegenereerd bericht.
            </p>
        </div>`;

        try {
            const clientRes = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${resendApiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    from: 'Fisc@West <noreply@fiscatwest.be>',
                    to: [clientEmail],
                    subject: 'Bevestiging BTW-documenten ontvangen',
                    html: clientHtml
                })
            });
            results.client = clientRes.ok ? 'sent' : 'failed';
        } catch (e) {
            results.client = 'error: ' + e.message;
        }
    }

    return results;
}