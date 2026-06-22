import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import { supabase, isSupabaseConfigured } from './utils/supabase';
import './styles.css';

const DOCTOR_PASSWORD = String(import.meta.env.VITE_DOCTOR_PASSWORD ?? '100').trim();
const DOCTOR_UNLOCK_KEY = 'qalert:doctorUnlocked';
const PATIENT_TOKEN_KEY = 'qalert:patientToken';
const CLIENT_ID_KEY = 'qalert:clientId';
const QUEUE_TABLE = 'queue_state';

function getClientId() {
  try {
    const saved = sessionStorage.getItem(CLIENT_ID_KEY);
    if (saved) return saved;
    const generated = window.crypto?.randomUUID?.() ?? `client-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(CLIENT_ID_KEY, generated);
    return generated;
  } catch {
    return `client-${Math.random().toString(36).slice(2)}`;
  }
}

function createQueueViewState() {
  return {
    currentToken: null,
    previousToken: null,
    history: [],
    activePatients: [],
    activeCount: 0,
    updatedAt: null,
    lastAction: 'System ready',
  };
}

function normalizeTokenValue(tokenNumber) {
  const token = Number(tokenNumber);
  if (!Number.isInteger(token) || token <= 0) return null;
  return token;
}

function buildQueueViewState(snapshot = {}, presenceState = {}) {
  const history = Array.isArray(snapshot.history)
    ? snapshot.history.map((token) => Number(token)).filter((token) => Number.isInteger(token) && token > 0)
    : [];
  const currentToken = normalizeTokenValue(snapshot.currentToken);
  const activePatients = Array.isArray(snapshot.activePatients) && snapshot.activePatients.length > 0
    ? snapshot.activePatients
        .map((patient) => {
          const token = normalizeTokenValue(patient?.token);
          if (token === null) return null;

          const tokensAhead = Number.isFinite(patient?.tokensAhead)
            ? Math.max(Number(patient.tokensAhead), 0)
            : Number.isFinite(currentToken)
              ? Math.max(token - currentToken, 0)
              : null;

          return {
            token,
            tokensAhead,
            status: patient?.status ?? 'waiting',
          };
        })
        .filter(Boolean)
    : derivePatientsFromPresence(presenceState, currentToken);

  return {
    currentToken,
    previousToken: history.length > 1 ? history[history.length - 2] : null,
    history,
    activePatients,
    activeCount: activePatients.length,
    updatedAt: snapshot.updatedAt ?? null,
    lastAction: snapshot.lastAction ?? 'System ready',
  };
}

function derivePatientsFromPresence(presenceState, currentToken) {
  const tokens = new Set();

  for (const entries of Object.values(presenceState ?? {})) {
    for (const entry of entries ?? []) {
      const token = normalizeTokenValue(entry?.tokenNumber);
      if (token !== null) tokens.add(token);
    }
  }

  return [...tokens]
    .sort((a, b) => a - b)
    .map((token) => {
      const diff = Number.isFinite(currentToken) ? token - currentToken : null;
      let status = 'waiting';

      if (!Number.isFinite(currentToken)) {
        status = 'waiting for first token';
      } else if (diff === 0) {
        status = 'being served';
      } else if (diff > 0 && diff <= 3) {
        status = 'near turn';
      } else if (diff < 0) {
        status = 'already called';
      }

      return {
        token,
        tokensAhead: diff === null ? null : Math.max(diff, 0),
        status,
      };
    });
}

function applyDoctorAction(snapshot, action, tokenNumber) {
  const next = {
    currentToken: normalizeTokenValue(snapshot.currentToken),
    history: Array.isArray(snapshot.history) ? [...snapshot.history] : [],
    updatedAt: new Date().toISOString(),
    lastAction: snapshot.lastAction ?? 'System ready',
  };

  if (action === 'set') {
    const token = normalizeTokenValue(tokenNumber);
    if (token === null) return null;
    next.currentToken = token;
    next.history.push(token);
    next.lastAction = 'Token updated manually';
    return next;
  }

  if (action === 'next') {
    const token = Number.isFinite(next.currentToken) ? next.currentToken + 1 : 1;
    next.currentToken = token;
    next.history.push(token);
    next.lastAction = 'Moved to next token';
    return next;
  }

  if (action === 'skip') {
    const token = Number.isFinite(next.currentToken) ? next.currentToken + 1 : 1;
    next.currentToken = token;
    next.history.push(token);
    next.lastAction = 'Skipped to next token';
    return next;
  }

  if (action === 'recall') {
    if (next.history.length < 2) return null;
    next.history.pop();
    next.currentToken = next.history[next.history.length - 1];
    next.lastAction = 'Recalled previous token';
    return next;
  }

  if (action === 'reset') {
    next.currentToken = null;
    next.history = [];
    next.lastAction = 'New day reset';
    return next;
  }

  return null;
}

async function loadQueueSnapshot() {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from(QUEUE_TABLE)
    .select('state')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    console.error('Failed to load queue snapshot:', error);
    return null;
  }

  return data?.state ?? null;
}

async function persistQueueSnapshot(snapshot) {
  if (!supabase) return;

  const { error } = await supabase.from(QUEUE_TABLE).upsert(
    {
      id: 1,
      state: snapshot,
      updated_at: snapshot.updatedAt,
    },
    { onConflict: 'id' },
  );

  if (error) {
    throw error;
  }
}

function formatRealtimeStatus(status) {
  if (status === 'SUBSCRIBED') return 'connected';
  if (status === 'TIMED_OUT') return 'timed out';
  if (status === 'CHANNEL_ERROR') return 'error';
  return 'connecting';
}

function App() {
  const [route, setRoute] = useState(getRoute);
  const [doctorUnlocked, setDoctorUnlocked] = useState(() => sessionStorage.getItem(DOCTOR_UNLOCK_KEY) === '1');
  const [doctorPassword, setDoctorPassword] = useState('');
  const [doctorAuthMessage, setDoctorAuthMessage] = useState('Enter the doctor password to open the dashboard.');
  const [realtimeStatus, setRealtimeStatus] = useState(isSupabaseConfigured ? 'connecting' : 'not configured');
  const [queueState, setQueueState] = useState(createQueueViewState);
  const [doctorToken, setDoctorToken] = useState('');
  const [patientToken, setPatientToken] = useState(() => localStorage.getItem(PATIENT_TOKEN_KEY) || '');
  const [patientMessage, setPatientMessage] = useState('Enter your token number to join the queue.');
  const [notificationEnabled, setNotificationEnabled] = useState('Notification' in window ? Notification.permission : 'unsupported');
  const lastAlertRef = useRef({ token: null, current: null, near: false });
  const channelRef = useRef(null);
  const socketRef = useRef(null);
  const presenceStateRef = useRef({});
  const queueStateRef = useRef(queueState);
  const patientTokenRef = useRef(patientToken);

  useEffect(() => {
    queueStateRef.current = queueState;
  }, [queueState]);

  useEffect(() => {
    patientTokenRef.current = patientToken;
  }, [patientToken]);

  useEffect(() => {
    const onPopState = () => setRoute(getRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    let alive = true;

    if (isSupabaseConfigured) {
      const clientId = getClientId();
      const channel = supabase.channel('qalert-queue', {
        config: {
          presence: { key: clientId },
        },
      });

      channelRef.current = channel;

      channel.on('postgres_changes', { event: '*', schema: 'public', table: QUEUE_TABLE }, (payload) => {
        const nextSnapshot = payload.new?.state;
        if (!alive || !nextSnapshot) return;
        setQueueState(buildQueueViewState(nextSnapshot, presenceStateRef.current));
      });

      channel.on('presence', { event: 'sync' }, () => {
        if (!alive) return;
        const activePatients = derivePatientsFromPresence(channel.presenceState(), queueStateRef.current.currentToken);
        presenceStateRef.current = channel.presenceState();
        setQueueState((prev) => ({
          ...prev,
          activePatients,
          activeCount: activePatients.length,
        }));
      });

      const syncPatientPresence = async () => {
        const token = normalizeTokenValue(patientTokenRef.current);
        if (token === null) return;

        try {
          await channel.track({ tokenNumber: token, role: 'patient' });
        } catch (error) {
          console.error('Failed to track patient presence:', error);
        }
      };

      const bootstrap = async () => {
        try {
          const snapshot = (await loadQueueSnapshot()) ?? createQueueViewState();
          if (!alive) return;
          setQueueState(buildQueueViewState(snapshot, presenceStateRef.current));

          if (!snapshot.updatedAt) {
            await persistQueueSnapshot(snapshot);
          }
        } catch (error) {
          console.error('Failed to bootstrap queue state:', error);
        }
      };

      bootstrap();

      const pollSnapshot = async () => {
        const snapshot = await loadQueueSnapshot();
        if (!alive || !snapshot) return;
        setQueueState((prev) => {
          const nextView = buildQueueViewState(snapshot, presenceStateRef.current);
          if (
            prev.currentToken === nextView.currentToken &&
            prev.previousToken === nextView.previousToken &&
            prev.lastAction === nextView.lastAction &&
            prev.updatedAt === nextView.updatedAt
          ) {
            return prev;
          }

          return nextView;
        });
      };

      const pollId = window.setInterval(() => {
        pollSnapshot().catch((error) => {
          console.error('Failed to refresh queue snapshot:', error);
        });
      }, 5000);

      channel.subscribe((status) => {
        if (!alive) return;
        setRealtimeStatus(formatRealtimeStatus(status));

        if (status === 'SUBSCRIBED') {
          syncPatientPresence();
        }
      });

      return () => {
        alive = false;
        window.clearInterval(pollId);
        channel.untrack().catch(() => {});
        supabase.removeChannel(channel);
        channelRef.current = null;
      };
    }

    const socket = io(window.location.origin, {
      autoConnect: true,
      transports: ['websocket', 'polling'],
    });

    socketRef.current = socket;
    setRealtimeStatus('connecting');

    const syncPatientPresence = () => {
      const token = normalizeTokenValue(patientTokenRef.current);
      if (token === null) return;
      socket.emit('patient:register', { tokenNumber: token, role: 'patient' });
    };

    socket.on('queue:state', (snapshot) => {
      if (!alive || !snapshot) return;
      presenceStateRef.current = {};
      setQueueState(buildQueueViewState(snapshot));
    });

    socket.on('connect', () => {
      if (!alive) return;
      setRealtimeStatus('connected');
      syncPatientPresence();
    });

    socket.on('disconnect', () => {
      if (!alive) return;
      setRealtimeStatus('connecting');
    });

    socket.on('connect_error', () => {
      if (!alive) return;
      setRealtimeStatus('error');
    });

    return () => {
      alive = false;
      socket.off('queue:state');
      socket.off('connect');
      socket.off('disconnect');
      socket.off('connect_error');
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handleState = () => {
      const token = normalizeTokenValue(patientToken);
      const current = queueState.currentToken;
      if (token === null || !Number.isFinite(current)) return;

      const difference = token - current;
      const was = lastAlertRef.current;

      if (difference === 0 && (was.token !== token || was.current !== current)) {
        playAlert();
        setPatientMessage(`Token ${token} is being served now.`);
        lastAlertRef.current = { token, current, near: false };
        return;
      }

      if (difference > 0 && difference <= 3 && !was.near) {
        notifyNearTurn(token, difference, current);
        setPatientMessage(`You are ${difference} token${difference > 1 ? 's' : ''} away.`);
        lastAlertRef.current = { token, current, near: true };
        return;
      }

      if (was.current !== current || was.token !== token || was.near !== (difference > 0 && difference <= 3)) {
        lastAlertRef.current = { token, current, near: difference > 0 && difference <= 3 };
      }
    };

    handleState();
  }, [patientToken, queueState.currentToken]);

  useEffect(() => {
    const saved = localStorage.getItem(PATIENT_TOKEN_KEY);
    if (!saved || !isSupabaseConfigured) return;

    const token = normalizeTokenValue(saved);
    if (token === null) return;

    const channel = channelRef.current;
    if (!channel) return;

    channel.track({ tokenNumber: token, role: 'patient' }).catch((error) => {
      console.error('Failed to restore patient presence:', error);
    });
  }, []);

  useEffect(() => {
    const token = normalizeTokenValue(patientToken);
    if (token === null) return;

    if (isSupabaseConfigured) {
      const channel = channelRef.current;
      if (!channel || realtimeStatus !== 'connected') return;

      channel.track({ tokenNumber: token, role: 'patient' }).catch((error) => {
        console.error('Failed to update patient presence:', error);
      });
      return;
    }

    const socket = socketRef.current;
    if (!socket || realtimeStatus !== 'connected') return;
    socket.emit('patient:register', { tokenNumber: token, role: 'patient' });
  }, [patientToken, realtimeStatus]);

  function navigate(path) {
    if (window.location.pathname === path) return;
    window.history.pushState({}, '', path);
    setRoute(getRoute());
  }

  function unlockDoctor() {
    const enteredPassword = doctorPassword.trim();
    if (enteredPassword !== DOCTOR_PASSWORD) {
      setDoctorAuthMessage('Incorrect password. Please try again.');
      return false;
    }

    sessionStorage.setItem(DOCTOR_UNLOCK_KEY, '1');
    setDoctorUnlocked(true);
    setDoctorAuthMessage('Access granted.');
    return true;
  }

  function lockDoctor() {
    sessionStorage.removeItem(DOCTOR_UNLOCK_KEY);
    setDoctorUnlocked(false);
    setDoctorPassword('');
    setDoctorAuthMessage('Doctor dashboard locked.');
  }

  async function submitPatientToken() {
    const tokenNumber = normalizeTokenValue(patientToken);
    if (tokenNumber === null) {
      setPatientMessage('Please enter a valid token number.');
      return;
    }

    localStorage.setItem(PATIENT_TOKEN_KEY, String(tokenNumber));
    setPatientMessage(`Watching token ${tokenNumber}.`);

    if (isSupabaseConfigured) {
      const channel = channelRef.current;
      if (channel && realtimeStatus === 'connected') {
        try {
          await channel.track({ tokenNumber, role: 'patient' });
        } catch (error) {
          console.error('Failed to track patient token:', error);
        }
      }
    } else {
      const socket = socketRef.current;
      if (socket && realtimeStatus === 'connected') {
        socket.emit('patient:register', { tokenNumber, role: 'patient' });
      }
    }

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then((permission) => setNotificationEnabled(permission));
    } else if ('Notification' in window) {
      setNotificationEnabled(Notification.permission);
    }
  }

  async function handleDoctorAction(action) {
    const tokenNumber = normalizeTokenValue(doctorToken);
    const nextSnapshot = applyDoctorAction(queueStateRef.current, action, tokenNumber);

    if (!nextSnapshot) {
      if (action === 'set') {
        setDoctorAuthMessage('Enter a valid token number first.');
      }
      return;
    }

    setQueueState(buildQueueViewState(nextSnapshot, presenceStateRef.current));

    if (isSupabaseConfigured) {
      try {
        await persistQueueSnapshot(nextSnapshot);
      } catch (error) {
        console.error('Failed to persist queue snapshot:', error);
        setDoctorAuthMessage('Could not save the queue state to Supabase.');
      }
      return;
    }

    const socket = socketRef.current;
    if (!socket || realtimeStatus !== 'connected') return;

    const payload = { tokenNumber };
    if (action === 'set') {
      socket.emit('queue:set', payload);
    } else if (action === 'next') {
      socket.emit('queue:next');
    } else if (action === 'skip') {
      socket.emit('queue:skip');
    } else if (action === 'recall') {
      socket.emit('queue:recall');
    } else if (action === 'reset') {
      socket.emit('queue:reset');
    }
  }

  if (route === 'patient') {
    return (
      <PatientRoute
        state={queueState}
        patientToken={patientToken}
        setPatientToken={setPatientToken}
        patientMessage={patientMessage}
        submitPatientToken={submitPatientToken}
        notificationEnabled={notificationEnabled}
        navigate={navigate}
      />
    );
  }

  if (route === 'doctor') {
    if (!doctorUnlocked) {
      return (
        <DoctorGate
          doctorPassword={doctorPassword}
          setDoctorPassword={setDoctorPassword}
          doctorAuthMessage={doctorAuthMessage}
          unlockDoctor={unlockDoctor}
          navigate={navigate}
        />
      );
    }

    return (
      <DoctorRoute
        state={queueState}
        doctorToken={doctorToken}
        setDoctorToken={setDoctorToken}
        handleDoctorAction={handleDoctorAction}
        lockDoctor={lockDoctor}
        navigate={navigate}
      />
    );
  }

  return (
    <LandingRoute
      navigate={navigate}
      currentToken={queueState.currentToken}
      activeCount={queueState.activeCount}
      lastAction={queueState.lastAction}
      connectionStatus={realtimeStatus}
      configured={isSupabaseConfigured}
    />
  );
}

function LandingRoute({ navigate, currentToken, activeCount, lastAction, connectionStatus, configured }) {
  return (
    <div className="route-shell landing-shell">
      <div className="landing-card">
        <p className="eyebrow">QAlert MVP</p>
        <h1>Real-time queue alerts for the desk and the patient phone.</h1>
        <p className="subhead">
          Choose the staff dashboard or the mobile patient view. Both stay in sync live through Supabase Realtime.
        </p>

        <div className="landing-metrics">
          <div>
            <span>Current token</span>
            <strong>{currentToken ?? '-'}</strong>
          </div>
          <div>
            <span>Waiting patients</span>
            <strong>{activeCount}</strong>
          </div>
          <div>
            <span>Status</span>
            <strong>{lastAction}</strong>
          </div>
          <div>
            <span>Realtime</span>
            <strong>{configured ? connectionStatus : 'not configured'}</strong>
          </div>
        </div>

        <div className="landing-actions">
          <button onClick={() => navigate('/doctor')}>Open Doctor View</button>
          <button className="ghost" onClick={() => navigate('/patient')}>
            Open Patient View
          </button>
        </div>
      </div>
    </div>
  );
}

function DoctorGate({ doctorPassword, setDoctorPassword, doctorAuthMessage, unlockDoctor, navigate }) {
  return (
    <div className="route-shell doctor-shell">
      <header className="route-header">
        <div>
          <p className="eyebrow">Doctor / Receptionist</p>
          <h1>Locked dashboard</h1>
          <p className="subhead">This view needs the doctor password before the queue controls open.</p>
        </div>
        <div className="header-links">
          <button className="ghost" onClick={() => navigate('/patient')}>
            Patient view
          </button>
          <button className="ghost" onClick={() => navigate('/')}>
            Home
          </button>
        </div>
      </header>

      <main className="doctor-grid single-column">
        <section className="panel auth-panel">
          <div className="panel-title">
            <h2>Enter password</h2>
            <span>{doctorAuthMessage}</span>
          </div>

          <div className="controls auth-controls">
            <input
              type="password"
              inputMode="numeric"
              placeholder="Doctor password"
              value={doctorPassword}
              onChange={(event) => setDoctorPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') unlockDoctor();
              }}
            />
            <div className="button-row">
              <button onClick={unlockDoctor}>Open Doctor View</button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function DoctorRoute({ state, doctorToken, setDoctorToken, handleDoctorAction, lockDoctor, navigate }) {
  const waitingPatients = state.activePatients;
  const currentDisplay = state.currentToken ?? '-';

  return (
    <div className="route-shell doctor-shell">
      <header className="route-header">
        <div>
          <p className="eyebrow">Doctor / Receptionist</p>
          <h1>Queue control</h1>
          <p className="subhead">Update the running token, skip, recall, or reset the day.</p>
        </div>
        <div className="header-links">
          <button className="ghost" onClick={lockDoctor}>
            Lock
          </button>
          <button className="ghost" onClick={() => navigate('/patient')}>
            Patient view
          </button>
          <button className="ghost" onClick={() => navigate('/')}>
            Home
          </button>
        </div>
      </header>

      <main className="doctor-grid">
        <section className="panel">
          <div className="panel-title">
            <h2>Desk controls</h2>
            <span>{state.lastAction}</span>
          </div>

          <div className="metric-row">
            <div className="metric">
              <label>Current token</label>
              <strong>{currentDisplay}</strong>
            </div>
            <div className="metric">
              <label>Previous token</label>
              <strong>{state.previousToken ?? '-'}</strong>
            </div>
            <div className="metric">
              <label>Waiting patients</label>
              <strong>{waitingPatients.length}</strong>
            </div>
          </div>

          <div className="controls">
            <input
              type="number"
              min="1"
              placeholder="Enter token number"
              value={doctorToken}
              onChange={(event) => setDoctorToken(event.target.value)}
            />
            <div className="button-row">
              <button onClick={() => handleDoctorAction('set')}>Set token</button>
              <button onClick={() => handleDoctorAction('next')}>Next token</button>
              <button onClick={() => handleDoctorAction('skip')}>Skip token</button>
              <button className="ghost" onClick={() => handleDoctorAction('recall')}>
                Recall previous
              </button>
              <button className="danger" onClick={() => handleDoctorAction('reset')}>
                Reset day
              </button>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h2>Waiting patients</h2>
            <span>Active tokens connected to the queue.</span>
          </div>

          <div className="list-card">
            {waitingPatients.length === 0 ? (
              <p className="empty">No active patient tokens yet.</p>
            ) : (
              <ul>
                {waitingPatients.map((patient) => (
                  <li key={patient.token}>
                    <span>Token {patient.token}</span>
                    <span className={`badge ${patient.status.replace(/\s+/g, '-')}`}>{patient.status}</span>
                    <span>{patient.tokensAhead === null ? '-' : `${patient.tokensAhead} ahead`}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function PatientRoute({
  state,
  patientToken,
  setPatientToken,
  patientMessage,
  submitPatientToken,
  notificationEnabled,
  navigate,
}) {
  return (
    <div className="route-shell patient-shell">
      <header className="patient-topbar">
        <button className="back-button ghost" onClick={() => navigate('/')}>
          Home
        </button>
        <div className="topbar-state">
          <span>Current</span>
          <strong>{state.currentToken ?? '-'}</strong>
        </div>
      </header>

      <main className="patient-app">
        <section className="patient-hero">
          <p className="eyebrow">Patient View</p>
          <h1>See when your token is coming up.</h1>
          <p className="subhead">
            Keep this page open on your phone and we will update you live as the queue moves.
          </p>
        </section>

        <section className="patient-card patient-entry">
          <label htmlFor="patient-token">Your token number</label>
          <div className="patient-input-row">
            <input
              id="patient-token"
              type="number"
              min="1"
              placeholder="e.g. 25"
              value={patientToken}
              onChange={(event) => setPatientToken(event.target.value)}
            />
            <button onClick={submitPatientToken}>Watch</button>
          </div>
          <p className="help">{patientMessage}</p>
        </section>

        <section className="patient-status-card">
          <div className="status-ring">
            <span>Your token</span>
            <strong>{patientToken || '-'}</strong>
          </div>

          <div className="patient-summary">
            <div>
              <span>Being served</span>
              <strong>{state.currentToken ?? '-'}</strong>
            </div>
            <div>
              <span>Tokens ahead</span>
              <strong>{getTokensAhead(state.currentToken, patientToken)}</strong>
            </div>
            <div>
              <span>Notifications</span>
              <strong>{notificationEnabled}</strong>
            </div>
          </div>
        </section>

        <section className="patient-card">
          <h2>Your status</h2>
          <p className="status-text">{getPatientStatus(state.currentToken, patientToken)}</p>
          <p className="help">
            When your token is near, the page can show a browser notification and play a short sound when the turn arrives.
          </p>
        </section>
      </main>
    </div>
  );
}

function getRoute() {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  if (pathname === '/doctor') return 'doctor';
  if (pathname === '/patient') return 'patient';
  return 'home';
}

function getTokensAhead(currentToken, patientToken) {
  const current = Number(currentToken);
  const token = Number(patientToken);
  if (!Number.isFinite(current) || !Number.isFinite(token)) return '-';
  return Math.max(token - current, 0);
}

function getPatientStatus(currentToken, patientToken) {
  const current = Number(currentToken);
  const token = Number(patientToken);
  if (!Number.isFinite(token)) return 'Enter your token to see your status.';
  if (!Number.isFinite(current)) return 'The queue has not started yet.';
  const diff = token - current;
  if (diff < 0) return 'Your token has already been called.';
  if (diff === 0) return 'It is your turn now.';
  if (diff <= 3) return `Your turn is near. ${diff} token${diff > 1 ? 's' : ''} ahead.`;
  return `${diff} token${diff > 1 ? 's' : ''} ahead of you.`;
}

function playAlert() {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gainNode.gain.value = 0.08;
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.15);
    setTimeout(() => audioContext.close(), 300);
  } catch {
    // Audio can fail on locked-down browsers; the visual cue still works.
  }
}

function notifyNearTurn(token, difference, currentToken) {
  const message = `Token ${token} is ${difference} away from the current token ${currentToken}.`;

  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('QAlert', { body: message });
    return;
  }

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') {
        new Notification('QAlert', { body: message });
      }
    });
  }
}

createRoot(document.getElementById('root')).render(<App />);
