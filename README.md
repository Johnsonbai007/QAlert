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
```

The doctor dashboard at `/doctor` is password protected. The patient view at `/patient` stays open.

## Routes

- `/` landing page with links to both views
- `/doctor` doctor / receptionist dashboard
- `/patient` mobile-first patient view
