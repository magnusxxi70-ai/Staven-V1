# STAVEN BLUE V1

Railway-ready STAVEN BLUE V1 bot scaffold with a protected Control Center.

## Railway
Set these Variables in the Railway service:

- `DASHBOARD_USER` — dashboard username
- `DASHBOARD_PASSWORD` — a strong dashboard password

Railway supplies `PORT` automatically; the app binds to `0.0.0.0`.

After deployment, open the generated Railway domain:
`https://YOUR-DOMAIN/`

The public health endpoint is:
`/health`

Never commit cookies, AppState, passwords, tokens, `.env`, or session files.

This project does not bypass CAPTCHA, checkpoints, bans, or authentication controls.
