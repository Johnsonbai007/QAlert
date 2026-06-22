# QAlert
A real-time hospital queue management system that lets doctors update token numbers and notifies patients when their turn is getting close.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Environment

```bash
VITE_DOCTOR_PASSWORD=100
VITE_SOCKET_URL=http://localhost:3000
```

The doctor dashboard at `/doctor` is password protected. The patient view at `/patient` stays open.

For local development, `VITE_SOCKET_URL` can stay unset because the frontend will connect to the same origin. For Vercel, point `VITE_SOCKET_URL` at a deployed Socket.IO backend, because Vercel serves the React app but does not run the long-lived `server/index.js` process.

## Routes

- `/` landing page with links to both views
- `/doctor` doctor / receptionist dashboard
- `/patient` mobile-first patient view
