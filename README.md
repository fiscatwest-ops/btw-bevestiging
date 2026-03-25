# BTW-Bevestiging v2 — Directe AdminPulse API

Dit is versie 2 van het BTW-bevestigingsformulier. 
**Geen Zapier meer!** Directe API calls naar AdminPulse.

## Wat doet dit?

1. Klant vult BTW-nummer in op het formulier
2. Klant uploadt optioneel extra documenten (naar Cloudinary)
3. Klant bevestigt dat alles is opgeladen
4. Vercel serverless function zoekt de klant in AdminPulse
5. Subtaak "Alle documenten binnen..." wordt op **In Progress** gezet

## Project Structuur

```
btw-bevestiging-v2/
├── api/
│   └── confirm-btw.js    # Vercel serverless function
├── public/
│   └── index.html        # Frontend formulier
├── vercel.json           # Vercel configuratie
├── package.json
└── README.md
```

## Deployment naar Vercel

### Stap 1: Push naar GitHub

```bash
git init
git add .
git commit -m "v2: Directe AdminPulse API (geen Zapier)"
git remote add origin https://github.com/fiscatwest-ops/btw-bevestiging.git
git push -u origin main --force
```

### Stap 2: Environment Variable instellen

In Vercel Dashboard → Settings → Environment Variables:

| Key | Value |
|-----|-------|
| `ADMINPULSE_API_KEY` | Je AdminPulse Bearer token |

⚠️ **Belangrijk:** Gebruik de API key uit je `.env` bestand of uit het PDF-bestand met credentials.

### Stap 3: Deploy

Vercel deployed automatisch bij push naar main.

## API Endpoint

```
POST /api/confirm-btw

Body:
{
  "vatNumber": "0562845171",
  "message": "Optionele mededeling",
  "fileUrls": [
    {"name": "factuur.pdf", "url": "https://cloudinary.com/..."}
  ]
}

Response (success):
{
  "success": true,
  "message": "Bevestiging succesvol verwerkt",
  "relation": {
    "name": "Fisc@West BV",
    "uniqueIdentifier": "APR00001",
    "vatNumber": "0562845171"
  },
  "task": {
    "name": "BTW-aangifte",
    "deadline": "2026-04-20T00:00:00",
    "subtask": "Alle documenten binnen...",
    "newStatus": "In Progress"
  }
}
```

## Belangrijke Learnings

1. **APR-code gebruiken, niet UUID** — AdminPulse verwacht de Unique Identifier (APR00001)
2. **Datumformaat AdminPulse:** `ddMMyyyy` voor query parameters
3. **Status codes:** 0 = To-do, 1 = In Progress, 2 = Done
4. **Rate limit:** 480 calls/min

## Cloudinary Configuratie

| Setting | Value |
|---------|-------|
| Cloud name | `dssqewl7x` |
| Upload preset | `btw-bevestiging` |
| Signing mode | Unsigned |

## reCAPTCHA

- Site key: `6Ld9cFksAAAAAPAvlhk9kRFWANwvAvHa3pm-ORSJ`
- Secret key: (zie memory/env)

---

*Fisc@West BV — David Debruyne*
*Versie 2.0 — Maart 2026*
