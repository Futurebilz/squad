# G-squad Deployment Guide

## Project status
This project is a Node.js mobile-first app with:
- a server in `server.js`
- a SQLite database
- static mobile app assets in `www/`
- optional Capacitor Android wrapper in `android/`

## Important deployment note
This app is not a static-only Vercel site. It is a full Node app with an API and local database. Heroku is the best fit for the current project structure.

## Recommended platform
Use Heroku for the app backend.

## Required environment variables
Set these in production:

```bash
AUTH_SECRET=your-long-random-secret
PLISIO_API_KEY=your-real-plisio-key
PLISIO_CALLBACK_URL=https://your-app.herokuapp.com/api/plisio/callback
ADMIN_API_KEY=your-admin-secret
NODE_ENV=production
```

Do not set `PORT` manually on Heroku. Heroku provides it automatically.

## Heroku quick steps

```bash
heroku create your-app-name
heroku config:set \
  AUTH_SECRET="your-long-random-secret" \
  PLISIO_API_KEY="your-real-plisio-key" \
  PLISIO_CALLBACK_URL="https://your-app.herokuapp.com/api/plisio/callback" \
  ADMIN_API_KEY="your-admin-secret" \
  NODE_ENV="production"
git push heroku main
heroku open
```

If your branch is not `main`, use:

```bash
git push heroku HEAD:main
```

## Runtime expectations
The app listens on the port provided by Heroku:

```js
const port = Number(process.env.PORT) || 3000;
```

The app also serves static files and exposes API routes under `/api`.

## SQLite limitation
The project uses SQLite via `better-sqlite3`. This works for demo/testing but is not the best production database choice. For real production scale, move to PostgreSQL.

## Vercel note
Vercel is not ideal for the full current app because the project is a Node backend with a database and native file access. Use Vercel only for a frontend split-out version, not the current full app as-is.
