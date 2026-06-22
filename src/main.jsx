import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import './styles.css';

const SOCKET_URL = String(import.meta.env.VITE_SOCKET_URL ?? '').trim() || window.location.origin;
const SOCKET_PATH = String(import.meta.env.VITE_SOCKET_PATH ?? '').trim() || '/socket.io';
const socket = io(SOCKET_URL, {
  path: SOCKET_PATH,
  transports: ['websocket', 'polling'],
});
const DOCTOR_PASSWORD = String(import.meta.env.VITE_DOCTOR_PASSWORD ?? '100').trim();
const DOCTOR_UNLOCK_KEY = 'qalert:doctorUnlocked';

function App() {
  const [route, setRoute] = useState(getRoute);
  const [doctorUnlocked, setDoctorUnlocked] = useState(() => sessionStorage.getItem(DOCTOR_UNLOCK_KEY) === '1');
  const [doctorPassword, setDoctorPassword] = useState('');
  const [doctorAuthMessage, setDoctorAuthMessage] = useState('Enter the doctor password to open the dashboard.');
  const [connectionStatus, setConnectionStatus] = useState(socket.connected ? 'connected' : 'connecting');
  const [state, setState] = useState({
    currentToken: null,
    previousToken: null,
    history: [],
    activePatients: [],
    activeCount: 0,
    updatedAt: null,
    lastAction: 'Connecting...',
  });
  const [doctorToken, setDoctorToken] = useState('');
  const [patientToken, setPatientToken] = useState(() => localStorage.getItem('qalert:patientToken') || '');
  const [patientMessage, setPatientMessage] = useState('Enter your token number to join the queue.');
  const [notificationEnabled, setNotificationEnabled] = useState('Notification' in window ? Notification.permission : 'unsupported');
  const lastAlertRef = useRef({ token: null, current: null, near: false });

  useEffect(() => {
    const onPopState = () => setRoute(getRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const handleState = (nextState) => {
      setState(nextState);

      const token = Number(patientToken);
      const current = nextState.currentToken;
      if (!Number.isFinite(token) || !Number.isFinite(current)) return;

      const difference = token - current;
      const was = lastAlertRef.current;

      if (difference === 0 && (was.token !== token || was.current !== current)) {
        playAlert();
        setPatientMessage(`Token ${token} is being served now.`);
        lastAlertRef.current = { token, current, near: false };
        return;
      }

      if (difference > 0 && difference <= 3 && !was.near) {
        notifyNearTurn(token, difference, nextState.currentToken);
        setPatientMessage(`You are ${difference} token${difference > 1 ? 's' : ''} away.`);
        lastAlertRef.current = { token, current, near: true };
        return;
      }

      if (was.current !== current || was.token !== token || was.near !== (difference > 0 && difference <= 3)) {
        lastAlertRef.current = { token, current, near: difference > 0 && difference <= 3 };
      }
    };

    socket.on('queue:state', handleState);
    return () => {
      socket.off('queue:state', handleState);
    };
  }, [patientToken]);

  useEffect(() => {
    const saved = localStorage.getItem('qalert:patientToken');
    if (!saved) return;
    socket.emit('patient:register', { tokenNumber: Number(saved) });
  }, []);

  useEffect(() => {
    const handleConnect = () => setConnectionStatus('connected');
    const handleDisconnect = () => setConnectionStatus('disconnected');
    const handleConnectError = () => setConnectionStatus('connecting');

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
    };
  }, []);

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

  function submitPatientToken() {
    const tokenNumber = Number(patientToken);
    if (!Number.isInteger(tokenNumber) || tokenNumber <= 0) {
      setPatientMessage('Please enter a valid token number.');
      return;
    }

    localStorage.setItem('qalert:patientToken', String(tokenNumber));
    socket.emit('patient:register', { tokenNumber });
    setPatientMessage(`Watching token ${tokenNumber}.`);

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then((permission) => setNotificationEnabled(permission));
    } else if ('Notification' in window) {
      setNotificationEnabled(Notification.permission);
    }
  }

  function handleDoctorAction(action) {
    const tokenNumber = Number(doctorToken);

    if (action === 'set') {
      if (!Number.isInteger(tokenNumber) || tokenNumber <= 0) return;
      socket.emit('queue:set', { tokenNumber });
    }

    if (action === 'next') socket.emit('queue:next');
    if (action === 'skip') socket.emit('queue:skip');
    if (action === 'recall') socket.emit('queue:recall');
    if (action === 'reset') socket.emit('queue:reset');
  }

  if (route === 'patient') {
    return (
      <PatientRoute
        state={state}
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
        state={state}
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
        currentToken={state.currentToken}
        activeCount={state.activeCount}
        lastAction={state.lastAction}
        connectionStatus={connectionStatus}
      />
    );
  }

function LandingRoute({ navigate, currentToken, activeCount, lastAction, connectionStatus }) {
  return (
    <div className="route-shell landing-shell">
      <div className="landing-card">
        <p className="eyebrow">QAlert MVP</p>
        <h1>Real-time queue alerts for the desk and the patient phone.</h1>
        <p className="subhead">
          Choose the staff dashboard or the mobile patient view. Both stay in sync live through Socket.IO with no database behind it.
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
            <strong>{connectionStatus}</strong>
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
