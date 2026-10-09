# Code Mode Agent

An AI agent written in Python that connects to INDmoney's MCP server and exposes its tools directly to the model. The website is an installable Progressive Web App (PWA).

## Hosting layout

- **Firebase Hosting** serves the website, PWA manifest, service worker, and icon.
- **Cloud Run** runs the FastAPI Python backend and handles INDmoney OAuth, MCP requests, and OpenAI requests.
- **Cloud Firestore** stores per-login OAuth sessions, refresh tokens, and that session's recent chat history.
- Hosting rewrites `/api/**` and `/auth/**` to the Cloud Run service so the site and API share one origin. That keeps OAuth cookies same-site.

The agent discovers MCP tool schemas at request time, exposes each tool directly to the model, and proxies tool calls with the signed-in user's OAuth token. OpenAI keys and OAuth tokens stay in the Cloud Run service. See [Firebase Hosting rewrites to Cloud Run](https://firebase.google.com/docs/hosting/cloud-run).

INDmoney OAuth is the app login. Each login gets a random, HTTP-only session cookie and a separate Firestore document. Conversations are stored as child records under that session, so each signed-in account sees only its own chats. Each chat keeps the latest 20 user/assistant messages, restores them after reload, and sends them to the model as context. Users can start, select, and delete chats. Disconnecting deletes the session and its chats. Portfolio requests always use the token held by that same session.

## Prerequisites

- Python 3.12+
- A Firebase project with billing enabled (Blaze)
- `firebase-tools` and the Google Cloud CLI (`gcloud`)
- An OpenAI API key
- Firestore Native mode enabled in the Firebase project

## Local development

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Add your OpenAI key and Firebase project ID to `.env`. Install the Google Cloud CLI, run `gcloud auth application-default login`, and configure your project. Docker Compose mounts the ADC file into the backend container for Firestore access:

```bash
gcloud auth application-default login
gcloud config set project YOUR_FIREBASE_PROJECT_ID
docker compose up --build
```

The web app is available at the `APP_ORIGIN` in `.env` (default `http://localhost:8003`). Sign in to INDmoney in the app before asking questions about account data.

## Deploy to Firebase and Cloud Run

1. Select your Firebase project and enable billing for Cloud Run and Firestore usage.

2. Create the Firestore database in the same region as the backend:

   ```bash
   gcloud config set project YOUR_FIREBASE_PROJECT_ID
   gcloud firestore databases create --location=asia-south1
   ```

   If the project already has a Firestore database, keep its current location; do not create another database just for this app.

   Configure automatic cleanup for expired OAuth session and chat documents:

   ```bash
   gcloud firestore fields ttls update sessionExpiresAt \
     --collection-group=indmoney_sessions \
     --enable-ttl
   gcloud firestore fields ttls update sessionExpiresAt \
     --collection-group=chats \
     --enable-ttl
   ```

3. Add `OPENAI_API_KEY` to Google Secret Manager. Grant the Cloud Run service identity access to this secret and the `roles/datastore.user` role for Firestore.

4. Create a `.firebaserc` from `.firebaserc.example`, replacing the placeholder with your project ID. Set `APP_ORIGIN` to `https://YOUR_FIREBASE_PROJECT_ID.web.app`.

5. Deploy the backend. This app uses region `asia-south1` and service name `codemode-api`, matching `firebase.json`:

   ```bash
   gcloud beta run deploy codemode-api \
     --source . \
     --region asia-south1 \
     --allow-unauthenticated \
     --concurrency 2 \
     --max 3 \
     --set-secrets OPENAI_API_KEY=OPENAI_API_KEY:latest \
     --set-env-vars MCP_SERVER_URL=https://mcp.indmoney.com/mcp,APP_ORIGIN=https://YOUR_FIREBASE_PROJECT_ID.web.app
   ```

   The service must allow unauthenticated invocation for Firebase Hosting rewrites. The API still requires an INDmoney OAuth session for account data.

6. Deploy the website and rewrites:

   ```bash
   firebase deploy --only hosting
   ```

7. Open the Firebase Hosting URL and choose **Connect INDmoney**. OAuth callback URLs use that origin, so finish authorization on the same `web.app` or custom domain you will use for the app.

Set a budget alert in Google Cloud before sharing the app. Google Cloud services require a billing account even when usage fits within a no-cost quota.

## Install the app

Open the deployed HTTPS site in a supported browser and choose **Install app** or **Add to Home Screen**. The app shell is available offline; INDmoney login, portfolio data, and AI responses need an internet connection.

## Android APK

The website is already configured as a PWA. A store-ready Android package still needs an Android wrapper (for example, a Trusted Web Activity or Capacitor), a public HTTPS app URL, and a release signing key. Keep the signing key outside the repository and store it in GitHub Actions secrets if building APKs from CI.

## Project structure

```text
app/
  main.py              FastAPI routes, OAuth, Firestore chat storage
  agent.py             OpenAI tool-call loop and conversation context
  mcp_client.py        MCP Streamable HTTP discovery and tool calls
src/public/            Firebase Hosting website and PWA assets
firebase.json          Static hosting and same-origin Cloud Run rewrites
requirements.txt       Python runtime dependencies
Dockerfile             Python Cloud Run container
```
