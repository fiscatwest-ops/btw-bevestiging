# BTW Documenten Bevestiging — Fisc@West BV (v2)

CTA-formulier waarmee klanten bevestigen dat ze alle BTW-documenten hebben opgeladen.

## Wat gebeurt er bij bevestiging?

1. **AdminPulse** subtaak → "In Progress"
2. **AdminPulse** documenten geüpload (Cloudinary URLs)
3. **Mail naar klant** — bevestiging in Fisc@West huisstijl
4. **Mail naar fiscatwest@gmail.com** — backup met AdminPulse status
5. **Google Sheet** — logging van alle bevestigingen

## Structuur

```
├── api/
│   └── confirm.js            # Vercel serverless (AdminPulse + trigger emails)
├── public/
│   └── index.html            # Frontend formulier
├── google-apps-script.js     # PLAK IN script.google.com (niet deployen via Vercel)
├── package.json
└── vercel.json
```

## Setup

### 1. Google Apps Script (e-mails)
1. Ga naar script.google.com → Nieuw project
2. Plak inhoud van `google-apps-script.js`
3. Implementeren → Nieuwe implementatie → Web-app
4. Uitvoeren als: Ik | Toegang: Iedereen
5. Kopieer de URL

### 2. Vercel Environment Variables
| Variabele | Waarde |
|-----------|--------|
| `ADMINPULSE_API_KEY` | Bearer API key |
| `RECAPTCHA_SECRET_KEY` | reCAPTCHA v2 secret |
| `GOOGLE_SCRIPT_URL` | URL uit stap 1 |

### 3. Deploy
Push naar GitHub → Vercel deployed automatisch.

## Versies
- v1: Zapier webhook flow (januari 2026)
- v2: Vercel serverless + Google Apps Script (maart 2026) — geen Zapier meer
