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
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

The doctor dashboard at `/doctor` is password protected. The patient view at `/patient` stays open.

For Vercel, the frontend now talks directly to Supabase Realtime, so you do not need a separate Socket.IO backend.

## Supabase Setup

Create a table named `queue_state` with a single row:

```sql
create table if not exists public.queue_state (
  id bigint primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.queue_state enable row level security;

create policy "allow public read"
on public.queue_state
for select
to anon
using (true);

create policy "allow public write"
on public.queue_state
for insert
to anon
with check (true);

create policy "allow public update"
on public.queue_state
for update
to anon
using (true)
with check (true);

alter publication supabase_realtime add table public.queue_state;
```

The app upserts row `id = 1` and listens for realtime changes on that table.

## Routes

- `/` landing page with links to both views
- `/doctor` doctor / receptionist dashboard
- `/patient` mobile-first patient view
