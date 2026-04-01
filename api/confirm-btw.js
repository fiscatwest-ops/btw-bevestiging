// BTW-bevestiging API v3.4
// Features: subtask update, remark, email via Google Apps Script
// Fix: subtaak matching + correcte veldmapping GAS-script

const ADMINPULSE_API = 'https://api.adminpulse.be';

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

    if (!apiKey) {
        console.error('Missing ADMINPULSE_API_KEY');
        return res.status(500).json({ error: 'Server configuration error' });
    }

    try {
        const {
            vatNumber,
            clientEmail,
            sendCopy,
            clientRemark,
            recaptchaToken,
            uploadedFiles
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

        // Zoek subtaak: eerst op specifieke naam, dan fallback op priority 3
        const targetSubtask = taskDetail.subtasks?.find(st => {
            const name = (st.name || '').toLowerCase();
            return name.includes('documenten binnen') ||
                   name.includes('bevestiging') ||
                   name.includes('alles opgeladen');
        }) || taskDetail.subtasks?.find(st => st.priority === 3);

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
                    status: 1,
                    remark: finalRemark
                })
            }
        );

        if (!updateRes.ok) {
            const errorText = await updateRes.text();
            throw new Error(`AdminPulse task update failed: ${updateRes.status} - ${errorText}`);
        }

        console.log('Subtask updated successfully');

        // 6. Stuur e-mail via Google Apps Script (altijd: backup naar kantoor + optioneel kopie klant)
        const googleScriptUrl = process.env.GOOGLE_SCRIPT_URL;
        if (googleScriptUrl) {
            try {
                await fetch(googleScriptUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        vatNumber: `BE ${cleanVat}`,
                        email: clientEmail || '',
                        sendCopy: !!sendCopy,
                        message: clientRemark || '',
                        files: (uploadedFiles || []).map(f => ({ name: f.name || 'bestand', url: f.url })),
                        adminpulseResult: {
                            relationName,
                            taskName: btwTask.name,
                            subtaskName: targetSubtask.name
                        }
                    })
                });
                console.log('Email sent via Google Apps Script');
            } catch (e) {
                console.log('Email failed (non-blocking):', e.message);
            }
        }

        return res.status(200).json({
            success: true,
            message: 'Bevestiging succesvol verwerkt',
            relation: relationName,
            task: btwTask.name,
            subtask: targetSubtask.name,
            filesCount: fileCount,
            docsUploaded
        });

    } catch (error) {
        console.error('Error processing confirmation:', error);
        return res.status(500).json({
            error: 'Fout bij verwerken van bevestiging',
            details: error.message
        });
    }
}
